"""Reading/writing audio with soundfile, waveform peaks (cached) and measured statistics.

Everything reported here is *measured* from samples. The `warnings` in `stats()` are simple threshold heuristics and are
labelled as such — this module does not claim to detect noise, echo or multiple speakers. Long files are processed in
blocks (peaks/stats never load a whole hour of audio into memory).
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import soundfile as sf

from ..protocol import CORRUPT_FILE, EMPTY_AUDIO, INVALID_PARAMS, NOT_FOUND, WorkerError

log = logging.getLogger("audio.analysis")

SILENCE_DBFS = -50.0          # window RMS below this counts as silence
SILENCE_WINDOW_MS = 20.0
CLIP_LEVEL = 0.999
DB_FLOOR = -120.0             # reported instead of -inf for digital silence
PEAK_BLOCK_FRAMES = 1 << 20
STATS_WINDOWS_PER_BLOCK = 1000


def dbfs(x: float) -> float:
    """Linear amplitude → dBFS, floored at DB_FLOOR (JSON cannot carry -inf)."""
    return round(20.0 * math.log10(x), 2) if x > 0 else DB_FLOOR


class _NotSoundfile(Exception):
    """libsndfile cannot open the file; caller may fall back to ffmpeg."""


def _open(path: Path) -> sf.SoundFile:
    path = Path(path)
    if not path.is_file():
        raise WorkerError(NOT_FOUND, f"File not found: {path}", {"path": str(path)}, False)
    try:
        return sf.SoundFile(str(path))
    except (sf.LibsndfileError, RuntimeError, OSError) as e:
        raise _NotSoundfile(str(e))


def _decoded_copy(path: Path) -> tuple[Path, tempfile.TemporaryDirectory]:
    """Decode a non-libsndfile format (aac/m4a/…) to a temporary float32 wav at the native rate and channel count."""
    from .ffmpeg import decode_to_wav, probe
    info = probe(path)   # raises UNSUPPORTED_FILE / CORRUPT_FILE with the real reason
    tmpdir = tempfile.TemporaryDirectory(prefix="sfvs-decode-")
    out = Path(tmpdir.name) / "decoded.wav"
    decode_to_wav(path, out, sample_rate=None, channels=info["channels"], sample_fmt="f32")
    return out, tmpdir


@contextmanager
def opened(path: Path) -> Iterator[sf.SoundFile]:
    """Open any audio file for reading: soundfile directly, or through a temporary ffmpeg decode for other formats."""
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
            if f.frames <= 0:
                raise WorkerError(EMPTY_AUDIO, f"{path.name} contains no samples", {"path": str(path)}, False)
            yield f
    finally:
        if tmp is not None:
            tmp.cleanup()


def frame_range(f: sf.SoundFile, start_s: float | None, end_s: float | None) -> tuple[int, int]:
    """Clamp `[start_s, end_s)` to the file → (first_frame, end_frame); EMPTY_AUDIO when nothing is selected."""
    sr, total = f.samplerate, f.frames
    a = 0 if start_s is None else max(0, int(round(float(start_s) * sr)))
    b = total if end_s is None else min(total, int(round(float(end_s) * sr)))
    if a >= b:
        raise WorkerError(EMPTY_AUDIO, f"The selected range is empty ({start_s}–{end_s} s of {total / sr:.2f} s)",
                          {"start_s": start_s, "end_s": end_s, "duration_s": total / sr}, True)
    return a, b


def iter_blocks(f: sf.SoundFile, a: int, b: int, blocksize: int) -> Iterator[np.ndarray]:
    """Yield float32 (frames, channels) blocks covering frames `[a, b)` of an open file."""
    f.seek(a)
    remaining = b - a
    while remaining > 0:
        block = f.read(min(blocksize, remaining), dtype="float32", always_2d=True)
        if len(block) == 0:
            break
        remaining -= len(block)
        yield block


def read_frames(path: Path, start_s: float | None = None, end_s: float | None = None) -> tuple[np.ndarray, int]:
    """Read `[start_s, end_s)` as float32 shaped (frames, channels) plus the sample rate."""
    with opened(path) as f:
        a, b = frame_range(f, start_s, end_s)
        f.seek(a)
        data = f.read(b - a, dtype="float32", always_2d=True)
        sr = f.samplerate
    if data.shape[0] == 0:
        raise WorkerError(EMPTY_AUDIO, f"{Path(path).name} contains no samples", {"path": str(path)}, False)
    return data, sr


def read_audio(path: Path, start_s: float | None = None, end_s: float | None = None) -> tuple[np.ndarray, int]:
    """Read audio as mono float32 (channels averaged) → (samples, sample_rate)."""
    data, sr = read_frames(path, start_s, end_s)
    return to_mono(data), sr


def to_mono(data: np.ndarray) -> np.ndarray:
    """(frames, channels) → (frames,) float32 by averaging channels; 1-D input passes through."""
    if data.ndim == 1:
        return data.astype(np.float32, copy=False)
    return data.mean(axis=1, dtype=np.float32) if data.shape[1] > 1 else data[:, 0].astype(np.float32, copy=False)


def _tmp_name(path: Path) -> Path:
    return path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.tmp")


def write_wav(path: Path, data: np.ndarray, sr: int, subtype: str = "PCM_24") -> None:
    """Write a WAV atomically (tmp + os.replace). PCM subtypes are clipped to ±1.0 so libsndfile never wraps around."""
    path = Path(path)
    if data.ndim not in (1, 2) or data.shape[0] == 0:
        raise WorkerError(EMPTY_AUDIO, "Refusing to write an empty audio file", {"path": str(path)}, False)
    if not np.all(np.isfinite(data)):
        raise WorkerError(CORRUPT_FILE, "Refusing to write non-finite samples", {"path": str(path)}, False)
    out = data if subtype.upper() in ("FLOAT", "DOUBLE") else np.clip(data, -1.0, 1.0)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_name(path)
    try:
        sf.write(str(tmp), out, int(sr), format="WAV", subtype=subtype)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def copy_range_wav(src: Path, dst: Path, start_s: float | None, end_s: float | None, subtype: str = "PCM_24",
                   blocksize: int = PEAK_BLOCK_FRAMES) -> dict[str, Any]:
    """Stream `[start_s, end_s)` of `src` into a new WAV at `dst` (channels preserved, atomic). Returns {frames, sample_rate, channels}."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_name(dst)
    clip = subtype.upper() not in ("FLOAT", "DOUBLE")
    frames = 0
    try:
        with opened(src) as f:
            a, b = frame_range(f, start_s, end_s)
            sr, channels = f.samplerate, f.channels
            with sf.SoundFile(str(tmp), "w", samplerate=sr, channels=channels, format="WAV", subtype=subtype) as out:
                for block in iter_blocks(f, a, b, blocksize):
                    out.write(np.clip(block, -1.0, 1.0) if clip else block)
                    frames += len(block)
        if frames == 0:
            raise WorkerError(EMPTY_AUDIO, "The selected range contains no samples", {"path": str(src)}, True)
        os.replace(tmp, dst)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return {"frames": frames, "sample_rate": sr, "channels": channels}


