"""ffmpeg / ffprobe subprocess wrappers.

Every call uses an argument array (never a shell), is cancellable through `ctx.track()`, and reports failures as
`WorkerError(FFMPEG_FAILED)` carrying the tail of ffmpeg's stderr so the UI can show the real reason.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from ..protocol import (CORRUPT_FILE, EMPTY_AUDIO, FFMPEG_FAILED, NOT_FOUND, UNSUPPORTED_FILE, CancelledError,
                        WorkerError)

log = logging.getLogger("audio.ffmpeg")

SAMPLE_FMT_CODEC = {"f32": "pcm_f32le", "s24": "pcm_s24le", "s16": "pcm_s16le"}
PCM_BIT_DEPTH = {"pcm_s16le": 16, "pcm_s16be": 16, "pcm_s24le": 24, "pcm_s24be": 24, "pcm_s32le": 32, "pcm_s32be": 32,
                 "pcm_f32le": 32, "pcm_f32be": 32, "pcm_f64le": 64, "pcm_u8": 8, "pcm_s8": 8}
# Extensions we treat as "meant to be audio": a probe failure on these is a corrupt file, anything else is unsupported.
AUDIO_EXTENSIONS = {"wav", "wave", "flac", "mp3", "m4a", "aac", "ogg", "oga", "opus", "wma", "aif", "aiff", "aifc", "caf",
                    "w64", "rf64", "mp4", "mkv", "webm", "mov", "mp2", "ac3", "amr", "au", "voc", "wv", "ape", "tta", "mka"}
STDERR_TAIL = 1200


def ffmpeg_path() -> str:
    """Absolute path of the ffmpeg binary (FFMPEG_FAILED when it is not installed)."""
    p = os.environ.get("SFVS_FFMPEG") or shutil.which("ffmpeg")
    if not p:
        raise WorkerError(FFMPEG_FAILED, "ffmpeg was not found on PATH. Install it (apt install ffmpeg) and restart.", recoverable=False)
    return p


def ffprobe_path() -> str:
    """Absolute path of the ffprobe binary (FFMPEG_FAILED when it is not installed)."""
    p = os.environ.get("SFVS_FFPROBE") or shutil.which("ffprobe")
    if not p:
        raise WorkerError(FFMPEG_FAILED, "ffprobe was not found on PATH. Install ffmpeg (apt install ffmpeg) and restart.", recoverable=False)
    return p


def _run(cmd: list[str], ctx=None, timeout: float | None = None) -> subprocess.CompletedProcess:
    """Run a command array, register it with `ctx` for cancellation, capture text output."""
    log.debug("run: %s", " ".join(cmd))
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        raise WorkerError(FFMPEG_FAILED, f"Could not start {cmd[0]}: {e}", recoverable=False)
    if ctx is not None:
        ctx.track(proc)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        raise WorkerError(FFMPEG_FAILED, f"{Path(cmd[0]).name} timed out after {timeout} s", {"stderr": (err or "")[-STDERR_TAIL:]})
    finally:
        if ctx is not None:
            try:
                ctx.subprocesses.remove(proc)
            except ValueError:
                pass
    if ctx is not None and ctx.cancelled():
        raise CancelledError({"command": Path(cmd[0]).name})
    return subprocess.CompletedProcess(cmd, proc.returncode, out, err)


def run_ffmpeg(args: list[str], ctx=None, timeout: float | None = None) -> subprocess.CompletedProcess:
    """Run `ffmpeg <args>` (args exclude the binary). Raises FFMPEG_FAILED with the stderr tail on a non-zero exit."""
    cmd = [ffmpeg_path(), "-hide_banner", "-nostdin", "-nostats", *[str(a) for a in args]]
    r = _run(cmd, ctx, timeout)
    if r.returncode != 0:
        tail = (r.stderr or "").strip()[-STDERR_TAIL:]
        last = tail.splitlines()[-1] if tail else "no error output"
        raise WorkerError(FFMPEG_FAILED, f"ffmpeg failed (exit {r.returncode}): {last}", {"stderr": tail, "exit_code": r.returncode})
    return r


def run_ffprobe(args: list[str], ctx=None, timeout: float | None = 60) -> subprocess.CompletedProcess:
    """Run `ffprobe <args>`; the caller interprets the exit code (a failing probe is a *file* problem, not a tool problem)."""
    return _run([ffprobe_path(), "-hide_banner", *[str(a) for a in args]], ctx, timeout)


def _first(*vals: Any) -> Any:
    for v in vals:
        if v not in (None, "", "N/A"):
            return v
    return None


def _to_float(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def _to_int(v: Any) -> int | None:
    f = _to_float(v)
    return int(f) if f is not None else None


def probe(path: Path) -> dict[str, Any]:
    """ffprobe a file → {format, codec, duration_s, sample_rate, channels, bit_depth|None, bitrate|None, size_bytes}.

    Raises NOT_FOUND (missing), UNSUPPORTED_FILE (not audio / unknown container), CORRUPT_FILE (ffprobe cannot parse a
    file that claims to be audio) or EMPTY_AUDIO (duration <= 0).
    """
    path = Path(path)
    if not path.is_file():
        raise WorkerError(NOT_FOUND, f"File not found: {path}", {"path": str(path)}, False)
    ext = path.suffix.lower().lstrip(".")
    r = run_ffprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", str(path)])
    if r.returncode != 0 or not r.stdout.strip():
        reason = (r.stderr or "").strip().splitlines()[-1:] or ["ffprobe produced no output"]
        code = CORRUPT_FILE if ext in AUDIO_EXTENSIONS else UNSUPPORTED_FILE
        what = "could not be read (it may be truncated or damaged)" if code == CORRUPT_FILE else "is not a supported audio file"
        raise WorkerError(code, f"{path.name} {what}: {reason[0]}", {"path": str(path), "stderr": (r.stderr or "")[-STDERR_TAIL:]}, False)
    try:
        data = json.loads(r.stdout)
    except ValueError:
        raise WorkerError(CORRUPT_FILE, f"ffprobe returned unreadable output for {path.name}", {"path": str(path)}, False)
    fmt = data.get("format") or {}
    audio = [s for s in data.get("streams") or [] if s.get("codec_type") == "audio"]
    if not audio:
        kinds = sorted({str(s.get("codec_type")) for s in data.get("streams") or []}) or ["none"]
        raise WorkerError(UNSUPPORTED_FILE, f"{path.name} contains no audio stream (streams: {', '.join(kinds)})",
                          {"path": str(path), "format": fmt.get("format_name")}, False)
    s = audio[0]
    names = str(fmt.get("format_name") or "").split(",")
    format_name = ext if ext in names else (names[0] if names and names[0] else ext or "unknown")
    duration = _to_float(_first(s.get("duration"), fmt.get("duration")))
    if duration is None and _to_int(s.get("nb_frames")) and _to_int(s.get("sample_rate")):
        duration = _to_int(s.get("nb_frames")) / _to_int(s.get("sample_rate"))  # type: ignore[operator]
    codec = str(s.get("codec_name") or "unknown")
    bit_depth = _to_int(_first(s.get("bits_per_raw_sample"), s.get("bits_per_sample"))) or PCM_BIT_DEPTH.get(codec)
    info = {
        "format": format_name, "codec": codec, "duration_s": round(duration, 6) if duration is not None else 0.0,
        "sample_rate": _to_int(s.get("sample_rate")) or 0, "channels": _to_int(s.get("channels")) or 0,
        "bit_depth": bit_depth or None, "bitrate": _to_int(_first(s.get("bit_rate"), fmt.get("bit_rate"))),
        "size_bytes": _to_int(fmt.get("size")) if _to_int(fmt.get("size")) is not None else path.stat().st_size,
    }
    if info["duration_s"] <= 0:
        raise WorkerError(EMPTY_AUDIO, f"{path.name} has no audio content (duration is zero)", {"path": str(path), "probe": info}, False)
    if info["sample_rate"] <= 0 or info["channels"] <= 0:
        raise WorkerError(CORRUPT_FILE, f"{path.name} reports an invalid sample rate or channel count", {"path": str(path), "probe": info}, False)
    return info


def soxr_args(sample_rate: int | None) -> list[str]:
    """ffmpeg args that resample with the soxr resampler (high precision) — empty when no resampling is requested."""
    if not sample_rate:
        return []
    return ["-af", f"aresample=resampler=soxr:precision=28:osr={int(sample_rate)}", "-ar", str(int(sample_rate))]


def decode_to_wav(src: Path, dst: Path, sample_rate: int | None = None, channels: int = 1, sample_fmt: str = "f32",
                  ctx=None, extra_filters: list[str] | None = None) -> dict[str, Any]:
    """Decode any ffmpeg-readable file to a WAV in a single pass (`-vn`, first audio stream, optional soxr resample).

    Atomic: writes `<dst>.tmp` then `os.replace`. `extra_filters` are appended before the resampler (e.g. atrim).
    Returns the probe of the written file plus `path`.
    """
    src, dst = Path(src), Path(dst)
    if sample_fmt not in SAMPLE_FMT_CODEC:
        raise WorkerError("INVALID_PARAMS", f"sample_fmt must be one of {sorted(SAMPLE_FMT_CODEC)}")
    if src.resolve() == dst.resolve():
        raise WorkerError("INVALID_PARAMS", "decode_to_wav: source and destination are the same file")
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".tmp")
    filters = list(extra_filters or [])
    args: list[str] = ["-y", "-i", str(src), "-vn", "-sn", "-dn", "-map", "0:a:0", "-map_metadata", "-1", "-ac", str(int(channels))]
    if sample_rate:
        filters.append(f"aresample=resampler=soxr:precision=28:osr={int(sample_rate)}")
        args += ["-ar", str(int(sample_rate))]
    if filters:
        args += ["-af", ",".join(filters)]
    args += ["-c:a", SAMPLE_FMT_CODEC[sample_fmt], "-f", "wav", str(tmp)]
    try:
        run_ffmpeg(args, ctx=ctx)
        os.replace(tmp, dst)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    info = probe(dst)
    info["path"] = str(dst)
    return info
