"""engine.* methods (see docs/PROTOCOL.md): list / capabilities / load / unload / prepare_reference / generate."""
from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..engines._common import prompt_settings
from ..engines.registry import ENGINES
from ..paths import safe_filename
from ..protocol import ENGINE_UNAVAILABLE, FFMPEG_FAILED, INTERNAL, INVALID_PARAMS, NOT_FOUND, WorkerError
from ..rpc import Ctx, method
from ..store.db import loads, new_id
from .models import get_models

log = logging.getLogger("jobs.engines")


# ---------------------------------------------------------------------- helpers
def S(ctx: Ctx):
    return ctx.server.state


def _engines(ctx: Ctx):
    get_models(ctx)   # EngineManager.ensure_loaded needs state['models']
    em = S(ctx).get("engines")
    if em is None:
        raise WorkerError(ENGINE_UNAVAILABLE, "The engine manager is not available in this worker", recoverable=False)
    return em


def _check_engine(engine_id: str) -> None:
    if engine_id not in ENGINES:
        raise WorkerError(ENGINE_UNAVAILABLE, f"Unknown engine {engine_id!r}. Known: {', '.join(ENGINES)}", {"engine_id": engine_id}, False)


def _sha256_file(path: Path, limit: int | None = None) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _reference_row(ctx: Ctx, reference_id: str) -> dict[str, Any]:
    db = S(ctx).get("db")
    if db is None:
        raise WorkerError(INTERNAL, "database not initialised", recoverable=False)
    row = db.one("SELECT * FROM voice_references WHERE id = ?", (reference_id,))
    if row is None:
        raise WorkerError(NOT_FOUND, f"Reference not found: {reference_id}", {"reference_id": reference_id}, False)
    d = dict(row)
    d["derived"] = loads(d.get("derived_json"), {}) or {}
    d["processing"] = loads(d.get("processing_json"), []) or []
    voice = db.one("SELECT language FROM voices WHERE id = ?", (d.get("voice_id"),))
    d["language"] = (voice["language"] if voice is not None else None) or "auto"
    return d


def _build_reference_with_ffmpeg(ctx: Ctx, row: dict[str, Any], engine_id: str, sample_rate: int, channels: int) -> Path:
    """Fallback derivation when the voices module is not available: cut + resample the asset with ffmpeg."""
    db = S(ctx)["db"]
    paths = S(ctx)["paths"]
    asset = db.one("SELECT * FROM assets WHERE id = ?", (row["asset_id"],))
    if asset is None:
        raise WorkerError(NOT_FOUND, f"Asset not found for reference {row['id']}", {"asset_id": row["asset_id"]}, False)
    src = Path(asset["working_path"] or asset["original_path"])
    if not src.exists():
        raise WorkerError(NOT_FOUND, f"Reference audio file is missing on disk: {src}", {"path": str(src)}, False)
    out_dir = paths.voices / row["voice_id"] / "references" / row["id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"reference.{engine_id}.wav"
    start, end = float(row["start_s"]), float(row["end_s"])
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src),
           "-vn", "-ac", str(channels), "-ar", str(sample_rate), "-c:a", "pcm_s24le", str(out)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.SubprocessError) as e:
        raise WorkerError(FFMPEG_FAILED, f"ffmpeg failed: {e}", recoverable=True)
    if r.returncode != 0 or not out.exists():
        raise WorkerError(FFMPEG_FAILED, "ffmpeg could not derive the reference file: " + (r.stderr or "")[-400:], recoverable=True)
    derived = dict(row.get("derived") or {})
    derived[engine_id] = {"path": str(out), "sample_rate": sample_rate, "channels": channels, "duration_s": round(end - start, 3)}
    db.update("voice_references", row["id"], {"derived_json": json.dumps(derived)}, touch=False)
    return out


