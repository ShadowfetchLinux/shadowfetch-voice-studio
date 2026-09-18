"""record.* methods: microphone devices, one recording session at a time, guided scripts.

Sessions live in `ctx.server.state['record_sessions']` (session_id → RecordSession). Input monitoring
(playing the microphone back while recording) is not implemented: `settings.monitor_input` is reported in the
start notes as ignored, so there is no feedback risk.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..protocol import INVALID_PARAMS, NOT_FOUND, WorkerError
from ..record.backends import list_input_devices
from ..record.scripts import get_script, reading_scripts
from ..record.session import BYTES_PER_SAMPLE, RecordSession
from ..rpc import Ctx, method
from ..store.db import dumps, new_id

log = logging.getLogger("jobs.record")
_sessions_lock = threading.Lock()
SUBTYPE_CODEC = {"PCM_16": "pcm_s16le", "PCM_24": "pcm_s24le", "PCM_32": "pcm_s32le", "FLOAT": "pcm_f32le", "DOUBLE": "pcm_f64le"}


def _sessions(ctx: Ctx) -> dict[str, RecordSession]:
    return ctx.server.state.setdefault("record_sessions", {})


def _session(ctx: Ctx, session_id: str) -> RecordSession:
    s = _sessions(ctx).get(session_id)
    if s is None:
        raise WorkerError(NOT_FOUND, f"Recording session not found: {session_id}", {"session_id": session_id}, False)
    return s


@method("record.devices")
def devices(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    """`{inputs:[Device+backend], default_input, backend, notes}` from the backend this machine can use."""
    return list_input_devices()


class StartParams(BaseModel):
    device_index: int | None = None
    sample_rate: int | None = Field(default=None, ge=8000, le=192000)
    channels: int = 1
    subtype: str | None = None
    session_name: str | None = None
    script_id: str | None = None
    take_number: int | None = Field(default=None, ge=1)


@method("record.start", params=StartParams)
def start(ctx: Ctx, p: StartParams) -> dict[str, Any]:
    """Open the microphone and start writing `recordings/<id>/original.wav`. One active session at a time."""
    st = ctx.server.state
    settings = st["settings"].value
    device_index = p.device_index if p.device_index is not None else settings.record_device_index
    sample_rate = p.sample_rate or settings.record_sample_rate or 48000
    subtype = p.subtype or settings.record_subtype or "PCM_24"
    if subtype not in BYTES_PER_SAMPLE:
        raise WorkerError(INVALID_PARAMS, f"Unsupported subtype {subtype!r}", {"allowed": sorted(BYTES_PER_SAMPLE)})
    if p.script_id and get_script(p.script_id) is None:
        raise WorkerError(INVALID_PARAMS, f"Unknown script {p.script_id!r}", {"script_ids": [s["id"] for s in reading_scripts()]})
    sessions = _sessions(ctx)
    with _sessions_lock:
        busy = [s.session_id for s in sessions.values() if s.active]
        if busy:
            raise WorkerError(INVALID_PARAMS, "A recording session is already active; stop or discard it first.",
                              {"active_session_id": busy[0]})
        session = RecordSession()
        session.meta = {"session_name": p.session_name, "script_id": p.script_id, "take_number": p.take_number}
        sessions[session.session_id] = session      # reserve the slot before the (slow) device open
    try:
        result = session.start(st["paths"], device_index, sample_rate, p.channels, subtype, on_event=ctx.server.transport.event)
    except BaseException:
        with _sessions_lock:
            sessions.pop(session.session_id, None)
        raise
    if settings.monitor_input:
        result["notes"].append("Input monitoring (settings.monitor_input) is not implemented in this version; the microphone "
                               "is not played back, so there is no feedback.")
    result["monitoring"] = False
    result["script_id"] = p.script_id
    result["take_number"] = p.take_number
    return result


class SessionParams(BaseModel):
    session_id: str
    script_id: str | None = None
    take_number: int | None = Field(default=None, ge=1)


@method("record.pause", params=SessionParams)
def pause(ctx: Ctx, p: SessionParams) -> dict[str, Any]:
    return _session(ctx, p.session_id).pause()


@method("record.resume", params=SessionParams)
def resume(ctx: Ctx, p: SessionParams) -> dict[str, Any]:
    return _session(ctx, p.session_id).resume()


@method("record.stop", params=SessionParams)
def stop(ctx: Ctx, p: SessionParams) -> dict[str, Any]:
    """Finish the WAV, register it as a `reference` asset (source `recording`) plus a `recordings` row."""
    st = ctx.server.state
    session = _session(ctx, p.session_id)
    result = session.stop()
    meta = session.meta
    script_id = p.script_id or meta.get("script_id")
    take_number = p.take_number or meta.get("take_number")
    original = Path(result["path"])
    if not original.exists() or result["duration_s"] <= 0:
        # nothing usable was written (e.g. the device failed immediately): no asset row, but say so honestly
        result.update({"asset_id": None, "recording_id": None, "working_path": None})
        result["notes"].append("No audio was written, so nothing was added to the library.")
        _sessions(ctx).pop(p.session_id, None)
        return result
    working = _decode_working(original, original.with_name("working.wav"), result["notes"])
    row = {
        "id": session.asset_id, "kind": "reference", "source": "recording",
        "original_name": (meta.get("session_name") or f"Recording {session.asset_id[-6:]}") + ".wav",
        "original_path": str(original), "working_path": str(working) if working else None,
        "sha256": _sha256(original), "format": "wav", "codec": SUBTYPE_CODEC.get(result["subtype"], result["subtype"].lower()),
        "duration_s": result["duration_s"], "sample_rate": result["sample_rate"], "channels": result["channels"],
        "bit_depth": BYTES_PER_SAMPLE.get(result["subtype"], 4) * 8, "size_bytes": original.stat().st_size,
        "stats_json": dumps(result["stats"]) if result["stats"] is not None else None,
    }
    db = st["db"]
    recording_id = new_id("take")
    with db.tx() as c:
        cols = list(row)
        c.execute(f"INSERT INTO assets ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", tuple(row[k] for k in cols))
        c.execute("INSERT INTO recordings (id, asset_id, device_name, negotiated_json, script_id, take_number) VALUES (?, ?, ?, ?, ?, ?)",
                  (recording_id, session.asset_id, result["negotiated"].get("device_name"),
                   dumps({**result["negotiated"], "notes": result["notes"], "overflows": result["overflows"],
                          "clip_count_total": result["clip_count_total"], "error": result["error"]}),
                   script_id, take_number))
    _sessions(ctx).pop(p.session_id, None)
    result.update({"asset_id": session.asset_id, "recording_id": recording_id, "working_path": str(working) if working else None,
                   "script_id": script_id, "take_number": take_number})
    return result


@method("record.discard", params=SessionParams)
def discard(ctx: Ctx, p: SessionParams) -> dict[str, Any]:
    session = _session(ctx, p.session_id)
    out = session.discard()
    _sessions(ctx).pop(p.session_id, None)
    return out


@method("record.scripts")
def scripts(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    return {"scripts": reading_scripts()}


def shutdown_sessions(state: dict[str, Any]) -> None:
    """Stop every active session (called from the worker's shutdown hook so files get valid headers)."""
    for s in list((state.get("record_sessions") or {}).values()):
        try:
            if s.active:
                s.stop()
        except Exception:  # noqa: BLE001
            log.exception("stopping session %s at shutdown", s.session_id)


# ---- helpers
def _decode_working(original: Path, working: Path, notes: list[str]) -> Path | None:
    """float32 mono working copy through the audio module's ffmpeg wrapper when it exists; else None (documented)."""
    try:
        from ..audio.ffmpeg import decode_to_wav
    except ImportError:
        notes.append("audio.ffmpeg.decode_to_wav is not available; working.wav was not created (audio.import can decode later).")
        return None
    try:
        decode_to_wav(original, working)
    except Exception as e:  # noqa: BLE001 — the original is safe on disk; the working copy is regenerable
        log.warning("decode_to_wav failed for %s: %s", original, e)
        notes.append(f"Creating working.wav failed: {str(e)[:200]}")
        return None
    if not working.exists():
        return None
    try:
        os.chmod(working, 0o600)
    except OSError:
        pass
    return working


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
