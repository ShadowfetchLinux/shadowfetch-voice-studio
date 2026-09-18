"""Non-destructive editing: trim, reference preparation, previewable processing, take assembly, loudness-matched copies.

Every function here writes a *new* file and never modifies its input.
"""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import BaseModel, ValidationError

from ..protocol import EMPTY_AUDIO, INVALID_PARAMS, NOT_FOUND, WorkerError, invalid_params
from . import analysis
from .analysis import find_sound_bounds, read_frames, to_mono, write_wav
from .ffmpeg import decode_to_wav, run_ffmpeg

log = logging.getLogger("audio.edit")

MIN_CLIP_S = 0.1
TRIM_THRESHOLD_DBFS = -50.0
TRIM_PAD_MS = 40
FADE_MS = 5.0


def _check_range(start_s: float | None, end_s: float | None) -> None:
    if start_s is not None and start_s < 0:
        raise WorkerError(INVALID_PARAMS, "start_s must be >= 0")
    if start_s is not None and end_s is not None and end_s <= start_s:
        raise WorkerError(INVALID_PARAMS, f"end_s ({end_s}) must be greater than start_s ({start_s})")


def _require_length(data: np.ndarray, sr: int, what: str) -> None:
    if data.shape[0] < MIN_CLIP_S * sr:
        raise WorkerError(EMPTY_AUDIO, f"{what} is shorter than {MIN_CLIP_S:g} s ({data.shape[0] / sr:.3f} s)",
                          {"duration_s": data.shape[0] / sr}, True)


def trim(src: Path, dst: Path, start_s: float, end_s: float, subtype: str = "PCM_24") -> dict[str, Any]:
    """Write `[start_s, end_s)` of `src` to `dst` (channels preserved). EMPTY_AUDIO when the result is <= 0.1 s."""
    src, dst = Path(src), Path(dst)
    _check_range(start_s, end_s)
    if src.resolve() == dst.resolve():
        raise WorkerError(INVALID_PARAMS, "trim never modifies its input: choose a different output path")
    data, sr = read_frames(src, start_s, end_s)
    _require_length(data, sr, "The trimmed clip")
    write_wav(dst, data, sr, subtype)
    return {"path": str(dst), "duration_s": round(data.shape[0] / sr, 6), "sample_rate": sr, "channels": int(data.shape[1])}


def _fit_channels(data: np.ndarray, channels: int) -> np.ndarray:
    """(frames, c) → (frames, channels): average down to mono, duplicate mono up, otherwise take/pad channels."""
    have = data.shape[1]
    if have == channels:
        return data
    if channels == 1:
        return to_mono(data)[:, None]
    if have == 1:
        return np.repeat(data, channels, axis=1)
    if have > channels:
        return data[:, :channels]
    return np.concatenate([data, np.repeat(data[:, -1:], channels - have, axis=1)], axis=1)


def _resample(data: np.ndarray, sr: int, target_sr: int, ctx=None) -> np.ndarray:
    """Resample (frames, channels) float32 through ffmpeg/soxr via a temporary float32 wav pair."""
    if sr == target_sr:
        return data
    with tempfile.TemporaryDirectory(prefix="sfvs-resample-") as d:
        a, b = Path(d) / "in.wav", Path(d) / "out.wav"
        write_wav(a, data, sr, "FLOAT")
        decode_to_wav(a, b, sample_rate=target_sr, channels=data.shape[1], sample_fmt="f32", ctx=ctx)
        out, _ = read_frames(b)
    return out


def normalize_peak(data: np.ndarray, target_dbfs: float) -> tuple[np.ndarray, float]:
    """Scale so the absolute peak sits at `target_dbfs` (up or down). Silence is left alone. Returns (copy, gain_db)."""
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak <= 1e-9:
        return data.copy(), 0.0
    gain = (10.0 ** (target_dbfs / 20.0)) / peak
    return (data * gain).astype(np.float32), round(20.0 * np.log10(gain), 3)


