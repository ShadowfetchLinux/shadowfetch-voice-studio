"""Reading/writing audio with soundfile, waveform peaks (cached) and measured statistics.

Everything reported here is *measured* from samples. The `warnings` in `stats()` are simple threshold heuristics and are
labelled as such — this module does not claim to detect noise, echo or multiple speakers.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from ..protocol import CORRUPT_FILE, EMPTY_AUDIO, INVALID_PARAMS, NOT_FOUND, UNSUPPORTED_FILE, WorkerError

log = logging.getLogger("audio.analysis")

SILENCE_DBFS = -50.0          # window RMS below this counts as silence
SILENCE_WINDOW_MS = 20.0
CLIP_LEVEL = 0.999
DB_FLOOR = -120.0             # reported instead of -inf for digital silence
PEAK_BLOCK_FRAMES = 1 << 20


def dbfs(x: float) -> float:
    """Linear amplitude → dBFS, floored at DB_FLOOR (JSON cannot carry -inf)."""
    return round(20.0 * math.log10(x), 2) if x > 0 else DB_FLOOR


def _open(path: Path) -> sf.SoundFile:
    path = Path(path)
    if not path.is_file():
        raise WorkerError(NOT_FOUND, f"File not found: {path}", {"path": str(path)}, False)
    try:
        return sf.SoundFile(str(path))
    except (sf.LibsndfileError, RuntimeError, OSError) as e:
        raise _NotSoundfile(str(e))


class _NotSoundfile(Exception):
    """libsndfile cannot open the file; caller may fall back to ffmpeg."""


def _decoded_copy(path: Path) -> tuple[Path, tempfile.TemporaryDirectory]:
    """Decode a non-libsndfile format (aac/m4a/…) to a temporary float32 wav at the native rate and channel count."""
    from .ffmpeg import decode_to_wav, probe
    info = probe(path)   # raises UNSUPPORTED_FILE / CORRUPT_FILE with the real reason
    tmpdir = tempfile.TemporaryDirectory(prefix="sfvs-decode-")
    out = Path(tmpdir.name) / "decoded.wav"
    decode_to_wav(path, out, sample_rate=None, channels=info["channels"], sample_fmt="f32")
    return out, tmpdir


def read_frames(path: Path, start_s: float | None = None, end_s: float | None = None) -> tuple[np.ndarray, int]:
    """Read `[start_s, end_s)` as float32 shaped (frames, channels) plus the sample rate.

    Falls back to an ffmpeg decode for formats libsndfile cannot open. EMPTY_AUDIO when the range is empty.
    """
    path = Path(path)
    tmp = None
    try:
        try:
            f = _open(path)
        except _NotSoundfile as first:
            try:
                decoded, tmp = _decoded_copy(path)
                f = _open(decoded)
            except _NotSoundfile:
                raise WorkerError(CORRUPT_FILE, f"Cannot decode {path.name}: {first}", {"path": str(path)}, False)
        with f:
            sr, total = f.samplerate, f.frames
            a = 0 if start_s is None else max(0, int(round(float(start_s) * sr)))
            b = total if end_s is None else min(total, int(round(float(end_s) * sr)))
            if a >= b:
                raise WorkerError(EMPTY_AUDIO, f"The selected range is empty ({start_s}–{end_s} s of {total / sr:.2f} s)",
                                  {"path": str(path), "start_s": start_s, "end_s": end_s, "duration_s": total / sr}, True)
            f.seek(a)
            data = f.read(b - a, dtype="float32", always_2d=True)
        if data.shape[0] == 0:
            raise WorkerError(EMPTY_AUDIO, f"{path.name} contains no samples", {"path": str(path)}, False)
        return data, sr
    finally:
        if tmp is not None:
            tmp.cleanup()


def read_audio(path: Path, start_s: float | None = None, end_s: float | None = None) -> tuple[np.ndarray, int]:
    """Read audio as mono float32 (channels averaged) → (samples, sample_rate)."""
    data, sr = read_frames(path, start_s, end_s)
    return to_mono(data), sr


def to_mono(data: np.ndarray) -> np.ndarray:
    """(frames, channels) → (frames,) float32 by averaging channels; 1-D input passes through."""
    if data.ndim == 1:
        return data.astype(np.float32, copy=False)
    return data.mean(axis=1, dtype=np.float32) if data.shape[1] > 1 else data[:, 0].astype(np.float32, copy=False)


def write_wav(path: Path, data: np.ndarray, sr: int, subtype: str = "PCM_24") -> None:
    """Write a WAV atomically (tmp + os.replace). PCM subtypes are clipped to ±1.0 so libsndfile never wraps around."""
    path = Path(path)
    if data.ndim not in (1, 2) or data.shape[0] == 0:
        raise WorkerError(EMPTY_AUDIO, "Refusing to write an empty audio file", {"path": str(path)}, False)
    if not np.all(np.isfinite(data)):
        raise WorkerError(CORRUPT_FILE, "Refusing to write non-finite samples", {"path": str(path)}, False)
    out = data if subtype.upper() in ("FLOAT", "DOUBLE") else np.clip(data, -1.0, 1.0)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        sf.write(str(tmp), out, int(sr), format="WAV", subtype=subtype)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------- peaks
def _peaks_key(path: Path, points: int) -> str:
    st = path.stat()
    return hashlib.sha1(f"{path.resolve()}|{st.st_mtime_ns}|{st.st_size}|{points}".encode()).hexdigest()


def peaks(path: Path, points: int = 2000, cache_dir: Path | None = None) -> dict[str, Any]:
    """Min/max envelope with `points` buckets → {points, duration_s, sample_rate, peaks:[[min,max],…]}.

    Streams the file in blocks (long files are never loaded whole). Cached as JSON in `cache_dir`, keyed by
    sha1(path + mtime + size + points), so an edited file is never served a stale envelope.
    """
    path = Path(path)
    if points < 1 or points > 100_000:
        raise WorkerError(INVALID_PARAMS, "points must be between 1 and 100000")
    if not path.is_file():
        raise WorkerError(NOT_FOUND, f"File not found: {path}", {"path": str(path)}, False)
    cache_file = (Path(cache_dir) / f"{_peaks_key(path, points)}.json") if cache_dir else None
    if cache_file and cache_file.is_file():
        try:
            return json.loads(cache_file.read_text())
        except (OSError, ValueError):
            pass
    result = _compute_peaks(path, points)
    if cache_file:
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache_file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(result, separators=(",", ":")))
            os.replace(tmp, cache_file)
        except OSError as e:
            log.warning("could not write peaks cache: %s", e)
    return result


def _compute_peaks(path: Path, points: int) -> dict[str, Any]:
    tmp = None
    try:
        try:
            f = _open(path)
        except _NotSoundfile:
            decoded, tmp = _decoded_copy(path)
            f = _open(decoded)
        with f:
            n, sr = f.frames, f.samplerate
            if n <= 0:
                raise WorkerError(EMPTY_AUDIO, f"{path.name} contains no samples", {"path": str(path)}, False)
            pts = max(1, min(points, n))
            edges = np.linspace(0, n, pts + 1).astype(np.int64)
            mins = np.full(pts, np.inf, dtype=np.float32)
            maxs = np.full(pts, -np.inf, dtype=np.float32)
            pos = 0
            for block in f.blocks(blocksize=PEAK_BLOCK_FRAMES, dtype="float32", always_2d=True):
                mono = to_mono(block)
                m = len(mono)
                if m == 0:
                    continue
                first = int(np.searchsorted(edges, pos, side="right")) - 1
                last = int(np.searchsorted(edges, pos + m - 1, side="right")) - 1
                local = np.clip(edges[first:last + 1] - pos, 0, m - 1)
                mins[first:last + 1] = np.minimum(mins[first:last + 1], np.minimum.reduceat(mono, local))
                maxs[first:last + 1] = np.maximum(maxs[first:last + 1], np.maximum.reduceat(mono, local))
                pos += m
        mins[~np.isfinite(mins)] = 0.0
        maxs[~np.isfinite(maxs)] = 0.0
        pairs = np.stack([mins, maxs], axis=1).round(4).tolist()
        return {"points": pts, "duration_s": round(n / sr, 6), "sample_rate": sr, "peaks": pairs}
    finally:
        if tmp is not None:
            tmp.cleanup()


# ---------------------------------------------------------------- silence / stats
def window_rms_db(x: np.ndarray, sr: int, window_ms: float = SILENCE_WINDOW_MS) -> np.ndarray:
    """RMS in dBFS of consecutive non-overlapping windows (the last partial window is included)."""
    w = max(1, int(round(sr * window_ms / 1000.0)))
    n = len(x)
    count = max(1, math.ceil(n / w))
    padded = np.zeros(count * w, dtype=np.float64)
    padded[:n] = x
    sq = padded.reshape(count, w) ** 2
    # the last window may be partial: divide by the real number of samples it holds
    lengths = np.full(count, w, dtype=np.float64)
    lengths[-1] = n - (count - 1) * w
    rms = np.sqrt(sq.sum(axis=1) / lengths)
    with np.errstate(divide="ignore"):
        db = 20.0 * np.log10(np.maximum(rms, 1e-12))
    return np.maximum(db, DB_FLOOR)


def find_sound_bounds(x: np.ndarray, sr: int, threshold_dbfs: float = SILENCE_DBFS, window_ms: float = SILENCE_WINDOW_MS,
                      hop_ms: float = 5.0) -> tuple[int, int] | None:
    """Sample-accurate `(first_sound, end_of_last_sound)` or None when the whole signal is under the threshold.

    A sliding RMS window (window_ms, hop_ms) locates the first/last windows above the threshold; the boundary is then
    refined to the first/last sample inside those windows whose magnitude exceeds the threshold amplitude.
    """
    n = len(x)
    if n == 0:
        return None
    w = max(1, int(round(sr * window_ms / 1000.0)))
    h = max(1, int(round(sr * hop_ms / 1000.0)))
    amp = 10.0 ** (threshold_dbfs / 20.0)
    x64 = x.astype(np.float64, copy=False)
    csum = np.concatenate([[0.0], np.cumsum(x64 * x64)])
    starts = np.arange(0, max(1, n - w + 1), h)
    ends = np.minimum(starts + w, n)
    rms = np.sqrt((csum[ends] - csum[starts]) / np.maximum(ends - starts, 1))
    loud = np.flatnonzero(rms >= amp)
    if len(loud) == 0:
        return None
    s0, e0 = int(starts[loud[0]]), int(ends[loud[0]])
    s1, e1 = int(starts[loud[-1]]), int(ends[loud[-1]])
    above = np.flatnonzero(np.abs(x64[s0:e0]) >= amp)
    first = s0 + int(above[0]) if len(above) else s0
    above = np.flatnonzero(np.abs(x64[s1:e1]) >= amp)
    last = s1 + int(above[-1]) + 1 if len(above) else e1
    return first, max(last, first + 1)


def stats(path: Path, start_s: float | None = None, end_s: float | None = None) -> dict[str, Any]:
    """Measured statistics of a file (or a range of it) plus threshold-based heuristic warnings."""
    path = Path(path)
    data, sr = read_frames(path, start_s, end_s)
    frames, channels = data.shape
    mono = to_mono(data)
    duration = frames / sr
    peak = float(np.max(np.abs(data))) if frames else 0.0
    rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2))) if frames else 0.0
    clipping = int(np.count_nonzero(np.abs(data) >= CLIP_LEVEL))
    dc = float(np.mean(mono, dtype=np.float64))
    win_db = window_rms_db(mono, sr)
    silent = win_db < SILENCE_DBFS
    win_s = SILENCE_WINDOW_MS / 1000.0
    total_windows = len(silent)
    if silent.all():
        leading = trailing = duration
    else:
        loud_idx = np.flatnonzero(~silent)
        leading = min(duration, float(loud_idx[0]) * win_s)
        trailing = min(duration, float(total_windows - 1 - loud_idx[-1]) * win_s)
    ratio = float(np.count_nonzero(silent)) / total_windows if total_windows else 1.0

    warnings: list[dict[str, Any]] = []

    def warn(code: str, message: str) -> None:
        warnings.append({"code": code, "message": message, "heuristic": True})

    if duration < 3.0:
        warn("TOO_SHORT", f"Only {duration:.1f} s of audio; most engines want at least 3 s of reference speech.")
    if peak > 0 and dbfs(peak) < -30.0:
        warn("TOO_QUIET", f"Peak level is {dbfs(peak):.1f} dBFS (below -30 dBFS). Check the input gain or normalize the copy.")
    if clipping >= 3:
        warn("CLIPPING", f"{clipping} samples are at or above {CLIP_LEVEL:g} full scale; the recording is probably clipped.")
    if ratio > 0.6:
        warn("MOSTLY_SILENT", f"{ratio * 100:.0f}% of the 20 ms windows are under {SILENCE_DBFS:g} dBFS; trim the silence or re-record.")
    if abs(dc) > 0.02:
        warn("DC_OFFSET", f"Mean sample value is {dc:+.3f}; a DC offset suggests a hardware/interface problem (a high-pass filter helps).")
    if sr < 16000:
        warn("LOW_SAMPLE_RATE", f"Sample rate is {sr} Hz (below 16 kHz); speech detail above {sr // 2} Hz is missing.")
    return {
        "duration_s": round(duration, 6), "sample_rate": sr, "channels": channels,
        "peak_dbfs": dbfs(peak), "rms_dbfs": dbfs(rms), "clipping_samples": clipping,
        "leading_silence_s": round(leading, 3), "trailing_silence_s": round(trailing, 3), "silence_ratio": round(ratio, 4),
        "dc_offset": round(dc, 5), "warnings": warnings,
    }
