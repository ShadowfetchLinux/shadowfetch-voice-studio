"""transcribe.* methods: transcribe.models, transcribe.run (GPU lock taken manually when device == "cuda")."""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from ..models.registry import MODELS
from ..protocol import (INVALID_PARAMS, MODEL_MISSING, NOT_FOUND, OFFLINE_BLOCKED, PERMISSION_DENIED, UNSUPPORTED_FILE,
                        WorkerError)
from ..rpc import Ctx, method
from ..transcribe.whisper import WhisperCache, cut_selection, transcribe
from .models import get_models


def S(ctx: Ctx):
    return ctx.server.state


def _cache(ctx: Ctx) -> WhisperCache:
    st = S(ctx)
    c = st.get("asr_models")
    if c is None:
        c = WhisperCache()
        st["asr_models"] = c
    return c


_FORBIDDEN_PREFIXES = ("/proc", "/sys", "/dev", "/run", "/etc")


def _user_audio_file(path: str) -> Path:
    """Re-validate a shell-picked (or app-managed) input path: absolute, a readable regular file, not a pseudo-filesystem.

    The worker has no list of the roots the shell's file picker allowed, so this mirrors jobs.audio.user_file
    (the same rule every other user-picked audio input goes through) instead of confining to `allowed_roots`.
    """
    if not path or not os.path.isabs(path):
        raise WorkerError(INVALID_PARAMS, "path must be an absolute path", {"path": path})
    p = Path(path)
    try:
        real = p.resolve(strict=True)
    except (OSError, RuntimeError):
        raise WorkerError(NOT_FOUND, f"Audio file not found: {p}", {"path": str(p)}, False)
    if any(str(real) == pre or str(real).startswith(pre + "/") for pre in _FORBIDDEN_PREFIXES):
        raise WorkerError(PERMISSION_DENIED, f"Refusing to read from {real}", {"path": str(real)}, False)
    if not real.is_file():
        raise WorkerError(UNSUPPORTED_FILE, f"Not a regular file: {p}", {"path": str(p)}, False)
    if not os.access(real, os.R_OK):
        raise WorkerError(PERMISSION_DENIED, f"Cannot read {p}", {"path": str(p)}, False)
    return p


@method("transcribe.models")
def transcribe_models(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    mm = get_models(ctx)
    settings = S(ctx)["settings"].value
    out = []
    for mid, spec in MODELS.items():
        if spec["kind"] != "asr":
            continue
        st = mm.state(mid)
        out.append({"id": mid, "repo": spec["repo"], "size_bytes": st.get("size_bytes") or spec.get("approx_size_bytes"),
                    "installed": st["state"] == "installed", "state": st["state"], "device": settings.asr_device,
                    "description": spec.get("description", ""), "license": spec["license"], "default": mid == settings.asr_model,
                    "english_only": mid.endswith(".en")})
    return {"models": out, "default_model": settings.asr_model, "default_device": settings.asr_device}


class RunParams(BaseModel):
    path: str
    start_s: float | None = None
    end_s: float | None = None
    model_id: str | None = None
    language: str | None = None
    device: str | None = None
    beam_size: int = 5
    vad_filter: bool = True


@method("transcribe.run", gpu=False, params=RunParams)
def transcribe_run(ctx: Ctx, p: RunParams) -> dict[str, Any]:
    st = S(ctx)
    settings = st["settings"].value
    paths = st["paths"]
    model_id = p.model_id or settings.asr_model
    device = (p.device or settings.asr_device or "cpu").lower()
    if device not in ("cpu", "cuda"):
        raise WorkerError(INVALID_PARAMS, "device must be 'cpu' or 'cuda'")
    spec = MODELS.get(model_id)
    if spec is None or spec["kind"] != "asr":
        raise WorkerError(INVALID_PARAMS, f"Unknown transcription model {model_id!r}", {"model_id": model_id})
    mm = get_models(ctx)
    try:
        model_dir = mm.resolve_installed_dir(model_id)
    except WorkerError as e:
        if e.code == MODEL_MISSING:
            hint = " Offline mode is on — turn it off before downloading." if mm._offline() else ""
            raise WorkerError(MODEL_MISSING, f"The transcription model {model_id} is not installed. Open Settings → Engines & models "
                              f"and download it ({(spec.get('approx_size_bytes') or 0) / 1e6:.0f} MB).{hint}",
                              {"model_id": model_id, "hint": OFFLINE_BLOCKED if mm._offline() else None}, True)
        raise
    src = _user_audio_file(p.path)
    paths.tmp.mkdir(parents=True, exist_ok=True)
    tmp = paths.tmp / f"asr-{ctx.req_id[:12]}-{int(time.time())}.wav"
    t0 = time.time()
    ctx.progress("decode", "Preparing the selection for transcription")
    cut_selection(src, tmp, p.start_s, p.end_s, ctx=ctx)
    gpu = ctx.server.gpu if device == "cuda" else None
    held = False
    try:
        if gpu is not None:
            gpu.acquire(ctx)   # may raise CANCELLED while queued
            held = True
        ctx.check_cancel()
        ctx.progress("load", f"Loading {model_id} on {device.upper()}")
        model = _cache(ctx).get(model_id, model_dir, device)
        ctx.progress("transcribe", "Transcribing", current=0, total=None)

        def prog(done: float, total: float) -> None:
            ctx.progress("transcribe", "Transcribing", current=int(done), total=int(total) if total else None,
                         detail={"seconds_done": round(done, 2), "seconds_total": round(total, 2) if total else None}, throttle_s=0.5)

        res = transcribe(model, tmp, p.language, model_id, beam_size=p.beam_size, vad=p.vad_filter, progress=prog,
                         cancel_check=ctx.check_cancel, device=device)
    finally:
        if held:
            gpu.release()
        try:
            tmp.unlink()
        except OSError:
            pass
    res.update({"model_id": model_id, "device": device, "elapsed_s": round(time.time() - t0, 3), "path": str(src),
                "start_s": p.start_s, "end_s": p.end_s})
    return res


@method("transcribe.unload")
def transcribe_unload(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    _cache(ctx).unload_all()
    return {"ok": True}
