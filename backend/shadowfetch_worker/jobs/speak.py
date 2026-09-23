"""speak.* methods: the Speak screen's scratch project and its Recent list.

The Speak screen is a thin front over the regular project pipeline (tts.plan → tts.generate → tts.assemble). It uses
one automatically managed project — created on first use, hidden from the project list — whose script is the text in
the editor and whose voice is the one picked in the voice menu. After each assemble the UI calls `speak.remember`,
which copies the master into a history file of its own (so the next Speak never overwrites what Recent plays) and
prunes the scratch project's superseded takes so it does not grow without bound.
"""
from __future__ import annotations

import logging
import os
import shutil
import threading
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..paths import require_free_space
from ..protocol import INVALID_PARAMS, NOT_FOUND, WorkerError
from ..rpc import Ctx, method
from ..store import repo
from ..store.db import dumps, loads, new_id

log = logging.getLogger("speak")

MAX_HISTORY = 30
SPEAK_PROJECT_NAME = "Speak"
_ENSURE_LOCK = threading.Lock()   # requests run on worker threads: two first calls must not create two projects


def S(ctx: Ctx) -> dict[str, Any]:
    return ctx.server.state


def speak_project_id(state: dict[str, Any]) -> str | None:
    """Id of the scratch project (None before the Speak screen was first used)."""
    settings = state.get("settings")
    return settings.value.speak_project_id if settings is not None else None


def ensure_speak_project(state: dict[str, Any]) -> dict[str, Any]:
    """The scratch project row as a dict, created (and remembered in settings) when missing or deleted."""
    with _ENSURE_LOCK:
        return _ensure_speak_project(state)


def _ensure_speak_project(state: dict[str, Any]) -> dict[str, Any]:
    db, settings = state["db"], state["settings"]
    pid = settings.value.speak_project_id
    row = db.one("SELECT * FROM projects WHERE id = ?", (pid,)) if pid else None
    if row is None:
        pid = new_id("proj")
        s = settings.value
        db.insert("projects", {"id": pid, "name": SPEAK_PROJECT_NAME, "folder": "", "tags_json": "[]", "engine_id": s.default_engine,
                               "language": s.default_language, "notes": "Managed by the Speak screen.",
                               "settings_json": dumps({"plan": repo.default_plan_options(s), "controls": {}, "seed": None})})
        repo.project_dir(state["paths"], pid).mkdir(parents=True, exist_ok=True)
        settings.patch({"speak_project_id": pid})
        log.info("created the Speak scratch project %s", pid)
        row = db.require("projects", pid)
    return repo.project_dict(row)


def _history_dir(state: dict[str, Any], project_id: str) -> Path:
    return repo.project_dir(state["paths"], project_id) / "history"


def _entry(row) -> dict[str, Any]:
    d = dict(row)
    d["exists"] = bool(d.get("path")) and Path(d["path"]).is_file()
    return d


def history(state: dict[str, Any], project_id: str, limit: int = MAX_HISTORY) -> list[dict[str, Any]]:
    rows = state["db"].all("SELECT * FROM speak_history WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
                           (project_id, limit))
    return [_entry(r) for r in rows]


def prune_takes(state: dict[str, Any], project_id: str) -> dict[str, int]:
    """Drop what the scratch project no longer needs: segments of older plans and every take that is not the
    selected take of a current segment (rows + files). History entries own copies, so nothing they play is lost."""
    db, paths = state["db"], state["paths"]
    row = db.require("projects", project_id)
    keep = {r["selected_take_id"] for r in repo.current_segments(db, row) if r["selected_take_id"]}
    doomed = [r for r in db.all("SELECT id, path, segment_id FROM takes WHERE project_id = ?", (project_id,)) if r["id"] not in keep]
    pdir = repo.project_dir(paths, project_id).resolve()
    for t in doomed:
        p = Path(t["path"])
        try:
            if p.resolve().is_relative_to(pdir):     # only files inside the scratch project are ever removed
                p.unlink(missing_ok=True)
        except OSError as e:
            log.warning("could not remove take file %s: %s", p, e)
    with db.tx() as c:
        for t in doomed:
            c.execute("DELETE FROM takes WHERE id = ?", (t["id"],))
        old = c.execute("DELETE FROM segments WHERE project_id = ? AND plan_version < ?", (project_id, row["plan_version"])).rowcount
    seg_root = pdir / "segments"
    if seg_root.is_dir():
        live = {r["id"] for r in db.all("SELECT id FROM segments WHERE project_id = ?", (project_id,))}
        for d in seg_root.iterdir():
            if d.is_dir() and d.name not in live:
                shutil.rmtree(d, ignore_errors=True)
    return {"takes_removed": len(doomed), "segments_removed": int(old or 0)}