# ---------------------------------------------------------------- peaks
def peaks_cache_file(path: Path, points: int, cache_dir: Path) -> Path:
    """Cache location for `peaks(path, points)`: keyed by sha1(path + mtime + size + points)."""
    path = Path(path)
    st = path.stat()
    key = hashlib.sha1(f"{path.resolve()}|{st.st_mtime_ns}|{st.st_size}|{points}".encode()).hexdigest()
    return Path(cache_dir) / f"{key}.json"


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
    cache_file = peaks_cache_file(path, points, cache_dir) if cache_dir else None
    if cache_file and cache_file.is_file():
        try:
            return json.loads(cache_file.read_text())
        except (OSError, ValueError):
            pass
    result = _compute_peaks(path, points)
    if cache_file:
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = _tmp_name(cache_file)
            tmp.write_text(json.dumps(result, separators=(",", ":")))
            os.replace(tmp, cache_file)
        except OSError as e:
            log.warning("could not write peaks cache: %s", e)
    return result


def _compute_peaks(path: Path, points: int) -> dict[str, Any]:
    with opened(path) as f:
        n, sr = f.frames, f.samplerate
        pts = max(1, min(points, n))
        edges = np.linspace(0, n, pts + 1).astype(np.int64)
        mins = np.full(pts, np.inf, dtype=np.float32)
        maxs = np.full(pts, -np.inf, dtype=np.float32)
        pos = 0
        for block in iter_blocks(f, 0, n, PEAK_BLOCK_FRAMES):
            mono = to_mono(block)
            m = len(mono)
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


