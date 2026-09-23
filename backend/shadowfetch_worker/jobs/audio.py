"""audio.* methods: probe, import, peaks, stats, trim, prepare_reference, preview_processing, play_device_test."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, Field

from ..audio import analysis, edit
from ..audio.ffmpeg import decode_to_wav, probe
from ..paths import AppPaths, require_free_space, safe_filename, unique_path
from ..protocol import (DEVICE_UNAVAILABLE, INVALID_PARAMS, NOT_FOUND, PERMISSION_DENIED, UNSUPPORTED_FILE, WorkerError)
from ..rpc import Ctx, method
from ..store.db import dumps, new_id, row_to_dict

log = logging.getLogger("jobs.audio")

MAX_INPUT_BYTES = 2 * 1024 ** 3
WORKING_RATE = 48000
COPY_CHUNK = 4 * 1024 * 1024
PREPARED_DIRNAME = "_prepared"


def _paths(ctx: Ctx) -> AppPaths:
    return ctx.server.state["paths"]


def user_file(path: str) -> Path:
    """Validate a user-picked input: absolute, existing regular file, readable, at most 2 GB."""
    if not path or not os.path.isabs(path):
        raise WorkerError(INVALID_PARAMS, "path must be an absolute path")
    p = Path(path)
    if not p.exists():
        raise WorkerError(NOT_FOUND, f"File not found: {p}", {"path": str(p)}, False)
    if not p.is_file():
        raise WorkerError(UNSUPPORTED_FILE, f"Not a regular file: {p}", {"path": str(p)}, False)
    if not os.access(p, os.R_OK):
        raise WorkerError(PERMISSION_DENIED, f"Cannot read {p}", {"path": str(p)}, False)
    size = p.stat().st_size
    if size > MAX_INPUT_BYTES:
        raise WorkerError(INVALID_PARAMS, f"{p.name} is {size / 1024 ** 3:.1f} GB; the limit is 2 GB", {"size_bytes": size}, False)
    return p


def output_file(path: str | None, default: Path, *inputs: Path) -> Path:
    """Resolve an optional user-chosen output path (parent must exist and be writable; never one of the inputs)."""
    if path:
        if not os.path.isabs(path):
            raise WorkerError(INVALID_PARAMS, "out_path must be an absolute path")
        out = Path(path)
    else:
        out = default
    out.parent.mkdir(parents=True, exist_ok=True)
    if not out.parent.is_dir() or not os.access(out.parent, os.W_OK):
        raise WorkerError(PERMISSION_DENIED, f"Cannot write into {out.parent}", {"path": str(out)}, True)
    for src in inputs:
        if out.exists() and out.resolve() == src.resolve():
            raise WorkerError(INVALID_PARAMS, "The output path is the input file; inputs are never modified", {"path": str(out)})
    return out


# ---------------------------------------------------------------- probe / import
class PathParams(BaseModel):
    path: str


@method("audio.probe", params=PathParams)
def audio_probe(ctx: Ctx, p: PathParams) -> dict[str, Any]:
    return probe(user_file(p.path))


class ImportParams(BaseModel):
    path: str
    kind: Literal["reference", "other"] = "reference"


def copy_with_sha256(src: Path, dst: Path, ctx: Ctx | None = None) -> str:
    """Copy `src` → `dst` atomically (tmp + replace) while hashing; progress in measured bytes."""
    total = src.stat().st_size
    h = hashlib.sha256()
    tmp = dst.with_name(dst.name + ".tmp")
    done = 0
    try:
        with open(src, "rb") as fi, open(tmp, "wb") as fo:
            while True:
                chunk = fi.read(COPY_CHUNK)
                if not chunk:
                    break
                h.update(chunk)
                fo.write(chunk)
                done += len(chunk)
                if ctx:
                    ctx.check_cancel()
                    ctx.progress("copy", "Copying the original file", detail={"bytes_done": done, "bytes_total": total}, throttle_s=0.25)
        os.replace(tmp, dst)
    finally:
        if tmp.exists():
            tmp.unlink()
    shutil.copystat(src, dst, follow_symlinks=True)
    try:
        os.chmod(dst, 0o600)
    except OSError:
        pass
    return h.hexdigest()


@method("audio.import", params=ImportParams)
def audio_import(ctx: Ctx, p: ImportParams) -> dict[str, Any]:
    """Copy the original untouched, decode once to working.wav (float32 mono 48 kHz), compute peaks + stats, insert the asset."""
    st = ctx.server.state
    paths, db = _paths(ctx), st["db"]
    src = user_file(p.path)
    info = probe(src)
    working_bytes = int(info["duration_s"] * WORKING_RATE * 4) + 1_000_000
    require_free_space(paths.recordings, src.stat().st_size + working_bytes, "importing this file")
    asset_id = new_id("asset")
    asset_dir = paths.recordings / asset_id
    asset_dir.mkdir(parents=True, exist_ok=False)
    try:
        os.chmod(asset_dir, 0o700)
    except OSError:
        pass
    ext = src.suffix.lower().lstrip(".") or info["format"]
    ext = "".join(ch for ch in ext if ch.isalnum()) or "bin"
    original = asset_dir / f"original.{ext}"
    working = asset_dir / "working.wav"
    try:
        sha = copy_with_sha256(src, original, ctx)
        ctx.check_cancel()
        ctx.progress("decode", "Decoding to the working format (float32 mono 48 kHz)")
        decode_to_wav(original, working, sample_rate=WORKING_RATE, channels=1, sample_fmt="f32", ctx=ctx)
        ctx.progress("analyze", "Computing waveform and statistics")
        pk = analysis.peaks(working, cache_dir=paths.peaks)
        peaks_path = analysis.peaks_cache_file(working, 2000, paths.peaks)
        stats = analysis.stats(working)
        meta = {"asset_id": asset_id, "kind": p.kind, "source": "import", "original_name": src.name, "original_path": str(original),
                "working_path": str(working), "sha256": sha, "probe": info, "stats": stats, "imported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        (asset_dir / "meta.json").write_text(json.dumps(meta, indent=2))
        db.insert("assets", {
            "id": asset_id, "kind": p.kind, "source": "import", "original_name": src.name, "original_path": str(original),
            "working_path": str(working), "sha256": sha, "format": info["format"], "codec": info["codec"],
            "duration_s": info["duration_s"], "sample_rate": info["sample_rate"], "channels": info["channels"],
            "bit_depth": info.get("bit_depth"), "size_bytes": info["size_bytes"], "stats_json": dumps(stats),
        })
    except Exception:
        shutil.rmtree(asset_dir, ignore_errors=True)
        raise
    return {"asset_id": asset_id, "original_path": str(original), "working_path": str(working), "probe": info,
            "peaks_path": str(peaks_path), "peaks": pk, "stats": stats, "sha256": sha, "kind": p.kind, "original_name": src.name}


# ---------------------------------------------------------------- peaks / stats / trim
class PeaksParams(BaseModel):
    path: str
    points: int = Field(2000, ge=16, le=20000)


@method("audio.peaks", params=PeaksParams)
def audio_peaks(ctx: Ctx, p: PeaksParams) -> dict[str, Any]:
    return {"path": p.path, **analysis.peaks(user_file(p.path), p.points, cache_dir=_paths(ctx).peaks)}


class StatsParams(BaseModel):
    path: str
    start_s: float | None = None
    end_s: float | None = None


@method("audio.stats", params=StatsParams)
def audio_stats(ctx: Ctx, p: StatsParams) -> dict[str, Any]:
    edit.check_range(p.start_s, p.end_s)
    return analysis.stats(user_file(p.path), p.start_s, p.end_s)


class TrimParams(BaseModel):
    path: str
    start_s: float
    end_s: float
    out_path: str | None = None


@method("audio.trim", params=TrimParams)
def audio_trim(ctx: Ctx, p: TrimParams) -> dict[str, Any]:
    src = user_file(p.path)
    default = unique_path(_paths(ctx).exports / f"{safe_filename(src.stem)} (trim {p.start_s:.2f}-{p.end_s:.2f}s).wav")
    out = output_file(p.out_path, default, src)
    return edit.trim(src, out, p.start_s, p.end_s)


# ---------------------------------------------------------------- prepare_reference
class RefProcessing(BaseModel):
    normalize_peak_dbfs: float | None = None


class PrepareReferenceParams(BaseModel):
    asset_id: str
    start_s: float
    end_s: float
    engine_id: str
    processing: RefProcessing | None = None


@method("audio.prepare_reference", params=PrepareReferenceParams)
def audio_prepare_reference(ctx: Ctx, p: PrepareReferenceParams) -> dict[str, Any]:
    """Derive `voices/_prepared/<asset_id>/reference.<engine_id>.wav` matching the engine's declared reference requirements."""
    st = ctx.server.state
    paths, db = _paths(ctx), st["db"]
    edit.check_range(p.start_s, p.end_s)
    asset = row_to_dict(db.require("assets", p.asset_id), ("stats_json",))
    working = Path(asset.get("working_path") or "")
    if not working.is_file():
        raise WorkerError(NOT_FOUND, f"The working file for asset {p.asset_id} is missing ({working}); re-import the audio.",
                          {"asset_id": p.asset_id}, False)
    engines = st.get("engines")
    if engines is None:
        raise WorkerError("ENGINE_UNAVAILABLE", "Engine manager is not available", recoverable=False)
    caps = engines.capabilities(p.engine_id)
    req = caps.reference
    duration = p.end_s - p.start_s
    if duration <= req.min_seconds:
        raise WorkerError(INVALID_PARAMS, f"{caps.name} needs more than {req.min_seconds:g} s of reference audio (selected {duration:.2f} s).",
                          {"min_seconds": req.min_seconds, "max_seconds": req.max_seconds, "duration_s": duration})
    if duration > req.max_seconds:
        raise WorkerError(INVALID_PARAMS, f"{caps.name} accepts at most {req.max_seconds:g} s of reference audio (selected {duration:.2f} s). Trim the selection.",
                          {"min_seconds": req.min_seconds, "max_seconds": req.max_seconds, "duration_s": duration})
    out_dir = paths.voices / PREPARED_DIRNAME / p.asset_id
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / f"reference.{p.engine_id}.wav"
    ctx.progress("prepare", f"Preparing reference for {caps.name} ({req.sample_rate} Hz, {req.channels} ch)")
    norm = p.processing.normalize_peak_dbfs if p.processing else None
    res = edit.prepare_reference(working, dst, req.sample_rate, req.channels, p.start_s, p.end_s, norm, ctx=ctx)
    processing = [{"op": "normalize_peak", "dbfs": norm}] if norm is not None else []
    fp_src = f"{asset.get('sha256')}|{p.start_s:.4f}|{p.end_s:.4f}|{dumps(processing)}|{req.sample_rate}|{req.channels}"
    fingerprint = hashlib.sha256(fp_src.encode()).hexdigest()
    return {"reference_id": f"prep_{fingerprint[:16]}", "asset_id": p.asset_id, "engine_id": p.engine_id, "start_s": p.start_s,
            "end_s": p.end_s, "processing": processing, "fingerprint": fingerprint, **res}


