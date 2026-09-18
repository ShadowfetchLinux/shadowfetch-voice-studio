"""backup.* methods: portable project archives.

Archive layout (zip): manifest.json + assets/takes/<take_id>.wav, assets/master.wav and, with include_voice,
assets/references/<reference_id>/{original.<ext>, working.wav, reference.<engine>.wav}.
Import creates fresh ids for everything, extracts only files the manifest references, rejects absolute paths,
"..", symlinks, unexpected extensions and oversized entries, and never executes anything (JSON only).
"""
from __future__ import annotations

import hashlib
import json
import logging
import stat
import time
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .. import __version__
from ..protocol import CORRUPT_FILE, INVALID_PARAMS, NOT_FOUND, UNSUPPORTED_FILE, WorkerError, invalid_params
from ..rpc import Ctx, method
from ..store import repo
from ..store.db import dumps, new_id, row_to_dict
from ..paths import safe_filename, unique_path

log = logging.getLogger("backup")

FORMAT = "sfvs-backup"
FORMAT_VERSION = 1
ALLOWED_EXT = {".wav", ".flac", ".mp3", ".json", ".txt"}
MAX_ENTRY_BYTES = 4 * 1024 ** 3
MAX_TOTAL_BYTES = 20 * 1024 ** 3
_CHUNK = 1024 * 1024


class ExportParams(BaseModel):
    project_id: str
    out_path: str | None = None
    include_voice: bool = True


class ImportParams(BaseModel):
    path: str
    folder: str | None = None


class Manifest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    format: Literal["sfvs-backup"]
    version: int
    exported_at: str = ""
    project: dict[str, Any]
    script: dict[str, Any] | None = None
    scripts: list[dict[str, Any]] = Field(default_factory=list)
    segments: list[dict[str, Any]] = Field(default_factory=list)
    takes: list[dict[str, Any]] = Field(default_factory=list)
    voice: dict[str, Any] | None = None
    references: list[dict[str, Any]] = Field(default_factory=list)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