# ---------------------------------------------------------------- silence / stats
def window_rms_db(x: np.ndarray, sr: int, window_ms: float = SILENCE_WINDOW_MS) -> np.ndarray:
    """RMS in dBFS of consecutive non-overlapping windows (the last partial window is included)."""
    w = max(1, int(round(sr * window_ms / 1000.0)))
    n = len(x)
    count = max(1, math.ceil(n / w))
    padded = np.zeros(count * w, dtype=np.float64)
    padded[:n] = x
    sq = padded.reshape(count, w) ** 2
    lengths = np.full(count, w, dtype=np.float64)     # the last window may be partial
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
    """Measured statistics of a file (or a range of it) plus threshold-based heuristic warnings. Streams in blocks."""
    path = Path(path)
    peak = sumsq = dcsum = 0.0
    frames = clipping = 0
    win_parts: list[np.ndarray] = []
    with opened(path) as f:
        sr, channels = f.samplerate, f.channels
        a, b = frame_range(f, start_s, end_s)
        w = max(1, int(round(sr * SILENCE_WINDOW_MS / 1000.0)))
        for data in iter_blocks(f, a, b, w * STATS_WINDOWS_PER_BLOCK):     # block = whole windows → windows stay aligned
            mono = to_mono(data).astype(np.float64)
            peak = max(peak, float(np.max(np.abs(data))))
            sumsq += float(np.sum(mono * mono))
            dcsum += float(np.sum(mono))
            clipping += int(np.count_nonzero(np.abs(data) >= CLIP_LEVEL))
            frames += len(mono)
            win_parts.append(window_rms_db(mono, sr))
    duration = frames / sr
    rms = math.sqrt(sumsq / frames) if frames else 0.0
    dc = dcsum / frames if frames else 0.0
    win_db = np.concatenate(win_parts) if win_parts else np.array([DB_FLOOR])
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