def prepare_reference(working_wav: Path, dst: Path, sample_rate: int, channels: int = 1, start_s: float | None = None,
                      end_s: float | None = None, normalize_peak_dbfs: float | None = None, ctx=None) -> dict[str, Any]:
    """Derive an engine-ready reference: trim → channel fit → soxr resample → optional peak normalisation → PCM_24 wav.

    The working file is never touched; normalisation applies to the copy only. Returns {path, sample_rate, channels,
    duration_s, stats, gain_db}.
    """
    working_wav, dst = Path(working_wav), Path(dst)
    _check_range(start_s, end_s)
    if channels < 1 or channels > 2:
        raise WorkerError(INVALID_PARAMS, "channels must be 1 or 2")
    data, sr = read_frames(working_wav, start_s, end_s)
    _require_length(data, sr, "The selected reference range")
    data = _fit_channels(data, channels)
    data = _resample(data, sr, int(sample_rate), ctx=ctx)
    gain_db = 0.0
    if normalize_peak_dbfs is not None:
        if not -60.0 <= float(normalize_peak_dbfs) <= 0.0:
            raise WorkerError(INVALID_PARAMS, "normalize_peak_dbfs must be between -60 and 0")
        data, gain_db = normalize_peak(data, float(normalize_peak_dbfs))
    write_wav(dst, data, int(sample_rate), "PCM_24")
    return {"path": str(dst), "sample_rate": int(sample_rate), "channels": channels,
            "duration_s": round(data.shape[0] / sample_rate, 6), "stats": analysis.stats(dst), "gain_db": gain_db}


# ---------------------------------------------------------------- processing steps (previewable, applied to copies)
class _NormalizePeak(BaseModel):
    dbfs: float = -3.0


class _TrimSilence(BaseModel):
    threshold_dbfs: float = TRIM_THRESHOLD_DBFS
    pad_ms: float = TRIM_PAD_MS


class _Highpass(BaseModel):
    hz: float = 80.0


class _Gain(BaseModel):
    db: float


PROCESSING_OPS: dict[str, type[BaseModel]] = {"normalize_peak": _NormalizePeak, "trim_silence": _TrimSilence,
                                              "highpass": _Highpass, "gain": _Gain}


def parse_steps(steps: list[dict[str, Any]]) -> list[tuple[str, BaseModel]]:
    """Validate a list of {"op": ..., ...} dicts → [(op, params)]; INVALID_PARAMS for unknown ops or bad values."""
    out = []
    for i, step in enumerate(steps or []):
        if not isinstance(step, dict) or "op" not in step:
            raise WorkerError(INVALID_PARAMS, f"processing step {i} must be an object with an 'op' key")
        op = str(step["op"])
        model = PROCESSING_OPS.get(op)
        if model is None:
            raise WorkerError(INVALID_PARAMS, f"Unknown processing op {op!r}; supported: {sorted(PROCESSING_OPS)}")
        try:
            out.append((op, model.model_validate({k: v for k, v in step.items() if k != "op"})))
        except ValidationError as ve:
            raise invalid_params(ve)
    return out


def trim_silence(data: np.ndarray, sr: int, threshold_dbfs: float = TRIM_THRESHOLD_DBFS, pad_ms: float = TRIM_PAD_MS) -> tuple[np.ndarray, int, int]:
    """Cut leading/trailing silence conservatively, keeping `pad_ms` of the original silence on each side.

    Returns (trimmed copy, samples removed at the start, samples removed at the end). A fully silent signal is returned
    unchanged (nothing to anchor a trim on).
    """
    mono = to_mono(data)
    bounds = find_sound_bounds(mono, sr, threshold_dbfs)
    if bounds is None:
        return data.copy(), 0, 0
    pad = int(round(sr * pad_ms / 1000.0))
    a = max(0, bounds[0] - pad)
    b = min(len(mono), bounds[1] + pad)
    return data[a:b].copy(), a, len(mono) - b


