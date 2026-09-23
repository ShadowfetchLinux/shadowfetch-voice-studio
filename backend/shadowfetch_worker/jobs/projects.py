"""projects.* methods: project rows, script versions, segments/takes, duplication and deletion.

Project files live under paths.projects/<project_id>/ (segments/<segment_id>/<take_id>.wav, master.wav).
Deleting a project removes only that directory; assets and voices are never touched.
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..protocol import INVALID_PARAMS, NOT_FOUND, WorkerError
from ..rpc import Ctx, method
from ..store import repo
from ..store.db import dumps, loads, new_id

log = logging.getLogger("projects")


def S(ctx: Ctx) -> dict[str, Any]:
    return ctx.server.state


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1)
    voice_id: str | None = None
    reference_id: str | None = None
    engine_id: str | None = None
    folder: str = ""
    tags: list[str] = Field(default_factory=list)
    language: str | None = None
    notes: str | None = None
    script_text: str | None = None


class ProjectList(BaseModel):
    query: str | None = None
    tags: list[str] = Field(default_factory=list)
    favorite: bool | None = None
    archived: bool | None = False        # False: active only, True: archived only, None: both
    folder: str | None = None
    include_speak: bool = False          # the Speak screen's scratch project is internal
    sort: Literal["updated", "created", "name"] = "updated"
    limit: int = 500


class IdParams(BaseModel):
    id: str


class ProjectUpdate(BaseModel):
    id: str
    patch: dict[str, Any]


class Duplicate(BaseModel):
    id: str
    name: str | None = None


class Archive(BaseModel):
    id: str
    archived: bool = True


class Delete(BaseModel):
    id: str
    confirm: bool = False


class SaveScript(BaseModel):
    id: str
    text: str


class SelectTake(BaseModel):
    id: str
    segment_index: int
    take_id: str | None


# ---- helpers
def _resolve_voice(db, voice_id: str | None, reference_id: str | None) -> tuple[str | None, str | None]:
    """Validate voice/reference ids; default the reference to the voice's selected one."""
    if reference_id and not voice_id:
        ref = db.require("voice_references", reference_id)
        voice_id = ref["voice_id"]
    if not voice_id:
        return None, None
    voice = db.require("voices", voice_id)
    if reference_id:
        ref = db.require("voice_references", reference_id)
        if ref["voice_id"] != voice_id:
            raise WorkerError(INVALID_PARAMS, "That reference belongs to a different voice.")
    else:
        reference_id = voice["selected_reference_id"]
    return voice_id, reference_id


def project_view(state: dict[str, Any], project_id: str) -> dict[str, Any]:
    """{project, script, segments (current plan, with takes), exports} as returned by projects.get."""
    db = state["db"]
    row = db.require("projects", project_id)
    proj = repo.project_dict(row)
    script = repo.latest_script(db, project_id)
    voice = db.one("SELECT name FROM voices WHERE id = ?", (proj["voice_id"],)) if proj["voice_id"] else None
    proj["voice_name"] = voice["name"] if voice else None
    return {
        "project": proj,
        "script": {"text": script["text"], "version": script["version"], "updated_at": script["created_at"]} if script else None,
        "segments": repo.segments_with_takes(db, row),
        "exports": [repo.export_dict(r) for r in db.all("SELECT * FROM exports WHERE project_id = ? ORDER BY created_at DESC", (project_id,))],
    }


def _summary(db, row) -> dict[str, Any]:
    d = repo.project_dict(row)
    voice = db.one("SELECT name FROM voices WHERE id = ?", (d["voice_id"],)) if d["voice_id"] else None
    d["voice_name"] = voice["name"] if voice else None
    script = repo.latest_script(db, d["id"])
    d["script_excerpt"] = (script["text"][:160] if script else "")
    d["script_version"] = script["version"] if script else 0
    counts = db.one("SELECT COUNT(*) AS n, SUM(selected_take_id IS NOT NULL) AS done FROM segments WHERE project_id = ? AND plan_version = ?",
                    (d["id"], row["plan_version"]))
    d["segment_count"], d["generated_count"] = int(counts["n"] or 0), int(counts["done"] or 0)
    d["has_master"] = bool(d["master_path"] and Path(d["master_path"]).exists())
    return d


# ---- methods
@method("projects.create", params=ProjectCreate)
def create(ctx: Ctx, p: ProjectCreate) -> dict[str, Any]:
    st = S(ctx)
    db, settings = st["db"], st["settings"].value
    voice_id, reference_id = _resolve_voice(db, p.voice_id, p.reference_id)
    language = p.language or (db.require("voices", voice_id)["language"] if voice_id else settings.default_language)
    pid = new_id("proj")
    db.insert("projects", {"id": pid, "name": p.name.strip(), "folder": p.folder.strip(), "tags_json": dumps(p.tags),
                           "voice_id": voice_id, "reference_id": reference_id, "engine_id": p.engine_id or settings.default_engine,
                           "language": language, "settings_json": dumps({"plan": repo.default_plan_options(settings), "controls": {}, "seed": None}),
                           "notes": p.notes})
    repo.project_dir(st["paths"], pid).mkdir(parents=True, exist_ok=True)
    if p.script_text is not None:
        repo.save_script(db, pid, p.script_text)
    return project_view(st, pid)["project"]