# ---- export
@method("backup.export", params=ExportParams)
def export(ctx: Ctx, p: ExportParams) -> dict[str, Any]:
    st = ctx.server.state
    db, paths = st["db"], st["paths"]
    row = db.require("projects", p.project_id)
    proj = repo.project_dict(row)
    if p.out_path:
        out = Path(p.out_path).expanduser()
        if not out.is_absolute() or not out.parent.is_dir():
            raise WorkerError(INVALID_PARAMS, "out_path must be an absolute path inside an existing folder.", {"out_path": p.out_path})
    else:
        out = paths.exports / f"{safe_filename(proj['name'])}-backup.zip"
    out = unique_path(out if out.suffix.lower() == ".zip" else out.with_suffix(out.suffix + ".zip"))
    files: list[tuple[Path, str]] = []          # (source, arcname)
    warnings: list[str] = []

    segments, takes = [], []
    for s in repo.segments_with_takes(db, row):
        segments.append({k: s[k] for k in ("id", "index", "paragraph", "text", "normalized_text", "substitutions", "selected_take_id")})
        for t in s["takes"]:
            if t["status"] != "ok" or not Path(t["path"]).exists():
                continue
            arc = f"assets/takes/{t['id']}.wav"
            files.append((Path(t["path"]), arc))
            takes.append({**{k: t[k] for k in ("id", "segment_id", "engine_id", "model_revision", "reference_id", "sample_rate",
                                                "duration_s", "seed", "settings", "label", "status", "created_at")}, "file": arc})
    master_file = None
    if proj["master_path"] and Path(proj["master_path"]).exists():
        master_file = "assets/master.wav"
        files.append((Path(proj["master_path"]), master_file))
    scripts = [{"version": r["version"], "text": r["text"], "created_at": r["created_at"]}
               for r in db.all("SELECT * FROM scripts WHERE project_id = ? ORDER BY version", (p.project_id,))]

    voice, references = None, []
    if p.include_voice and proj["voice_id"]:
        vrow = db.one("SELECT * FROM voices WHERE id = ?", (proj["voice_id"],))
        if vrow is not None:
            voice = row_to_dict(vrow, repo.VOICE_JSON)
            for r in db.all("SELECT * FROM voice_references WHERE voice_id = ? ORDER BY created_at", (voice["id"],)):
                ref = repo.reference_dict(r)
                asset = db.one("SELECT * FROM assets WHERE id = ?", (ref["asset_id"],))
                if asset is None:
                    warnings.append(f"Reference {ref['id']} skipped: its asset row is missing.")
                    continue
                ref["asset"] = row_to_dict(asset, ("stats_json",))
                base = f"assets/references/{ref['id']}"
                ref["original_file"] = ref["working_file"] = None
                orig = Path(asset["original_path"]) if asset["original_path"] else None
                if orig and orig.exists() and orig.suffix.lower() in ALLOWED_EXT:
                    ref["original_file"] = f"{base}/original{orig.suffix.lower()}"
                    files.append((orig, ref["original_file"]))
                elif orig:
                    warnings.append(f"Original clip {orig.name} not included ({orig.suffix or 'no'} extension is not portable); working.wav is.")
                work = Path(asset["working_path"]) if asset["working_path"] else None
                if work and work.exists():
                    ref["working_file"] = f"{base}/working.wav"
                    files.append((work, ref["working_file"]))
                ref["derived_files"] = {}
                for eid, d in (ref.get("derived") or {}).items():
                    dp = Path(d.get("path", ""))
                    if dp.exists() and dp.suffix.lower() == ".wav":
                        ref["derived_files"][eid] = f"{base}/reference.{eid}.wav"
                        files.append((dp, ref["derived_files"][eid]))
                references.append(ref)

    manifest = {
        "format": FORMAT, "version": FORMAT_VERSION, "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "app_version": __version__,
        "project": {**{k: proj[k] for k in ("id", "name", "folder", "tags", "favorite", "voice_id", "reference_id", "engine_id", "language",
                                             "settings", "plan_version", "notes", "created_at", "updated_at")},
                    "master_file": master_file, "master": proj["master"]},
        "script": ({"version": scripts[-1]["version"], "text": scripts[-1]["text"]} if scripts else None), "scripts": scripts,
        "segments": segments, "takes": takes, "voice": voice, "references": references,
    }
    n = len(files) + 1
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1, default=str))
        for i, (src, arc) in enumerate(files, 1):
            ctx.check_cancel()
            ctx.progress("export", f"Adding {PurePosixPath(arc).name}", i, n, throttle_s=0.2)
            z.write(src, arc, compress_type=zipfile.ZIP_STORED)
    ctx.progress("export", "Backup written", n, n)
    return {"path": str(out), "size_bytes": out.stat().st_size, "files": len(files), "warnings": warnings}


# ---- import
def _check_entry(zi: zipfile.ZipInfo, total: int) -> int:
    """Validate one archive entry; returns the new running total of uncompressed bytes."""
    name = zi.filename
    parts = PurePosixPath(name).parts
    if (not name or name.startswith("/") or "\\" in name or PureWindowsPath(name).drive or PureWindowsPath(name).is_absolute()
            or ".." in parts or any(p in ("", ".") for p in parts) or "\x00" in name):
        raise WorkerError(CORRUPT_FILE, f"The backup contains an unsafe path: {name!r}", {"entry": name}, False)
    if stat.S_ISLNK(zi.external_attr >> 16):
        raise WorkerError(CORRUPT_FILE, f"The backup contains a symbolic link: {name!r}", {"entry": name}, False)
    if zi.is_dir():
        return total
    if PurePosixPath(name).suffix.lower() not in ALLOWED_EXT:
        raise WorkerError(UNSUPPORTED_FILE, f"The backup contains a file type that is not allowed: {name!r}", {"entry": name}, False)
    if zi.file_size > MAX_ENTRY_BYTES:
        raise WorkerError(UNSUPPORTED_FILE, f"Entry {name!r} is larger than 4 GB.", {"entry": name, "size": zi.file_size}, False)
    total += zi.file_size
    if total > MAX_TOTAL_BYTES:
        raise WorkerError(UNSUPPORTED_FILE, "The backup expands to more than 20 GB.", {"total": total}, False)
    return total


