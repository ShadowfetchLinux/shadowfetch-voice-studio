"""Row -> dict helpers and small queries shared by voices/projects/tts/backup jobs.

Conventions
- Timestamps come from SQLite (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`).
- `projects.settings_json` = {"plan": {max_chars, paragraph_pause_ms, sentence_pause_ms, pronunciation, spell_numbers},
  "controls": {<engine_id>: {control_id: value}}, "seed": int|None}.
- `voice_references.derived_json` = {<engine_id>: {path, fingerprint, sample_rate, channels, duration_s, ...}}.
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
from pathlib import Path
from typing import Any

from ..paths import AppPaths
from ..settings import Settings
from .db import Database, dumps, loads, new_id, row_to_dict

log = logging.getLogger("repo")

VOICE_JSON = ("tags_json",)
REF_JSON = ("processing_json", "derived_json")
PROJECT_JSON = ("tags_json", "settings_json", "master_json")
SEGMENT_JSON = ("substitutions_json",)
TAKE_JSON = ("settings_json",)
EXPORT_JSON = ("settings_json", "probe_json", "loudness_json")
MAX_SCRIPT_VERSIONS = 50


# ---- fingerprints / paths
def reference_fingerprint(asset_sha256: str | None, start_s: float, end_s: float, transcript: str, processing: Any) -> str:
    """sha256(asset sha256 | start | end | transcript | json(processing)); trim times use 3 decimals."""
    material = "|".join([asset_sha256 or "", f"{float(start_s):.3f}", f"{float(end_s):.3f}", (transcript or "").strip(),
                         json.dumps(processing or [], sort_keys=True, separators=(",", ":"), ensure_ascii=False)])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def project_dir(paths: AppPaths, project_id: str) -> Path:
    return paths.projects / project_id


def voice_dir(paths: AppPaths, voice_id: str) -> Path:
    return paths.voices / voice_id


def reference_dir(paths: AppPaths, voice_id: str, reference_id: str) -> Path:
    return voice_dir(paths, voice_id) / "references" / reference_id


def normalize_peak_from(processing: Any) -> float | None:
    """Extract `normalize_peak_dbfs` from a processing list ([{id:"normalize_peak", dbfs:-3}] or
    [{normalize_peak_dbfs:-3}]) or dict ({normalize_peak_dbfs:-3})."""
    items = processing if isinstance(processing, list) else [processing] if isinstance(processing, dict) else []
    for step in items:
        if not isinstance(step, dict):
            continue
        if step.get("normalize_peak_dbfs") is not None:
            return float(step["normalize_peak_dbfs"])
        if step.get("id") in ("normalize_peak", "normalize") and step.get("dbfs") is not None:
            return float(step["dbfs"])
    return None


# ---- dict shapes
ASSET_SUMMARY_SQL = ("SELECT id, kind, source, original_name, original_path, working_path, duration_s, sample_rate, channels, "
                     "created_at FROM assets WHERE id = ?")


def reference_dict(row, db: Database | None = None) -> dict[str, Any]:
    """voice_references row → dict (+ trim; + the source asset summary when a db is given, so the UI can re-transcribe)."""
    d = row_to_dict(row, REF_JSON)
    d["trim"] = {"start_s": d["start_s"], "end_s": d["end_s"]}
    if db is not None:
        a = db.one(ASSET_SUMMARY_SQL, (d["asset_id"],))
        d["asset"] = dict(a) if a else None
    return d


def voice_dict(db: Database, row, with_references: bool = True) -> dict[str, Any]:
    d = row_to_dict(row, VOICE_JSON)
    refs = db.all("SELECT * FROM voice_references WHERE voice_id = ? ORDER BY created_at, id", (d["id"],))
    d["reference_count"] = len(refs)
    if with_references:
        d["references"] = [reference_dict(r, db) for r in refs]
    return d


def project_dict(row) -> dict[str, Any]:
    d = row_to_dict(row, PROJECT_JSON)
    d["settings"] = d.get("settings") or {}
    d["master"] = d.get("master") or None
    return d


def segment_dict(row) -> dict[str, Any]:
    d = row_to_dict(row, SEGMENT_JSON)
    d["index"] = d.pop("idx")
    d["char_count"] = len(d["normalized_text"])
    return d


def take_dict(row) -> dict[str, Any]:
    return row_to_dict(row, TAKE_JSON)


def export_dict(row) -> dict[str, Any]:
    return row_to_dict(row, EXPORT_JSON)


# ---- scripts
def latest_script(db: Database, project_id: str):
    return db.one("SELECT * FROM scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1", (project_id,))


def save_script(db: Database, project_id: str, text: str) -> tuple[int, bool]:
    """Store a new script version unless the text is unchanged. Keeps at most MAX_SCRIPT_VERSIONS versions.
    Returns (version, changed)."""
    latest = latest_script(db, project_id)
    if latest is not None and latest["text"] == text:
        return int(latest["version"]), False
    version = (int(latest["version"]) if latest else 0) + 1
    with db.tx() as c:
        c.execute("INSERT INTO scripts (id, project_id, version, text) VALUES (?, ?, ?, ?)", (new_id("scr"), project_id, version, text))
        c.execute("DELETE FROM scripts WHERE project_id = ? AND version <= ?", (project_id, version - MAX_SCRIPT_VERSIONS))
        c.execute("UPDATE projects SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", (project_id,))
    return version, True


# ---- segments / takes
def current_segments(db: Database, project) -> list:
    return db.all("SELECT * FROM segments WHERE project_id = ? AND plan_version = ? ORDER BY idx", (project["id"], project["plan_version"]))


def takes_by_segment(db: Database, segment_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {sid: [] for sid in segment_ids}
    if not segment_ids:
        return out
    marks = ",".join("?" for _ in segment_ids)
    for r in db.all(f"SELECT * FROM takes WHERE segment_id IN ({marks}) ORDER BY created_at, id", tuple(segment_ids)):
        out.setdefault(r["segment_id"], []).append(take_dict(r))
    return out


def segments_with_takes(db: Database, project) -> list[dict[str, Any]]:
    segs = [segment_dict(r) for r in current_segments(db, project)]
    takes = takes_by_segment(db, [s["id"] for s in segs])
    for s in segs:
        s["takes"] = takes.get(s["id"], [])
    return segs


# ---- project settings
def default_plan_options(settings: Settings) -> dict[str, Any]:
    return {"max_chars": settings.max_chars_per_segment, "paragraph_pause_ms": settings.paragraph_pause_ms,
            "sentence_pause_ms": settings.sentence_pause_ms, "pronunciation": [], "spell_numbers": False}


def plan_options(project: dict[str, Any], settings: Settings) -> dict[str, Any]:
    opts = default_plan_options(settings)
    opts.update({k: v for k, v in (project.get("settings", {}).get("plan") or {}).items() if v is not None})
    return opts


def merge_project_settings(db: Database, project_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    """Shallow-merge top-level keys (plan/controls/seed) into projects.settings_json."""
    row = db.require("projects", project_id)
    current = loads(row["settings_json"], {}) or {}
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(current.get(k), dict):
            current[k] = {**current[k], **v}
        else:
            current[k] = v
    db.update("projects", project_id, {"settings_json": dumps(current)})
    return current


def touch(db: Database, table: str, id_: str) -> None:
    """Bump updated_at on a row (tables with an updated_at column only)."""
    with db.tx() as c:
        c.execute(f"UPDATE {table} SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", (id_,))


# ---- caches
def delete_prompt_cache(db: Database, reference_id: str) -> int:
    """Remove prompt_cache rows (and their files) for a reference. Returns the number of rows removed."""
    rows = db.all("SELECT * FROM prompt_cache WHERE reference_id = ?", (reference_id,))
    for r in rows:
        try:
            Path(r["path"]).unlink(missing_ok=True)
        except OSError as e:
            log.warning("could not remove prompt cache %s: %s", r["path"], e)
    with db.tx() as c:
        c.execute("DELETE FROM prompt_cache WHERE reference_id = ?", (reference_id,))
    return len(rows)


def remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