@method("projects.list", params=ProjectList)
def list_(ctx: Ctx, p: ProjectList) -> dict[str, Any]:
    st = S(ctx)
    db = st["db"]
    where, args = [], []
    speak_id = st["settings"].value.speak_project_id if st.get("settings") is not None else None
    if speak_id and not p.include_speak:
        where.append("id != ?")
        args.append(speak_id)
    if p.archived is not None:
        where.append("archived = ?")
        args.append(int(p.archived))
    if p.favorite is not None:
        where.append("favorite = ?")
        args.append(int(p.favorite))
    if p.folder is not None:
        where.append("folder = ?")
        args.append(p.folder)
    if p.query:
        where.append("(name LIKE ? OR tags_json LIKE ? OR IFNULL(notes,'') LIKE ?)")
        args += [f"%{p.query}%"] * 3
    for tag in p.tags:
        where.append("EXISTS (SELECT 1 FROM json_each(projects.tags_json) WHERE value = ?)")
        args.append(tag)
    order = {"updated": "updated_at DESC, rowid DESC", "created": "created_at DESC, rowid DESC", "name": "name COLLATE NOCASE ASC"}[p.sort]
    sql = "SELECT * FROM projects" + (" WHERE " + " AND ".join(where) if where else "") + f" ORDER BY {order} LIMIT ?"
    rows = db.all(sql, tuple(args) + (p.limit,))
    return {"projects": [_summary(db, r) for r in rows]}


@method("projects.get", params=IdParams)
def get(ctx: Ctx, p: IdParams) -> dict[str, Any]:
    return project_view(S(ctx), p.id)


_PATCH_FIELDS = {"name", "folder", "tags", "favorite", "archived", "voice_id", "reference_id", "engine_id", "language", "notes", "settings"}


@method("projects.update", params=ProjectUpdate)
def update(ctx: Ctx, p: ProjectUpdate) -> dict[str, Any]:
    st = S(ctx)
    db = st["db"]
    row = db.require("projects", p.id)
    unknown = set(p.patch) - _PATCH_FIELDS
    if unknown:
        raise WorkerError(INVALID_PARAMS, f"Unknown project fields: {', '.join(sorted(unknown))}", {"allowed": sorted(_PATCH_FIELDS)})
    patch = dict(p.patch)
    fields: dict[str, Any] = {}
    if "voice_id" in patch or "reference_id" in patch:
        voice_id = patch.get("voice_id", row["voice_id"])
        reference_id = patch.get("reference_id") if "reference_id" in patch else (row["reference_id"] if voice_id == row["voice_id"] else None)
        fields["voice_id"], fields["reference_id"] = _resolve_voice(db, voice_id, reference_id)
    if "settings" in patch:
        repo.merge_project_settings(db, p.id, dict(patch["settings"] or {}))
    for k in ("name", "folder", "engine_id", "language", "notes"):
        if k in patch:
            v = patch[k]
            if k == "name" and not str(v or "").strip():
                raise WorkerError(INVALID_PARAMS, "Project name cannot be empty.")
            fields[k] = v.strip() if isinstance(v, str) and k in ("name", "folder") else v
    if "tags" in patch:
        fields["tags_json"] = dumps([str(t) for t in (patch["tags"] or [])])
    for k in ("favorite", "archived"):
        if k in patch:
            fields[k] = int(bool(patch[k]))
    if fields:
        db.update("projects", p.id, fields)
    else:
        repo.touch(db, "projects", p.id)
    return project_view(st, p.id)["project"]


