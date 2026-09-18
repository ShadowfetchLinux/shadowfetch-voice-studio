"""models.* methods (see docs/PROTOCOL.md). The ModelManager is created lazily on first use and shared via server.state."""
from __future__ import annotations

import threading
from typing import Any

from pydantic import BaseModel

from ..models.manager import ModelManager
from ..rpc import Ctx, method

_INIT_LOCK = threading.Lock()


def get_models(ctx_or_server) -> ModelManager:
    """Return the process-wide ModelManager, creating it on first use (stored in server.state['models'])."""
    server = getattr(ctx_or_server, "server", ctx_or_server)
    mm = server.state.get("models")
    if mm is None:
        with _INIT_LOCK:
            mm = server.state.get("models")
            if mm is None:
                mm = ModelManager(server.state, transport=getattr(server, "transport", None))
                server.state["models"] = mm
    return mm


class ModelParams(BaseModel):
    model_id: str


class UseDirParams(BaseModel):
    model_id: str
    path: str


class RemoveParams(BaseModel):
    model_id: str
    confirm: bool = False


@method("models.list")
def models_list(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    mm = get_models(ctx)
    return {"models": mm.list(), "offline": mm._offline(), "hf_cache": str(mm.hf_cache)}


@method("models.state", params=ModelParams)
def models_state(ctx: Ctx, p: ModelParams) -> dict[str, Any]:
    return get_models(ctx).state(p.model_id)


@method("models.download", params=ModelParams)
def models_download(ctx: Ctx, p: ModelParams) -> dict[str, Any]:
    return get_models(ctx).download(ctx, p.model_id)


@method("models.cancel_download", params=ModelParams)
def models_cancel(ctx: Ctx, p: ModelParams) -> dict[str, Any]:
    return {"ok": get_models(ctx).cancel_download(p.model_id)}


@method("models.verify", params=ModelParams)
def models_verify(ctx: Ctx, p: ModelParams) -> dict[str, Any]:
    ctx.progress("verify", f"Verifying {p.model_id}")
    return get_models(ctx).verify(p.model_id)


@method("models.use_existing_dir", params=UseDirParams)
def models_use_dir(ctx: Ctx, p: UseDirParams) -> dict[str, Any]:
    return get_models(ctx).use_existing_dir(p.model_id, p.path)


@method("models.remove", params=RemoveParams)
def models_remove(ctx: Ctx, p: RemoveParams) -> dict[str, Any]:
    return get_models(ctx).remove(p.model_id, p.confirm)
