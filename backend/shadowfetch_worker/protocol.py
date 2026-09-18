"""Protocol envelope + error model. See docs/PROTOCOL.md."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from . import PROTOCOL_VERSION


class Request(BaseModel):
    v: int = PROTOCOL_VERSION
    type: Literal["request"] = "request"
    id: str
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class Cancel(BaseModel):
    v: int = PROTOCOL_VERSION
    type: Literal["cancel"] = "cancel"
    id: str


# ---- error codes (stable strings the UI switches on)
INVALID_PARAMS = "INVALID_PARAMS"
NOT_FOUND = "NOT_FOUND"
CANCELLED = "CANCELLED"
MODEL_MISSING = "MODEL_MISSING"
MODEL_INVALID = "MODEL_INVALID"
MODEL_LOAD_FAILED = "MODEL_LOAD_FAILED"
ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"
ENGINE_CRASHED = "ENGINE_CRASHED"
GPU_OOM = "GPU_OOM"
OFFLINE_BLOCKED = "OFFLINE_BLOCKED"
DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
DISK_FULL = "DISK_FULL"
DEVICE_UNAVAILABLE = "DEVICE_UNAVAILABLE"
PERMISSION_DENIED = "PERMISSION_DENIED"
UNSUPPORTED_FILE = "UNSUPPORTED_FILE"
CORRUPT_FILE = "CORRUPT_FILE"
EMPTY_AUDIO = "EMPTY_AUDIO"
FFMPEG_FAILED = "FFMPEG_FAILED"
DB_ERROR = "DB_ERROR"
INTERNAL = "INTERNAL"


class WorkerError(Exception):
    """Raised by handlers; serialized as an `error` message."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None, recoverable: bool = True):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
        self.recoverable = recoverable

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details, "recoverable": self.recoverable}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "WorkerError":
        return cls(d.get("code", INTERNAL), d.get("message", "unknown error"), d.get("details") or {}, bool(d.get("recoverable", True)))


class CancelledError(WorkerError):
    def __init__(self, details: dict[str, Any] | None = None):
        super().__init__(CANCELLED, "Cancelled", details, True)


def invalid_params(exc: ValidationError | str) -> WorkerError:
    if isinstance(exc, ValidationError):
        errs = [{"loc": ".".join(str(x) for x in e["loc"]), "msg": e["msg"]} for e in exc.errors()]
        return WorkerError(INVALID_PARAMS, "Invalid parameters: " + "; ".join(f"{e['loc']}: {e['msg']}" for e in errs), {"errors": errs})
    return WorkerError(INVALID_PARAMS, str(exc))


def envelope_progress(req_id: str, stage: str, message: str, current: int | None = None, total: int | None = None,
                      detail: dict[str, Any] | None = None) -> dict[str, Any]:
    msg: dict[str, Any] = {"v": PROTOCOL_VERSION, "type": "progress", "id": req_id, "stage": stage, "message": message}
    if current is not None:
        msg["current"] = current
    if total is not None:
        msg["total"] = total
    if detail:
        msg["detail"] = detail
    return msg


def envelope_result(req_id: str, result: Any) -> dict[str, Any]:
    return {"v": PROTOCOL_VERSION, "type": "result", "id": req_id, "result": result}


def envelope_error(req_id: str, err: WorkerError) -> dict[str, Any]:
    return {"v": PROTOCOL_VERSION, "type": "error", "id": req_id, "error": err.to_dict()}


def envelope_event(event: str, data: dict[str, Any]) -> dict[str, Any]:
    return {"v": PROTOCOL_VERSION, "type": "event", "event": event, "data": data}
