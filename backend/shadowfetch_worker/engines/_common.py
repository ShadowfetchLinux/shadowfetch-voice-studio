"""Helpers shared by the engine adapters. No torch import at module level (the main worker imports this)."""
from __future__ import annotations

import logging
import random
from pathlib import Path
from typing import Any

from ..protocol import EMPTY_AUDIO, INVALID_PARAMS, WorkerError
from .base import ControlSpec

log = logging.getLogger("engines.common")


def package_version(dist_name: str) -> str:
    """Installed version of a distribution, or 'not installed' (never raises, never imports the package)."""
    try:
        from importlib.metadata import PackageNotFoundError, version
        try:
            return version(dist_name)
        except PackageNotFoundError:
            return "not installed"
    except Exception:  # noqa: BLE001
        return "unknown"


def filter_settings(settings: dict[str, Any] | None, controls: list[ControlSpec]) -> dict[str, Any]:
    """Keep only declared controls, coerce to the declared type and clamp to [min, max]. Unknown keys are dropped."""
    out: dict[str, Any] = {}
    if not settings:
        return out
    by_id = {c.id: c for c in controls}
    for key, raw in settings.items():
        spec = by_id.get(key)
        if spec is None or raw is None:
            continue
        try:
            if spec.type == "bool":
                val: Any = raw if isinstance(raw, bool) else str(raw).lower() in ("1", "true", "yes", "on")
            elif spec.type == "int":
                val = int(round(float(raw)))
            elif spec.type == "float":
                val = float(raw)
            else:  # enum
                val = raw
        except (TypeError, ValueError):
            raise WorkerError(INVALID_PARAMS, f"Setting {key!r} has an invalid value {raw!r}")
        if spec.type in ("int", "float"):
            if spec.min is not None and val < spec.min:
                val = spec.min if spec.type == "float" else int(spec.min)
            if spec.max is not None and val > spec.max:
                val = spec.max if spec.type == "float" else int(spec.max)
        out[key] = val
    return out


def apply_control_defaults(cfg: dict[str, Any], controls: list[ControlSpec]) -> dict[str, Any]:
    """Fill every declared control that the caller omitted with its declared default, so the UI default, the
    engine behaviour and any threshold derived from the value agree (the wrappers would otherwise fall back to the
    checkpoint's own generation_config, e.g. Qwen's max_new_tokens=8192 vs the declared 2048)."""
    for c in controls:
        cfg.setdefault(c.id, c.default)
    return cfg


def prompt_settings(settings: dict[str, Any] | None, controls: list[ControlSpec], prompt_control_ids: list[str] | tuple[str, ...]) -> dict[str, Any]:
    """The subset of settings that shapes a reusable prompt, coerced and defaulted (used for cache identity)."""
    subset = [c for c in controls if c.id in prompt_control_ids]
    return apply_control_defaults(filter_settings(settings, subset), subset)


def intended_device() -> str:
    """Device an engine will be asked to run on. Static, no torch: 'cuda' when an NVIDIA driver is present.
    The live device is reported by engine.health / the load result."""
    import os
    import shutil
    if os.environ.get("SFVS_FORCE_CPU") == "1":
        return "cpu"
    if os.path.exists("/proc/driver/nvidia/version") or os.path.exists("/dev/nvidia0") or shutil.which("nvidia-smi"):
        return "cuda"
    return "cpu"


def prompt_meta_path(cache_path: Path) -> Path:
    return Path(cache_path).with_name(Path(cache_path).name + ".meta.json")


def write_prompt_meta(cache_path: Path, meta: dict[str, Any]) -> None:
    """Sidecar JSON next to a prompt cache (which settings produced it; used to detect stale/ mismatching caches)."""
    import json
    mp = prompt_meta_path(cache_path)
    tmp = mp.with_name(mp.name + ".part")
    tmp.write_text(json.dumps(meta, sort_keys=True, default=str))
    tmp.replace(mp)


def read_prompt_meta(cache_path: Path) -> dict[str, Any] | None:
    import json
    try:
        return json.loads(prompt_meta_path(cache_path).read_text())
    except (OSError, ValueError):
        return None


def apply_seed(seed: int | None) -> int:
    """Seed torch (CPU + every CUDA device) and Python's random. Returns the seed actually used.

    Note: seeds make a run repeatable on the same machine/environment; they are NOT reproducible across
    torch/CUDA versions or GPUs.
    """
    if seed is None:
        seed = random.SystemRandom().randint(0, 2**31 - 1)
    seed = int(seed) & 0xFFFFFFFF
    import torch
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except Exception:  # noqa: BLE001
        pass
    return seed


def write_wav_24(out_path: Path, audio, sample_rate: int) -> float:
    """Write mono float audio as 24-bit PCM WAV. Returns the duration in seconds. Raises EMPTY_AUDIO on no samples."""
    import numpy as np
    import soundfile as sf
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.reshape(-1) if 1 in arr.shape else arr.mean(axis=0)
    if arr.size == 0:
        raise WorkerError(EMPTY_AUDIO, "The engine returned no audio for this text.", {"out_path": str(out_path)})
    if not np.isfinite(arr).all():
        raise WorkerError(EMPTY_AUDIO, "The engine returned non-finite samples (NaN/inf).", {"out_path": str(out_path)})
    peak = float(np.max(np.abs(arr)))
    if peak > 1.0:  # avoid wrap-around when converting to PCM; audio is otherwise untouched
        arr = arr / peak
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.name + ".part")
    sf.write(str(tmp), arr, sample_rate, subtype="PCM_24", format="WAV")
    tmp.replace(out_path)
    return float(arr.shape[0]) / float(sample_rate)


def audio_duration_s(path: Path) -> float:
    import soundfile as sf
    info = sf.info(str(path))
    return float(info.frames) / float(info.samplerate)


def snapshot_revision(model_dir: Path) -> str | None:
    """`<hf cache>/models--Org--Name/snapshots/<sha>` -> sha ; custom dirs -> 'local'."""
    parts = model_dir.resolve().parts
    if len(parts) >= 2 and parts[-2] == "snapshots":
        return parts[-1]
    return "local"


def cuda_sync_and_vram() -> int | None:
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            return int(torch.cuda.memory_allocated())
    except Exception:  # noqa: BLE001
        return None
    return None


def release_cuda() -> None:
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
    except Exception:  # noqa: BLE001
        pass