def _trim_history(state: dict[str, Any], project_id: str, keep: int) -> int:
    db = state["db"]
    rows = db.all("SELECT id, path FROM speak_history WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?",
                  (project_id, keep))
    for r in rows:
        _delete_history_file(state, project_id, r["path"])
    with db.tx() as c:
        for r in rows:
            c.execute("DELETE FROM speak_history WHERE id = ?", (r["id"],))
    return len(rows)


def _delete_history_file(state: dict[str, Any], project_id: str, path: str | None) -> None:
    if not path:
        return
    p = Path(path)
    try:
        if p.resolve().is_relative_to(_history_dir(state, project_id).resolve()):
            p.unlink(missing_ok=True)
    except OSError as e:
        log.warning("could not remove history file %s: %s", p, e)


# ---------------------------------------------------------------- methods
class SessionParams(BaseModel):
    history_limit: int = Field(default=10, ge=0, le=MAX_HISTORY)


@method("speak.session", params=SessionParams)
def session(ctx: Ctx, p: SessionParams) -> dict[str, Any]:
    """Open (creating on first use) the scratch project: its id, the saved text, the remembered voice and Recent."""
    st = S(ctx)
    db = st["db"]
    proj = ensure_speak_project(st)
    script = repo.latest_script(db, proj["id"])
    voice_id = proj["voice_id"]
    if voice_id and db.one("SELECT id FROM voices WHERE id = ? AND archived = 0", (voice_id,)) is None:
        voice_id = None
    return {"project_id": proj["id"], "text": script["text"] if script else "", "script_version": script["version"] if script else 0,
            "voice_id": voice_id, "engine_id": proj["engine_id"], "language": proj["language"],
            "settings": proj["settings"], "history": history(st, proj["id"], p.history_limit)}


class HistoryParams(BaseModel):
    limit: int = Field(default=MAX_HISTORY, ge=1, le=MAX_HISTORY)


@method("speak.history", params=HistoryParams)
def history_list(ctx: Ctx, p: HistoryParams) -> dict[str, Any]:
    st = S(ctx)
    return {"history": history(st, ensure_speak_project(st)["id"], p.limit)}


class RememberParams(BaseModel):
    project_id: str
    text: str
    voice_id: str | None = None
    keep: int = Field(default=MAX_HISTORY, ge=1, le=MAX_HISTORY)


@method("speak.remember", params=RememberParams)
def remember(ctx: Ctx, p: RememberParams) -> dict[str, Any]:
    """Snapshot the project's freshly assembled master into Recent, then prune superseded takes and old entries."""
    st = S(ctx)
    db = st["db"]
    if p.project_id != speak_project_id(st):
        raise WorkerError(INVALID_PARAMS, "speak.remember only works on the Speak scratch project.", {"project_id": p.project_id})
    row = db.require("projects", p.project_id)
    master = Path(row["master_path"]) if row["master_path"] else None
    if master is None or not master.is_file():
        raise WorkerError(NOT_FOUND, "There is no assembled speech to keep yet.", {"project_id": p.project_id})
    info = loads(row["master_json"], {}) or {}
    hid = new_id("speech")
    hdir = _history_dir(st, p.project_id)
    hdir.mkdir(parents=True, exist_ok=True)
    dst = hdir / f"{hid}.wav"
    try:
        os.link(master, dst)       # tts.assemble replaces master.wav atomically (new inode), so a hard link is a safe snapshot
    except OSError:
        require_free_space(hdir, master.stat().st_size, "keeping this speech")
        shutil.copy2(master, dst)
    voice_id = p.voice_id or row["voice_id"]
    voice = db.one("SELECT name FROM voices WHERE id = ?", (voice_id,)) if voice_id else None
    db.insert("speak_history", {"id": hid, "project_id": p.project_id, "text": p.text, "voice_id": voice_id,
                                "voice_name": voice["name"] if voice else None, "engine_id": row["engine_id"], "path": str(dst),
                                "duration_s": info.get("duration_s"), "sample_rate": info.get("sample_rate")})
    pruned = prune_takes(st, p.project_id)
    pruned["history_removed"] = _trim_history(st, p.project_id, p.keep)
    entry = _entry(db.require("speak_history", hid))
    return {**entry, "pruned": pruned}


class ForgetParams(BaseModel):
    id: str


@method("speak.forget", params=ForgetParams)
def forget(ctx: Ctx, p: ForgetParams) -> dict[str, Any]:
    st = S(ctx)
    db = st["db"]
    row = db.require("speak_history", p.id)
    _delete_history_file(st, row["project_id"], row["path"])
    with db.tx() as c:
        c.execute("DELETE FROM speak_history WHERE id = ?", (p.id,))
    return {"ok": True, "id": p.id}
