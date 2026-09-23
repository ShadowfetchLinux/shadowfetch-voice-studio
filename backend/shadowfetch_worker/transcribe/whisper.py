"""faster-whisper wrapper: model cache + selection cutting + transcription.

faster-whisper 1.2.1:
  WhisperModel(<local CTranslate2 dir>, device="cpu"|"cuda", compute_type="int8"|"float16", cpu_threads=N)
  segments, info = model.transcribe(path_or_float32_16k, beam_size=5, language=None|"en", vad_filter=True,
                                    word_timestamps=False, condition_on_previous_text=False)
On CUDA, torch must be imported BEFORE ctranslate2 so libcublas.so.12 from the torch wheels is already loaded.
faster_whisper is imported lazily so the main worker keeps starting without it.
"""
from __future__ import annotations

import logging
import math
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from ..protocol import EMPTY_AUDIO, FFMPEG_FAILED, INTERNAL, INVALID_PARAMS, MODEL_INVALID, MODEL_LOAD_FAILED, WorkerError

log = logging.getLogger("transcribe")
_LOCK = threading.RLock()
TARGET_SR = 16000


def is_english_only_model(model_id: str) -> bool:
    return model_id.endswith(".en")


def cut_selection(src: Path, dst: Path, start_s: float | None, end_s: float | None, ctx=None) -> Path:
    """Write the selection as a 16 kHz mono float32 WAV (what Whisper consumes). Uses audio.ffmpeg when present."""
    src, dst = Path(src), Path(dst)
    if not src.exists():
        raise WorkerError(INVALID_PARAMS, f"Audio file not found: {src}", {"path": str(src)})
    if start_s is not None and end_s is not None and end_s <= start_s:
        raise WorkerError(INVALID_PARAMS, "end_s must be greater than start_s")
    filters: list[str] = []
    if start_s is not None or end_s is not None:
        parts = []
        if start_s is not None:
            parts.append(f"start={float(start_s):.3f}")
        if end_s is not None:
            parts.append(f"end={float(end_s):.3f}")
        filters.append("atrim=" + ":".join(parts))
        filters.append("asetpts=PTS-STARTPTS")
    try:
        from ..audio.ffmpeg import decode_to_wav
        decode_to_wav(src, dst, sample_rate=TARGET_SR, channels=1, sample_fmt="f32", ctx=ctx, extra_filters=filters or None)
        return dst
    except ImportError:
        pass
    except WorkerError:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("audio.ffmpeg.decode_to_wav failed (%s); using ffmpeg directly", e)
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-sn", "-dn", "-map", "0:a:0"]
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd += ["-ac", "1", "-ar", str(TARGET_SR), "-c:a", "pcm_f32le", "-f", "wav", str(dst)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.SubprocessError) as e:
        raise WorkerError(FFMPEG_FAILED, f"ffmpeg failed: {e}")
    if r.returncode != 0 or not dst.exists():
        raise WorkerError(FFMPEG_FAILED, "ffmpeg could not decode the selection: " + (r.stderr or "")[-400:])
    return dst


class WhisperCache:
    """One loaded WhisperModel per (model_id, device), stored in server.state['asr_models']."""

    def __init__(self) -> None:
        self.models: dict[tuple[str, str], Any] = {}
        self.last_used: dict[tuple[str, str], float] = {}

    def get(self, model_id: str, model_dir: Path, device: str) -> Any:
        key = (model_id, device)
        with _LOCK:
            m = self.models.get(key)
            if m is None:
                m = load_model(model_dir, device)
                self.models = {key: m}   # keep one model resident (RAM/VRAM policy)
            self.last_used[key] = time.time()
            return m

    def unload_all(self) -> None:
        with _LOCK:
            self.models.clear()
            self.last_used.clear()