def ensure_reference_file(ctx: Ctx, row: dict[str, Any], engine_id: str) -> Path:
    """Engine-specific derived reference file for a voice_references row (delegates to jobs.voices when present)."""
    state = S(ctx)
    try:
        from .voices import ensure_reference_file as _voices_ensure  # written by the voices module owner
    except ImportError:
        _voices_ensure = None
    if _voices_ensure is not None:
        try:
            res = _voices_ensure(state, row, engine_id)
            p = Path(res["path"] if isinstance(res, dict) else res)
            if p.exists():
                return p
        except WorkerError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("voices.ensure_reference_file failed (%s); deriving with ffmpeg", e)
    cached = (row.get("derived") or {}).get(engine_id)
    if cached and cached.get("path") and Path(cached["path"]).exists():
        return Path(cached["path"])
    caps = _engines(ctx).capabilities(engine_id)
    return _build_reference_with_ffmpeg(ctx, row, engine_id, caps.reference.sample_rate, caps.reference.channels)


def _fingerprint(row: dict[str, Any], reference_file: Path, revision: str | None) -> str:
    """The reference's own fingerprint (sha256 of asset sha + trim + transcript + processing, set by voices.*).
    Rows created without one get a content hash of the derived file; the model revision is a separate column."""
    fp = row.get("fingerprint")
    if fp:
        return str(fp)
    return _sha256_file(reference_file)


def prompt_identity(caps, settings: dict[str, Any] | None) -> tuple[dict[str, Any], str]:
    """(prompt-shaping settings with defaults applied, cache-key suffix). The suffix is '' when every prompt control is
    at its declared default, so prompt_cache rows/files built before this existed stay valid."""
    ps = prompt_settings(settings, caps.controls, caps.prompt_controls)
    defaults = {c.id: c.default for c in caps.controls if c.id in caps.prompt_controls}
    if ps == defaults:
        return ps, ""
    return ps, hashlib.sha256(json.dumps(ps, sort_keys=True, default=str).encode()).hexdigest()[:10]


def _prompt_cache_for(ctx: Ctx, engine_id: str, row: dict[str, Any], reference_file: Path, settings: dict[str, Any] | None = None,
                      force: bool = False) -> dict[str, Any]:
    """Find (or build) the reusable engine prompt for a reference. Returns the prompt_cache row as a dict.

    The prompt identity is (reference, engine, model revision, reference fingerprint, prompt-shaping controls such as
    Chatterbox's norm_loudness / Qwen's x_vector_only_mode): non-default prompt settings get their own row and file."""
    em = _engines(ctx)
    db = S(ctx)["db"]
    paths = S(ctx)["paths"]
    caps = em.capabilities(engine_id)
    loaded = em.ensure_loaded(ctx, engine_id)
    revision = loaded.get("revision") or em.info[engine_id].get("revision") or "unknown"
    ps, suffix = prompt_identity(caps, settings)
    fp = _fingerprint(row, reference_file, revision) + (f":{suffix}" if suffix else "")
    existing = db.one("SELECT * FROM prompt_cache WHERE reference_id = ? AND engine_id = ? AND model_revision = ? AND fingerprint = ? "
                      "ORDER BY created_at DESC LIMIT 1", (row["id"], engine_id, revision, fp))
    if existing and not force and Path(existing["path"]).exists():
        rec = dict(existing)
        rec["prompt_settings"] = ps
        return rec
    if not caps.supports_reusable_prompt:
        raise WorkerError(INVALID_PARAMS, f"{engine_id} does not support reusable prompts", recoverable=False)
    needs_transcript = caps.reference.needs_transcript and not ps.get("x_vector_only_mode", False)
    if needs_transcript and not (row.get("transcript") or "").strip():
        raise WorkerError(INVALID_PARAMS, f"{caps.name} needs the reference transcript. Transcribe or type it first.",
                          {"reference_id": row["id"]}, True)
    name = f"{safe_filename(row['id'])}-{safe_filename(engine_id)}-{safe_filename(str(revision))[:40]}" + (f"-{suffix}" if suffix else "")
    cache_path = paths.prompts / f"{name}.pt"
    ctx.progress("prepare", f"Preparing the voice prompt for {caps.name}")
    res = em.prepare_reference(ctx, engine_id, reference_file, row.get("transcript") or "", row.get("language") or "auto", cache_path,
                               settings=ps)
    path = str(res.get("path") or cache_path)
    with db.tx() as c:
        c.execute("DELETE FROM prompt_cache WHERE reference_id = ? AND engine_id = ? AND model_revision = ? AND fingerprint = ?",
                  (row["id"], engine_id, revision, fp))
    rec = {"id": new_id("pc"), "reference_id": row["id"], "engine_id": engine_id, "model_revision": revision, "fingerprint": fp, "path": path}
    db.insert("prompt_cache", rec)
    rec["meta"] = res.get("meta") or {}
    rec["prompt_settings"] = ps
    return rec


