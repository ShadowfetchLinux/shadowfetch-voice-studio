"""system.* methods."""
from __future__ import annotations

import os
import shutil
import time
from typing import Any

from pydantic import BaseModel

from ..protocol import ENGINE_UNAVAILABLE, INVALID_PARAMS, WorkerError
from ..rpc import Ctx, method
from ..system.diagnostics import diagnostics, gpu_info


def S(ctx: Ctx):
    return ctx.server.state


@method("system.ping")
def ping(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "uptime_s": round(time.time() - ctx.server.started, 1), "pid": os.getpid()}


@method("system.diagnostics")
def diag(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    st = S(ctx)
    return diagnostics(st["paths"], st["runtime"], st["settings"].value.offline)


@method("system.gpu_status")
def gpu_status(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    st = S(ctx)
    engines = st.get("engines")
    return {"gpus": gpu_info(), "engines": engines.states() if engines else {}}


class CudaParams(BaseModel):
    engine_id: str = "qwen3-tts-base"


@method("system.cuda_smoke_test", gpu=True, params=CudaParams)
def cuda_smoke(ctx: Ctx, p: CudaParams) -> dict[str, Any]:
    """A real CUDA matmul in the engine's environment (not just `is_available`)."""
    import json
    import subprocess
    rt = S(ctx)["runtime"]
    py = rt.python_for_engine(p.engine_id)
    if py is None:
        raise WorkerError(ENGINE_UNAVAILABLE, f"Environment for {p.engine_id} is not installed.")
    code = (
        "import json,time,torch\n"
        "out={'torch_version':torch.__version__,'cuda_version':torch.version.cuda,'ok':False}\n"
        "if not torch.cuda.is_available(): out['error']='torch.cuda.is_available() is False'\n"
        "else:\n"
        "  try:\n"
        "    d=torch.device('cuda'); out['device']=torch.cuda.get_device_name(0)\n"
        "    a=torch.randn(2048,2048,device=d,dtype=torch.bfloat16); b=torch.randn(2048,2048,device=d,dtype=torch.bfloat16)\n"
        "    torch.cuda.synchronize(); t=time.time(); c=(a@b).float().sum().item(); torch.cuda.synchronize()\n"
        "    out['matmul_ms']=round((time.time()-t)*1000,2); out['ok']=bool(c==c)\n"
        "    out['vram_free_bytes'],out['vram_total_bytes']=torch.cuda.mem_get_info()\n"
        "  except Exception as e: out['error']=str(e)[:400]\n"
        "print(json.dumps(out))\n"
    )
    ctx.progress("cuda", "Running a CUDA matmul in the engine environment")
    r = subprocess.run([str(py), "-c", code], capture_output=True, text=True, timeout=180)
    lines = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
    if not lines:
        return {"ok": False, "error": (r.stderr or "no output")[-600:]}
    return json.loads(lines[-1])


class OfflineParams(BaseModel):
    offline: bool


@method("system.set_offline", params=OfflineParams)
def set_offline(ctx: Ctx, p: OfflineParams) -> dict[str, Any]:
    st = S(ctx)
    st["settings"].patch({"offline": p.offline})
    _apply_offline_env(p.offline)
    return {"offline": p.offline}


def _apply_offline_env(offline: bool) -> None:
    for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
        if offline:
            os.environ[k] = "1"
        else:
            os.environ.pop(k, None)


@method("system.settings.get")
def settings_get(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    return S(ctx)["settings"].value.model_dump()


class PatchParams(BaseModel):
    patch: dict[str, Any]


@method("system.settings.set", params=PatchParams)
def settings_set(ctx: Ctx, p: PatchParams) -> dict[str, Any]:
    st = S(ctx)
    if "gpu_jobs" in p.patch and not (1 <= int(p.patch["gpu_jobs"]) <= 4):
        raise WorkerError(INVALID_PARAMS, "gpu_jobs must be between 1 and 4")
    v = st["settings"].patch(p.patch)
    if "offline" in p.patch:
        _apply_offline_env(v.offline)
    return v.model_dump()


def _dir_size(path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


@method("system.storage_usage")
def storage_usage(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    paths = S(ctx)["paths"]
    return {
        "data_dir": str(paths.data), "models_bytes": _dir_size(paths.models), "recordings_bytes": _dir_size(paths.recordings),
        "voices_bytes": _dir_size(paths.voices), "projects_bytes": _dir_size(paths.projects), "exports_bytes": _dir_size(paths.exports),
        "cache_bytes": _dir_size(paths.cache), "free_bytes": shutil.disk_usage(paths.data).free,
        "total_bytes": shutil.disk_usage(paths.data).total,
    }


class ClearCacheParams(BaseModel):
    kinds: list[str] = ["prompts", "peaks", "tmp"]


@method("system.clear_cache", params=ClearCacheParams)
def clear_cache(ctx: Ctx, p: ClearCacheParams) -> dict[str, Any]:
    """Only regenerable caches. Recordings, voices, projects and masters are never touched here."""
    paths = S(ctx)["paths"]
    freed = 0
    targets = {"prompts": paths.prompts, "peaks": paths.peaks, "tmp": paths.tmp}
    for kind in p.kinds:
        d = targets.get(kind)
        if not d or not d.exists():
            continue
        freed += _dir_size(d)
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True, exist_ok=True)
    if "prompts" in p.kinds:
        db = S(ctx).get("db")
        if db:
            with db.tx() as c:
                c.execute("DELETE FROM prompt_cache")
    return {"freed_bytes": freed}


@method("system.log_bundle")
def log_bundle(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    import json
    import zipfile
    st = S(ctx)
    paths = st["paths"]
    out = paths.exports / f"diagnostics-{int(time.time())}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in paths.logs.glob("*.log*"):
            z.write(f, f"logs/{f.name}")
        z.writestr("diagnostics.json", json.dumps(diagnostics(paths, st["runtime"], st["settings"].value.offline), indent=2, default=str))
    return {"path": str(out)}
