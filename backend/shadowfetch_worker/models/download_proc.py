"""Download subprocess: `python -m shadowfetch_worker.models.download_proc --repo R --revision SHA --cache-dir DIR [--ignore P ...]`

Runs huggingface_hub.snapshot_download in its own process so the main worker can kill it on cancel
(a killed download leaves resumable *.incomplete blobs behind; the next download continues them).

stdout: JSON lines only —
  {"bytes_done": int, "bytes_total": int, "files_done": int, "files_total": int}   (throttled to 4 Hz)
  {"done": true, "path": "<snapshot dir>", "revision": "<sha>"}                     (last line on success)
  {"error": "<CODE>", "message": "..."}                                             (last line on failure)
Progress bytes are MEASURED: bytes_total from the repo's file metadata (minus ignored files), bytes_done from the
tqdm callbacks when huggingface_hub passes them through, else from the blob files growing on disk.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import threading
import time
from pathlib import Path

_OUT_LOCK = threading.Lock()
_MIN_INTERVAL = 0.25   # 4 Hz


def _emit(obj: dict) -> None:
    with _OUT_LOCK:
        sys.__stdout__.write(json.dumps(obj) + "\n")
        sys.__stdout__.flush()


class Progress:
    def __init__(self, bytes_total: int, files_total: int, blobs_dir: Path):
        self.bytes_total = bytes_total
        self.files_total = files_total
        self.files_done = 0
        self.tqdm_bytes = 0
        self.blobs_dir = blobs_dir
        self._last = 0.0
        self._lock = threading.Lock()
        self._stop = threading.Event()

    def disk_bytes(self) -> int:
        """Bytes of every blob (complete or .incomplete) for this repo — grows while files download."""
        total = 0
        try:
            for p in self.blobs_dir.iterdir():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
        except OSError:
            pass
        return total

    def emit(self, force: bool = False) -> None:
        now = time.time()
        with self._lock:
            if not force and now - self._last < _MIN_INTERVAL:
                return
            self._last = now
        done = max(self.tqdm_bytes, self.disk_bytes())
        total = max(self.bytes_total, done)
        _emit({"bytes_done": int(done), "bytes_total": int(total), "files_done": int(self.files_done), "files_total": int(self.files_total)})

    def poll_loop(self) -> None:
        while not self._stop.wait(_MIN_INTERVAL):
            self.emit()

    def stop(self) -> None:
        self._stop.set()


_DEVNULL = open(os.devnull, "w")


def _make_tqdm_class(progress: Progress):
    from tqdm import tqdm as _tqdm

    class JsonTqdm(_tqdm):
        """Silent tqdm that forwards counts to the JSON progress reporter."""

        def __init__(self, *args, **kwargs):
            # tqdm ignores update() when disabled, so keep it enabled but render into /dev/null
            kwargs["disable"] = False
            kwargs["file"] = _DEVNULL
            kwargs["mininterval"] = 3600
            super().__init__(*args, **kwargs)
            self._is_bytes = kwargs.get("unit") == "B"
            self._is_files = not self._is_bytes
            self._is_reconstruct = "reconstruct" in str(kwargs.get("desc") or "").lower() or \
                                   str(kwargs.get("name") or "") == "huggingface_hub.snapshot_download"

        def update(self, n=1):
            r = super().update(n)
            try:
                if self._is_bytes:
                    if self._is_reconstruct or not getattr(progress, "_saw_reconstruct", False):
                        if self._is_reconstruct:
                            progress._saw_reconstruct = True
                        progress.tqdm_bytes = int(self.n or 0)
                elif self._is_files:
                    progress.files_done = int(self.n or 0)
                    if self.total:
                        progress.files_total = int(self.total)
                progress.emit()
            except Exception:  # noqa: BLE001
                pass
            return r

    return JsonTqdm


def _expected(repo: str, revision: str | None, ignore: list[str], token: str | None) -> tuple[int, int, str | None]:
    """(bytes_total, files_total, resolved sha) from the repo's file metadata. (0, 0, None) when unavailable (offline)."""
    try:
        from huggingface_hub import HfApi
        info = HfApi(token=token).model_info(repo, revision=revision, files_metadata=True)
        total = 0
        n = 0
        for s in info.siblings or []:
            if any(fnmatch.fnmatch(s.rfilename, pat) for pat in ignore):
                continue
            n += 1
            total += int(getattr(s, "size", 0) or 0)
        return total, n, getattr(info, "sha", None)
    except Exception:  # noqa: BLE001
        return 0, 0, None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--revision", default=None)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--ignore", action="append", default=[])
    ap.add_argument("--expected-bytes", type=int, default=0)
    ap.add_argument("--max-workers", type=int, default=4)
    args = ap.parse_args(argv)

    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    # our own stdout is the channel: anything else that prints goes to stderr
    sys.stdout = sys.stderr

    if os.environ.get("HF_HUB_OFFLINE") == "1":
        _emit({"error": "OFFLINE_BLOCKED", "message": "Offline mode is on; downloads are blocked."})
        return 3

    token = os.environ.get("HF_TOKEN") or None
    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    blobs_dir = cache_dir / ("models--" + args.repo.replace("/", "--")) / "blobs"
    bytes_total, files_total, sha = _expected(args.repo, args.revision, args.ignore, token)
    if not bytes_total:
        bytes_total = int(args.expected_bytes or 0)
    progress = Progress(bytes_total, files_total, blobs_dir)
    progress.emit(force=True)
    poller = threading.Thread(target=progress.poll_loop, daemon=True)
    poller.start()

    try:
        from huggingface_hub import snapshot_download
        path = snapshot_download(repo_id=args.repo, revision=args.revision, cache_dir=str(cache_dir),
                                 ignore_patterns=args.ignore or None, tqdm_class=_make_tqdm_class(progress),
                                 max_workers=max(1, args.max_workers), token=token, local_files_only=False)
    except Exception as e:  # noqa: BLE001
        progress.stop()
        name = type(e).__name__
        text = f"{name}: {e}"
        low = text.lower()
        if "no space left" in low or "enospc" in low:
            code = "DISK_FULL"
        elif "offline" in low or "localentrynotfound" in low or "cannot reach" in low or "connection" in low or "name resolution" in low \
                or "timed out" in low or "max retries" in low:
            code = "DOWNLOAD_FAILED"
            text = "Network error while downloading: " + text
        elif "401" in low or "403" in low or "gated" in low:
            code = "PERMISSION_DENIED"
        elif "404" in low or "revisionnotfound" in low or "repositorynotfound" in low:
            code = "NOT_FOUND"
        else:
            code = "DOWNLOAD_FAILED"
        _emit({"error": code, "message": text[:800]})
        return 2
    progress.stop()
    progress.files_done = progress.files_total or progress.files_done
    progress.emit(force=True)
    resolved = sha or args.revision or Path(path).name
    _emit({"done": True, "path": str(path), "revision": resolved, "bytes_total": int(max(progress.bytes_total, progress.disk_bytes()))})
    return 0


if __name__ == "__main__":
    sys.exit(main())
