"""Qwen3-TTS 1.7B Base adapter (package `qwen-tts`).

Runs inside the `main` engine host. torch / qwen_tts are imported lazily so `capabilities()` works in the
main worker (no torch there).

Verified API (qwen-tts 0.1.1):
  model = Qwen3TTSModel.from_pretrained(<dir>, device_map="cuda:0", dtype=torch.bfloat16)   # SDPA attention (default)
  items = model.create_voice_clone_prompt(ref_audio=<path>, ref_text=<transcript>, x_vector_only_mode=False)
  wavs, sr = model.generate_voice_clone(text=..., language="English", voice_clone_prompt=items, **gen_kwargs)
Reusable prompts are persisted exactly like the official demo: torch.save({"items": [asdict(it) ...]}).
"""
from __future__ import annotations

import dataclasses
import logging
import time
from pathlib import Path
from typing import Any

from ..protocol import INVALID_PARAMS, MODEL_LOAD_FAILED, WorkerError
from ._common import (apply_seed, audio_duration_s, cuda_sync_and_vram, filter_settings, package_version, release_cuda,
                      snapshot_revision, write_wav_24)
from .base import Capabilities, ControlSpec, EngineAdapter, GenerateResult, Language, ReferenceRequirements

log = logging.getLogger("engines.qwen3_tts")

ENGINE_ID = "qwen3-tts-base"
MODEL_ID = "qwen3-tts-12hz-1.7b-base"
MODEL_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
OUTPUT_SR = 24000
MAX_CHARS = 400

# app code -> (label, exact engine value). The engine validates case-insensitively against
# model.get_supported_languages(); "Auto" lets the model detect the language.
LANGUAGES: list[tuple[str, str, str]] = [
    ("en", "English", "English"), ("zh", "Chinese", "Chinese"), ("de", "German", "German"), ("it", "Italian", "Italian"),
    ("pt", "Portuguese", "Portuguese"), ("es", "Spanish", "Spanish"), ("ja", "Japanese", "Japanese"), ("ko", "Korean", "Korean"),
    ("fr", "French", "French"), ("ru", "Russian", "Russian"), ("auto", "Auto-detect", "Auto"),
]

CONTROLS: list[ControlSpec] = [
    ControlSpec(id="temperature", label="Sampling temperature", type="float", min=0.1, max=1.5, step=0.05, default=0.9,
                description="Higher values sound more varied and expressive; lower values are steadier and closer to the reference."),
    ControlSpec(id="repetition_penalty", label="Repetition penalty", type="float", min=1.0, max=1.5, step=0.05, default=1.05,
                description="Discourages repeated codec tokens (stutters, loops). Raise slightly if words repeat."),
    ControlSpec(id="top_p", label="Top-p (nucleus sampling)", type="float", min=0.5, max=1.0, step=0.01, default=1.0, advanced=True,
                description="Restricts sampling to the most likely tokens whose probabilities sum to top-p."),
    ControlSpec(id="top_k", label="Top-k", type="int", min=1, max=100, step=1, default=50, advanced=True,
                description="Sample only from the k most likely codec tokens."),
    ControlSpec(id="subtalker_temperature", label="Sub-talker temperature", type="float", min=0.1, max=1.5, step=0.05, default=0.9,
                advanced=True, description="Temperature of the second-stage (sub-talker) decoder of the 12 Hz codec."),
    ControlSpec(id="max_new_tokens", label="Max codec frames", type="int", min=256, max=8192, step=64, default=2048, advanced=True,
                description="Upper bound on generated codec frames: 12.5 codec frames per second (2048 ≈ 164 s). "
                            "The checkpoint's own default is 8192."),
    ControlSpec(id="x_vector_only_mode", label="Speaker embedding only", type="bool", default=False, advanced=True,
                description="Speaker embedding only — no transcript needed, lower fidelity. Disables in-context (ICL) cloning."),
]