_PKG_DIST = {"qwen3-tts-base": "qwen-tts", "chatterbox-turbo": "chatterbox-tts"}


def _engine_pkg_version(ctx: Ctx, engine_id: str) -> str | None:
    """Version of the engine package inside the engine's own Python environment (cached per process)."""
    cache = S(ctx).setdefault("engine_pkg_versions", {})
    if engine_id in cache:
        return cache[engine_id]
    dist = _PKG_DIST.get(engine_id)
    py = S(ctx)["runtime"].python_for_engine(engine_id) if "runtime" in S(ctx) else None
    ver = None
    if dist and py is not None:
        try:
            r = subprocess.run([str(py), "-c", f"import importlib.metadata as m; print(m.version({dist!r}))"], capture_output=True, text=True, timeout=60)
            ver = r.stdout.strip() or None if r.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            ver = None
    cache[engine_id] = ver
    return ver


def _caps_dict(ctx: Ctx, engine_id: str) -> dict[str, Any]:
    """Static capabilities, with the two environment-dependent fields taken from the engine's own environment:
    `version` (package version inside the engine env) and `device` (what torch.cuda.is_available() says there)."""
    em = _engines(ctx)
    caps = em.capabilities(engine_id).model_dump()
    if caps.get("version") == "not installed":
        ver = _engine_pkg_version(ctx, engine_id)
        if ver:
            caps["version"] = ver
    info = em.info.get(engine_id) or {}
    if info.get("state") == "loaded" and info.get("device"):
        caps["device"] = info["device"]                       # live device of the loaded engine
    else:
        rt = S(ctx).get("runtime")
        probe = rt.probe_env(ENGINES[engine_id]["env"]) if rt is not None else {}
        if "cuda_available" in probe:
            caps["device"] = "cuda" if probe.get("cuda_available") else "cpu"
    return caps