# ---------------------------------------------------------------- automatic reference selection
class SuggestReferenceParams(BaseModel):
    path: str | None = None
    asset_id: str | None = None
    engine_id: str | None = None


@method("audio.suggest_reference", params=SuggestReferenceParams)
def audio_suggest_reference(ctx: Ctx, p: SuggestReferenceParams) -> dict[str, Any]:
    """Recommend a clean reference range (whole phrases, mostly speech, inside the engine's recommended length) and
    report plain problems (quiet, clipped, noisy, too little speech). Reads only; nothing is written or modified."""
    st = ctx.server.state
    if p.asset_id:
        asset = st["db"].require("assets", p.asset_id)
        src = Path(asset["working_path"] or asset["original_path"] or "")
        if not src.is_file():
            raise WorkerError(NOT_FOUND, "The audio file for this recording is missing on disk.", {"asset_id": p.asset_id}, False)
    elif p.path:
        src = user_file(p.path)
    else:
        raise WorkerError(INVALID_PARAMS, "Pass asset_id or path.")
    engine_id = p.engine_id or st["settings"].value.default_engine
    min_s, max_s, rec = 3.0, 30.0, (8.0, 15.0)
    engines = st.get("engines")
    if engines is not None:
        try:
            req = engines.capabilities(engine_id).reference
            if req.max_seconds > 0 and req.recommended_seconds[1] > 0:
                min_s, max_s, rec = float(req.min_seconds), float(req.max_seconds), tuple(req.recommended_seconds)
        except WorkerError:
            pass
    ctx.progress("analyze", "Looking for the clearest part of the recording")
    res = analysis.suggest_reference(src, min_s, max_s, rec)
    return {**res, "engine_id": engine_id, "path": str(src), "min_seconds": min_s, "max_seconds": max_s}