def _language_value(language: str | None) -> str:
    if not language:
        return "Auto"
    low = language.strip().lower()
    for code, _label, value in LANGUAGES:
        if low in (code, value.lower()):
            return value
    raise WorkerError(INVALID_PARAMS, f"Language {language!r} is not supported by Qwen3-TTS. "
                      f"Use one of: {', '.join(c for c, _, _ in LANGUAGES)}.")


class Qwen3TTSAdapter(EngineAdapter):
    id = ENGINE_ID

    def __init__(self) -> None:
        self.model = None
        self.device = "cpu"
        self.dtype_name = "float32"
        self.model_dir: Path | None = None
        self.revision: str | None = None
        self._prompt_cache: dict[str, tuple[float, list]] = {}   # path -> (mtime, items) — avoids re-reading each segment

    # ------------------------------------------------------------------ static
    def capabilities(self) -> Capabilities:
        return Capabilities(
            id=ENGINE_ID, name="Qwen3-TTS 1.7B Base", version=package_version("qwen-tts"), model_id=MODEL_ID,
            model_repo=MODEL_REPO, output_sample_rate=OUTPUT_SR,
            languages=[Language(code=c, label=l, engine_value=v) for c, l, v in LANGUAGES],
            reference=ReferenceRequirements(
                needs_transcript=True, min_seconds=3.0, max_seconds=30.0, recommended_seconds=(8.0, 15.0),
                sample_rate=OUTPUT_SR, channels=1,
                notes="In-context (ICL) cloning conditions on the reference audio AND its exact transcript — an inaccurate "
                      "transcript degrades the clone, so confirm it word for word. 3 s is the documented minimum ('3-second "
                      "rapid voice clone'); 8–15 s of clean, single-speaker speech works best. Known upstream issue: the output "
                      "can echo the last 1–2 s of the reference transcript, and long inputs may drop the final words — keep "
                      "segments under ~400 characters. Any format/sample rate is accepted (resampled to 24 kHz mono internally)."),
            controls=list(CONTROLS), tags=[], max_chars_per_request=MAX_CHARS,
            supports_cancel=True, cancel_granularity="segment", supports_seed=True, supports_reusable_prompt=True,
            supports_multi_reference=False, watermark=None, license="Apache-2.0", device=self.device,
            notes="Cancel aborts the running segment by stopping the engine process (the engine must reload afterwards). "
                  "Seeds are applied with torch.manual_seed and repeat a result on the same machine/environment only; they are "
                  "not reproducible across torch/CUDA versions or GPUs. bf16 on CUDA, fp32 on CPU (fp16 is not safe for this model).",
        )

    # ------------------------------------------------------------------ lifecycle
    def load(self, model_dir: Path, device: str = "cuda", dtype: str = "bfloat16", progress=None) -> dict[str, Any]:
        import torch
        from qwen_tts import Qwen3TTSModel
        model_dir = Path(model_dir)
        if not (model_dir / "config.json").exists():
            raise WorkerError(MODEL_LOAD_FAILED, f"No config.json in {model_dir}", {"model_dir": str(model_dir)})
        use_cuda = device.startswith("cuda") and torch.cuda.is_available()
        if device.startswith("cuda") and not use_cuda:
            log.warning("CUDA requested but torch.cuda.is_available() is False — loading on CPU")
        device_map = device if use_cuda else "cpu"
        if use_cuda and device == "cuda":
            device_map = "cuda:0"
        torch_dtype = torch.bfloat16 if use_cuda else torch.float32   # fp16 is not safe; fp32 on CPU
        if progress:
            progress(f"Loading Qwen3-TTS weights ({'bf16 on ' + device_map if use_cuda else 'fp32 on CPU'})")
        t0 = time.time()
        # No attn_implementation: SDPA is the default and flash-attn is not available for sm_120.
        self.model = Qwen3TTSModel.from_pretrained(str(model_dir), device_map=device_map, dtype=torch_dtype)
        self.device = device_map
        self.dtype_name = "bfloat16" if use_cuda else "float32"
        self.model_dir = model_dir
        self.revision = snapshot_revision(model_dir)
        vram = cuda_sync_and_vram()
        supported = None
        try:
            supported = self.model.get_supported_languages()
        except Exception:  # noqa: BLE001
            pass
        log.info("qwen3-tts loaded in %.1fs device=%s dtype=%s vram=%s langs=%s", time.time() - t0, self.device, self.dtype_name, vram, supported)
        return {"revision": self.revision, "vram_bytes": vram, "device": self.device, "dtype": self.dtype_name,
                "supported_languages": supported, "load_ms": int((time.time() - t0) * 1000)}

    def unload(self) -> None:
        self._prompt_cache.clear()
        if self.model is not None:
            m = self.model
            self.model = None
            try:
                del m.model
            except Exception:  # noqa: BLE001
                pass
            del m
        release_cuda()

    def loaded(self) -> bool:
        return self.model is not None

    def health(self) -> dict[str, Any]:
        return {"loaded": self.loaded(), "device": self.device, "dtype": self.dtype_name, "revision": self.revision}

    # ------------------------------------------------------------------ prompts
    def _require_model(self):
        if self.model is None:
            raise WorkerError(MODEL_LOAD_FAILED, "Qwen3-TTS is not loaded", recoverable=True)
        return self.model

    def _build_items(self, reference_path: Path, transcript: str, x_vector_only: bool) -> list:
        model = self._require_model()
        if not x_vector_only and not (transcript or "").strip():
            raise WorkerError(INVALID_PARAMS, "Qwen3-TTS needs the reference transcript for in-context cloning "
                              "(or enable 'Speaker embedding only').")
        return model.create_voice_clone_prompt(ref_audio=str(reference_path), ref_text=(transcript or "").strip() or None,
                                               x_vector_only_mode=bool(x_vector_only))

    @staticmethod
    def save_items(items: list, path: Path) -> None:
        import torch
        payload = {"items": [dataclasses.asdict(it) for it in items]}
        # detach to CPU so the cache is device-independent and small to load
        for d in payload["items"]:
            for k, v in list(d.items()):
                if hasattr(v, "detach"):
                    d[k] = v.detach().to("cpu").contiguous()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".part")
        torch.save(payload, str(tmp))
        tmp.replace(path)

    @staticmethod
    def load_items(path: Path) -> list:
        import torch
        from qwen_tts import VoiceClonePromptItem
        data = torch.load(str(path), map_location="cpu", weights_only=True)
        items = []
        for d in data["items"]:
            xv = bool(d.get("x_vector_only_mode", False))
            items.append(VoiceClonePromptItem(ref_code=d["ref_code"], ref_spk_embedding=d["ref_spk_embedding"], x_vector_only_mode=xv,
                                              icl_mode=bool(d.get("icl_mode", not xv)), ref_text=d.get("ref_text")))
        if not items:
            raise ValueError("prompt cache holds no items")
        return items

    def _items_to_device(self, items: list) -> list:
        dev = getattr(self.model, "device", None) or self.device
        for it in items:
            if it.ref_code is not None:
                it.ref_code = it.ref_code.to(dev)
            it.ref_spk_embedding = it.ref_spk_embedding.to(dev)
        return items

    def prepare_reference(self, reference_path: Path, transcript: str, language: str, cache_path: Path) -> dict[str, Any]:
        reference_path = Path(reference_path)
        if not reference_path.exists():
            raise WorkerError(INVALID_PARAMS, f"Reference file not found: {reference_path}")
        t0 = time.time()
        items = self._build_items(reference_path, transcript, x_vector_only=False)
        cache_path = Path(cache_path)
        self.save_items(items, cache_path)
        self._prompt_cache.pop(str(cache_path), None)
        try:
            ref_seconds = round(audio_duration_s(reference_path), 3)
        except Exception:  # noqa: BLE001
            ref_seconds = None
        return {"path": str(cache_path), "meta": {"items": len(items), "x_vector_only_mode": False, "icl_mode": True,
                                                 "ref_seconds": ref_seconds, "revision": self.revision,
                                                 "elapsed_s": round(time.time() - t0, 3)}}

    def _cached_items(self, cache_path: Path) -> list | None:
        key = str(cache_path)
        try:
            mtime = cache_path.stat().st_mtime
        except OSError:
            return None
        hit = self._prompt_cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
        items = self._items_to_device(self.load_items(cache_path))
        self._prompt_cache = {key: (mtime, items)}   # keep only the most recent prompt in memory
        return items

    # ------------------------------------------------------------------ generation
    def generate(self, text: str, language: str, reference_path: Path, transcript: str, out_path: Path,
                 settings: dict[str, Any], seed: int | None = None, prompt_cache_path: Path | None = None,
                 cancel_check=None) -> GenerateResult:
        model = self._require_model()
        text = (text or "").strip()
        if not text:
            raise WorkerError(INVALID_PARAMS, "Text is empty")
        warnings: list[str] = []
        if len(text) > MAX_CHARS:
            warnings.append(f"Text is {len(text)} characters (> {MAX_CHARS}); long inputs may drop the final words.")
        lang_value = _language_value(language)
        cfg = filter_settings(settings, CONTROLS)
        x_vector_only = bool(cfg.pop("x_vector_only_mode", False))
        gen_kwargs = {k: v for k, v in cfg.items() if k in ("temperature", "repetition_penalty", "top_p", "top_k",
                                                            "subtalker_temperature", "max_new_tokens")}
        if cancel_check:
            cancel_check()

        # prompt: cached items when they exist and match the requested mode; otherwise from the reference file
        items = None
        if prompt_cache_path is not None and Path(prompt_cache_path).exists():
            try:
                items = self._cached_items(Path(prompt_cache_path))
                if items and bool(items[0].x_vector_only_mode) != x_vector_only:
                    log.info("prompt cache mode (x_vector_only=%s) differs from requested (%s); rebuilding from reference",
                             items[0].x_vector_only_mode, x_vector_only)
                    items = None
            except Exception as e:  # noqa: BLE001
                log.warning("prompt cache %s could not be loaded (%s); falling back to ref_audio/ref_text", prompt_cache_path, e)
                warnings.append("Prompt cache unreadable — rebuilt the voice prompt from the reference audio.")
                items = None
        if items is None:
            reference_path = Path(reference_path)
            if not reference_path.exists():
                raise WorkerError(INVALID_PARAMS, f"Reference file not found: {reference_path}")
            items = self._build_items(reference_path, transcript, x_vector_only)

        used_seed = apply_seed(seed)
        t0 = time.time()
        wavs, sr = model.generate_voice_clone(text=text, language=lang_value, voice_clone_prompt=items, **gen_kwargs)
        elapsed = time.time() - t0
        if cancel_check:
            cancel_check()
        if not wavs:
            raise WorkerError("EMPTY_AUDIO", "The engine returned no audio for this text.")
        wav = wavs[0]
        duration = write_wav_24(Path(out_path), wav, int(sr))
        if int(sr) != OUTPUT_SR:
            warnings.append(f"Engine reported {sr} Hz (expected {OUTPUT_SR}).")
        frames = int(gen_kwargs.get("max_new_tokens", 2048))
        if duration >= frames / 12.5 * 0.98:
            warnings.append("Output hit the max codec frame limit; the text may be truncated — raise 'Max codec frames' or split it.")
        log.info("qwen3-tts generated %.2fs of audio in %.2fs (%.1fx realtime) seed=%s", duration, elapsed, duration / max(elapsed, 1e-6), used_seed)
        return GenerateResult(path=str(out_path), sample_rate=int(sr), duration_s=round(duration, 4), seed=used_seed,
                              elapsed_s=round(elapsed, 3), warnings=warnings)
