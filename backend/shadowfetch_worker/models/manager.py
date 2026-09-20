"""ModelManager: registry + DB rows + on-disk truth for every known model; cancellable subprocess downloads.

No torch, no network in this module (downloads run in `download_proc` as a child process).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from ..paths import require_free_space
from ..protocol import (DOWNLOAD_FAILED, INVALID_PARAMS, MODEL_INVALID, MODEL_MISSING, NOT_FOUND, OFFLINE_BLOCKED,
                        CancelledError, WorkerError)
from .registry import MODELS
from .verify import (VerifyResult, dir_size, incomplete_blobs, read_ref, read_tts_model_type, repo_cache_dir,
                     snapshot_dir, verify_dir, verify_hf_snapshot)

log = logging.getLogger("models")
BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
STATES = ("missing", "downloading", "installed", "error", "verifying")


def _gb(n: int | None) -> str:
    return f"{(n or 0) / 1e9:.1f} GB" if (n or 0) >= 1e9 else f"{(n or 0) / 1e6:.0f} MB"


class ModelManager:
    def __init__(self, state: dict[str, Any], transport=None):
        self.st = state
        self.transport = transport
        self.paths = state["paths"]
        self.hf_cache: Path = Path(self.paths.hf_cache)
        self.active: dict[str, subprocess.Popen] = {}
        self._lock = threading.RLock()
        self._last_emitted: dict[str, str] = {}
        self._cancel_requested: set[str] = set()   # model ids whose running download was cancelled via cancel_download()

    # ------------------------------------------------------------------ helpers
    @property
    def db(self):
        return self.st.get("db")

    def _offline(self) -> bool:
        settings = self.st.get("settings")
        if settings is not None and getattr(settings, "value", None) is not None and settings.value.offline:
            return True
        return os.environ.get("HF_HUB_OFFLINE") == "1"

    @staticmethod
    def spec(model_id: str) -> dict[str, Any]:
        m = MODELS.get(model_id)
        if m is None:
            raise WorkerError(NOT_FOUND, f"Unknown model {model_id!r}", {"model_id": model_id}, False)
        return m

    def _row(self, model_id: str) -> dict[str, Any] | None:
        db = self.db
        if db is None:
            return None
        try:
            r = db.one("SELECT * FROM models WHERE id = ?", (model_id,))
        except Exception:  # noqa: BLE001
            return None
        return dict(r) if r is not None else None

    def _save_row(self, model_id: str, **fields: Any) -> None:
        db = self.db
        if db is None:
            return
        spec = self.spec(model_id)
        cur = self._row(model_id) or {"id": model_id, "repo": spec["repo"], "revision_pinned": spec["revision"], "revision_installed": None,
                                      "path": None, "state": "missing", "size_bytes": None, "error": None}
        cur.update(fields)
        cur["repo"] = spec["repo"]
        cur["revision_pinned"] = spec["revision"]
        with db.tx() as c:
            c.execute("INSERT OR REPLACE INTO models (id, repo, revision_pinned, revision_installed, path, state, size_bytes, error, updated_at) "
                      "VALUES (?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                      (model_id, cur["repo"], cur["revision_pinned"], cur.get("revision_installed"), cur.get("path"), cur.get("state", "missing"),
                       cur.get("size_bytes"), cur.get("error")))

    def _delete_row(self, model_id: str) -> None:
        db = self.db
        if db is None:
            return
        with db.tx() as c:
            c.execute("DELETE FROM models WHERE id = ?", (model_id,))

    def emit(self, model_id: str, state: str, **extra: Any) -> None:
        data = {"model_id": model_id, "state": state, **{k: v for k, v in extra.items() if v is not None}}
        key = json.dumps(data, sort_keys=True, default=str)
        if self._last_emitted.get(model_id) == key:
            return
        self._last_emitted[model_id] = key
        if self.transport is not None:
            try:
                self.transport.event("model.state", data)
            except Exception:  # noqa: BLE001
                log.exception("model.state event failed")

    # ------------------------------------------------------------------ inspection
    def _custom_dir(self, model_id: str) -> Path | None:
        row = self._row(model_id)
        if row and row.get("revision_installed") == "local" and row.get("path"):
            return Path(row["path"])
        return None

    def _verify_result(self, model_id: str) -> VerifyResult:
        spec = self.spec(model_id)
        custom = self._custom_dir(model_id)
        if custom is not None:
            return verify_dir(custom, spec["required_files"], "local")
        return verify_hf_snapshot(self.hf_cache, spec["repo"], spec["revision"], spec["required_files"])

    def state(self, model_id: str) -> dict[str, Any]:
        spec = self.spec(model_id)
        row = self._row(model_id) or {}
        entry: dict[str, Any] = {
            "id": model_id, "engine_id": spec.get("engine_id"), "kind": spec["kind"], "repo": spec["repo"],
            "revision_pinned": spec["revision"], "revision_installed": None, "size_bytes": None,
            "approx_size_bytes": spec.get("approx_size_bytes"), "license": spec["license"], "license_url": spec.get("license_url"),
            "description": spec.get("description", ""), "state": "missing", "path": None, "error": None,
            "required_files": list(spec["required_files"]), "ignore_patterns": list(spec.get("ignore_patterns") or []),
        }
        with self._lock:
            downloading = model_id in self.active and self.active[model_id].poll() is None
        if downloading:
            entry.update(state="downloading", path=row.get("path"))
            return entry
        vr = self._verify_result(model_id)
        if vr.ok:
            entry.update(state="installed", path=vr.path, revision_installed=vr.revision, size_bytes=vr.size_bytes)
        elif vr.path is None:
            entry.update(state="missing")
        else:
            entry.update(state="error", path=vr.path, revision_installed=vr.revision,
                         error=self._describe_failure(vr))
        if entry["state"] == "missing" and row.get("error"):
            entry["error"] = row["error"]        # last download error stays visible until the next attempt
        # keep the DB row in sync with what is on disk (without re-inserting rows for models nobody touched)
        if row and (row.get("state") != entry["state"] or (entry["state"] == "installed" and row.get("size_bytes") != entry["size_bytes"])):
            self._save_row(model_id, state=entry["state"], path=entry["path"], revision_installed=entry["revision_installed"],
                           size_bytes=entry["size_bytes"], error=entry["error"])
        elif not row and entry["state"] == "installed":
            self._save_row(model_id, state="installed", path=entry["path"], revision_installed=entry["revision_installed"],
                           size_bytes=entry["size_bytes"], error=None)
        return entry

    @staticmethod
    def _describe_failure(vr: VerifyResult) -> str:
        parts = []
        if vr.missing_files:
            parts.append(f"{len(vr.missing_files)} required file{'s' if len(vr.missing_files) != 1 else ''} missing ({', '.join(vr.missing_files[:4])})")
        parts += vr.errors[:3]
        return "Download incomplete: " + "; ".join(parts) + ". Download again to resume, or remove it."

    def list(self) -> list[dict[str, Any]]:
        out = []
        for mid in MODELS:
            try:
                out.append(self.state(mid))
            except WorkerError as e:
                out.append({"id": mid, "state": "error", "error": e.message})
        return out

    def resolve_installed_dir(self, model_id: str) -> Path:
        spec = self.spec(model_id)
        vr = self._verify_result(model_id)
        if vr.ok and vr.path:
            return Path(vr.path)
        size = _gb(spec.get("approx_size_bytes"))
        if vr.path is None:
            msg = f"Model {model_id} is not installed. Open Settings → Engines & models to download it ({size})."
            if self._offline():
                msg += " Offline mode is on — turn it off to download."
            raise WorkerError(MODEL_MISSING, msg, {"model_id": model_id, "repo": spec["repo"], "approx_size_bytes": spec.get("approx_size_bytes"),
                                                   "offline": self._offline(), "hint": OFFLINE_BLOCKED if self._offline() else None}, True)
        raise WorkerError(MODEL_INVALID, f"Model {model_id} is incomplete: {self._describe_failure(vr)}",
                          {"model_id": model_id, "path": vr.path, "missing_files": vr.missing_files, "errors": vr.errors}, True)

    def installed_revision(self, model_id: str) -> str | None:
        spec = self.spec(model_id)
        custom = self._custom_dir(model_id)
        if custom is not None:
            return "local"
        return spec["revision"] or read_ref(self.hf_cache, spec["repo"], "main")

    def verify(self, model_id: str) -> dict[str, Any]:
        self.spec(model_id)
        self.emit(model_id, "verifying")
        vr = self._verify_result(model_id)
        entry = self.state(model_id)
        self.emit(model_id, entry["state"], message=entry.get("error"))
        return {"ok": vr.ok, "missing_files": vr.missing_files, "errors": vr.errors, "revision": vr.revision, "path": vr.path,
                "size_bytes": vr.size_bytes, "incomplete_blobs": incomplete_blobs(self.hf_cache, self.spec(model_id)["repo"])}

    # ------------------------------------------------------------------ downloads
    def download(self, ctx, model_id: str) -> dict[str, Any]:
        spec = self.spec(model_id)
        repo = spec["repo"]
        if self._offline():
            raise WorkerError(OFFLINE_BLOCKED, f"Offline mode is on — downloading {repo} needs the network. Turn offline mode off in Settings and retry.",
                              {"model_id": model_id, "repo": repo}, True)
        with self._lock:
            if model_id in self.active and self.active[model_id].poll() is None:
                raise WorkerError(INVALID_PARAMS, f"{model_id} is already downloading", {"model_id": model_id}, True)
            self.hf_cache.mkdir(parents=True, exist_ok=True)
            already = 0
            snap = snapshot_dir(self.hf_cache, repo, spec["revision"])
            if snap is not None:
                already = dir_size(snap)
            needed = int(max(0, spec.get("approx_size_bytes", 0) - already) * 1.1)
            require_free_space(self.hf_cache, needed, f"downloading {repo} ({_gb(spec.get('approx_size_bytes'))})")
            cmd = [sys.executable, "-m", "shadowfetch_worker.models.download_proc", "--repo", repo, "--cache-dir", str(self.hf_cache),
                   "--expected-bytes", str(int(spec.get("approx_size_bytes") or 0))]
            if spec.get("revision"):
                cmd += ["--revision", spec["revision"]]
            for pat in spec.get("ignore_patterns") or []:
                cmd += ["--ignore", pat]
            env = {k: v for k, v in os.environ.items() if k not in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE")}
            env.update({"HF_HUB_CACHE": str(self.hf_cache), "HF_HUB_DISABLE_TELEMETRY": "1", "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
                        "PYTHONPATH": str(BACKEND_DIR) + os.pathsep + os.environ.get("PYTHONPATH", "")})
            self.paths.logs.mkdir(parents=True, exist_ok=True)
            log_file = open(self.paths.logs / "download.log", "ab", buffering=0)
            log_file.write(f"\n=== {time.strftime('%Y-%m-%dT%H:%M:%S')} {model_id} {repo}@{spec['revision'] or 'main'}\n".encode())
            try:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=log_file, env=env, cwd=str(BACKEND_DIR), text=True,
                                        encoding="utf-8", bufsize=1, start_new_session=True)
            except OSError as e:
                log_file.close()
                raise WorkerError(DOWNLOAD_FAILED, f"Could not start the download process: {e}", {"model_id": model_id}, True)
            ctx.track(proc)
            self.active[model_id] = proc
        self._save_row(model_id, state="downloading", error=None)
        self.emit(model_id, "downloading", bytes_done=0, bytes_total=spec.get("approx_size_bytes"))
        ctx.progress("download", f"Downloading {repo}", current=0, total=int(spec.get("approx_size_bytes") or 0),
                     detail={"bytes_done": 0, "bytes_total": spec.get("approx_size_bytes"), "model_id": model_id})

        final: dict[str, Any] | None = None
        last_event = 0.0
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if "bytes_done" in msg and "done" not in msg and "error" not in msg:
                    bd, bt = int(msg.get("bytes_done") or 0), int(msg.get("bytes_total") or 0)
                    detail = {"bytes_done": bd, "bytes_total": bt, "files_done": msg.get("files_done"), "files_total": msg.get("files_total"),
                              "model_id": model_id}
                    ctx.progress("download", f"Downloading {repo}", current=bd, total=bt or None, detail=detail, throttle_s=0.25)
                    if time.time() - last_event >= 1.0:
                        last_event = time.time()
                        self.emit(model_id, "downloading", bytes_done=bd, bytes_total=bt)
                elif "done" in msg or "error" in msg:
                    final = msg
        finally:
            code = proc.wait()
            with self._lock:
                self.active.pop(model_id, None)
                user_cancelled = model_id in self._cancel_requested
                self._cancel_requested.discard(model_id)
            try:
                log_file.close()
            except OSError:
                pass

        # A cancel (request cancel → ctx.track() killed the child; or models.cancel_download → SIGTERM/SIGKILL) is a
        # CANCELLED, resumable outcome — never a DOWNLOAD_FAILED error persisted in the models table.
        if ctx.cancelled() or user_cancelled or (code in (-15, -9) and not final):
            entry = self.state(model_id)
            self._save_row(model_id, state=entry["state"], error=entry.get("error"))
            self.emit(model_id, entry["state"], message="Download cancelled" if entry["state"] != "installed" else None)
            raise CancelledError({"model_id": model_id, "resumable": True, "state": entry["state"],
                                  "cancelled_by": "request" if ctx.cancelled() else "user"})
        if final and final.get("error"):
            code_name = str(final.get("error"))
            message = str(final.get("message") or "Download failed")
            if code_name == "OFFLINE_BLOCKED":
                message = "Offline mode is on — turn it off in Settings to download models."
            self._save_row(model_id, state="error", error=message)
            self.emit(model_id, "error", message=message)
            raise WorkerError(code_name if code_name.isupper() else DOWNLOAD_FAILED, message, {"model_id": model_id, "repo": repo}, True)
        if code != 0 or not final:
            tail = self._log_tail()
            message = f"Download of {repo} failed (exit code {code}). See logs/download.log."
            self._save_row(model_id, state="error", error=message)
            self.emit(model_id, "error", message=message)
            raise WorkerError(DOWNLOAD_FAILED, message, {"model_id": model_id, "exit_code": code, "log_tail": tail}, True)

        ctx.progress("verify", f"Verifying {repo}")
        self.emit(model_id, "verifying")
        vr = self._verify_result(model_id)
        if not vr.ok:
            message = self._describe_failure(vr)
            self._save_row(model_id, state="error", path=vr.path, error=message)
            self.emit(model_id, "error", message=message)
            raise WorkerError(MODEL_INVALID, f"{repo} downloaded but failed verification: {message}",
                              {"model_id": model_id, "missing_files": vr.missing_files, "errors": vr.errors}, True)
        revision = vr.revision or final.get("revision") or spec["revision"]
        self._save_row(model_id, state="installed", path=vr.path, revision_installed=revision, size_bytes=vr.size_bytes, error=None)
        self.emit(model_id, "installed", bytes_done=vr.size_bytes, bytes_total=vr.size_bytes)
        ctx.progress("download", f"Downloaded {repo}", current=vr.size_bytes, total=vr.size_bytes,
                     detail={"bytes_done": vr.size_bytes, "bytes_total": vr.size_bytes, "model_id": model_id})
        return {"model_id": model_id, "path": vr.path, "revision": revision, "size_bytes": vr.size_bytes}

    def _log_tail(self, n: int = 1500) -> str:
        try:
            data = (self.paths.logs / "download.log").read_bytes()[-n:]
            return data.decode("utf-8", "replace")
        except OSError:
            return ""

    def cancel_download(self, model_id: str) -> bool:
        with self._lock:
            proc = self.active.get(model_id)
            if proc is None or proc.poll() is not None:
                return False
            self._cancel_requested.add(model_id)
        try:
            os.killpg(proc.pid, 15)
        except (OSError, ProcessLookupError):
            try:
                proc.kill()
            except OSError:
                pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, 9)
            except (OSError, ProcessLookupError):
                pass
        return True

    # ------------------------------------------------------------------ custom dirs / removal
    FORBIDDEN_DIRS = ("/", "/proc", "/sys", "/dev", "/run", "/etc", "/boot", "/root")

    @classmethod
    def _validate_custom_dir(cls, path: str) -> Path:
        """Re-validate a shell-picked directory (PROTOCOL: paths are absolute; the worker re-validates).

        Absolute only (no cwd-relative or '~' expansion), must exist as a directory, and must not resolve to the
        filesystem root or a pseudo/system tree.
        """
        if not path or not isinstance(path, str) or not Path(path).is_absolute():
            raise WorkerError(INVALID_PARAMS, "path must be an absolute directory path", {"path": path}, True)
        raw = Path(path)
        try:
            p = raw.resolve(strict=True)
        except (OSError, RuntimeError):
            raise WorkerError(INVALID_PARAMS, f"Not a directory: {path}", {"path": str(raw)}, True)
        if not p.is_dir():
            raise WorkerError(INVALID_PARAMS, f"Not a directory: {path}", {"path": str(p)}, True)
        sp = str(p)
        for pre in cls.FORBIDDEN_DIRS:
            if sp == pre or (pre != "/" and sp.startswith(pre + "/")):
                raise WorkerError(INVALID_PARAMS, f"Refusing to use {sp} as a model directory", {"path": sp}, True)
        return p

    def use_existing_dir(self, model_id: str, path: str) -> dict[str, Any]:
        spec = self.spec(model_id)
        p = self._validate_custom_dir(path)
        vr = verify_dir(p, spec["required_files"], "local")
        if not vr.ok:
            raise WorkerError(MODEL_INVALID, f"{p} does not contain a complete {spec['repo']} checkpoint: "
                              f"missing {', '.join(vr.missing_files) or '(none)'}" + (f"; {'; '.join(vr.errors)}" if vr.errors else ""),
                              {"missing_files": vr.missing_files, "errors": vr.errors, "required_files": spec["required_files"]}, True)
        warnings: list[str] = []
        revision = "local"
        parts = p.parts
        if len(parts) >= 2 and parts[-2] == "snapshots":
            revision = parts[-1]
            if spec["revision"] and revision != spec["revision"]:
                warnings.append(f"This snapshot is revision {revision[:12]}, not the pinned {spec['revision'][:12]} — outputs may differ.")
        else:
            warnings.append("Revision unknown for a custom directory; the app cannot verify it matches the pinned revision.")
        tts_type = read_tts_model_type(p)
        if tts_type == "custom_voice":
            warnings.append("This checkpoint is a Qwen3-TTS CustomVoice (fine-tuned) model. After Load, generation uses "
                            "the trained speaker instead of reference-audio cloning.")
        elif tts_type and tts_type != "base":
            warnings.append(f"This checkpoint reports tts_model_type={tts_type!r}; the app's Qwen adapter is built for "
                            f"base (voice clone) and custom_voice (fine-tuned).")
        # a directory inside our own HF cache is still recorded as custom ('local'): remove() will only unlink it, never delete it
        self._save_row(model_id, state="installed", path=str(p), revision_installed="local", size_bytes=vr.size_bytes, error=None)
        self.emit(model_id, "installed")
        return {"ok": True, "revision": revision, "path": str(p), "size_bytes": vr.size_bytes, "warnings": warnings}

    def remove(self, model_id: str, confirm: bool) -> dict[str, Any]:
        spec = self.spec(model_id)
        if not confirm:
            raise WorkerError(INVALID_PARAMS, "Removal needs confirm=true", {"model_id": model_id}, True)
        self.cancel_download(model_id)
        with self._lock:
            self._cancel_requested.discard(model_id)
        custom = self._custom_dir(model_id)
        freed = 0
        if custom is not None:
            self._delete_row(model_id)     # custom dirs are never deleted, only unlinked
            self.emit(model_id, self.state(model_id)["state"], message="Custom directory unlinked (files kept)")
            return {"ok": True, "deleted": False, "freed_bytes": 0}
        target = repo_cache_dir(self.hf_cache, spec["repo"])
        try:
            target.resolve().relative_to(self.hf_cache.resolve())
        except ValueError:
            raise WorkerError(INVALID_PARAMS, "Refusing to delete a directory outside the managed models folder", {"path": str(target)}, False)
        shared: set[Path] = set()
        if target.is_dir():
            freed = dir_size(target)
            shared = self._shared_blob_targets(target)
            shutil.rmtree(target, ignore_errors=False)
            self._remove_orphaned_shared_blobs(shared)
        self._delete_row(model_id)
        self.emit(model_id, "missing")
        return {"ok": True, "deleted": True, "freed_bytes": freed, "shared_blobs_removed": len(shared)}

    # huggingface_hub >= 1.x stores content-addressed blobs in <hf_cache>/blobs/<xx>/<sha256> and symlinks each repo's
    # blobs/ entries to them; older versions write real files into <repo>/blobs. Removing a repo must not leave orphans.
    def _shared_store(self) -> Path:
        return (self.hf_cache / "blobs").resolve()

    def _shared_blob_targets(self, repo_dir: Path) -> set[Path]:
        store = self._shared_store()
        out: set[Path] = set()
        blobs = repo_dir / "blobs"
        if not blobs.is_dir():
            return out
        for p in blobs.iterdir():
            if p.is_symlink():
                try:
                    t = p.resolve()
                    t.relative_to(store)
                    out.add(t)
                except (OSError, ValueError):
                    continue
        return out

    def _remove_orphaned_shared_blobs(self, targets: set[Path]) -> int:
        if not targets:
            return 0
        still_used: set[Path] = set()
        for other in self.hf_cache.glob("models--*"):
            still_used |= self._shared_blob_targets(other)
        removed = 0
        for t in targets - still_used:
            try:
                t.unlink()
                removed += 1
                parent = t.parent
                if parent != self._shared_store() and not any(parent.iterdir()):
                    parent.rmdir()
            except OSError:
                pass
        return removed