# ---------------------------------------------------------------------- methods
@method("engine.list")
def engine_list(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    em = _engines(ctx)
    mm = get_models(ctx)
    out = []
    for d in em.descriptors():
        eid = d["id"]
        model_id = ENGINES[eid]["model_id"]    # descriptors() overlays the runtime info (model_id None while unloaded)
        entry = {"id": eid, "name": d["name"], "installed": bool(d.get("installed")), "state": d.get("state"), "model_id": model_id,
                 "loaded_model_id": d.get("model_id"), "optional": d.get("optional", False), "description": d.get("description", ""),
                 "env": d.get("env"), "env_probe": d.get("env_probe"), "revision": d.get("revision"), "vram_bytes": d.get("vram_bytes"),
                 "device": d.get("device"), "message": d.get("message")}
        try:
            entry["model_state"] = mm.state(model_id)["state"]
        except WorkerError as e:
            entry["model_state"] = "error"
            entry["model_error"] = e.message
        if entry["installed"]:
            try:
                entry["capabilities"] = _caps_dict(ctx, eid)
            except Exception as e:  # noqa: BLE001
                entry["capabilities_error"] = str(e)[:300]
        out.append(entry)
    return {"engines": out}


class EngineParams(BaseModel):
    engine_id: str


@method("engine.capabilities", params=EngineParams)
def engine_capabilities(ctx: Ctx, p: EngineParams) -> dict[str, Any]:
    _check_engine(p.engine_id)
    return _caps_dict(ctx, p.engine_id)


class LoadParams(BaseModel):
    engine_id: str
    model_id: str | None = None
    device: str = "cuda"


@method("engine.load", gpu=True, params=LoadParams)
def engine_load(ctx: Ctx, p: LoadParams) -> dict[str, Any]:
    _check_engine(p.engine_id)
    return _engines(ctx).ensure_loaded(ctx, p.engine_id, p.model_id, device=p.device)


@method("engine.unload", params=EngineParams)
def engine_unload(ctx: Ctx, p: EngineParams) -> dict[str, Any]:
    _check_engine(p.engine_id)
    _engines(ctx).unload(p.engine_id, reason="unloaded by user")
    return {"ok": True}


@method("engine.health", params=EngineParams)
def engine_health(ctx: Ctx, p: EngineParams) -> dict[str, Any]:
    _check_engine(p.engine_id)
    return _engines(ctx).health(p.engine_id)


class PrepareParams(BaseModel):
    engine_id: str
    reference_id: str
    settings: dict[str, Any] = Field(default_factory=dict)   # only the engine's prompt_controls matter here
    force: bool = False


@method("engine.prepare_reference", gpu=True, params=PrepareParams)
def engine_prepare_reference(ctx: Ctx, p: PrepareParams) -> dict[str, Any]:
    _check_engine(p.engine_id)
    row = _reference_row(ctx, p.reference_id)
    ref_file = ensure_reference_file(ctx, row, p.engine_id)
    rec = _prompt_cache_for(ctx, p.engine_id, row, ref_file, settings=p.settings, force=p.force)
    return {"prompt_cache_id": rec["id"], "path": rec["path"], "engine_id": p.engine_id, "model_revision": rec["model_revision"],
            "fingerprint": rec["fingerprint"], "reference_path": str(ref_file), "meta": rec.get("meta", {}),
            "prompt_settings": rec.get("prompt_settings", {})}


class GenerateParams(BaseModel):
    engine_id: str
    reference_id: str
    text: str
    language: str = "en"
    settings: dict[str, Any] = Field(default_factory=dict)
    seed: int | None = None
    out_dir: str
    tag: str | None = None
    use_prompt_cache: bool = True


@method("engine.generate", gpu=True, params=GenerateParams)
def engine_generate(ctx: Ctx, p: GenerateParams) -> dict[str, Any]:
    """Single ad-hoc generation (tests, previews, engine comparison). Project takes go through tts.generate."""
    _check_engine(p.engine_id)
    text = p.text.strip()
    if not text:
        raise WorkerError(INVALID_PARAMS, "Text is empty")
    em = _engines(ctx)
    paths = S(ctx)["paths"]
    caps = em.capabilities(p.engine_id)
    if p.language and p.language.lower() not in {l.code for l in caps.languages} | {l.engine_value.lower() for l in caps.languages}:
        raise WorkerError(INVALID_PARAMS, f"{caps.name} does not support language {p.language!r}",
                          {"supported": [l.code for l in caps.languages]}, True)
    out_dir = paths.resolve_inside(p.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    row = _reference_row(ctx, p.reference_id)
    ref_file = ensure_reference_file(ctx, row, p.engine_id)
    prompt_path: Path | None = None
    warnings: list[str] = []
    if p.use_prompt_cache and caps.supports_reusable_prompt:
        try:
            prompt_path = Path(_prompt_cache_for(ctx, p.engine_id, row, ref_file, settings=p.settings)["path"])
        except WorkerError as e:
            if e.code in ("CANCELLED", "GPU_OOM", "ENGINE_CRASHED", "MODEL_MISSING", "MODEL_INVALID", "ENGINE_UNAVAILABLE"):
                raise
            warnings.append(f"Prompt cache unavailable ({e.message}); generating from the reference file.")
    if len(text) > caps.max_chars_per_request:
        warnings.append(f"Text has {len(text)} characters; {caps.name} recommends at most {caps.max_chars_per_request} per request.")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = safe_filename(p.tag or "adhoc", "adhoc")
    out_path = out_dir / f"{name}-{p.engine_id}-{stamp}-{new_id()[:6]}.wav"
    ctx.progress("generate", f"Generating with {caps.name}", current=0, total=1)
    res = em.generate(ctx, p.engine_id, text, p.language, ref_file, row.get("transcript") or "", out_path, p.settings, p.seed, prompt_path)
    ctx.progress("generate", "Done", current=1, total=1)
    return {"path": res.get("path", str(out_path)), "sample_rate": res.get("sample_rate"), "duration_s": res.get("duration_s"),
            "seed": res.get("seed"), "elapsed_s": res.get("elapsed_s"), "normalized_text": text, "engine_id": p.engine_id,
            "reference_id": p.reference_id, "warnings": warnings + list(res.get("warnings") or [])}