# ---------------------------------------------------------------- reference suggestion
REF_WINDOW_MS = 20.0
REF_MIN_PAUSE_S = 0.2          # a gap this long between words is a phrase boundary (a safe place to cut)
REF_EDGE_PAD_S = 0.15          # room kept before the first / after the last word of a selection
REF_MAX_SCAN_S = 300.0         # a reference is ~15 s; the first five minutes are plenty to find one


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index runs where `mask` is True."""
    if len(mask) == 0:
        return []
    m = np.concatenate([[False], mask.astype(bool), [False]])
    d = np.diff(m.astype(np.int8))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    return list(zip(starts.tolist(), ends.tolist()))


def suggest_reference_range(x: np.ndarray, sr: int, min_s: float, max_s: float, recommended: tuple[float, float]) -> dict[str, Any]:
    """Pick a clean reference section from mono samples `x`: whole phrases (cut only inside pauses, with a little
    room before the first and after the last word), mostly active speech, steady level, no clipping, and a length
    inside the engine's recommended window when the audio allows it.

    Heuristic and measured only — it does not detect speakers or noise types. `reliable` is False when no section
    with clean edges and enough speech exists; the caller should then let the user choose the range by hand.
    """
    lo, hi = float(recommended[0] or 8.0), float(recommended[1] or 15.0)
    if hi <= 0:
        lo, hi = 8.0, 15.0
    allowed_lo = max(float(min_s) + 0.25, 1.0)
    allowed_hi = max(allowed_lo, float(max_s) - 0.05)
    target = (lo + hi) / 2.0
    w = max(1, int(round(sr * REF_WINDOW_MS / 1000.0)))
    ws = w / sr
    n = len(x)
    total_s = n / sr if sr else 0.0
    count = max(1, math.ceil(n / w))
    padded = np.zeros(count * w, dtype=np.float32)
    padded[:n] = x[:n]
    frames = padded.reshape(count, w)
    lengths = np.full(count, w, dtype=np.float64)
    lengths[-1] = max(1, n - (count - 1) * w)
    rms = np.sqrt((frames.astype(np.float64) ** 2).sum(axis=1) / lengths)
    with np.errstate(divide="ignore"):
        db = np.maximum(20.0 * np.log10(np.maximum(rms, 1e-12)), DB_FLOOR)
    clipped = (np.abs(frames) >= CLIP_LEVEL).sum(axis=1)

    audible = db[db > DB_FLOOR + 1.0]
    if len(audible) == 0:
        noise = speech_level = DB_FLOOR
    else:
        noise = float(np.percentile(db, 5))              # pauses and word gaps (digital silence counts as silence)
        speech_level = float(np.percentile(audible, 95))
    spread = speech_level - noise
    thr = max(SILENCE_DBFS - 5.0, min(speech_level - 12.0, noise + max(6.0, 0.35 * spread)))
    active = db >= thr
    # word gaps shorter than REF_MIN_PAUSE_S count as speech (hangover), longer ones are pauses
    min_pause = max(1, int(round(REF_MIN_PAUSE_S / ws)))
    for a, b in _runs(~active):
        if b - a < min_pause and a > 0 and b < count:
            active[a:b] = True
    speech_s = float(active.sum()) * ws
    pauses = [(a, b) for a, b in _runs(~active)]

    # candidate cut points: (time, clean) — starts just before speech resumes, ends just after it stops
    starts: list[tuple[float, bool, int]] = []     # (time_s, clean_edge, first_window)
    ends: list[tuple[float, bool, int]] = []       # (time_s, clean_edge, end_window)
    if count and active[0]:
        starts.append((0.0, False, 0))
    if count and active[-1]:
        ends.append((total_s, False, count))
    for a, b in pauses:
        pad = min(REF_EDGE_PAD_S, (b - a) * ws / 2.0)
        if b < count:
            starts.append((max(a * ws, b * ws - pad), True, b))
        if a > 0:
            ends.append((min(b * ws, a * ws + pad, total_s), True, a))
    starts.sort()
    ends.sort()

    act_cum = np.concatenate([[0], np.cumsum(active.astype(np.int64))])
    clip_cum = np.concatenate([[0], np.cumsum((clipped > 0).astype(np.int64))])
    db_act = np.where(active, db, 0.0)
    s1 = np.concatenate([[0.0], np.cumsum(db_act)])
    s2 = np.concatenate([[0.0], np.cumsum(db_act * db_act)])
    long_pause = np.zeros(count + 1, dtype=np.int64)          # for each window index: length of a pause ending there
    for a, b in pauses:
        long_pause[b] = b - a

    best: tuple[float, dict[str, Any]] | None = None
    for st, st_clean, wa in starts:
        for en, en_clean, wb in ends:
            if wb <= wa:
                continue
            d = en - st
            if d < allowed_lo:
                continue
            if d > allowed_hi:
                break
            nwin = max(1, wb - wa)
            act = int(act_cum[wb] - act_cum[wa])
            ratio = act / nwin
            if act:
                mean = (s1[wb] - s1[wa]) / act
                std = math.sqrt(max(0.0, (s2[wb] - s2[wa]) / act - mean * mean))
            else:
                mean, std = DB_FLOOR, 0.0
            clip_w = int(clip_cum[wb] - clip_cum[wa])
            inner = long_pause[wa + 1:wb]
            longest = float(inner.max()) * ws if len(inner) else 0.0
            dur_pen = 0.0 if lo <= d <= hi else ((lo - d) / lo * 2.0 if d < lo else (d - hi) / hi * 2.0)
            score = (3.0 * ratio - dur_pen - 0.05 * abs(d - target) - 1.5 * min(1.0, clip_w / 5.0)
                     - 0.05 * max(0.0, std - 6.0) - 0.8 * max(0.0, longest - 0.8)
                     - (0.0 if st_clean else 1.0) - (0.0 if en_clean else 1.0) - 0.0005 * st)
            if best is None or score > best[0]:
                best = (score, {"start_s": round(st, 3), "end_s": round(en, 3), "speech_ratio": round(ratio, 3),
                                "edges_clean": bool(st_clean and en_clean), "clipped_windows": clip_w,
                                "level_std_db": round(std, 2), "longest_pause_s": round(longest, 2)})

    if best is not None:
        sel = best[1]
        dur = sel["end_s"] - sel["start_s"]
        reliable = bool(sel["edges_clean"] and sel["speech_ratio"] >= 0.5 and dur >= max(allowed_lo, min(lo, 5.0)))
    else:
        # nothing phrase-aligned fits: the densest stretch of the right length, for the user to adjust by hand
        span = int(round(min(max(lo, allowed_lo), total_s, allowed_hi) / ws)) or count
        span = min(span, count)
        dens = act_cum[span:] - act_cum[:-span] if span < count + 1 else np.array([act_cum[-1]])
        i = int(np.argmax(dens)) if len(dens) else 0
        a, b = i * ws, min(total_s, (i + span) * ws)
        sel = {"start_s": round(a, 3), "end_s": round(b, 3), "speech_ratio": round(float(dens[i]) / max(1, span), 3) if len(dens) else 0.0,
               "edges_clean": False, "clipped_windows": int(clip_cum[min(count, i + span)] - clip_cum[i]), "level_std_db": None,
               "longest_pause_s": None}
        reliable = False

    snr = speech_level - noise
    sel_peak = float(np.max(np.abs(x[int(sel["start_s"] * sr):int(sel["end_s"] * sr)]))) if sel["end_s"] > sel["start_s"] else 0.0
    issues: list[dict[str, Any]] = []

    def issue(code: str, message: str, severity: str = "warn") -> None:
        issues.append({"code": code, "message": message, "severity": severity, "heuristic": True})

    if speech_s < 0.5 or speech_level <= SILENCE_DBFS:
        issue("NO_SPEECH", "No speech was found in this audio.", "block")
    elif speech_s <= float(min_s):
        issue("TOO_SHORT", f"Only about {speech_s:.0f} s of speech; at least {float(min_s) + 1:.0f} s is needed.", "block")
    else:
        if dbfs(sel_peak) < -30.0 or speech_level < -40.0:
            issue("TOO_QUIET", f"The speech is very quiet (peak {dbfs(sel_peak):.0f} dBFS).")
        if sel["clipped_windows"] >= 3:
            issue("CLIPPING", "The recording is distorted (clipped) in places.")
        if snr < 15.0 and speech_level > SILENCE_DBFS:
            issue("NOISY", f"The voice is only about {snr:.0f} dB above the background noise.")
        if sel["speech_ratio"] < 0.5:
            issue("MOSTLY_SILENT", "The usable part contains a lot of silence.")
        if speech_s < lo:
            issue("SHORT", f"About {speech_s:.0f} s of speech; {lo:.0f}–{hi:.0f} s clones best.")
    return {**sel, "duration_s": round(sel["end_s"] - sel["start_s"], 3), "reliable": reliable and not any(i["severity"] == "block" for i in issues),
            "total_s": round(total_s, 3), "speech_s": round(speech_s, 2), "noise_floor_dbfs": round(noise, 1),
            "speech_level_dbfs": round(speech_level, 1), "snr_db": round(snr, 1), "peak_dbfs": dbfs(sel_peak), "issues": issues,
            "recommended_seconds": [lo, hi]}


def suggest_reference(path: Path, min_s: float, max_s: float, recommended: tuple[float, float],
                      max_scan_s: float = REF_MAX_SCAN_S) -> dict[str, Any]:
    """`suggest_reference_range` over the first `max_scan_s` seconds of a file (mono)."""
    with opened(Path(path)) as f:
        total = f.frames / f.samplerate
    x, sr = read_audio(Path(path), 0.0, min(total, max_scan_s))
    out = suggest_reference_range(x, sr, min_s, max_s, recommended)
    out["total_s"] = round(total, 3)
    out["scanned_s"] = round(min(total, max_scan_s), 3)
    return out