# ---------------------------------------------------------------- preview processing
class PreviewParams(BaseModel):
    path: str
    processing: list[dict[str, Any]] | dict[str, Any] = Field(default_factory=list)


def processing_to_steps(processing: list[dict[str, Any]] | dict[str, Any]) -> list[dict[str, Any]]:
    """Accept either an ordered step list or the compact object form {normalize_peak_dbfs, trim_silence, highpass_hz, gain_db}."""
    if isinstance(processing, list):
        return processing
    steps: list[dict[str, Any]] = []
    if processing.get("trim_silence"):
        ts = processing["trim_silence"]
        steps.append({"op": "trim_silence", **(ts if isinstance(ts, dict) else {})})
    if processing.get("highpass_hz") is not None:
        steps.append({"op": "highpass", "hz": processing["highpass_hz"]})
    if processing.get("gain_db") is not None:
        steps.append({"op": "gain", "db": processing["gain_db"]})
    if processing.get("normalize_peak_dbfs") is not None:
        steps.append({"op": "normalize_peak", "dbfs": processing["normalize_peak_dbfs"]})
    known = {"trim_silence", "highpass_hz", "gain_db", "normalize_peak_dbfs"}
    unknown = sorted(set(processing) - known)
    if unknown:
        raise WorkerError(INVALID_PARAMS, f"Unknown processing keys {unknown}; supported: {sorted(known)} or a list of steps")
    return steps


