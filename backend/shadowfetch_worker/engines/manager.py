"""EngineManager: supervises engine-host subprocesses from the main worker.

One loaded engine at a time by default (settings.gpu_jobs == 1). Unloading kills the host process — the only
way to reliably return VRAM. Adapters' `capabilities()` must not import torch so the main worker can read
capabilities without spawning a host.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import Future
from pathlib import Path
from typing import Any

from ..protocol import (ENGINE_CRASHED, ENGINE_UNAVAILABLE, INTERNAL, MODEL_MISSING, CancelledError, WorkerError,
                        MODEL_LOAD_FAILED)
from ..rpc import Ctx
from .base import Capabilities
from .registry import ENGINES, load_adapter_class

log = logging.getLogger("engines")
BACKEND_DIR = Path(__file__).resolve().parent.parent.parent


class EngineHost:
    """A running `engine_host` subprocess speaking the worker protocol."""

    def __init__(self, engine_id: str, python: Path, log_path: Path, env: dict[str, str]):
        self.engine_id = engine_id
        self.python = python
        self.log_file = open(log_path, "ab", buffering=0)
        cmd = [str(python), "-m", "shadowfetch_worker.engine_host", "--engine", engine_id]
        full_env = {**os.environ, **env, "PYTHONPATH": str(BACKEND_DIR) + os.pathsep + os.environ.get("PYTHONPATH", ""),
                    "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log_file,
                                     env=full_env, cwd=str(BACKEND_DIR), text=True, encoding="utf-8", bufsize=1,
                                     start_new_session=True)
        self._pending: dict[str, tuple[Future, Ctx | None]] = {}
        self._lock = threading.Lock()
        self.ready = threading.Event()
        self.dead = threading.Event()
        self.exit_error: str | None = None
        self._reader = threading.Thread(target=self._read_loop, name=f"engine-{engine_id}-reader", daemon=True)
        self._reader.start()
        if not self.ready.wait(120):
            self.kill()
            raise WorkerError(ENGINE_CRASHED, f"Engine host for {engine_id} did not start (see logs/engine-{engine_id}.log)",
                              recoverable=True)

    def _read_loop(self) -> None:
        try:
            for line in self.proc.stdout:  # type: ignore[union-attr]
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                t = msg.get("type")
                if t == "ready":
                    self.ready.set()
                    continue
                rid = msg.get("id")
                with self._lock:
                    entry = self._pending.get(rid)
                if not entry:
                    continue
                fut, ctx = entry
                if t == "progress":
                    if ctx is not None:
                        ctx.progress(msg.get("stage", "engine"), msg.get("message", ""), msg.get("current"), msg.get("total"), msg.get("detail"))
                elif t == "result":
                    with self._lock:
                        self._pending.pop(rid, None)
                    fut.set_result(msg.get("result"))
                elif t == "error":
                    with self._lock:
                        self._pending.pop(rid, None)
                    fut.set_exception(WorkerError.from_dict(msg.get("error") or {}))
        finally:
            code = self.proc.wait()
            self.exit_error = f"engine host exited with code {code}"
            self.dead.set()
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for fut, _ in pending:
                if not fut.done():
                    fut.set_exception(WorkerError(ENGINE_CRASHED, f"The {self.engine_id} engine process stopped unexpectedly "
                                                  f"(code {code}). Check logs/engine-{self.engine_id}.log.", recoverable=True))

    def alive(self) -> bool:
        return not self.dead.is_set() and self.proc.poll() is None

    def call(self, method: str, params: dict[str, Any], ctx: Ctx | None = None, timeout: float | None = None) -> Any:
        if not self.alive():
            raise WorkerError(ENGINE_CRASHED, f"Engine host for {self.engine_id} is not running", recoverable=True)
        rid = uuid.uuid4().hex
        fut: Future = Future()
        with self._lock:
            self._pending[rid] = (fut, ctx)
        try:
            self.proc.stdin.write(json.dumps({"v": 1, "type": "request", "id": rid, "method": method, "params": params}) + "\n")  # type: ignore[union-attr]
            self.proc.stdin.flush()  # type: ignore[union-attr]
        except (OSError, ValueError) as e:
            raise WorkerError(ENGINE_CRASHED, f"Cannot talk to engine host: {e}", recoverable=True)
        deadline = time.time() + timeout if timeout else None
        while True:
            try:
                return fut.result(timeout=0.25)
            except TimeoutError:
                pass
            except Exception:
                raise
            if ctx is not None and ctx.cancelled():
                self._send_cancel(rid)
                # give the host a moment to stop gracefully, then hard-kill (VRAM returned, engine must reload)
                try:
                    return fut.result(timeout=5.0)
                except TimeoutError:
                    self.kill()
                    raise CancelledError({"engine_id": self.engine_id, "hard_cancel": True})
            if deadline and time.time() > deadline:
                self._send_cancel(rid)
                raise WorkerError(INTERNAL, f"{method} timed out after {timeout}s", recoverable=True)

    def _send_cancel(self, rid: str) -> None:
        try:
            self.proc.stdin.write(json.dumps({"v": 1, "type": "cancel", "id": rid}) + "\n")  # type: ignore[union-attr]
            self.proc.stdin.flush()  # type: ignore[union-attr]
        except (OSError, ValueError):
            pass

    def kill(self) -> None:
        try:
            if self.proc.poll() is None:
                try:
                    self.proc.stdin.write(json.dumps({"v": 1, "type": "shutdown"}) + "\n")  # type: ignore[union-attr]
                    self.proc.stdin.flush()  # type: ignore[union-attr]
                except (OSError, ValueError):
                    pass
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(self.proc.pid, 9)
        finally:
            self.dead.set()
            try:
                self.log_file.close()
            except OSError:
                pass


class EngineManager:
    def __init__(self, server):
        self.server = server
        self.st = server.state
        self.hosts: dict[str, EngineHost] = {}
        self.info: dict[str, dict[str, Any]] = {eid: {"state": "unloaded", "model_id": None, "revision": None, "last_used": 0.0,
                                                     "vram_bytes": None, "message": ""} for eid in ENGINES}
        self._lock = threading.RLock()
        self._caps: dict[str, Capabilities] = {}
        self._idle = threading.Thread(target=self._idle_loop, daemon=True, name="engine-idle")
        self._idle.start()

    # ---- static info
    def descriptors(self) -> list[dict[str, Any]]:
        rt = self.st["runtime"]
        out = []
        for eid, d in ENGINES.items():
            probe = rt.probe_env(d["env"])
            pkg = {"qwen3-tts-base": "pkg_qwen_tts", "chatterbox-turbo": "pkg_chatterbox"}.get(eid)
            installed = bool(probe.get("installed")) and (probe.get(pkg) is not None if pkg else True)
            out.append({**d, "installed": installed, "env_probe": {k: v for k, v in probe.items() if k in ("torch", "cuda_available", "cuda_device", "python", "error", "torch_error")},
                        **self.info[eid]})
        return out

    def states(self) -> dict[str, dict[str, Any]]:
        return {eid: {**v, "alive": eid in self.hosts and self.hosts[eid].alive()} for eid, v in self.info.items()}

    def capabilities(self, engine_id: str) -> Capabilities:
        if engine_id not in ENGINES:
            raise WorkerError(ENGINE_UNAVAILABLE, f"Unknown engine {engine_id}")
        if engine_id not in self._caps:
            cls = load_adapter_class(engine_id)
            self._caps[engine_id] = cls().capabilities()
        return self._caps[engine_id]

    # ---- lifecycle
    def _emit(self, engine_id: str) -> None:
        d = self.info[engine_id]
        self.server.transport.event("engine.state", {"engine_id": engine_id, **d})

    def _set(self, engine_id: str, **kw) -> None:
        self.info[engine_id].update(kw)
        self._emit(engine_id)

    def _spawn(self, engine_id: str) -> EngineHost:
        rt = self.st["runtime"]
        py = rt.python_for_engine(engine_id)
        if py is None:
            raise WorkerError(ENGINE_UNAVAILABLE, f"The Python environment for {ENGINES[engine_id]['name']} is not installed. "
                              f"Run scripts/bootstrap.sh (or install it from Settings → Engines).", {"engine_id": engine_id}, False)
        paths = self.st["paths"]
        env = {"HF_HUB_CACHE": str(paths.hf_cache), "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false"}
        if self.st["settings"].value.offline:
            env.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
        host = EngineHost(engine_id, py, paths.logs / f"engine-{engine_id}.log", env)
        self.hosts[engine_id] = host
        return host

    def ensure_loaded(self, ctx: Ctx, engine_id: str, model_id: str | None = None, device: str = "cuda") -> dict[str, Any]:
        if engine_id not in ENGINES:
            raise WorkerError(ENGINE_UNAVAILABLE, f"Unknown engine {engine_id}")
        with self._lock:
            model_id = model_id or ENGINES[engine_id]["model_id"]
            host = self.hosts.get(engine_id)
            if host and host.alive() and self.info[engine_id]["state"] == "loaded" and self.info[engine_id]["model_id"] == model_id:
                self.info[engine_id]["last_used"] = time.time()
                return {"engine_id": engine_id, "model_id": model_id, "revision": self.info[engine_id]["revision"], "already_loaded": True}
            # one loaded engine at a time (VRAM policy)
            if int(self.st["settings"].value.gpu_jobs or 1) <= 1:
                for other in list(self.hosts):
                    if other != engine_id:
                        self.unload(other, reason="another engine was requested")
            models = self.st.get("models")
            if models is None:
                raise WorkerError(INTERNAL, "model manager not initialised", recoverable=False)
            model_dir = models.resolve_installed_dir(model_id)   # raises MODEL_MISSING / MODEL_INVALID
            revision = models.installed_revision(model_id)
            if host is None or not host.alive():
                self._set(engine_id, state="loading", model_id=model_id, message="Starting engine process")
                ctx.progress("engine", f"Starting {ENGINES[engine_id]['name']} process")
                try:
                    host = self._spawn(engine_id)
                except WorkerError as e:
                    self._set(engine_id, state="error", message=e.message)
                    raise
            self._set(engine_id, state="loading", model_id=model_id, message="Loading model weights")
            ctx.progress("engine", f"Loading {ENGINES[engine_id]['name']} weights")
            t0 = time.time()
            try:
                res = host.call("engine.load", {"model_dir": str(model_dir), "device": device, "revision": revision}, ctx=ctx, timeout=900)
            except WorkerError as e:
                self._set(engine_id, state="error", message=e.message)
                if e.code == ENGINE_CRASHED or e.code == "GPU_OOM":
                    self.unload(engine_id, reason="load failed")
                raise
            self._set(engine_id, state="loaded", model_id=model_id, revision=res.get("revision") or revision,
                      vram_bytes=res.get("vram_bytes"), message="", last_used=time.time())
            return {"engine_id": engine_id, "model_id": model_id, "revision": self.info[engine_id]["revision"],
                    "load_ms": int((time.time() - t0) * 1000), "vram_bytes": res.get("vram_bytes")}

    def unload(self, engine_id: str, reason: str = "") -> None:
        with self._lock:
            host = self.hosts.pop(engine_id, None)
            if host:
                host.kill()
            if engine_id in self.info:
                self._set(engine_id, state="unloaded", model_id=None, revision=None, vram_bytes=None, message=reason)

    def shutdown_all(self) -> None:
        for eid in list(self.hosts):
            self.unload(eid, "worker shutdown")

    def _idle_loop(self) -> None:
        while True:
            time.sleep(30)
            try:
                minutes = int(self.st["settings"].value.idle_unload_minutes or 0)
                if minutes <= 0:
                    continue
                now = time.time()
                for eid, d in list(self.info.items()):
                    if d["state"] == "loaded" and now - d["last_used"] > minutes * 60 and self.server.gpu.holder is None:
                        log.info("idle-unloading %s", eid)
                        self.unload(eid, "idle")
            except Exception:  # noqa: BLE001
                log.exception("idle loop")

    # ---- operations (called with the GPU lock held by the RPC layer)
    def _host(self, ctx: Ctx, engine_id: str) -> EngineHost:
        self.ensure_loaded(ctx, engine_id)
        host = self.hosts[engine_id]
        self.info[engine_id]["last_used"] = time.time()
        return host

    def prepare_reference(self, ctx: Ctx, engine_id: str, reference_path: Path, transcript: str, language: str, cache_path: Path) -> dict[str, Any]:
        host = self._host(ctx, engine_id)
        try:
            return host.call("engine.prepare", {"reference_path": str(reference_path), "transcript": transcript, "language": language,
                                                "cache_path": str(cache_path)}, ctx=ctx, timeout=600)
        except WorkerError as e:
            if e.code == ENGINE_CRASHED:
                self.unload(engine_id, "crashed")
            raise

    def generate(self, ctx: Ctx, engine_id: str, text: str, language: str, reference_path: Path, transcript: str,
                 out_path: Path, settings: dict[str, Any], seed: int | None, prompt_cache_path: Path | None) -> dict[str, Any]:
        host = self._host(ctx, engine_id)
        try:
            res = host.call("engine.generate", {"text": text, "language": language, "reference_path": str(reference_path),
                                                "transcript": transcript, "out_path": str(out_path), "settings": settings, "seed": seed,
                                                "prompt_cache_path": str(prompt_cache_path) if prompt_cache_path else None},
                            ctx=ctx, timeout=1800)
            self.info[engine_id]["last_used"] = time.time()
            return res
        except WorkerError as e:
            if e.code == ENGINE_CRASHED:
                self.unload(engine_id, "crashed")
            elif e.code == "GPU_OOM":
                self.info[engine_id]["message"] = "GPU out of memory"
            raise

    def health(self, engine_id: str) -> dict[str, Any]:
        host = self.hosts.get(engine_id)
        if not host or not host.alive():
            return {"alive": False}
        try:
            return {"alive": True, **host.call("engine.health", {}, timeout=15)}
        except WorkerError as e:
            return {"alive": False, "error": e.message}
