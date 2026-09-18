"""voices.* methods: voice profiles and their reference clips.

A voice is metadata + one or more references (asset + trim + transcript + processing). Derived engine-specific
reference files live under paths.voices/<voice_id>/references/<reference_id>/ and are regenerable; deleting a
voice never deletes assets or recordings.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..protocol import ENGINE_UNAVAILABLE, INVALID_PARAMS, NOT_FOUND, WorkerError
from ..rpc import Ctx, method
from ..store import repo
from ..store.db import dumps, loads, new_id

log = logging.getLogger("voices")


def S(ctx: Ctx) -> dict[str, Any]:
    return ctx.server.state


class Trim(BaseModel):
    start_s: float
    end_s: float


class VoiceCreate(BaseModel):
    name: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)
    language: str = "en"
    rights_confirmed: bool = False
    rights_note: str | None = None
    asset_id: str
    trim: Trim
    transcript: str = ""
    transcript_source: str = "edited"
    transcript_confirmed: bool = True
    asr_model: str | None = None
    engine_id: str | None = None
    processing: list[dict[str, Any]] = Field(default_factory=list)
    label: str | None = None
    notes: str | None = None


class IdParams(BaseModel):
    id: str


class VoiceList(BaseModel):
    include_archived: bool = False
    query: str | None = None


class VoiceUpdate(BaseModel):
    id: str
    patch: dict[str, Any]


class VoiceDelete(BaseModel):
    id: str
    force: bool = False


class AddReference(BaseModel):
    voice_id: str
    asset_id: str
    trim: Trim
    transcript: str = ""
    transcript_source: str = "edited"
    transcript_confirmed: bool = True
    asr_model: str | None = None
    processing: list[dict[str, Any]] = Field(default_factory=list)
    label: str | None = None
    select: bool = False
    engine_id: str | None = None


class SelectReference(BaseModel):
    voice_id: str
    reference_id: str


class UpdateReference(BaseModel):
    reference_id: str
    patch: dict[str, Any]


# ---- helpers
def _validate_trim(asset, trim: Trim) -> None:
    if trim.start_s < 0 or trim.end_s <= trim.start_s:
        raise WorkerError(INVALID_PARAMS, f"Trim must satisfy 0 <= start_s < end_s (got {trim.start_s} .. {trim.end_s}).")
    dur = asset["duration_s"]
    if dur is not None and trim.end_s > float(dur) + 0.01:
        raise WorkerError(INVALID_PARAMS, f"Trim end {trim.end_s:.2f}s is beyond the clip duration of {float(dur):.2f}s.",
                          {"duration_s": dur})


def _insert_reference(db, voice_id: str, asset, trim: Trim, transcript: str, processing: list, label: str | None,
                      transcript_source: str, transcript_confirmed: bool, asr_model: str | None) -> str:
    if not (transcript or "").strip():
        raise WorkerError(INVALID_PARAMS, "A transcript of the reference clip is required (type it or run transcription).")
    _validate_trim(asset, trim)
    from ..audio import edit
    if hasattr(edit, "parse_steps"):
        edit.parse_steps([x for x in (processing or []) if isinstance(x, dict) and x.get("op")])   # INVALID_PARAMS on unknown ops
    ref_id = new_id("ref")
    fp = repo.reference_fingerprint(asset["sha256"], trim.start_s, trim.end_s, transcript, processing)
    db.insert("voice_references", {
        "id": ref_id, "voice_id": voice_id, "asset_id": asset["id"], "label": label, "start_s": float(trim.start_s),
        "end_s": float(trim.end_s), "transcript": transcript.strip(), "transcript_source": transcript_source,
        "transcript_confirmed": int(bool(transcript_confirmed)), "asr_model": asr_model, "processing_json": dumps(processing),
        "fingerprint": fp, "derived_json": "{}"})
    return ref_id


def _validate_against_engine(state: dict[str, Any], engine_id: str | None, trim: Trim) -> None:
    """When the user names a target engine, reject references outside its declared reference window at save time."""
    engines = state.get("engines")
    if not engine_id or engines is None:
        return
    try:
        req = engines.capabilities(engine_id).reference
    except WorkerError:
        return
    dur = float(trim.end_s) - float(trim.start_s)
    if dur <= req.min_seconds:
        raise WorkerError(INVALID_PARAMS, f"This engine needs more than {req.min_seconds:g} s of reference audio (selected {dur:.2f} s).",
                          {"min_seconds": req.min_seconds, "max_seconds": req.max_seconds, "duration_s": dur})
    if dur > req.max_seconds:
        raise WorkerError(INVALID_PARAMS, f"This engine uses at most {req.max_seconds:g} s of reference audio (selected {dur:.2f} s); "
                          f"shorten the selection.", {"min_seconds": req.min_seconds, "max_seconds": req.max_seconds, "duration_s": dur})


def _voice(ctx: Ctx, voice_id: str) -> dict[str, Any]:
    db = S(ctx)["db"]
    return repo.voice_dict(db, db.require("voices", voice_id))


def ensure_reference_file(state: dict[str, Any], reference_row, engine_id: str) -> Path:
    """Return the engine-specific derived wav for a reference, building it with audio.edit.prepare_reference when
    missing or stale (fingerprint changed). Cached per engine in voice_references.derived_json."""
    db, paths = state["db"], state["paths"]
    ref = dict(reference_row)
    derived = loads(ref.get("derived_json"), {}) or {}
    entry = derived.get(engine_id) or {}
    if entry.get("fingerprint") == ref["fingerprint"] and entry.get("path") and Path(entry["path"]).exists():
        return Path(entry["path"])
    engines = state.get("engines")
    if engines is None:
        raise WorkerError(ENGINE_UNAVAILABLE, "The engine manager is not available in this worker.", recoverable=False)
    caps = engines.capabilities(engine_id)
    asset = db.require("assets", ref["asset_id"])
    src = asset["working_path"] or asset["original_path"]
    if not src or not Path(src).exists():
        raise WorkerError(NOT_FOUND, "The audio file for this reference is missing on disk.", {"path": src, "asset_id": asset["id"]})
    dst = repo.reference_dir(paths, ref["voice_id"], ref["id"]) / f"reference.{engine_id}.wav"
    dst.parent.mkdir(parents=True, exist_ok=True)
    from ..audio import edit
    # The stored processing list (normalize / trim_silence / highpass / gain) is part of the reference fingerprint and is
    # what the user auditioned with audio.preview_processing, so the derived engine file must apply exactly those steps.
    steps = [dict(x) for x in (loads(ref.get("processing_json"), []) or []) if isinstance(x, dict) and x.get("op")]
    if hasattr(edit, "parse_steps"):
        edit.parse_steps(steps)
    if steps and hasattr(edit, "apply_processing"):
        tmp = dst.with_name(dst.stem + ".raw.tmp.wav")
        edit.prepare_reference(Path(src), tmp, caps.reference.sample_rate, channels=caps.reference.channels,
                               start_s=ref["start_s"], end_s=ref["end_s"], normalize_peak_dbfs=None)
        try:
            info = edit.apply_processing(tmp, dst, steps, subtype="PCM_24")
        finally:
            tmp.unlink(missing_ok=True)
    else:
        info = edit.prepare_reference(Path(src), dst, caps.reference.sample_rate, channels=caps.reference.channels,
                                      start_s=ref["start_s"], end_s=ref["end_s"],
                                      normalize_peak_dbfs=repo.normalize_peak_from(steps) if steps else None)
    derived[engine_id] = {**(info or {}), "path": str(dst), "fingerprint": ref["fingerprint"], "processing": steps,
                          "sample_rate": (info or {}).get("sample_rate", caps.reference.sample_rate),
                          "channels": (info or {}).get("channels", caps.reference.channels)}
    db.update("voice_references", ref["id"], {"derived_json": dumps(derived)}, touch=False)
    return dst


def _invalidate_reference(state: dict[str, Any], ref) -> None:
    """Drop everything derived from a reference (engine wavs, prompt caches)."""
    db, paths = state["db"], state["paths"]
    repo.delete_prompt_cache(db, ref["id"])
    repo.remove_tree(repo.reference_dir(paths, ref["voice_id"], ref["id"]))
    db.update("voice_references", ref["id"], {"derived_json": "{}"}, touch=False)


# ---- methods
@method("voices.create", params=VoiceCreate)
def create(ctx: Ctx, p: VoiceCreate) -> dict[str, Any]:
    st = S(ctx)
    db = st["db"]
    if p.rights_confirmed is not True:
        raise WorkerError(INVALID_PARAMS, "Please confirm that you have the rights and consent to clone this voice "
                          "(rights_confirmed must be true).", {"field": "rights_confirmed"})
    asset = db.require("assets", p.asset_id)
    _validate_against_engine(st, p.engine_id, p.trim)
    voice_id = new_id("voice")
    db.insert("voices", {"id": voice_id, "name": p.name.strip(), "tags_json": dumps(p.tags), "language": p.language,
                         "rights_confirmed": 1, "rights_note": p.rights_note, "notes": p.notes})
    try:
        ref_id = _insert_reference(db, voice_id, asset, p.trim, p.transcript, p.processing, p.label, p.transcript_source,
                                   p.transcript_confirmed, p.asr_model)
    except WorkerError:
        with db.tx() as c:
            c.execute("DELETE FROM voices WHERE id = ?", (voice_id,))
        raise
    db.update("voices", voice_id, {"selected_reference_id": ref_id})
    repo.voice_dir(st["paths"], voice_id).mkdir(parents=True, exist_ok=True)
    out = _voice(ctx, voice_id)
    if p.engine_id:
        try:
            ensure_reference_file(st, db.require("voice_references", ref_id), p.engine_id)
            out = _voice(ctx, voice_id)
        except Exception as e:  # noqa: BLE001 - the derived file is regenerable; creation must not fail because of it
            log.warning("could not prepare reference for %s: %s", p.engine_id, e)
            out["warnings"] = [f"Reference file for {p.engine_id} could not be prepared yet: {e}"]
    return out


@method("voices.list", params=VoiceList)
def list_(ctx: Ctx, p: VoiceList) -> dict[str, Any]:
    db = S(ctx)["db"]
    sql, args = "SELECT * FROM voices", []
    where = [] if p.include_archived else ["archived = 0"]
    if p.query:
        where.append("(name LIKE ? OR tags_json LIKE ? OR IFNULL(notes,'') LIKE ?)")
        args += [f"%{p.query}%"] * 3
    if where:
        sql += " WHERE " + " AND ".join(where)
    rows = db.all(sql + " ORDER BY favorite DESC, updated_at DESC", tuple(args))
    return {"voices": [repo.voice_dict(db, r, with_references=True) for r in rows]}


@method("voices.get", params=IdParams)
def get(ctx: Ctx, p: IdParams) -> dict[str, Any]:
    return _voice(ctx, p.id)


_VOICE_PATCH = {"name", "tags", "language", "notes", "favorite", "archived", "rights_note"}


@method("voices.update", params=VoiceUpdate)
def update(ctx: Ctx, p: VoiceUpdate) -> dict[str, Any]:
    db = S(ctx)["db"]
    db.require("voices", p.id)
    unknown = set(p.patch) - _VOICE_PATCH
    if unknown:
        raise WorkerError(INVALID_PARAMS, f"Unknown voice fields: {', '.join(sorted(unknown))}", {"allowed": sorted(_VOICE_PATCH)})
    fields: dict[str, Any] = {}
    for k, v in p.patch.items():
        if k == "tags":
            fields["tags_json"] = dumps([str(t) for t in (v or [])])
        elif k in ("favorite", "archived"):
            fields[k] = int(bool(v))
        elif k == "name":
            if not str(v or "").strip():
                raise WorkerError(INVALID_PARAMS, "Voice name cannot be empty.")
            fields[k] = str(v).strip()
        else:
            fields[k] = v
    db.update("voices", p.id, fields)
    return _voice(ctx, p.id)


@method("voices.delete", params=VoiceDelete)
def delete(ctx: Ctx, p: VoiceDelete) -> dict[str, Any]:
    st = S(ctx)
    db = st["db"]
    db.require("voices", p.id)
    used = [{"id": r["id"], "name": r["name"]} for r in db.all("SELECT id, name FROM projects WHERE voice_id = ? ORDER BY name", (p.id,))]
    if used and not p.force:
        raise WorkerError(INVALID_PARAMS, f"This voice is used by {len(used)} project(s). Pass force:true to delete it anyway; "
                          "those projects keep their generated takes but lose their voice link.", {"used_by_projects": used})
    refs = db.all("SELECT * FROM voice_references WHERE voice_id = ?", (p.id,))
    for r in refs:
        repo.delete_prompt_cache(db, r["id"])
    with db.tx() as c:
        c.execute("DELETE FROM voices WHERE id = ?", (p.id,))      # cascades voice_references (+ prompt_cache); projects -> NULL
    repo.remove_tree(repo.voice_dir(st["paths"], p.id))            # derived files only; assets/recordings stay
    return {"ok": True, "id": p.id, "unlinked_projects": used}


@method("voices.add_reference", params=AddReference)
def add_reference(ctx: Ctx, p: AddReference) -> dict[str, Any]:
    db = S(ctx)["db"]
    voice = db.require("voices", p.voice_id)
    asset = db.require("assets", p.asset_id)
    _validate_against_engine(S(ctx), p.engine_id, p.trim)
    ref_id = _insert_reference(db, p.voice_id, asset, p.trim, p.transcript, p.processing, p.label, p.transcript_source,
                               p.transcript_confirmed, p.asr_model)
    if p.select or not voice["selected_reference_id"]:
        db.update("voices", p.voice_id, {"selected_reference_id": ref_id})
    else:
        repo.touch(db, "voices", p.voice_id)
    return repo.reference_dict(db.require("voice_references", ref_id), db)


@method("voices.select_reference", params=SelectReference)
def select_reference(ctx: Ctx, p: SelectReference) -> dict[str, Any]:
    db = S(ctx)["db"]
    db.require("voices", p.voice_id)
    ref = db.require("voice_references", p.reference_id)
    if ref["voice_id"] != p.voice_id:
        raise WorkerError(INVALID_PARAMS, "That reference belongs to a different voice.")
    db.update("voices", p.voice_id, {"selected_reference_id": p.reference_id})
    return _voice(ctx, p.voice_id)


_REF_PATCH = {"transcript", "label", "trim", "processing", "transcript_confirmed", "transcript_source", "asr_model"}


@method("voices.update_reference", params=UpdateReference)
def update_reference(ctx: Ctx, p: UpdateReference) -> dict[str, Any]:
    st = S(ctx)
    db = st["db"]
    ref = db.require("voice_references", p.reference_id)
    unknown = set(p.patch) - _REF_PATCH
    if unknown:
        raise WorkerError(INVALID_PARAMS, f"Unknown reference fields: {', '.join(sorted(unknown))}", {"allowed": sorted(_REF_PATCH)})
    fields: dict[str, Any] = {}
    patch = dict(p.patch)
    if "transcript" in patch:
        text = str(patch["transcript"] or "").strip()
        if not text:
            raise WorkerError(INVALID_PARAMS, "The transcript cannot be empty.")
        if text != ref["transcript"]:
            fields.update({"transcript": text, "transcript_source": patch.get("transcript_source", "edited"),
                           "transcript_confirmed": int(patch.get("transcript_confirmed", True))})
    if "trim" in patch:
        trim = Trim.model_validate(patch["trim"])
        _validate_trim(db.require("assets", ref["asset_id"]), trim)
        fields.update({"start_s": float(trim.start_s), "end_s": float(trim.end_s)})
    if "processing" in patch:
        fields["processing_json"] = dumps(list(patch["processing"] or []))
    for k in ("label", "asr_model"):
        if k in patch:
            fields[k] = patch[k]
    if "transcript_confirmed" in patch and "transcript_confirmed" not in fields:
        fields["transcript_confirmed"] = int(bool(patch["transcript_confirmed"]))
    if "transcript_source" in patch and "transcript_source" not in fields:
        fields["transcript_source"] = str(patch["transcript_source"])
    merged = {**dict(ref), **fields}
    asset = db.require("assets", ref["asset_id"])
    new_fp = repo.reference_fingerprint(asset["sha256"], merged["start_s"], merged["end_s"], merged["transcript"],
                                        loads(merged["processing_json"], []))
    if new_fp != ref["fingerprint"]:
        fields["fingerprint"] = new_fp
        _invalidate_reference(st, ref)
    db.update("voice_references", p.reference_id, fields, touch=False)
    repo.touch(db, "voices", ref["voice_id"])
    return repo.reference_dict(db.require("voice_references", p.reference_id))