@method("projects.duplicate", params=Duplicate)
def duplicate(ctx: Ctx, p: Duplicate) -> dict[str, Any]:
    """Copy the project row, all script versions, the current plan's segments and their take files, and the master."""
    st = S(ctx)
    db, paths = st["db"], st["paths"]
    src = db.require("projects", p.id)
    new_pid = new_id("proj")
    new_dir = repo.project_dir(paths, new_pid)
    new_dir.mkdir(parents=True, exist_ok=True)
    master_path, master_json = None, None
    if src["master_path"] and Path(src["master_path"]).exists():
        master_path = str(new_dir / "master.wav")
        shutil.copy2(src["master_path"], master_path)
        m = loads(src["master_json"], {}) or {}
        m["path"] = master_path
        master_json = dumps(m)
    db.insert("projects", {
        "id": new_pid, "name": (p.name or f"{src['name']} (copy)").strip(), "folder": src["folder"], "tags_json": src["tags_json"],
        "favorite": 0, "archived": 0, "voice_id": src["voice_id"], "reference_id": src["reference_id"], "engine_id": src["engine_id"],
        "language": src["language"], "settings_json": src["settings_json"], "plan_version": src["plan_version"],
        "master_path": master_path, "master_json": master_json, "notes": src["notes"]})
    scripts = db.all("SELECT * FROM scripts WHERE project_id = ? ORDER BY version", (p.id,))
    segments = repo.current_segments(db, src)
    takes = repo.takes_by_segment(db, [s["id"] for s in segments])
    copied = 0
    with db.tx() as c:
        for s in scripts:
            c.execute("INSERT INTO scripts (id, project_id, version, text, created_at) VALUES (?, ?, ?, ?, ?)",
                      (new_id("scr"), new_pid, s["version"], s["text"], s["created_at"]))
        for s in segments:
            new_sid = new_id("seg")
            c.execute("INSERT INTO segments (id, project_id, plan_version, idx, paragraph, text, normalized_text, substitutions_json) "
                      "VALUES (?,?,?,?,?,?,?,?)", (new_sid, new_pid, s["plan_version"], s["idx"], s["paragraph"], s["text"],
                                                  s["normalized_text"], s["substitutions_json"]))
            for t in takes.get(s["id"], []):
                new_tid = new_id("take")
                dst = new_dir / "segments" / new_sid / f"{new_tid}.wav"
                if Path(t["path"]).exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(t["path"], dst)
                    copied += 1
                c.execute("INSERT INTO takes (id, segment_id, project_id, engine_id, model_revision, reference_id, path, sample_rate, "
                          "duration_s, seed, settings_json, label, status, created_at, reference_fingerprint, language) "
                          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (new_tid, new_sid, new_pid, t["engine_id"], t["model_revision"], t["reference_id"], str(dst), t["sample_rate"],
                           t["duration_s"], t["seed"], dumps(t["settings"]), t["label"], t["status"], t["created_at"],
                           t.get("reference_fingerprint"), t.get("language")))
                if t["id"] == s["selected_take_id"]:
                    c.execute("UPDATE segments SET selected_take_id = ? WHERE id = ?", (new_tid, new_sid))
    log.info("duplicated project %s -> %s (%d take files)", p.id, new_pid, copied)
    return project_view(st, new_pid)["project"]


@method("projects.archive", params=Archive)
def archive(ctx: Ctx, p: Archive) -> dict[str, Any]:
    st = S(ctx)
    st["db"].require("projects", p.id)
    st["db"].update("projects", p.id, {"archived": int(p.archived)})
    return project_view(st, p.id)["project"]


@method("projects.delete", params=Delete)
def delete(ctx: Ctx, p: Delete) -> dict[str, Any]:
    st = S(ctx)
    db = st["db"]
    db.require("projects", p.id)
    if not p.confirm:
        raise WorkerError(INVALID_PARAMS, "Deleting a project removes its generated takes and master. Pass confirm:true to proceed.")
    with db.tx() as c:
        c.execute("DELETE FROM projects WHERE id = ?", (p.id,))     # cascades scripts, segments, takes, exports rows
    repo.remove_tree(repo.project_dir(st["paths"], p.id))          # never assets or voices
    return {"ok": True, "id": p.id}


@method("projects.save_script", params=SaveScript)
def save_script(ctx: Ctx, p: SaveScript) -> dict[str, Any]:
    db = S(ctx)["db"]
    db.require("projects", p.id)
    version, changed = repo.save_script(db, p.id, p.text)
    return {"script_version": version, "changed": changed}


@method("projects.select_take", params=SelectTake)
def select_take(ctx: Ctx, p: SelectTake) -> dict[str, Any]:
    db = S(ctx)["db"]
    proj = db.require("projects", p.id)
    seg = db.one("SELECT * FROM segments WHERE project_id = ? AND plan_version = ? AND idx = ?", (p.id, proj["plan_version"], p.segment_index))
    if seg is None:
        raise WorkerError(NOT_FOUND, f"Segment {p.segment_index} is not in the current plan.", {"segment_index": p.segment_index})
    if p.take_id is not None:
        take = db.require("takes", p.take_id)
        if take["segment_id"] != seg["id"]:
            raise WorkerError(INVALID_PARAMS, "That take belongs to a different segment.")
    db.update("segments", seg["id"], {"selected_take_id": p.take_id}, touch=False)
    repo.touch(db, "projects", p.id)
    return {"ok": True, "segment_id": seg["id"], "segment_index": p.segment_index, "take_id": p.take_id}
