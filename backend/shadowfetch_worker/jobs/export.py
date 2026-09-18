"""export.* methods: loudness target presets and rendering a master to WAV/FLAC/MP3."""
from __future__ import annotations

import logging
from typing import Any, Literal

from pydantic import BaseModel

from ..audio import export as ex
from ..audio.ffmpeg import probe
from ..engines.registry import ENGINES
from ..paths import AppPaths, require_free_space, safe_filename
from ..protocol import INVALID_PARAMS, NOT_FOUND, WorkerError
from ..rpc import Ctx, method
from ..store.db import dumps, new_id
from .audio import output_file, user_file

log = logging.getLogger("jobs.export")


@method("export.loudness_targets")
def export_loudness_targets(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    """Named loudness presets the user may choose; none is applied unless `export.render` is asked to."""
    return {"targets": ex.LOUDNESS_TARGETS, "default": None}


class LoudnessChoice(BaseModel):
    target_id: str


class RenderParams(BaseModel):
    project_id: str | None = None
    master_path: str | None = None
    format: Literal["wav", "flac", "mp3"] = "wav"
    out_path: str | None = None
    wav_bit_depth: int | str = 24          # 16 | 24 | 32 (PROTOCOL.md also spells float as "32f")
    sample_rate: str | int = "native"
    mp3_bitrate_kbps: int | None = 192
    mp3_vbr_quality: int | None = None
    loudness: LoudnessChoice | None = None
    ai_metadata: bool = True
    engine_label: str | None = None


@method("export.render", params=RenderParams)
def export_render(ctx: Ctx, p: RenderParams) -> dict[str, Any]:
    """Render the project's master (or an explicit `master_path`) to `out_path` (default: exports/<name>.<fmt>)."""
    st = ctx.server.state
    paths: AppPaths = st["paths"]
    db = st["db"]
    project = None
    if p.project_id:
        project = dict(db.require("projects", p.project_id))
    master_str = p.master_path or (project or {}).get("master_path")
    if not master_str:
        raise WorkerError(NOT_FOUND if project else INVALID_PARAMS,
                          "No master to export: assemble the project first (tts.assemble) or pass master_path.",
                          {"project_id": p.project_id}, True)
    master = user_file(master_str)
    engine_label = p.engine_label
    if engine_label is None and project:
        eid = project.get("engine_id") or ""
        engine_label = ENGINES.get(eid, {}).get("name", eid)
    base = safe_filename((project or {}).get("name") or master.stem, "export")
    out = output_file(p.out_path, paths.exports / f"{base}.{p.format}", master)
    if out.suffix.lower().lstrip(".") != p.format:
        out = out.with_suffix(f".{p.format}")
    target = ex.loudness_target(p.loudness.target_id) if p.loudness else None
    try:
        p.wav_bit_depth = int(str(p.wav_bit_depth).lower().rstrip("f"))
    except ValueError:
        raise WorkerError(INVALID_PARAMS, "wav_bit_depth must be 16, 24 or 32f")
    if p.sample_rate != "native":
        try:
            p.sample_rate = int(p.sample_rate)
        except (TypeError, ValueError):
            raise WorkerError(INVALID_PARAMS, "sample_rate must be 'native' or an integer")
    src = probe(master)
    require_free_space(out.parent, ex.estimate_output_bytes(src, p.format, p.wav_bit_depth, p.sample_rate, p.mp3_bitrate_kbps), "this export")
    res = ex.render(master, out, p.format, wav_bit_depth=p.wav_bit_depth, sample_rate=p.sample_rate,
                    mp3_bitrate_kbps=p.mp3_bitrate_kbps, mp3_vbr_quality=p.mp3_vbr_quality, loudness_target=target,
                    ai_metadata=p.ai_metadata, engine_label=engine_label or "", ctx=ctx)
    settings = {"format": p.format, "wav_bit_depth": p.wav_bit_depth, "sample_rate": p.sample_rate, "mp3_bitrate_kbps": p.mp3_bitrate_kbps,
                "mp3_vbr_quality": p.mp3_vbr_quality, "loudness_target": target["id"] if target else None, "ai_metadata": p.ai_metadata,
                "engine_label": engine_label or ""}
    if project:
        export_id = new_id("export")
        db.insert("exports", {"id": export_id, "project_id": p.project_id, "path": res["path"], "format": p.format,
                              "settings_json": dumps(settings), "probe_json": dumps(res["probe"]),
                              "loudness_json": dumps(res["loudness_measured"]) if res["loudness_measured"] else None,
                              "size_bytes": res["size_bytes"]})
        res["export_id"] = export_id
    res["settings"] = settings
    res["master_path"] = str(master)
    return res