@method("audio.preview_processing", params=PreviewParams)
def audio_preview_processing(ctx: Ctx, p: PreviewParams) -> dict[str, Any]:
    """Temporary processed copy in the cache dir for A/B listening; the source is untouched and the copy is disposable."""
    src = user_file(p.path)
    steps = processing_to_steps(p.processing)
    edit.parse_steps(steps)
    st = src.stat()
    key = hashlib.sha1(f"{src.resolve()}|{st.st_mtime_ns}|{st.st_size}|{dumps(steps)}".encode()).hexdigest()[:20]
    out = _paths(ctx).tmp / f"preview-{key}.wav"
    if out.is_file():
        info = probe(out)
        return {"path": str(out), "duration_s": info["duration_s"], "sample_rate": info["sample_rate"], "channels": info["channels"],
                "steps": steps, "cached": True, "source": str(src)}
    ctx.progress("preview", f"Applying {len(steps)} processing step(s) to a copy")
    res = edit.apply_processing(src, out, steps, ctx=ctx)
    return {**res, "cached": False, "source": str(src)}


# ---------------------------------------------------------------- device test
class DeviceTestParams(BaseModel):
    device_index: int | None = None


def _tone_wav(path: Path, seconds: float = 0.5, hz: float = 440.0, sr: int = 48000, dbfs: float = -12.0) -> Path:
    t = np.arange(int(seconds * sr)) / sr
    x = (10 ** (dbfs / 20.0)) * np.sin(2 * np.pi * hz * t)
    edit.apply_fades(x, sr, 10.0)
    analysis.write_wav(path, x.astype(np.float32), sr, "PCM_16")
    return path


@method("audio.play_device_test", params=DeviceTestParams)
def audio_play_device_test(ctx: Ctx, p: DeviceTestParams) -> dict[str, Any]:
    """Play a 0.5 s 440 Hz tone. Uses sounddevice when PortAudio is present, else ffplay, else paplay; reports which."""
    wav = _tone_wav(_paths(ctx).tmp / "device-test-440hz.wav")
    notes: list[str] = []
    tried: list[str] = []
    try:
        import sounddevice as sd  # noqa: WPS433  (import may raise OSError when libportaudio is missing)
        import soundfile as sf
        data, sr = sf.read(str(wav), dtype="float32")
        sd.play(data, sr, device=p.device_index, blocking=True)
        try:
            dev_name = sd.query_devices(p.device_index if p.device_index is not None else sd.default.device[1]).get("name")
        except Exception:  # noqa: BLE001  (no default device to describe; playback already happened)
            dev_name = None
        return {"ok": True, "backend": "sounddevice", "device_index": p.device_index, "device_name": dev_name, "notes": notes}
    except (ImportError, OSError) as e:
        tried.append(f"sounddevice: {str(e).splitlines()[0][:160]}")
    except Exception as e:  # noqa: BLE001  (PortAudioError etc.)
        tried.append(f"sounddevice: {type(e).__name__}: {str(e)[:160]}")
    for name, cmd in (("ffplay", ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", str(wav)]),
                      ("paplay", ["paplay", str(wav)])):
        exe = shutil.which(name)
        if not exe:
            tried.append(f"{name}: not installed")
            continue
        try:
            proc = ctx.track(subprocess.Popen([exe, *cmd[1:]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True))
            _, err = proc.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            tried.append(f"{name}: timed out")
            continue
        if proc.returncode == 0:
            if p.device_index is not None:
                notes.append(f"device_index is ignored by the {name} fallback (it plays on the system default output)")
            notes.extend(tried)
            return {"ok": True, "backend": name, "device_index": None, "notes": notes}
        tried.append(f"{name}: exit {proc.returncode} {(err or '').strip()[:160]}")
    raise WorkerError(DEVICE_UNAVAILABLE, "No way to play audio was found: " + "; ".join(tried), {"tried": tried}, True)