def apply_fades(data: np.ndarray, sr: int, fade_ms: float = FADE_MS) -> np.ndarray:
    """Linear fade in/out of `fade_ms` (never longer than half the clip) applied in place; returns `data`."""
    n = data.shape[0]
    k = min(int(round(sr * fade_ms / 1000.0)), n // 2)
    if k > 0:
        ramp = np.linspace(0.0, 1.0, k, endpoint=False, dtype=np.float32)
        shape = (k,) + (1,) * (data.ndim - 1)
        data[:k] *= ramp.reshape(shape)
        data[n - k:] *= ramp[::-1].reshape(shape)
    return data


def _highpass(data: np.ndarray, sr: int, hz: float, ctx=None) -> np.ndarray:
    with tempfile.TemporaryDirectory(prefix="sfvs-hp-") as d:
        a, b = Path(d) / "in.wav", Path(d) / "out.wav"
        write_wav(a, data, sr, "FLOAT")
        run_ffmpeg(["-y", "-i", str(a), "-af", f"highpass=f={float(hz)}", "-c:a", "pcm_f32le", "-f", "wav", str(b)], ctx=ctx)
        out, _ = read_frames(b)
    return out


def apply_processing(src: Path, dst: Path, steps: list[dict[str, Any]], subtype: str = "FLOAT", ctx=None) -> dict[str, Any]:
    """Apply ordered optional steps to a COPY of `src` and write it to `dst` (float32 wav by default, so nothing clips).

    Ops: normalize_peak{dbfs}, trim_silence{threshold_dbfs,pad_ms}, highpass{hz} (ffmpeg), gain{db}. Unknown → INVALID_PARAMS.
    Returns {path, duration_s, sample_rate, channels, steps:[{op, ...applied values}]}.
    """
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise WorkerError(INVALID_PARAMS, "apply_processing never modifies its input: choose a different output path")
    parsed = parse_steps(steps)
    data, sr = read_frames(src)
    applied: list[dict[str, Any]] = []
    for op, p in parsed:
        if op == "normalize_peak":
            data, gain_db = normalize_peak(data, p.dbfs)               # type: ignore[attr-defined]
            applied.append({"op": op, "dbfs": p.dbfs, "gain_db": gain_db})  # type: ignore[attr-defined]
        elif op == "trim_silence":
            data, head, tail = trim_silence(data, sr, p.threshold_dbfs, p.pad_ms)   # type: ignore[attr-defined]
            applied.append({"op": op, "threshold_dbfs": p.threshold_dbfs, "pad_ms": p.pad_ms,   # type: ignore[attr-defined]
                            "removed_leading_s": round(head / sr, 4), "removed_trailing_s": round(tail / sr, 4)})
        elif op == "highpass":
            if not 10.0 <= p.hz <= sr / 2:                              # type: ignore[attr-defined]
                raise WorkerError(INVALID_PARAMS, f"highpass hz must be between 10 and {sr / 2:g}")
            data = _highpass(data, sr, p.hz, ctx=ctx)                   # type: ignore[attr-defined]
            applied.append({"op": op, "hz": p.hz})                      # type: ignore[attr-defined]
        elif op == "gain":
            if not -60.0 <= p.db <= 40.0:                               # type: ignore[attr-defined]
                raise WorkerError(INVALID_PARAMS, "gain db must be between -60 and +40")
            data = (data * (10.0 ** (p.db / 20.0))).astype(np.float32)  # type: ignore[attr-defined]
            applied.append({"op": op, "db": p.db})                      # type: ignore[attr-defined]
        if data.shape[0] == 0:
            raise WorkerError(EMPTY_AUDIO, f"Nothing left after step {op!r}", {"steps": applied}, True)
    write_wav(dst, data, sr, subtype)
    return {"path": str(dst), "duration_s": round(data.shape[0] / sr, 6), "sample_rate": sr, "channels": int(data.shape[1]),
            "steps": applied}


# ---------------------------------------------------------------- assembly
def assemble(takes: list[dict[str, Any]], out_path: Path, sentence_pause_ms: int = 250, paragraph_pause_ms: int = 600,
             sample_rate: int | None = None, ctx=None) -> dict[str, Any]:
    """Concatenate selected takes into a single PCM_24 master.

    takes = [{"path", "paragraph", "index"}] in playback order. Per take: conservative silence trim (-50 dBFS, 40 ms pad
    kept), 5 ms fades, resample to the target rate when needed (ffmpeg/soxr). A paragraph change inserts
    `paragraph_pause_ms` of silence, otherwise `sentence_pause_ms`. Pure concatenation — audio never overlaps.
    Returns {path, duration_s, sample_rate, segments_used, segments:[{index, paragraph, start_s, end_s, …}], warnings}.
    """
    if not takes:
        raise WorkerError(INVALID_PARAMS, "assemble needs at least one take")
    if sentence_pause_ms < 0 or paragraph_pause_ms < 0 or sentence_pause_ms > 10_000 or paragraph_pause_ms > 10_000:
        raise WorkerError(INVALID_PARAMS, "pauses must be between 0 and 10000 ms")
    out_path = Path(out_path)
    for i, t in enumerate(takes):
        p = Path(str(t.get("path", "")))
        if not p.is_file():
            raise WorkerError(NOT_FOUND, f"Take {i} (segment {t.get('index')}) is missing: {p}", {"path": str(p), "index": t.get("index")}, True)
        if out_path.exists() and p.resolve() == out_path.resolve():
            raise WorkerError(INVALID_PARAMS, "A take cannot also be the assembly output")
    chunks: list[np.ndarray] = []
    segments: list[dict[str, Any]] = []
    warnings: list[str] = []
    target_sr = int(sample_rate) if sample_rate else None
    pos = 0
    prev_par: int | None = None
    total = len(takes)
    for i, t in enumerate(takes):
        if ctx:
            ctx.check_cancel({"segments_done": i})
            ctx.progress("assemble", f"Assembling segment {i + 1} of {total}", i + 1, total, throttle_s=0.2)
        data, sr = read_frames(Path(t["path"]))
        mono = to_mono(data)
        if target_sr is None:
            target_sr = sr
        if sr != target_sr:
            mono = to_mono(_resample(mono[:, None], sr, target_sr, ctx=ctx))
            warnings.append(f"segment {t.get('index')}: resampled {sr} → {target_sr} Hz")
        trimmed, head, tail = trim_silence(mono, target_sr)
        if head == 0 and tail == 0 and find_sound_bounds(trimmed, target_sr) is None:
            warnings.append(f"segment {t.get('index')}: take is silent (under {TRIM_THRESHOLD_DBFS:g} dBFS); kept as is")
        apply_fades(trimmed, target_sr)
        par = int(t.get("paragraph", 0))
        pause_ms = 0
        if i > 0:
            pause_ms = paragraph_pause_ms if (prev_par is not None and par != prev_par) else sentence_pause_ms
            gap = int(round(target_sr * pause_ms / 1000.0))
            if gap:
                chunks.append(np.zeros(gap, dtype=np.float32))
                pos += gap
        chunks.append(trimmed)
        segments.append({"index": t.get("index", i), "paragraph": par, "take_path": str(t["path"]),
                         "start_s": round(pos / target_sr, 6), "end_s": round((pos + len(trimmed)) / target_sr, 6),
                         "pause_before_ms": pause_ms, "trimmed_leading_s": round(head / target_sr, 4),
                         "trimmed_trailing_s": round(tail / target_sr, 4)})
        pos += len(trimmed)
        prev_par = par
    master = np.concatenate(chunks)
    peak = float(np.max(np.abs(master))) if master.size else 0.0
    if peak > 1.0:
        warnings.append(f"peak {20 * np.log10(peak):+.2f} dBFS exceeds full scale; the 24-bit master is clipped at 0 dBFS")
    write_wav(out_path, master, target_sr, "PCM_24")   # type: ignore[arg-type]
    return {"path": str(out_path), "duration_s": round(len(master) / target_sr, 6), "sample_rate": target_sr,   # type: ignore[operator]
            "segments_used": len(segments), "segments": segments, "warnings": warnings}


def loudness_match_copy(src: Path, dst: Path, target_lufs: float = -18.0, ctx=None) -> dict[str, Any]:
    """Gain-only copy (no limiting, no compression) whose integrated loudness matches `target_lufs`.

    PREVIEW ONLY: meant for A/B auditioning of engines at equal loudness. Written as float32 so a large positive gain is
    not clipped in the file (it may still clip on playback; `peak_dbfs_after` says so).
    """
    from .export import measure_loudness
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve():
        raise WorkerError(INVALID_PARAMS, "loudness_match_copy never modifies its input")
    m = measure_loudness(src, ctx=ctx)
    data, sr = read_frames(src)
    if m["integrated_lufs"] is None:
        write_wav(dst, data, sr, "FLOAT")
        return {"path": str(dst), "measured_lufs": None, "target_lufs": target_lufs, "gain_db": 0.0, "preview_only": True,
                "warning": "source is silent; copied without gain", "peak_dbfs_after": analysis.dbfs(float(np.max(np.abs(data))))}
    gain_db = float(target_lufs) - float(m["integrated_lufs"])
    out = (data * (10.0 ** (gain_db / 20.0))).astype(np.float32)
    write_wav(dst, out, sr, "FLOAT")
    return {"path": str(dst), "measured_lufs": m["integrated_lufs"], "target_lufs": target_lufs, "gain_db": round(gain_db, 3),
            "preview_only": True, "peak_dbfs_after": analysis.dbfs(float(np.max(np.abs(out))))}
