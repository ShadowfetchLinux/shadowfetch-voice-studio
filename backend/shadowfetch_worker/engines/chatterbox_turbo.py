"""Chatterbox-Turbo adapter (package `chatterbox-tts`, Resemble AI).

Runs inside the `chatterbox` engine host (its own Python environment). torch / chatterbox are imported lazily.

Verified API (chatterbox-tts 0.1.7, chatterbox/tts_turbo.py):
  model = ChatterboxTurboTTS.from_local(<snapshot dir>, device="cuda")      # ve / t3_turbo_v1 / s3gen_meanflow / tokenizer (vocab.json+merges.txt), fp32
  model.prepare_conditionals(<wav>, exaggeration=0.0, norm_loudness=True)   # asserts clip > 5.0 s; uses the first 10–15 s
  model.conds : Conditionals  (.save(path) / Conditionals.load(path, map_location="cpu") / .to(device))
  wav = model.generate(text, audio_prompt_path=None, temperature=0.8, top_k=1000, top_p=0.95, repetition_penalty=1.2,
                       norm_loudness=True)  -> CPU float32 torch.Tensor (1, N) at model.sr == 24000, Perth-watermarked.
exaggeration / cfg_weight / min_p are ignored by Turbo and therefore not exposed. English only.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from ..protocol import INVALID_PARAMS, MODEL_LOAD_FAILED, WorkerError
from ._common import (apply_control_defaults, apply_seed, audio_duration_s, cuda_sync_and_vram, filter_settings, intended_device,
                      package_version, prompt_settings, read_prompt_meta, release_cuda, snapshot_revision, write_prompt_meta,
                      write_wav_24)
from .base import Capabilities, ControlSpec, EngineAdapter, GenerateResult, Language, ReferenceRequirements, TagSpec

log = logging.getLogger("engines.chatterbox_turbo")

ENGINE_ID = "chatterbox-turbo"
MODEL_ID = "chatterbox-turbo"
MODEL_REPO = "ResembleAI/chatterbox-turbo"
OUTPUT_SR = 24000
MAX_CHARS = 300
MIN_REF_SECONDS = 5.0   # hard assert in prepare_conditionals: len(wav)/sr > 5.0
# Controls that shape the reusable prompt (Conditionals): they are part of the prompt-cache identity. norm_loudness is
# applied by prepare_conditionals() — ChatterboxTurboTTS.generate() only re-applies it when audio_prompt_path is given.
PROMPT_CONTROLS: tuple[str, ...] = ("norm_loudness",)

# The 9 official paralinguistic tags of Chatterbox-Turbo (model card).
TAGS: list[TagSpec] = [
    TagSpec(token="[clear throat]", label="Clear throat"), TagSpec(token="[sigh]", label="Sigh"), TagSpec(token="[shush]", label="Shush"),
    TagSpec(token="[cough]", label="Cough"), TagSpec(token="[groan]", label="Groan"), TagSpec(token="[sniff]", label="Sniff"),
    TagSpec(token="[gasp]", label="Gasp"), TagSpec(token="[chuckle]", label="Chuckle"), TagSpec(token="[laugh]", label="Laugh"),
]

CONTROLS: list[ControlSpec] = [
    ControlSpec(id="temperature", label="Sampling temperature", type="float", min=0.05, max=2.0, step=0.05, default=0.8,
                description="Higher values sound more varied; lower values are steadier."),
    ControlSpec(id="repetition_penalty", label="Repetition penalty", type="float", min=1.0, max=2.0, step=0.05, default=1.2,
                description="Discourages repeated speech tokens (stutters, loops)."),
    ControlSpec(id="top_p", label="Top-p (nucleus sampling)", type="float", min=0.0, max=1.0, step=0.01, default=0.95, advanced=True,
                description="Restricts sampling to the most likely tokens whose probabilities sum to top-p."),
    ControlSpec(id="top_k", label="Top-k", type="int", min=0, max=1000, step=10, default=1000, advanced=True,
                description="Sample only from the k most likely speech tokens (0 = disabled)."),
    ControlSpec(id="norm_loudness", label="Normalise reference loudness", type="bool", default=True,
                description="Loudness-normalise the reference clip to −27 LUFS before conditioning (engine-side, recommended)."),
]


class ChatterboxTurboAdapter(EngineAdapter):
    id = ENGINE_ID

    def __init__(self) -> None:
        self.model = None
        self.device = "cpu"
        self.model_dir: Path | None = None
        self.revision: str | None = None
        self._conds_key: str | None = None   # (cache path, mtime) currently held in model.conds

    # ------------------------------------------------------------------ static
    def capabilities(self) -> Capabilities:
        return Capabilities(
            id=ENGINE_ID, name="Chatterbox-Turbo", version=package_version("chatterbox-tts"), model_id=MODEL_ID,
            model_repo=MODEL_REPO, output_sample_rate=OUTPUT_SR,
            languages=[Language(code="en", label="English", engine_value="en")],
            reference=ReferenceRequirements(
                needs_transcript=False, min_seconds=MIN_REF_SECONDS, max_seconds=15.0, recommended_seconds=(8.0, 12.0),
                sample_rate=OUTPUT_SR, channels=1,
                notes="The clip must be longer than 5 s (hard requirement of the engine). Only the first ~10–15 s are used: "
                      "10 s condition the vocoder and 15 s the speech-token prompt. No transcript is needed. When "
                      "'Normalise reference loudness' is on, the engine loudness-normalises the reference to −27 LUFS before "
                      "conditioning. English only."),
            controls=list(CONTROLS), tags=list(TAGS), max_chars_per_request=MAX_CHARS,
            supports_cancel=True, cancel_granularity="segment", supports_seed=True, supports_reusable_prompt=True,
            supports_multi_reference=False, prompt_controls=list(PROMPT_CONTROLS), watermark="perth", license="MIT",
            device=self.device if self.model is not None else intended_device(),
            notes="Every output carries Resemble AI's Perth watermark (applied by the engine on the CPU); the app never removes "
                  "it. Text is limited to 1024 text tokens and 1000 speech tokens (~40 s) per request — keep segments under "
                  "~300 characters. Seeds are applied with torch.manual_seed and repeat a result on the same machine/environment "
                  "only. Cancel aborts the running segment by stopping the engine process.",
        )

    # ------------------------------------------------------------------ lifecycle
    def load(self, model_dir: Path, device: str = "cuda", dtype: str = "float32", progress=None) -> dict[str, Any]:
        import torch
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        model_dir = Path(model_dir)
        for f in ("ve.safetensors", "t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors", "tokenizer_config.json", "vocab.json", "merges.txt"):
            if not (model_dir / f).exists():
                raise WorkerError(MODEL_LOAD_FAILED, f"Missing {f} in {model_dir}", {"model_dir": str(model_dir), "file": f})
        use_cuda = device.startswith("cuda") and torch.cuda.is_available()
        if device.startswith("cuda") and not use_cuda:
            log.warning("CUDA requested but torch.cuda.is_available() is False — loading on CPU")
        dev = device if use_cuda else "cpu"
        if progress:
            progress(f"Loading Chatterbox-Turbo weights (fp32 on {dev})")
        t0 = time.time()
        self.model = ChatterboxTurboTTS.from_local(str(model_dir), device=dev)   # never from_pretrained (would download)
        self.device = dev
        self.model_dir = model_dir
        self.revision = snapshot_revision(model_dir)
        self._conds_key = None
        vram = cuda_sync_and_vram()
        sr = int(getattr(self.model, "sr", OUTPUT_SR))
        if sr != OUTPUT_SR:
            log.warning("chatterbox reports sr=%s (expected %s)", sr, OUTPUT_SR)
        log.info("chatterbox-turbo loaded in %.1fs device=%s vram=%s", time.time() - t0, dev, vram)
        return {"revision": self.revision, "vram_bytes": vram, "device": dev, "dtype": "float32", "sample_rate": sr,
                "load_ms": int((time.time() - t0) * 1000)}

    def unload(self) -> None:
        if self.model is not None:
            m = self.model
            self.model = None
            for attr in ("t3", "s3gen", "ve", "conds"):
                try:
                    setattr(m, attr, None)
                except Exception:  # noqa: BLE001
                    pass
            del m
        self._conds_key = None
        release_cuda()

    def loaded(self) -> bool:
        return self.model is not None

    def health(self) -> dict[str, Any]:
        return {"loaded": self.loaded(), "device": self.device, "revision": self.revision}

    # ------------------------------------------------------------------ prompts
    def _require_model(self):
        if self.model is None:
            raise WorkerError(MODEL_LOAD_FAILED, "Chatterbox-Turbo is not loaded", recoverable=True)
        return self.model

    @staticmethod
    def _check_reference(reference_path: Path) -> float:
        reference_path = Path(reference_path)
        if not reference_path.exists():
            raise WorkerError(INVALID_PARAMS, f"Reference file not found: {reference_path}")
        try:
            secs = audio_duration_s(reference_path)
        except Exception:  # noqa: BLE001
            return -1.0   # not a soundfile-readable container; let librosa in the engine decide
        if secs <= MIN_REF_SECONDS:
            raise WorkerError(INVALID_PARAMS, f"Chatterbox-Turbo needs a reference longer than {MIN_REF_SECONDS:.0f} s "
                              f"(this one is {secs:.1f} s).", {"seconds": secs, "min_seconds": MIN_REF_SECONDS})
        return secs

    def prepare_reference(self, reference_path: Path, transcript: str, language: str, cache_path: Path,
                          settings: dict[str, Any] | None = None) -> dict[str, Any]:
        model = self._require_model()
        reference_path = Path(reference_path)
        if not reference_path.exists():
            raise WorkerError(INVALID_PARAMS, f"Reference file not found: {reference_path}")
        secs = self._check_reference(reference_path)
        norm_loudness = bool(prompt_settings(settings, CONTROLS, PROMPT_CONTROLS)["norm_loudness"])
        t0 = time.time()
        model.prepare_conditionals(str(reference_path), exaggeration=0.0, norm_loudness=norm_loudness)
        cache_path = Path(cache_path)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_path.with_name(cache_path.name + ".part")
        model.conds.save(tmp)
        tmp.replace(cache_path)
        meta = {"norm_loudness": norm_loudness, "ref_seconds": round(secs, 3) if secs > 0 else None, "revision": self.revision,
                "engine_id": ENGINE_ID, "elapsed_s": round(time.time() - t0, 3)}
        write_prompt_meta(cache_path, {k: meta[k] for k in ("norm_loudness", "revision", "engine_id", "ref_seconds")})
        self._conds_key = f"{cache_path}:{cache_path.stat().st_mtime}"
        return {"path": str(cache_path), "meta": meta}

    def _load_conds(self, cache_path: Path) -> None:
        from chatterbox.tts_turbo import Conditionals
        key = f"{cache_path}:{cache_path.stat().st_mtime}"
        if self._conds_key == key and self.model.conds is not None:
            return
        self.model.conds = Conditionals.load(str(cache_path), map_location="cpu").to(self.device)
        self._conds_key = key

    @staticmethod
    def _cache_matches(cache_path: Path, norm_loudness: bool) -> tuple[bool, str]:
        """A prompt cache is only reusable when it was built with the same prompt-shaping settings. Caches without a
        sidecar (built by older code) are assumed to carry the declared default (norm_loudness=True)."""
        meta = read_prompt_meta(cache_path) or {}
        built_with = bool(meta.get("norm_loudness", True))
        if built_with != norm_loudness:
            return False, f"prompt cache was built with norm_loudness={built_with}, requested {norm_loudness}"
        return True, ""

    # ------------------------------------------------------------------ generation
    def _reference_for_fallback(self, reference_path: Path | None, why: str) -> str:
        if reference_path is None or not Path(reference_path).exists():
            raise WorkerError(INVALID_PARAMS, f"No usable voice prompt: {why} and no reference file was given"
                              + (f" (missing: {reference_path})" if reference_path else "") + ".", {"reference_path": str(reference_path or "")})
        self._check_reference(Path(reference_path))
        self._conds_key = None
        return str(reference_path)

    def generate(self, text: str, language: str, reference_path: Path | None, transcript: str, out_path: Path,
                 settings: dict[str, Any], seed: int | None = None, prompt_cache_path: Path | None = None,
                 cancel_check=None) -> GenerateResult:
        model = self._require_model()
        text = (text or "").strip()
        if not text:
            raise WorkerError(INVALID_PARAMS, "Text is empty")
        if language and language.strip().lower() not in ("en", "english", "auto"):
            raise WorkerError(INVALID_PARAMS, "Chatterbox-Turbo is English-only.")
        warnings: list[str] = []
        if len(text) > MAX_CHARS:
            warnings.append(f"Text is {len(text)} characters (> {MAX_CHARS}); the engine caps output at ~40 s and may cut it off.")
        cfg = apply_control_defaults(filter_settings(settings, CONTROLS), CONTROLS)
        norm_loudness = bool(cfg.pop("norm_loudness"))
        gen_kwargs = {k: cfg[k] for k in ("temperature", "top_p", "top_k", "repetition_penalty")}
        if cancel_check:
            cancel_check()

        # Prompt source: the cached Conditionals when they exist AND were built with the requested prompt settings;
        # otherwise the reference file (audio_prompt_path — the only path on which generate() applies norm_loudness).
        audio_prompt_path: str | None = None
        if prompt_cache_path is not None and Path(prompt_cache_path).exists():
            ok, why = self._cache_matches(Path(prompt_cache_path), norm_loudness)
            if not ok:
                log.info("%s; rebuilding the prompt from the reference file", why)
                audio_prompt_path = self._reference_for_fallback(reference_path, why)
            else:
                try:
                    self._load_conds(Path(prompt_cache_path))
                except Exception as e:  # noqa: BLE001
                    log.warning("prompt cache %s could not be loaded (%s); falling back to the reference file", prompt_cache_path, e)
                    warnings.append("Prompt cache unreadable — rebuilt the voice prompt from the reference audio.")
                    audio_prompt_path = self._reference_for_fallback(reference_path, "the prompt cache is unreadable")
        else:
            audio_prompt_path = self._reference_for_fallback(reference_path, "no prompt cache was given")

        used_seed = apply_seed(seed)
        t0 = time.time()
        # NEVER touch model.watermarker: outputs keep Resemble's Perth watermark.
        wav = model.generate(text, audio_prompt_path=audio_prompt_path, norm_loudness=norm_loudness, **gen_kwargs)
        elapsed = time.time() - t0
        if cancel_check:
            cancel_check()
        arr = wav.detach().cpu().float().numpy().reshape(-1) if hasattr(wav, "detach") else wav
        sr = int(getattr(model, "sr", OUTPUT_SR))
        duration = write_wav_24(Path(out_path), arr, sr)
        if duration >= 39.5:
            warnings.append("Output reached the engine's ~40 s limit; the text was probably cut off — split it.")
        log.info("chatterbox-turbo generated %.2fs of audio in %.2fs (%.1fx realtime) seed=%s", duration, elapsed, duration / max(elapsed, 1e-6), used_seed)
        return GenerateResult(path=str(out_path), sample_rate=sr, duration_s=round(duration, 4), seed=used_seed,
                              elapsed_s=round(elapsed, 3), warnings=warnings)
