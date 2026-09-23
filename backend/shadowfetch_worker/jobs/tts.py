"""tts.* methods: project-level orchestration (plan -> generate takes -> assemble master; engine comparison).

Seed policy: when a `seed` is given, segment k (0-based plan index) is generated with `seed + k`, so re-running
a single segment reproduces the same take while different segments still vary. Without a seed the engine
picks its own (reported per take when the engine supports seeds).
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..engines.base import Capabilities
from ..paths import safe_filename
from ..protocol import ENGINE_UNAVAILABLE, INVALID_PARAMS, NOT_FOUND, CancelledError, WorkerError
from ..rpc import Ctx, method
from ..store import repo
from ..store.db import dumps, loads, new_id
from ..text.segmenter import plan_segments
from .voices import ensure_reference_file

log = logging.getLogger("tts")


def S(ctx: Ctx) -> dict[str, Any]:
    return ctx.server.state


class PlanOptions(BaseModel):
    max_chars: int | None = Field(default=None, ge=20, le=5000)
    paragraph_pause_ms: int | None = Field(default=None, ge=0, le=10000)
    sentence_pause_ms: int | None = Field(default=None, ge=0, le=10000)
    pronunciation: list[dict[str, str]] | None = None
    spell_numbers: bool | None = None


class PlanParams(BaseModel):
    project_id: str
    script_text: str | None = None
    engine_id: str | None = None
    options: PlanOptions = Field(default_factory=PlanOptions)


class GenerateParams(BaseModel):
    project_id: str
    segment_indices: list[int] | None = None
    take_label: str | None = None
    engine_id: str | None = None
    reference_id: str | None = None
    language: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    seed: int | None = None
    regenerate_all: bool = False
    # Speak: regenerate only segments whose selected take was not made with this exact voice audio (reference id +
    # fingerprint), engine, language and controls. Default mode skips any segment with a take, whoever spoke it.
    only_changed: bool = False


class AssembleParams(BaseModel):
    project_id: str
    take_selection: dict[str, str] | None = None      # {"<segment_index>": take_id}; JSON object keys are strings
    paragraph_pause_ms: int | None = Field(default=None, ge=0, le=10000)
    sentence_pause_ms: int | None = Field(default=None, ge=0, le=10000)


class CompareParams(BaseModel):
    project_id: str
    engine_ids: list[str] = Field(min_length=1)
    segment_index: int
    reference_id: str | None = None
    language: str | None = None
    settings: dict[str, dict[str, Any]] = Field(default_factory=dict)   # per engine id
    seed: int | None = None


# ---- helpers
def _engines(st: dict[str, Any]):
    eng = st.get("engines")
    if eng is None:
        raise WorkerError(ENGINE_UNAVAILABLE, "The engine manager is not available in this worker.", recoverable=False)
    return eng


def _caps(st: dict[str, Any], engine_id: str) -> Capabilities:
    try:
        return _engines(st).capabilities(engine_id)
    except WorkerError:
        raise
    except Exception as e:  # adapter module missing / broken
        raise WorkerError(ENGINE_UNAVAILABLE, f"Engine {engine_id} is not available: {e}", {"engine_id": engine_id})


def validate_controls(caps: Capabilities, settings: dict[str, Any]) -> dict[str, Any]:
    """Only controls the engine declared are accepted; values are checked against the declared type/range."""
    declared = {c.id: c for c in caps.controls}
    unknown = sorted(set(settings) - set(declared))
    if unknown:
        raise WorkerError(INVALID_PARAMS, f"{caps.name} did not declare the control(s): {', '.join(unknown)}",
                          {"unknown": unknown, "declared": sorted(declared)})
    out: dict[str, Any] = {}
    for k, v in settings.items():
        c = declared[k]
        if c.type == "bool":
            v = bool(v)
        elif c.type in ("float", "int"):
            try:
                v = float(v) if c.type == "float" else int(v)
            except (TypeError, ValueError):
                raise WorkerError(INVALID_PARAMS, f"Control {k} expects a number.")
            if (c.min is not None and v < c.min) or (c.max is not None and v > c.max):
                raise WorkerError(INVALID_PARAMS, f"Control {k} must be between {c.min} and {c.max} (got {v}).")
        elif c.type == "enum":
            allowed = [o.get("value") for o in (c.options or [])]
            if v not in allowed:
                raise WorkerError(INVALID_PARAMS, f"Control {k} must be one of {allowed} (got {v!r}).")
        out[k] = v
    return out


def _resolve_reference(db, project, reference_id: str | None):
    rid = reference_id or project["reference_id"]
    if not rid and project["voice_id"]:
        rid = db.require("voices", project["voice_id"])["selected_reference_id"]
    if not rid:
        raise WorkerError(INVALID_PARAMS, "This project has no voice reference yet. Pick a voice (and a reference clip) first.",
                          {"project_id": project["id"]})
    return db.require("voice_references", rid)


def _language(caps: Capabilities, requested: str | None, fallback: str) -> str:
    lang = requested or fallback
    codes = [l.code for l in caps.languages]
    if codes and lang not in codes:
        raise WorkerError(INVALID_PARAMS, f"{caps.name} does not support language {lang!r}. Supported: {', '.join(codes)}.",
                          {"supported": codes})
    return lang


def prepare_engine(ctx: Ctx, st: dict[str, Any], engine_id: str, caps: Capabilities, ref, language: str,
                   controls: dict[str, Any] | None = None) -> dict[str, Any]:
    """Derived reference wav + loaded engine + (when supported) a reusable prompt from prompt_cache.
    Delegates prompt identity/caching to jobs.engines._prompt_cache_for so the Create page, engine.prepare_reference and
    compare-engines all share one cache keyed by (reference, engine, revision, fingerprint, prompt-shaping controls).
    Returns {reference_path, model_revision, prompt_path, prompt_cache_id}."""
    engines = _engines(st)
    ref_path = ensure_reference_file(st, ref, engine_id)
    loaded = engines.ensure_loaded(ctx, engine_id)
    revision = str(loaded.get("revision") or "")
    prompt_path, cache_id = None, None
    if caps.supports_reusable_prompt:
        from .engines import _prompt_cache_for
        row = dict(ref)
        row.setdefault("language", language)
        rec = _prompt_cache_for(ctx, engine_id, row, ref_path, settings=controls or {})
        prompt_path, cache_id = Path(rec["path"]), rec["id"]
    return {"reference_path": ref_path, "model_revision": revision, "prompt_path": prompt_path, "prompt_cache_id": cache_id}


def _has_take(db, seg) -> bool:
    if not seg["selected_take_id"]:
        return False
    t = db.one("SELECT path FROM takes WHERE id = ? AND status = 'ok'", (seg["selected_take_id"],))
    return bool(t and Path(t["path"]).exists())


def _take_matches(db, seg, engine_id: str, ref, language: str, controls: dict[str, Any]) -> bool:
    """The segment's selected take is usable AND was made with this engine, this exact reference audio (id +
    fingerprint), this language and these controls. Takes from before migration 0002 carry no fingerprint → False."""
    if not seg["selected_take_id"]:
        return False
    t = db.one("SELECT * FROM takes WHERE id = ? AND status = 'ok'", (seg["selected_take_id"],))
    if t is None or not Path(t["path"]).exists():
        return False
    if t["engine_id"] != engine_id or t["reference_id"] != ref["id"] or t["language"] != language:
        return False
    if not t["reference_fingerprint"] or t["reference_fingerprint"] != ref["fingerprint"]:
        return False
    return (loads(t["settings_json"], {}) or {}) == controls


def _insert_take(db, seg, project_id: str, take_id: str, engine_id: str, revision: str, ref, res: dict[str, Any],
                 out: Path, settings: dict[str, Any], seed: int | None, label: str | None, select: bool,
                 language: str | None = None) -> dict[str, Any]:
    take = {"id": take_id, "segment_id": seg["id"], "project_id": project_id, "engine_id": engine_id, "model_revision": revision or None,
            "reference_id": ref["id"], "reference_fingerprint": ref["fingerprint"], "language": language,
            "path": str(res.get("path") or out), "sample_rate": res.get("sample_rate"),
            "duration_s": res.get("duration_s"), "seed": res.get("seed", seed), "settings_json": dumps(settings), "label": label,
            "status": "ok"}
    db.insert("takes", take)
    if select:
        db.update("segments", seg["id"], {"selected_take_id": take_id}, touch=False)
    return {"segment_index": seg["idx"], "segment_id": seg["id"], "take_id": take_id, "path": take["path"],
            "duration_s": take["duration_s"], "sample_rate": take["sample_rate"], "seed": take["seed"],
            "warnings": list(res.get("warnings") or [])}


# ---- methods
@method("tts.plan", params=PlanParams)
def plan(ctx: Ctx, p: PlanParams) -> dict[str, Any]:
    """Split the script into segments for a new plan version. Segments whose normalized text is unchanged keep
    their id (and takes); old-plan segments without takes are pruned."""
    st = S(ctx)
    db, settings = st["db"], st["settings"].value
    row = db.require("projects", p.project_id)
    proj = repo.project_dict(row)
    if p.script_text is not None:
        script_version, _ = repo.save_script(db, p.project_id, p.script_text)
        text = p.script_text
    else:
        s = repo.latest_script(db, p.project_id)
        if s is None:
            raise WorkerError(INVALID_PARAMS, "This project has no script yet. Save a script first.")
        text, script_version = s["text"], s["version"]
    engine_id = p.engine_id or proj["engine_id"] or settings.default_engine
    opts = repo.plan_options(proj, settings)
    opts.update({k: v for k, v in p.options.model_dump().items() if v is not None})
    warnings: list[str] = []
    engine_max = None
    try:
        engine_max = _caps(st, engine_id).max_chars_per_request
    except WorkerError as e:
        warnings.append(f"Engine limit unknown ({e.message}); segments were not clamped to the engine's maximum.")
    planned = plan_segments(text, opts["max_chars"], opts["pronunciation"], bool(opts["spell_numbers"]), engine_max)
    warnings += planned["warnings"]
    new_version = int(row["plan_version"]) + 1
    pool: dict[str, list] = {}
    for old in db.all("SELECT * FROM segments WHERE project_id = ? ORDER BY plan_version DESC, idx", (p.project_id,)):
        pool.setdefault(old["normalized_text"], []).append(old)
    out_segments = []
    with db.tx() as c:
        for seg in planned["segments"]:
            cands = pool.get(seg["normalized_text"])
            reused = cands.pop(0) if cands else None
            if reused is not None:
                c.execute("UPDATE segments SET plan_version = ?, idx = ?, paragraph = ?, text = ?, substitutions_json = ? WHERE id = ?",
                          (new_version, seg["index"], seg["paragraph"], seg["text"], dumps(seg["substitutions"]), reused["id"]))
                sid, selected = reused["id"], reused["selected_take_id"]
            else:
                sid, selected = new_id("seg"), None
                c.execute("INSERT INTO segments (id, project_id, plan_version, idx, paragraph, text, normalized_text, substitutions_json) "
                          "VALUES (?,?,?,?,?,?,?,?)", (sid, p.project_id, new_version, seg["index"], seg["paragraph"], seg["text"],
                                                       seg["normalized_text"], dumps(seg["substitutions"])))
            out_segments.append({**seg, "id": sid, "selected_take_id": selected, "reused": reused is not None})
        c.execute("DELETE FROM segments WHERE project_id = ? AND plan_version < ? AND id NOT IN (SELECT segment_id FROM takes)",
                  (p.project_id, new_version))
        c.execute("UPDATE projects SET plan_version = ?, engine_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
                  (new_version, engine_id, p.project_id))
    repo.merge_project_settings(db, p.project_id, {"plan": opts})
    takes = repo.takes_by_segment(db, [s["id"] for s in out_segments])
    for s in out_segments:
        s["take_count"] = len(takes.get(s["id"], []))
    return {"segments": out_segments, "engine_id": engine_id, "plan_version": new_version, "script_version": script_version,
            "options": opts, "warnings": warnings, "normalization_notes": planned["normalization_notes"]}


@method("tts.generate", gpu=True, params=GenerateParams)
def generate(ctx: Ctx, p: GenerateParams) -> dict[str, Any]:
    """Generate one take per requested segment (default: every segment without a usable selected take)."""
    st = S(ctx)
    db, paths, settings = st["db"], st["paths"], st["settings"]
    row = db.require("projects", p.project_id)
    proj = repo.project_dict(row)
    engine_id = p.engine_id or proj["engine_id"] or settings.value.default_engine
    caps = _caps(st, engine_id)
    controls = validate_controls(caps, p.settings)
    ref = _resolve_reference(db, proj, p.reference_id)
    language = _language(caps, p.language, proj["language"])
    warnings: list[str] = []
    seed = p.seed
    if seed is not None and not caps.supports_seed:
        warnings.append(f"{caps.name} does not support seeds; the seed was ignored.")
        seed = None
    segs = repo.current_segments(db, row)
    if not segs:
        raise WorkerError(INVALID_PARAMS, "The script has not been planned yet. Run tts.plan first.")
    by_idx = {s["idx"]: s for s in segs}
    if p.regenerate_all:
        targets = list(segs)
    elif p.segment_indices is not None:
        bad = sorted(set(p.segment_indices) - set(by_idx))
        if bad:
            raise WorkerError(INVALID_PARAMS, f"Segment index(es) not in the current plan: {bad}", {"bad_indices": bad})
        targets = [by_idx[i] for i in sorted(set(p.segment_indices))]
    elif p.only_changed:
        targets = [s for s in segs if not _take_matches(db, s, engine_id, ref, language, controls)]
    else:
        targets = [s for s in segs if not _has_take(db, s)]
    target_ids = {s["id"] for s in targets}
    skipped = [s["idx"] for s in segs if s["id"] not in target_ids]

    # remember what was used so the project reopens with the same setup — but never overwrite stored values with
    # "not sent": no controls for an engine that declares some (the caller did not know them yet), or no seed field
    db.update("projects", p.project_id, {"engine_id": engine_id, "reference_id": ref["id"], "voice_id": ref["voice_id"], "language": language})
    remembered: dict[str, Any] = {}
    if controls or not caps.controls:
        remembered["controls"] = {engine_id: controls}
        settings.patch({"engine_settings": {**settings.value.engine_settings, engine_id: controls}})
    if "seed" in p.model_fields_set:
        remembered["seed"] = p.seed
    if remembered:
        repo.merge_project_settings(db, p.project_id, remembered)

    t0 = time.time()
    if not targets:   # every segment already has a matching take: nothing to load onto the GPU
        return {"takes": [], "skipped": skipped, "elapsed_s": 0.0, "engine_id": engine_id, "reference_id": ref["id"],
                "model_revision": None, "prompt_cache_id": None, "warnings": warnings}
    prep = prepare_engine(ctx, st, engine_id, caps, ref, language, controls)
    engines = _engines(st)
    completed: list[dict[str, Any]] = []
    n = len(targets)
    for i, seg in enumerate(targets, 1):
        try:
            ctx.check_cancel()
            ctx.progress("generate", f"Generating segment {i} of {n}", i, n, detail={"segment_index": seg["idx"], "segment_id": seg["id"]})
            take_id = new_id("take")
            out = repo.project_dir(paths, p.project_id) / "segments" / seg["id"] / f"{take_id}.wav"
            out.parent.mkdir(parents=True, exist_ok=True)
            per_seed = seed + int(seg["idx"]) if seed is not None else None
            res = engines.generate(ctx, engine_id, seg["normalized_text"], language, prep["reference_path"], ref["transcript"], out,
                                   controls, per_seed, prep["prompt_path"]) or {}
            completed.append(_insert_take(db, seg, p.project_id, take_id, engine_id, prep["model_revision"], ref, res, out,
                                          controls, per_seed, p.take_label, select=True, language=language))
        except WorkerError as e:
            details = {**e.details, "completed": completed, "failed_segment": seg["idx"], "engine_id": engine_id}
            if isinstance(e, CancelledError):
                raise CancelledError(details) from e
            raise WorkerError(e.code, e.message, details, e.recoverable) from e
        except Exception as e:  # noqa: BLE001  (db/disk errors: keep the finished takes visible to the UI)
            from ..rpc import classify_exception
            err = classify_exception(e)
            raise WorkerError(err.code, err.message, {**err.details, "completed": completed, "failed_segment": seg["idx"],
                                                      "engine_id": engine_id}, err.recoverable) from e
    repo.touch(db, "projects", p.project_id)
    return {"takes": completed, "skipped": skipped, "elapsed_s": round(time.time() - t0, 2), "engine_id": engine_id,
            "reference_id": ref["id"], "model_revision": prep["model_revision"], "prompt_cache_id": prep["prompt_cache_id"],
            "warnings": warnings}


@method("tts.assemble", params=AssembleParams)
def assemble(ctx: Ctx, p: AssembleParams) -> dict[str, Any]:
    """Concatenate the selected take of every segment (in plan order) into <project>/master.wav."""
    st = S(ctx)
    db, paths, settings = st["db"], st["paths"], st["settings"].value
    row = db.require("projects", p.project_id)
    proj = repo.project_dict(row)
    segs = repo.current_segments(db, row)
    if not segs:
        raise WorkerError(INVALID_PARAMS, "The script has not been planned yet. Run tts.plan first.")
    override = {int(k): v for k, v in (p.take_selection or {}).items()}
    takes_in, missing = [], []
    for s in segs:
        tid = override.get(s["idx"], s["selected_take_id"])
        t = db.one("SELECT * FROM takes WHERE id = ? AND segment_id = ?", (tid, s["id"])) if tid else None
        if t is None or not Path(t["path"]).exists():
            missing.append(s["idx"])
            continue
        takes_in.append({"path": t["path"], "paragraph": s["paragraph"], "index": s["idx"], "take_id": t["id"]})
    if missing:
        raise WorkerError(INVALID_PARAMS, f"{len(missing)} segment(s) have no generated take yet (indices {missing[:20]}). "
                          "Generate them first.", {"missing_segments": missing})
    opts = repo.plan_options(proj, settings)
    sentence_ms = p.sentence_pause_ms if p.sentence_pause_ms is not None else int(opts["sentence_pause_ms"])
    paragraph_ms = p.paragraph_pause_ms if p.paragraph_pause_ms is not None else int(opts["paragraph_pause_ms"])
    pdir = repo.project_dir(paths, p.project_id)
    pdir.mkdir(parents=True, exist_ok=True)
    final, tmp = pdir / "master.wav", pdir / "master.tmp.wav"
    from ..audio import edit
    info = dict(edit.assemble([{"path": t["path"], "paragraph": t["paragraph"], "index": t["index"]} for t in takes_in], tmp,
                              sentence_ms, paragraph_ms, ctx=ctx) or {})
    os.replace(tmp, final)
    master = {**info, "path": str(final), "segments_used": len(takes_in), "take_ids": [t["take_id"] for t in takes_in],
              "sentence_pause_ms": sentence_ms, "paragraph_pause_ms": paragraph_ms, "plan_version": row["plan_version"],
              "assembled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    db.update("projects", p.project_id, {"master_path": str(final), "master_json": dumps(master)})
    if p.sentence_pause_ms is not None or p.paragraph_pause_ms is not None:
        repo.merge_project_settings(db, p.project_id, {"plan": {"sentence_pause_ms": sentence_ms, "paragraph_pause_ms": paragraph_ms}})
    ctx.progress("assemble", "Master written", len(takes_in), len(takes_in))
    return {"master_path": str(final), "duration_s": info.get("duration_s"), "sample_rate": info.get("sample_rate"),
            "segments_used": len(takes_in)}


@method("tts.compare_engines", gpu=True, params=CompareParams)
def compare_engines(ctx: Ctx, p: CompareParams) -> dict[str, Any]:
    """Generate one segment with several engines in turn (one loaded at a time) and produce loudness-matched
    previews in the cache; the generated takes stay untouched and are not auto-selected."""
    st = S(ctx)
    db, paths = st["db"], st["paths"]
    row = db.require("projects", p.project_id)
    proj = repo.project_dict(row)
    seg = db.one("SELECT * FROM segments WHERE project_id = ? AND plan_version = ? AND idx = ?", (p.project_id, row["plan_version"], p.segment_index))
    if seg is None:
        raise WorkerError(NOT_FOUND, f"Segment {p.segment_index} is not in the current plan.", {"segment_index": p.segment_index})
    ref = _resolve_reference(db, proj, p.reference_id)
    engines = _engines(st)
    results: list[dict[str, Any]] = []
    n = len(p.engine_ids)
    for i, engine_id in enumerate(p.engine_ids, 1):
        try:
            ctx.check_cancel()
            caps = _caps(st, engine_id)
            controls = validate_controls(caps, p.settings.get(engine_id, {}))
            language = _language(caps, p.language, proj["language"])
            ctx.progress("compare", f"Generating with {caps.name} ({i} of {n})", i, n, detail={"engine_id": engine_id})
            prep = prepare_engine(ctx, st, engine_id, caps, ref, language, p.settings.get(engine_id) or {})
            take_id = new_id("take")
            out = repo.project_dir(paths, p.project_id) / "segments" / seg["id"] / f"{take_id}.wav"
            out.parent.mkdir(parents=True, exist_ok=True)
            per_seed = p.seed + int(seg["idx"]) if (p.seed is not None and caps.supports_seed) else None
            res = engines.generate(ctx, engine_id, seg["normalized_text"], language, prep["reference_path"], ref["transcript"], out,
                                   controls, per_seed, prep["prompt_path"]) or {}
            take = _insert_take(db, seg, p.project_id, take_id, engine_id, prep["model_revision"], ref, res, out, controls,
                                per_seed, f"compare:{engine_id}", select=False, language=language)
            preview = paths.tmp / f"compare-{take_id}.wav"
            from ..audio import edit
            edit.loudness_match_copy(Path(take["path"]), preview, target_lufs=-18.0)
            results.append({"engine_id": engine_id, "take_id": take_id, "path": take["path"], "loudness_matched_preview_path": str(preview),
                            "duration_s": take["duration_s"], "sample_rate": take["sample_rate"], "seed": take["seed"]})
        except CancelledError as e:
            raise CancelledError({**e.details, "results": results, "failed_engine": engine_id}) from e
        except WorkerError as e:
            log.warning("compare: engine %s failed: %s", engine_id, e.message)
            results.append({"engine_id": engine_id, "error": e.to_dict()})
    return {"results": results, "segment_index": p.segment_index, "segment_id": seg["id"]}
