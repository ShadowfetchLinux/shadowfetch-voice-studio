"""Export rendering: WAV/FLAC/MP3 via ffmpeg, optional two-pass EBU R128 loudness normalisation, validation.

Loudness targets are *named presets* the user can pick; none is applied unless asked for. Measurements come from
ffmpeg's `loudnorm` filter (integrated loudness, true peak with oversampling, loudness range).
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from ..paths import unique_path
from ..protocol import CORRUPT_FILE, EMPTY_AUDIO, FFMPEG_FAILED, INVALID_PARAMS, PERMISSION_DENIED, WorkerError
from .ffmpeg import probe, run_ffmpeg, soxr_filter

log = logging.getLogger("audio.export")

APP_LABEL = "Shadowfetch Voice Studio"
LOUDNESS_TARGETS: list[dict[str, Any]] = [
    {"id": "podcast-16", "label": "Podcast (-16 LUFS, -1 dBTP)", "integrated_lufs": -16.0, "true_peak_dbtp": -1.0, "lra": 11.0,
     "description": "Common podcast delivery level (Apple/Spotify podcast guidance): -16 LUFS integrated, true peak at or below -1 dBTP."},
    {"id": "streaming-14", "label": "Streaming (-14 LUFS, -1 dBTP)", "integrated_lufs": -14.0, "true_peak_dbtp": -1.0, "lra": 11.0,
     "description": "Music/streaming platform playback level (Spotify, YouTube normalise around -14 LUFS); louder than podcast delivery."},
    {"id": "broadcast-r128-23", "label": "Broadcast EBU R128 (-23 LUFS, -1 dBTP)", "integrated_lufs": -23.0, "true_peak_dbtp": -1.0, "lra": 11.0,
     "description": "EBU R128 broadcast programme loudness: -23 LUFS integrated, true peak at or below -1 dBTP."},
]
_TARGET_ALIASES = {"ebu-r128-podcast-16": "podcast-16", "podcast": "podcast-16", "streaming": "streaming-14",
                   "broadcast-23": "broadcast-r128-23", "broadcast": "broadcast-r128-23", "r128": "broadcast-r128-23"}
FORMATS = ("wav", "flac", "mp3")
WAV_CODECS = {16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_f32le"}
MP3_BITRATES = (64, 96, 128, 160, 192, 256, 320)
_JSON_BLOCK = re.compile(r"\{[^{}]*\}", re.S)


def loudness_target(target_id: str) -> dict[str, Any]:
    """Look up a named target (a few historical aliases accepted) → the preset dict; INVALID_PARAMS when unknown."""
    tid = _TARGET_ALIASES.get(target_id, target_id)
    for t in LOUDNESS_TARGETS:
        if t["id"] == tid:
            return t
    raise WorkerError(INVALID_PARAMS, f"Unknown loudness target {target_id!r}; choose one of {[t['id'] for t in LOUDNESS_TARGETS]}")


def _loudnorm_json(stderr: str) -> dict[str, float | None]:
    blocks = _JSON_BLOCK.findall(stderr or "")
    for raw in reversed(blocks):
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if "input_i" in d:
            out: dict[str, float | None] = {}
            for k, v in d.items():
                try:
                    f = float(v)
                    out[k] = f if math.isfinite(f) else None
                except (TypeError, ValueError):
                    out[k] = None
            out["normalization_type"] = d.get("normalization_type")  # type: ignore[assignment]
            return out
    raise WorkerError(FFMPEG_FAILED, "loudnorm did not report measurements", {"stderr": (stderr or "")[-1200:]})


def measure_loudness(path: Path, target: dict[str, Any] | None = None, ctx=None) -> dict[str, Any]:
    """First-pass `loudnorm` measurement → {integrated_lufs, true_peak_dbtp, lra, threshold, target_offset}.

    Non-finite values (digital silence) are reported as None. When `target` is given the offset is computed for it.
    """
    t = target or LOUDNESS_TARGETS[0]
    filt = (f"loudnorm=I={t['integrated_lufs']}:TP={t['true_peak_dbtp']}:LRA={t['lra']}:print_format=json")
    r = run_ffmpeg(["-i", str(path), "-vn", "-map", "0:a:0", "-af", filt, "-f", "null", "-"], ctx=ctx)
    d = _loudnorm_json(r.stderr)
    return {"integrated_lufs": d.get("input_i"), "true_peak_dbtp": d.get("input_tp"), "lra": d.get("input_lra"),
            "threshold": d.get("input_thresh"), "target_offset": d.get("target_offset")}


def estimate_output_bytes(src_probe: dict[str, Any], fmt: str, wav_bit_depth: int = 24, sample_rate: str | int = "native",
                          mp3_bitrate_kbps: int | None = 192) -> int:
    """Rough upper bound of the rendered file size (used for the free-space check before rendering)."""
    dur = float(src_probe.get("duration_s") or 0)
    rate = int(src_probe.get("sample_rate") or 48000) if sample_rate == "native" else int(sample_rate)
    ch = int(src_probe.get("channels") or 1)
    if fmt == "mp3":
        return int(dur * (mp3_bitrate_kbps or 320) * 1000 / 8) + 1_000_000
    depth = wav_bit_depth if fmt == "wav" else 24
    return int(dur * rate * ch * depth / 8) + 1_000_000


def _validate_output(path: Path, fmt: str, expected_rate: int, expected_codec: str) -> dict[str, Any]:
    info = probe(path)   # raises for unreadable / empty output
    problems = []
    if info["sample_rate"] != expected_rate:
        problems.append(f"sample rate {info['sample_rate']} != {expected_rate}")
    if info["codec"] != expected_codec:
        problems.append(f"codec {info['codec']} != {expected_codec}")
    if fmt in ("wav", "flac"):
        frames = 0
        try:
            with sf.SoundFile(str(path)) as f:
                for block in f.blocks(blocksize=1 << 20, dtype="float32", always_2d=True):
                    frames += len(block)
                    if not np.all(np.isfinite(block)):
                        problems.append("non-finite samples in output")
                        break
        except (sf.LibsndfileError, RuntimeError, OSError) as e:
            problems.append(f"soundfile cannot read the output: {e}")
        if frames == 0:
            problems.append("output has no samples")
    if problems:
        raise WorkerError(CORRUPT_FILE, "Rendered file failed validation: " + "; ".join(problems), {"path": str(path), "probe": info}, True)
    return info


def render(master_path: Path, out_path: Path, fmt: str, *, wav_bit_depth: int = 24, sample_rate: str | int = "native",
           mp3_bitrate_kbps: int | None = 192, mp3_vbr_quality: int | None = None, loudness_target: dict[str, Any] | None = None,
           ai_metadata: bool = True, engine_label: str = "", ctx=None) -> dict[str, Any]:
    """Render `master_path` to `out_path` as wav/flac/mp3 with ffmpeg.

    - `loudness_target` (a LOUDNESS_TARGETS entry) enables two-pass linear `loudnorm`; otherwise no processing at all.
    - `sample_rate` 'native' keeps the master's rate; an int resamples with soxr.
    - never overwrites the master; writes `<out>.tmp` then renames; an existing `out_path` is renamed `name (2).ext`.
    - metadata: comment + encoded_by tags marking the file as AI-generated (when `ai_metadata`), else all metadata stripped.
    - validates with ffprobe (duration > 0, sample rate, codec) and, for wav/flac, reads back every sample with soundfile.
    Returns {path, size_bytes, probe, loudness_measured|None, collision_renamed, format}.
    """
    master_path, out_path = Path(master_path), Path(out_path)
    fmt = fmt.lower()
    if fmt not in FORMATS:
        raise WorkerError(INVALID_PARAMS, f"format must be one of {FORMATS}")
    if fmt == "wav" and wav_bit_depth not in WAV_CODECS:
        raise WorkerError(INVALID_PARAMS, "wav_bit_depth must be 16, 24 or 32 (32 = float)")
    if fmt == "mp3":
        if mp3_vbr_quality is not None and not 0 <= int(mp3_vbr_quality) <= 9:
            raise WorkerError(INVALID_PARAMS, "mp3_vbr_quality must be 0–9")
        if mp3_vbr_quality is None and (mp3_bitrate_kbps is None or int(mp3_bitrate_kbps) not in MP3_BITRATES):
            raise WorkerError(INVALID_PARAMS, f"mp3_bitrate_kbps must be one of {MP3_BITRATES}")
    src = probe(master_path)
    if sample_rate == "native":
        out_rate = int(src["sample_rate"])
    else:
        try:
            out_rate = int(sample_rate)
        except (TypeError, ValueError):
            raise WorkerError(INVALID_PARAMS, "sample_rate must be 'native' or an integer")
        if out_rate < 8000 or out_rate > 192000:
            raise WorkerError(INVALID_PARAMS, "sample_rate must be between 8000 and 192000 Hz")
    if out_path.resolve() == master_path.resolve():
        raise WorkerError(PERMISSION_DENIED, "The export path is the master file itself; exports never overwrite the master.",
                          {"path": str(out_path)}, True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    final = unique_path(out_path)
    collision = final != out_path
    tmp = final.with_name(final.name + ".tmp")

    steps = 3 if loudness_target else 2
    filters: list[str] = []
    if loudness_target:
        t = loudness_target
        if ctx:
            ctx.progress("export", "Measuring loudness (pass 1 of 2)", 1, steps)
        m = measure_loudness(master_path, t, ctx=ctx)
        if m["integrated_lufs"] is None or m["true_peak_dbtp"] is None:
            raise WorkerError(EMPTY_AUDIO, "Loudness cannot be measured: the master is silent.", {"path": str(master_path)}, False)
        filters.append(f"loudnorm=I={t['integrated_lufs']}:TP={t['true_peak_dbtp']}:LRA={t['lra']}"
                       f":measured_I={m['integrated_lufs']}:measured_TP={m['true_peak_dbtp']}:measured_LRA={m['lra'] or 0}"
                       f":measured_thresh={m['threshold']}:offset={m['target_offset'] or 0}:linear=true:print_format=summary")
        filters.append(soxr_filter(out_rate))          # loudnorm outputs 192 kHz internally; bring it back to the target rate
    elif out_rate != int(src["sample_rate"]):
        filters.append(soxr_filter(out_rate))

    args: list[str] = ["-y", "-i", str(master_path), "-vn", "-sn", "-dn", "-map", "0:a:0"]
    if filters:
        args += ["-af", ",".join(filters)]
    args += ["-ar", str(out_rate)]
    if fmt == "wav":
        codec = WAV_CODECS[wav_bit_depth]
        args += ["-c:a", codec, "-f", "wav"]
    elif fmt == "flac":
        codec = "flac"
        depth = int(src.get("bit_depth") or 24)
        args += ["-c:a", "flac", "-sample_fmt", "s16" if depth <= 16 else "s32", "-compression_level", "8", "-f", "flac"]
    else:
        codec = "mp3"
        args += ["-c:a", "libmp3lame"]
        args += ["-q:a", str(int(mp3_vbr_quality))] if mp3_vbr_quality is not None else ["-b:a", f"{int(mp3_bitrate_kbps)}k"]
        args += ["-id3v2_version", "3", "-f", "mp3"]
    args += ["-map_metadata", "-1"]
    if ai_metadata:
        label = f"AI-generated speech — {APP_LABEL}" + (f" ({engine_label})" if engine_label else "")
        args += ["-metadata", f"comment={label}", "-metadata", f"encoded_by={APP_LABEL}"]
    args.append(str(tmp))

    if ctx:
        ctx.progress("export", f"Encoding {fmt.upper()}" + (" (pass 2 of 2)" if loudness_target else ""), steps - 1, steps)
    try:
        run_ffmpeg(args, ctx=ctx)
        if ctx:
            ctx.progress("export", "Validating the rendered file", steps, steps)
        info = _validate_output(tmp, fmt, out_rate, codec)
        os.replace(tmp, final)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    measured = measure_loudness(final, loudness_target, ctx=ctx) if loudness_target else None
    if measured:
        measured = {k: measured[k] for k in ("integrated_lufs", "true_peak_dbtp", "lra")}
    return {"path": str(final), "size_bytes": final.stat().st_size, "probe": info, "loudness_measured": measured,
            "collision_renamed": collision, "format": fmt}