def load_model(model_dir: Path, device: str):
    model_dir = Path(model_dir)
    if not (model_dir / "model.bin").exists():
        raise WorkerError(MODEL_LOAD_FAILED, f"No model.bin in {model_dir}", {"model_dir": str(model_dir)})
    # faster-whisper falls back to tokenizers.Tokenizer.from_pretrained("openai/whisper-…") — a network fetch that
    # ignores HF_HUB_OFFLINE — when tokenizer.json is missing. Refuse before that can happen.
    if not (model_dir / "tokenizer.json").exists():
        raise WorkerError(MODEL_INVALID, f"{model_dir} has no tokenizer.json; the transcription model is incomplete. "
                          "Open Settings → Engines & models and download (or verify) it again.",
                          {"model_dir": str(model_dir), "missing_files": ["tokenizer.json"]}, True)
    if device == "cuda":
        try:
            import torch  # noqa: F401  — must precede ctranslate2 so the CUDA libs from the torch wheels are loaded
        except ImportError:
            log.warning("torch not importable; ctranslate2 must find libcublas on its own")
    from faster_whisper import WhisperModel
    compute = "float16" if device == "cuda" else "int8"
    threads = max(1, min(8, (os.cpu_count() or 4) // 2))
    t0 = time.time()
    try:
        m = WhisperModel(str(model_dir), device=device, compute_type=compute, cpu_threads=threads, local_files_only=True)
    except Exception as e:  # noqa: BLE001
        low = str(e).lower()
        if device == "cuda" and ("cuda" in low or "cublas" in low or "cudnn" in low or "libc" in low):
            raise WorkerError(MODEL_LOAD_FAILED, f"faster-whisper could not start on the GPU ({str(e)[:200]}). Switch the transcription "
                              "device to CPU in Settings.", {"exception": str(e)[:600], "device": device}, True)
        raise WorkerError(MODEL_LOAD_FAILED, f"Could not load the transcription model: {str(e)[:300]}", {"exception": str(e)[:600]}, True)
    log.info("faster-whisper loaded %s on %s (%s) in %.1fs", model_dir.name, device, compute, time.time() - t0)
    return m


_CUDA_HINTS = ("cuda", "cublas", "cudnn", "libc", "device", "gpu", "out of memory", "nvrtc", "ptx")


def _model_device(model) -> str:
    try:
        dev = getattr(getattr(model, "model", None), "device", None) or getattr(model, "device", None)
        return str(dev or "cpu").lower()
    except Exception:  # noqa: BLE001
        return "cpu"


def _transcribe_error(e: Exception, device: str) -> WorkerError:
    """Map CUDA-related failures (constructor OR lazy decoding) to the same recoverable 'switch to CPU' error."""
    low = str(e).lower()
    if device.startswith("cuda") and any(h in low for h in _CUDA_HINTS):
        return WorkerError(MODEL_LOAD_FAILED, f"faster-whisper failed on the GPU ({str(e)[:200]}). Switch the transcription device "
                           "to CPU in Settings.", {"exception": str(e)[:600], "device": device}, True)
    return WorkerError(INTERNAL, f"Transcription failed: {str(e)[:300]}", {"exception": str(e)[:600], "device": device}, True)


def transcribe(model, audio_path: Path, language: str | None, model_id: str, beam_size: int = 5, vad: bool = True,
               progress=None, cancel_check=None, device: str | None = None) -> dict[str, Any]:
    lang = (language or "").strip().lower() or None
    if lang == "auto":
        lang = None
    if is_english_only_model(model_id):
        lang = "en"
    t0 = time.time()
    device = (device or _model_device(model)).lower()
    segments: list[dict[str, Any]] = []
    # The decoder runs lazily while `segments_iter` is consumed, so the loop is wrapped with the same handler as
    # the call itself: CUDA/cuBLAS/JIT failures on the GPU get the actionable "switch to CPU" hint either way.
    try:
        segments_iter, info = model.transcribe(str(audio_path), beam_size=beam_size, language=lang, vad_filter=vad,
                                               word_timestamps=False, condition_on_previous_text=False)
        total = float(getattr(info, "duration", 0.0) or 0.0)
        for seg in segments_iter:
            if cancel_check:
                cancel_check({"partial_segments": len(segments)})
            text = (seg.text or "").strip()
            if not text:
                continue
            lp = getattr(seg, "avg_logprob", None)
            ns = getattr(seg, "no_speech_prob", None)
            segments.append({"start": round(float(seg.start), 3), "end": round(float(seg.end), 3), "text": text,
                             "avg_logprob": round(float(lp), 4) if lp is not None else None,
                             "no_speech_prob": round(float(ns), 4) if ns is not None else None})
            if progress:
                progress(min(float(seg.end), total) if total else float(seg.end), total)
    except WorkerError:
        raise
    except Exception as e:  # noqa: BLE001
        raise _transcribe_error(e, device)
    text = " ".join(s["text"] for s in segments).strip()
    elapsed = time.time() - t0
    if not text:
        raise WorkerError(EMPTY_AUDIO, "No speech was detected in the selection.", {"duration_s": total, "elapsed_s": round(elapsed, 3)}, True)
    return {"text": text, "language": getattr(info, "language", lang) or lang or "unknown",
            "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
            "segments": segments, "confidence": transcript_confidence(segments),
            "duration_s": round(total, 3), "elapsed_s": round(elapsed, 3)}


def transcript_confidence(segments: list[dict[str, Any]]) -> float | None:
    """Duration-weighted mean token probability (exp(avg_logprob)) of the decoded segments, 0..1; None when the model
    reported no log-probabilities. A heuristic: below ~0.6 the words deserve a human look before cloning."""
    num = den = 0.0
    for s in segments:
        lp = s.get("avg_logprob")
        if lp is None:
            continue
        w = max(0.05, float(s["end"]) - float(s["start"]))
        num += w * math.exp(min(0.0, float(lp)))
        den += w
    return round(num / den, 3) if den else None
