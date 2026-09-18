"""JSON-lines RPC server: dispatch, worker threads, cancellation, progress, GPU lock.

Handlers are plain functions registered with `@method("ns.name", gpu=False, params=Model)`.
They receive a `Ctx` (progress/cancel/events) and validated params, and return a JSON-serializable dict.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from . import PROTOCOL_VERSION
from .protocol import (CancelledError, GPU_OOM, INTERNAL, INVALID_PARAMS, NOT_FOUND, WorkerError, envelope_error,
                       envelope_event, envelope_progress, envelope_result, invalid_params)

log = logging.getLogger("rpc")


class Transport:
    """Thread-safe writer for the protocol channel (the *real* stdout fd)."""

    def __init__(self, fd: int | None = None):
        self._lock = threading.Lock()
        self._fd = fd if fd is not None else os.dup(1)
        self._file = os.fdopen(self._fd, "w", buffering=1, encoding="utf-8")

    def send(self, obj: dict[str, Any]) -> None:
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default)
        with self._lock:
            self._file.write(line + "\n")
            self._file.flush()

    def event(self, name: str, data: dict[str, Any]) -> None:
        self.send(envelope_event(name, data))


def _json_default(o: Any):
    try:
        import numpy as np
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:
        pass
    if isinstance(o, BaseModel):
        return o.model_dump()
    if hasattr(o, "__fspath__"):
        return os.fspath(o)
    return str(o)


@dataclass
class Ctx:
    """Per-request context handed to handlers."""
    req_id: str
    method: str
    transport: Transport
    server: "Server"
    _cancel: threading.Event = field(default_factory=threading.Event)
    _last_progress: float = 0.0
    started_at: float = field(default_factory=time.time)
    subprocesses: list = field(default_factory=list)   # Popen objects to kill on cancel

    # -- progress / cancel
    def progress(self, stage: str, message: str, current: int | None = None, total: int | None = None,
                 detail: dict[str, Any] | None = None, throttle_s: float = 0.0) -> None:
        now = time.time()
        if throttle_s and now - self._last_progress < throttle_s and current not in (None, total):
            return
        self._last_progress = now
        self.transport.send(envelope_progress(self.req_id, stage, message, current, total, detail))

    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check_cancel(self, details: dict[str, Any] | None = None) -> None:
        if self._cancel.is_set():
            raise CancelledError(details)

    def cancel(self) -> None:
        self._cancel.set()
        for p in list(self.subprocesses):
            try:
                p.kill()
            except Exception:  # noqa: BLE001
                pass

    def track(self, popen):
        """Register a subprocess so `cancel` kills it."""
        self.subprocesses.append(popen)
        return popen

    def event(self, name: str, data: dict[str, Any]) -> None:
        self.transport.event(name, data)


@dataclass
class MethodSpec:
    name: str
    fn: Callable[[Ctx, Any], Any]
    gpu: bool = False
    params_model: type[BaseModel] | None = None


_REGISTRY: dict[str, MethodSpec] = {}


def method(name: str, gpu: bool = False, params: type[BaseModel] | None = None):
    """Register a handler. `params` is a pydantic model used to validate `request.params`."""

    def deco(fn: Callable[[Ctx, Any], Any]):
        _REGISTRY[name] = MethodSpec(name, fn, gpu, params)
        return fn

    return deco


def registry() -> dict[str, MethodSpec]:
    return _REGISTRY


class GpuLock:
    """Serializes GPU-heavy jobs. Reports queueing to the waiting request."""

    def __init__(self, slots: int = 1):
        self._sem = threading.Semaphore(slots)
        self.slots = slots
        self.holder: str | None = None

    def acquire(self, ctx: Ctx) -> None:
        if not self._sem.acquire(blocking=False):
            ctx.progress("queued", "Waiting for the GPU (another job is running)")
            while not self._sem.acquire(timeout=0.25):
                ctx.check_cancel()
        self.holder = ctx.method

    def release(self) -> None:
        self.holder = None
        self._sem.release()


class Server:
    def __init__(self, transport: Transport, worker_name: str = "main", max_workers: int = 8, gpu_slots: int = 1,
                 on_shutdown: Callable[[], None] | None = None):
        self.transport = transport
        self.worker_name = worker_name
        self.pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="job")
        self.gpu = GpuLock(gpu_slots)
        self.active: dict[str, Ctx] = {}
        self._active_lock = threading.Lock()
        self.started = time.time()
        self.on_shutdown = on_shutdown
        self.state: dict[str, Any] = {}   # shared per-process state (db, settings, engine manager...)

    # -- lifecycle
    def serve_forever(self, stdin=None) -> None:
        stdin = stdin or sys.stdin
        self.transport.send({"v": PROTOCOL_VERSION, "type": "ready", "worker": self.worker_name,
                             "protocol": PROTOCOL_VERSION, "pid": os.getpid()})
        for raw in stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                log.warning("dropping non-JSON line: %r", raw[:200])
                continue
            t = msg.get("type")
            if t == "request":
                self._on_request(msg)
            elif t == "cancel":
                self.cancel(str(msg.get("id", "")))
            elif t == "shutdown":
                break
            else:
                log.warning("unknown message type %r", t)
        self.shutdown()

    def shutdown(self) -> None:
        for ctx in list(self.active.values()):
            ctx.cancel()
        if self.on_shutdown:
            try:
                self.on_shutdown()
            except Exception:  # noqa: BLE001
                log.exception("on_shutdown failed")
        self.pool.shutdown(wait=False, cancel_futures=True)

    def cancel(self, req_id: str) -> None:
        with self._active_lock:
            ctx = self.active.get(req_id)
        if ctx:
            ctx.cancel()

    # -- dispatch
    def _on_request(self, msg: dict[str, Any]) -> None:
        req_id = str(msg.get("id") or "")
        name = str(msg.get("method") or "")
        spec = _REGISTRY.get(name)
        if not req_id:
            return
        if spec is None:
            self.transport.send(envelope_error(req_id, WorkerError(NOT_FOUND, f"Unknown method {name!r}", recoverable=False)))
            return
        ctx = Ctx(req_id=req_id, method=name, transport=self.transport, server=self)
        with self._active_lock:
            self.active[req_id] = ctx
        self.pool.submit(self._run, spec, ctx, msg.get("params") or {})

    def _run(self, spec: MethodSpec, ctx: Ctx, raw_params: dict[str, Any]) -> None:
        try:
            params: Any = raw_params
            if spec.params_model is not None:
                try:
                    params = spec.params_model.model_validate(raw_params)
                except ValidationError as ve:
                    raise invalid_params(ve)
            if spec.gpu:
                self.gpu.acquire(ctx)
            try:
                ctx.check_cancel()
                result = spec.fn(ctx, params)
            finally:
                if spec.gpu:
                    self.gpu.release()
            if isinstance(result, BaseModel):
                result = result.model_dump()
            self.transport.send(envelope_result(ctx.req_id, result if result is not None else {}))
        except WorkerError as we:
            self.transport.send(envelope_error(ctx.req_id, we))
        except MemoryError:
            self.transport.send(envelope_error(ctx.req_id, WorkerError(GPU_OOM, "Out of memory", {"method": spec.name})))
        except Exception as exc:  # noqa: BLE001
            log.exception("handler %s failed", spec.name)
            err = classify_exception(exc)
            self.transport.send(envelope_error(ctx.req_id, err))
        finally:
            with self._active_lock:
                self.active.pop(ctx.req_id, None)


def classify_exception(exc: Exception) -> WorkerError:
    text = f"{type(exc).__name__}: {exc}"
    low = text.lower()
    if "out of memory" in low or "cuda oom" in low or "cudaerrormemoryallocation" in low:
        return WorkerError(GPU_OOM, "The GPU ran out of memory. Unload other models, shorten the segment, or switch the engine to CPU.",
                           {"exception": text[:500]}, True)
    if "no space left" in low or "enospc" in low:
        return WorkerError("DISK_FULL", "The disk is full. Free space and retry.", {"exception": text[:500]}, True)
    if "permission denied" in low:
        return WorkerError("PERMISSION_DENIED", "Permission denied: " + str(exc)[:300], {"exception": text[:500]}, True)
    return WorkerError(INTERNAL, text[:600], {"traceback": traceback.format_exc()[-2000:]}, True)