def _extract(z: zipfile.ZipFile, arc: str, dst: Path) -> Path:
    zi = z.getinfo(arc)
    dst.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        with z.open(zi) as src, open(dst, "wb") as f:
            for chunk in iter(lambda: src.read(_CHUNK), b""):
                written += len(chunk)
                if written > zi.file_size or written > MAX_ENTRY_BYTES:
                    raise WorkerError(CORRUPT_FILE, f"Entry {arc!r} is larger than declared.", {"entry": arc}, False)
                f.write(chunk)
    except (zipfile.BadZipFile, EOFError, OSError) as e:
        dst.unlink(missing_ok=True)
        raise WorkerError(CORRUPT_FILE, f"Could not extract {arc!r}: {e}", {"entry": arc}, False)
    except WorkerError:
        dst.unlink(missing_ok=True)
        raise
    return dst


def _require_file(names: set[str], arc: Any, what: str) -> str:
    if not isinstance(arc, str) or not arc.startswith("assets/") or arc not in names:
        raise WorkerError(CORRUPT_FILE, f"The manifest references a missing or misplaced file for {what}: {arc!r}", {"entry": arc}, False)
    return arc


@method("backup.import", params=ImportParams)
def import_(ctx: Ctx, p: ImportParams) -> dict[str, Any]:
    st = ctx.server.state
    db, paths = st["db"], st["paths"]
    src = Path(p.path).expanduser()
    if not src.is_file():
        raise WorkerError(NOT_FOUND, f"Backup file not found: {src}", {"path": str(src)})
    if not zipfile.is_zipfile(src):
        raise WorkerError(UNSUPPORTED_FILE, "This file is not a zip archive.", {"path": str(src)})
    warnings: list[str] = []
    try:
        zf = zipfile.ZipFile(src)
    except (zipfile.BadZipFile, OSError) as e:
        raise WorkerError(CORRUPT_FILE, f"The backup archive is damaged: {e}", {"path": str(src)}, False)
    with zf as z:
        total = 0
        for zi in z.infolist():
            total = _check_entry(zi, total)
        names = {zi.filename for zi in z.infolist() if not zi.is_dir()}
        if "manifest.json" not in names:
            raise WorkerError(CORRUPT_FILE, "manifest.json is missing from the backup.", recoverable=False)
        try:
            m = Manifest.model_validate(json.loads(z.read("manifest.json").decode("utf-8")))
        except (ValueError, UnicodeDecodeError) as e:
            raise WorkerError(CORRUPT_FILE, f"manifest.json is not valid JSON: {e}", recoverable=False)
        except ValidationError as ve:
            err = invalid_params(ve)
            raise WorkerError(CORRUPT_FILE, "manifest.json is not a valid backup manifest: " + err.message, err.details, False)
        if m.version > FORMAT_VERSION:
            raise WorkerError(UNSUPPORTED_FILE, f"This backup was written by a newer version (format {m.version}).", recoverable=False)
        # everything referenced must exist before we touch the database
        for t in m.takes:
            _require_file(names, t.get("file"), f"take {t.get('id')}")
        if m.project.get("master_file"):
            _require_file(names, m.project["master_file"], "master")
        for r in m.references:
            for key in ("original_file", "working_file"):
                if r.get(key):
                    _require_file(names, r[key], f"reference {r.get('id')}")
            for eid, arc in (r.get("derived_files") or {}).items():
                _require_file(names, arc, f"reference {r.get('id')} ({eid})")
        n_files = len(m.takes) + len(m.references) * 2 + 1
        done = 0

        # ---- voice + references (new ids)
        voice_id, ref_map = None, {}
        if m.voice and m.references:
            voice_id = new_id("voice")
            v = m.voice
            note = f"Imported from backup {src.name} on {time.strftime('%Y-%m-%d')}"
            db.insert("voices", {"id": voice_id, "name": str(v.get("name") or "Imported voice"), "tags_json": dumps(list(v.get("tags") or [])),
                                 "language": str(v.get("language") or "en"), "rights_confirmed": int(bool(v.get("rights_confirmed"))),
                                 "rights_note": "; ".join(x for x in (str(v.get("rights_note") or ""), note) if x), "notes": v.get("notes"),
                                 "favorite": int(bool(v.get("favorite")))})
            for r in m.references:
                ref_id, asset_id = new_id("ref"), new_id("asset")
                base = paths.recordings / asset_id
                orig_path = work_path = None
                if r.get("original_file"):
                    orig_path = _extract(z, r["original_file"], base / f"original{PurePosixPath(r['original_file']).suffix.lower()}")
                if r.get("working_file"):
                    work_path = _extract(z, r["working_file"], base / "working.wav")
                done += 2
                ctx.progress("import", f"Restoring reference {len(ref_map) + 1}", done, n_files)
                if not orig_path and not work_path:
                    warnings.append(f"Reference {r.get('id')} skipped: no audio in the backup.")
                    continue
                a = r.get("asset") or {}
                sha = _sha256(orig_path or work_path)
                db.insert("assets", {"id": asset_id, "kind": str(a.get("kind") or "reference"), "source": "import",
                                     "original_name": a.get("original_name"), "original_path": str(orig_path or work_path),
                                     "working_path": str(work_path) if work_path else None, "sha256": sha, "format": a.get("format"),
                                     "codec": a.get("codec"), "duration_s": a.get("duration_s"), "sample_rate": a.get("sample_rate"),
                                     "channels": a.get("channels"), "bit_depth": a.get("bit_depth"), "size_bytes": a.get("size_bytes"),
                                     "stats_json": dumps(a.get("stats")) if a.get("stats") is not None else None})
                processing = list(r.get("processing") or [])
                start_s, end_s = float(r.get("start_s") or 0.0), float(r.get("end_s") or 0.0)
                transcript = str(r.get("transcript") or "")
                fp = repo.reference_fingerprint(sha, start_s, end_s, transcript, processing)
                derived = {}
                for eid, arc in (r.get("derived_files") or {}).items():
                    dst = _extract(z, arc, repo.reference_dir(paths, voice_id, ref_id) / f"reference.{safe_filename(eid)}.wav")
                    old = (r.get("derived") or {}).get(eid) or {}
                    derived[eid] = {**{k: old[k] for k in ("sample_rate", "channels", "duration_s") if k in old}, "path": str(dst), "fingerprint": fp}
                db.insert("voice_references", {"id": ref_id, "voice_id": voice_id, "asset_id": asset_id, "label": r.get("label"),
                                               "start_s": start_s, "end_s": end_s, "transcript": transcript,
                                               "transcript_source": str(r.get("transcript_source") or "edited"),
                                               "transcript_confirmed": int(bool(r.get("transcript_confirmed"))), "asr_model": r.get("asr_model"),
                                               "processing_json": dumps(processing), "fingerprint": fp, "derived_json": dumps(derived)})
                ref_map[str(r.get("id"))] = ref_id
            if ref_map:
                sel = ref_map.get(str(m.voice.get("selected_reference_id"))) or next(iter(ref_map.values()))
                db.update("voices", voice_id, {"selected_reference_id": sel})
            else:
                with db.tx() as c:
                    c.execute("DELETE FROM voices WHERE id = ?", (voice_id,))
                voice_id = None

        # ---- project, scripts, segments, takes
        pid = new_id("proj")
        pdir = repo.project_dir(paths, pid)
        pdir.mkdir(parents=True, exist_ok=True)
        pr = m.project
        master_path, master_json = None, None
        if pr.get("master_file"):
            master_path = str(_extract(z, pr["master_file"], pdir / "master.wav"))
            master_json = dumps({**(pr.get("master") or {}), "path": master_path})
        ref_id = ref_map.get(str(pr.get("reference_id"))) if ref_map else None
        db.insert("projects", {"id": pid, "name": str(pr.get("name") or src.stem), "folder": p.folder if p.folder is not None else str(pr.get("folder") or ""),
                               "tags_json": dumps(list(pr.get("tags") or [])), "favorite": int(bool(pr.get("favorite"))), "archived": 0,
                               "voice_id": voice_id, "reference_id": ref_id, "engine_id": pr.get("engine_id"),
                               "language": str(pr.get("language") or "en"), "settings_json": dumps(pr.get("settings") or {}),
                               "plan_version": 1 if m.segments else 0, "master_path": master_path, "master_json": master_json,
                               "notes": pr.get("notes")})
        scripts = m.scripts or ([{"version": 1, "text": m.script.get("text", "")}] if m.script else [])
        seg_map: dict[str, str] = {}
        with db.tx() as c:
            for i, s in enumerate(sorted(scripts, key=lambda x: int(x.get("version") or 0)), 1):
                c.execute("INSERT INTO scripts (id, project_id, version, text) VALUES (?,?,?,?)", (new_id("scr"), pid, i, str(s.get("text") or "")))
            for i, s in enumerate(sorted(m.segments, key=lambda x: int(x.get("index") or 0))):
                sid = new_id("seg")
                seg_map[str(s.get("id"))] = sid
                c.execute("INSERT INTO segments (id, project_id, plan_version, idx, paragraph, text, normalized_text, substitutions_json) "
                          "VALUES (?,?,?,?,?,?,?,?)", (sid, pid, 1, i, int(s.get("paragraph") or 0), str(s.get("text") or ""),
                                                       str(s.get("normalized_text") or s.get("text") or ""), dumps(list(s.get("substitutions") or []))))
        take_count = 0
        selected: dict[str, str] = {}
        for t in m.takes:
            sid = seg_map.get(str(t.get("segment_id")))
            if sid is None:
                warnings.append(f"Take {t.get('id')} skipped: its segment is not in the manifest.")
                continue
            tid = new_id("take")
            dst = _extract(z, t["file"], pdir / "segments" / sid / f"{tid}.wav")
            done += 1
            ctx.progress("import", f"Restoring take {take_count + 1} of {len(m.takes)}", done, n_files, throttle_s=0.2)
            db.insert("takes", {"id": tid, "segment_id": sid, "project_id": pid, "engine_id": str(t.get("engine_id") or "unknown"),
                                "model_revision": t.get("model_revision"), "reference_id": ref_map.get(str(t.get("reference_id"))),
                                "path": str(dst), "sample_rate": t.get("sample_rate"), "duration_s": t.get("duration_s"), "seed": t.get("seed"),
                                "settings_json": dumps(t.get("settings") or {}), "label": t.get("label"), "status": "ok"})
            take_count += 1
            for s in m.segments:
                if str(s.get("selected_take_id")) == str(t.get("id")):
                    selected[sid] = tid
        for sid, tid in selected.items():
            db.update("segments", sid, {"selected_take_id": tid}, touch=False)
    ctx.progress("import", "Backup restored", n_files, n_files)
    return {"project_id": pid, "voice_id": voice_id, "reference_ids": list(ref_map.values()), "segments": len(seg_map),
            "takes": take_count, "warnings": warnings}
