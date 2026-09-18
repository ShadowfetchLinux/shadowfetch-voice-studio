"""One recording session: capture backend → queue → writer thread → incremental WAV, plus a 10 Hz level meter.

Threads: the backend delivers float32 mono blocks on its own thread (`_on_block`); a writer thread appends them
to a `soundfile.SoundFile` (flushed about once a second, so audio is on disk while recording); a meter thread
emits `record.level` events. State changes are announced through `record.state` events.
"""
from __future__ import annotations

import errno
import logging
import math
import os
import queue
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np
import soundfile as sf

from ..paths import AppPaths
from ..protocol import DEVICE_UNAVAILABLE, DISK_FULL, INTERNAL, INVALID_PARAMS, WorkerError
from ..store.db import new_id
from .backends import CaptureBackend, create_backend

log = logging.getLogger("record.session")

EventCallback = Callable[[str, dict[str, Any]], None]

BYTES_PER_SAMPLE = {"PCM_16": 2, "PCM_24": 3, "PCM_32": 4, "FLOAT": 4, "DOUBLE": 8}
PRECISION_NOTE = "File is 24-bit; the microphone's effective precision is not reported by the capture API."


def dbfs(x: float, floor: float = -120.0) -> float:
    """Linear amplitude → dBFS, clamped to `floor` (JSON cannot carry -inf)."""
    return round(max(floor, 20.0 * math.log10(x)), 2) if x > 0 else floor


def basic_stats(path: Path, clip_level: float = 0.999) -> dict[str, Any]:
    """Peak / RMS / clipping counted over the whole file in chunks (fallback when audio.analysis is missing)."""
    info = sf.info(str(path))
    peak, sumsq, n, clipped = 0.0, 0.0, 0, 0
    for block in sf.blocks(str(path), blocksize=1 << 16, dtype="float32", always_2d=True):
        mono = np.max(np.abs(block), axis=1) if block.shape[1] > 1 else np.abs(block[:, 0])
        peak = max(peak, float(mono.max(initial=0.0)))
        sumsq += float(np.sum(block.astype(np.float64) ** 2)) / block.shape[1]
        n += block.shape[0]
        clipped += int(np.count_nonzero(mono >= clip_level))
    rms = math.sqrt(sumsq / n) if n else 0.0
    warnings: list[dict[str, Any]] = []
    if clipped:
        warnings.append({"code": "CLIPPING", "message": f"{clipped} samples at or above {dbfs(clip_level)} dBFS.", "heuristic": True})
    if n and dbfs(peak) < -30:
        warnings.append({"code": "TOO_QUIET", "message": f"Peak level is only {dbfs(peak)} dBFS; raise the input gain.", "heuristic": True})
    return {"duration_s": round(info.frames / info.samplerate, 4) if info.samplerate else 0.0, "sample_rate": info.samplerate,
            "channels": info.channels, "peak_dbfs": dbfs(peak), "rms_dbfs": dbfs(rms), "clipping_samples": clipped,
            "warnings": warnings, "source": "record.session.basic_stats"}


def file_stats(path: Path) -> dict[str, Any]:
    """Prefer the shared analyser (`audio.analysis.stats`); fall back to `basic_stats`."""
    try:
        from ..audio.analysis import stats  # written by the audio module
    except ImportError:
        return basic_stats(path)
    try:
        return stats(path)
    except Exception as e:  # noqa: BLE001 — never lose a recording because analysis failed
        log.warning("audio.analysis.stats failed on %s: %s; using basic stats", path.name, e)
        out = basic_stats(path)
        out["analysis_error"] = str(e)[:300]
        return out


def classify_write_error(exc: BaseException) -> WorkerError:
    if isinstance(exc, WorkerError):
        return exc
    text = str(exc)
    if (isinstance(exc, OSError) and exc.errno == errno.ENOSPC) or "no space left" in text.lower():
        return WorkerError(DISK_FULL, "The disk filled up while recording; the audio captured so far was kept.", {"exception": text[:300]})
    return WorkerError(INTERNAL, f"Writing the recording failed: {text[:300]}", {"exception": f"{type(exc).__name__}: {text[:300]}"})


class RecordSession:
    """Lifecycle: start → (pause ↔ resume)* → stop | discard. `session_id` doubles as the asset id on disk."""

    METER_INTERVAL_S = 0.1
    FLUSH_INTERVAL_S = 1.0
    CLIP_LEVEL = 0.999
    QUEUE_BLOCKS = 4096          # ≈ 3 min of 2048-frame blocks at 48 kHz before blocks are dropped (and counted)

    def __init__(self, backend: CaptureBackend | None = None, session_id: str | None = None):
        self.session_id = session_id or new_id("rec")
        self.asset_id = self.session_id
        self.state = "idle"
        self.path: Path | None = None
        self.dir: Path | None = None
        self.negotiated: dict[str, Any] = {}
        self.notes: list[str] = []
        self.error: WorkerError | None = None
        self.result: dict[str, Any] | None = None
        self.meta: dict[str, Any] = {}        # caller-owned (session_name, script_id, take_number)
        self.sample_rate = 0
        self.subtype = "PCM_24"
        self.frames_captured = 0      # frames accepted for writing (paused blocks are not counted)
        self.frames_written = 0
        self.clip_count_total = 0
        self.dropped_blocks = 0
        self._backend = backend
        self._on_event: EventCallback = lambda _n, _d: None
        self._queue: queue.Queue[np.ndarray | None] = queue.Queue(maxsize=self.QUEUE_BLOCKS)
        self._file: Any = None
        self._lock = threading.Lock()        # state transitions (never held while waiting for threads)
        self._stop_lock = threading.Lock()   # serializes stop()/discard()
        self._mlock = threading.Lock()
        self._win_peak, self._win_sumsq, self._win_count = 0.0, 0.0, 0
        self._writer: threading.Thread | None = None
        self._meter: threading.Thread | None = None
        self._meter_stop = threading.Event()
        self._writer_done = threading.Event()

    # ------------------------------------------------------------------ public API
    def start(self, paths: AppPaths, device_index: int | None, sample_rate: int = 48000, channels: int = 1,
              subtype: str = "PCM_24", on_event: EventCallback | None = None) -> dict[str, Any]:
        """Open the device, create `recordings/<id>/original.wav`, start writer + meter. Returns the start result."""
        if self.state != "idle":
            raise WorkerError(INVALID_PARAMS, f"Session {self.session_id} was already started")
        if channels != 1:
            raise WorkerError(INVALID_PARAMS, "Only mono (channels=1) capture is implemented.", {"channels": channels})
        if subtype not in BYTES_PER_SAMPLE or not sf.check_format("WAV", subtype):
            raise WorkerError(INVALID_PARAMS, f"Unsupported WAV subtype {subtype!r}", {"allowed": sorted(BYTES_PER_SAMPLE)})
        if on_event is not None:
            self._on_event = on_event
        self.subtype = subtype
        if self._backend is None:
            self._backend, notes = create_backend(device_index, sample_rate)
            self.notes.extend(notes)
        self.state = "starting"
        try:
            negotiated = self._backend.start(self._on_block, self._on_capture_error)
        except BaseException:
            self.state = "error"
            raise
        self.sample_rate = int(negotiated.get("sample_rate") or sample_rate)
        self.notes.extend(negotiated.pop("notes", []) or [])
        self.negotiated = {**negotiated, "subtype": subtype, "file_subtype": subtype, "file_sample_rate": self.sample_rate,
                           "precision_note": PRECISION_NOTE}
        self.notes.append(PRECISION_NOTE)
        try:
            self.dir = paths.recordings / self.asset_id
            self.dir.mkdir(parents=True, exist_ok=False)
            os.chmod(self.dir, 0o700)
            self.path = self.dir / "original.wav"
            self._file = self._open_file(self.path, self.sample_rate, channels, subtype)
            os.chmod(self.path, 0o600)
        except BaseException as e:
            self._backend.stop()
            self.state = "error"
            if self.dir is not None:
                shutil.rmtree(self.dir, ignore_errors=True)
            if isinstance(e, Exception):
                raise classify_write_error(e) from e
            raise
        self._writer = threading.Thread(target=self._writer_loop, name=f"record-writer-{self.session_id}", daemon=True)
        self._meter = threading.Thread(target=self._meter_loop, name=f"record-meter-{self.session_id}", daemon=True)
        self._writer.start()
        self._meter.start()
        if self.state == "starting":      # a capture error may already have happened
            self.state = "recording"
            self._emit_state("recording")
        return {"session_id": self.session_id, "asset_id": self.asset_id, "path": str(self.path), "negotiated": self.negotiated,
                "notes": list(self.notes), "state": self.state}

    def pause(self) -> dict[str, Any]:
        with self._lock:
            if self.state != "recording":
                raise WorkerError(INVALID_PARAMS, f"Cannot pause: session is {self.state}", {"state": self.state})
            self.state = "paused"
        self._emit_state("paused")
        return {"session_id": self.session_id, "state": "paused", "elapsed_s": self.elapsed_s}

    def resume(self) -> dict[str, Any]:
        with self._lock:
            if self.state != "paused":
                raise WorkerError(INVALID_PARAMS, f"Cannot resume: session is {self.state}", {"state": self.state})
            self.state = "recording"
        self._emit_state("recording")
        return {"session_id": self.session_id, "state": "recording", "elapsed_s": self.elapsed_s}

    def stop(self) -> dict[str, Any]:
        """Finish the file and return `{session_id, path, duration_s, stats, negotiated, notes, error?}` (partial file on error)."""
        with self._stop_lock:
            if self.result is not None:
                return self.result
            with self._lock:
                if self.state in ("idle", "discarded"):
                    raise WorkerError(INVALID_PARAMS, f"Cannot stop: session is {self.state}", {"state": self.state})
                had_error = self.state == "error"
                if not had_error:
                    self.state = "stopping"
            self._shutdown_pipeline()
            assert self.path is not None
            duration = self._measure_duration()
            stats: dict[str, Any] | None = None
            if duration > 0:
                try:
                    stats = file_stats(self.path)
                except Exception as e:  # noqa: BLE001
                    log.warning("stats failed for %s: %s", self.path, e)
                    self.notes.append(f"Statistics could not be computed: {e}")
            with self._lock:
                if self.state != "error":
                    self.state = "stopped"
                self.result = {
                    "session_id": self.session_id, "asset_id": self.asset_id, "path": str(self.path), "duration_s": duration,
                    "stats": stats, "negotiated": self.negotiated, "notes": list(self.notes), "sample_rate": self.sample_rate,
                    "channels": 1, "subtype": self.subtype, "frames_written": self.frames_written, "bytes_written": self.bytes_written,
                    "clip_count_total": self.clip_count_total, "overflows": self.overflows, "dropped_blocks": self.dropped_blocks,
                    "error": self.error.to_dict() if self.error else None, "state": self.state,
                }
        self._emit_state("stopped", reason=f"stopped after error: {self.error.code}" if self.error else None)
        return self.result

    def discard(self) -> dict[str, Any]:
        """Stop capturing and delete the session's files."""
        with self._stop_lock:
            with self._lock:
                if self.state == "discarded":
                    return {"ok": True, "session_id": self.session_id}
                active = self.state not in ("idle", "stopped")
                self.state = "discarded"
            if active:
                self._shutdown_pipeline()
            if self.dir is not None:
                shutil.rmtree(self.dir, ignore_errors=True)
        if active:
            self._emit_state("stopped", reason="discarded")
        return {"ok": True, "session_id": self.session_id}

    @property
    def active(self) -> bool:
        """True while the microphone is open (recording or paused)."""
        return self.state in ("starting", "recording", "paused")

    @property
    def elapsed_s(self) -> float:
        return round(self.frames_captured / self.sample_rate, 3) if self.sample_rate else 0.0

    @property
    def bytes_written(self) -> int:
        return self.frames_written * BYTES_PER_SAMPLE.get(self.subtype, 4)

    @property
    def overflows(self) -> int:
        return self._backend.overflows if self._backend is not None else 0

    # ------------------------------------------------------------------ pipeline
    def _open_file(self, path: Path, sample_rate: int, channels: int, subtype: str):
        return sf.SoundFile(str(path), "w", samplerate=sample_rate, channels=channels, subtype=subtype, format="WAV")

    def _on_block(self, block: np.ndarray) -> None:
        """Backend thread: meter every block; queue it for the writer only while recording."""
        if block.size == 0:
            return
        absb = np.abs(block)
        peak = float(absb.max())
        with self._mlock:
            self._win_peak = max(self._win_peak, peak)
            self._win_sumsq += float(np.dot(block.astype(np.float64), block.astype(np.float64)))
            self._win_count += block.size
        if self.state not in ("starting", "recording"):
            return
        if peak >= self.CLIP_LEVEL:
            self.clip_count_total += int(np.count_nonzero(absb >= self.CLIP_LEVEL))
        try:
            self._queue.put_nowait(block)
            self.frames_captured += block.size
        except queue.Full:
            self.dropped_blocks += 1

    def _on_capture_error(self, exc: BaseException) -> None:
        """Backend thread: the device went away or the reader died. Keep the file; the stream is already dead."""
        err = exc if isinstance(exc, WorkerError) else WorkerError(DEVICE_UNAVAILABLE, f"Capture failed: {exc}")
        self._fail(err, stop_backend=False)

    def _fail(self, err: WorkerError, stop_backend: bool) -> None:
        with self._lock:
            if self.state in ("stopping", "stopped", "discarded", "error"):
                return
            self.error = err
            self.state = "error"
        self._meter_stop.set()
        self._put_sentinel()
        if stop_backend and self._backend is not None:
            try:
                self._backend.stop()
            except Exception as e:  # noqa: BLE001
                log.warning("backend stop after failure: %s", e)
        log.error("recording %s failed: %s %s", self.session_id, err.code, err.message)
        self._emit_state("error", reason=err.message, code=err.code)

    def _put_sentinel(self) -> None:
        try:
            self._queue.put(None, timeout=1.0)
        except queue.Full:
            pass

    def _writer_loop(self) -> None:
        last_flush = time.monotonic()
        try:
            while True:
                item = self._queue.get()
                if item is None:
                    break
                self._file.write(item)
                self.frames_written += int(item.size)
                now = time.monotonic()
                if now - last_flush >= self.FLUSH_INTERVAL_S:
                    self._file.flush()
                    last_flush = now
        except Exception as exc:  # noqa: BLE001 — ENOSPC, I/O errors: keep what was written
            werr = classify_write_error(exc)
            self._close_file()
            self._fail(werr, stop_backend=True)
            self._drain()
        finally:
            self._close_file()
            self._writer_done.set()

    def _drain(self) -> None:
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                return

    def _close_file(self) -> None:
        f, self._file = self._file, None
        if f is None:
            return
        try:
            f.close()
        except Exception as e:  # noqa: BLE001
            log.warning("closing recording file failed: %s", e)

    def _meter_loop(self) -> None:
        while not self._meter_stop.wait(self.METER_INTERVAL_S):
            with self._mlock:
                peak, sumsq, count = self._win_peak, self._win_sumsq, self._win_count
                self._win_peak, self._win_sumsq, self._win_count = 0.0, 0.0, 0
            rms = math.sqrt(sumsq / count) if count else 0.0
            self._emit("record.level", {"session_id": self.session_id, "peak_dbfs": dbfs(peak), "rms_dbfs": dbfs(rms),
                                        "clipped": bool(peak >= self.CLIP_LEVEL), "clip_count_total": self.clip_count_total,
                                        "elapsed_s": self.elapsed_s, "bytes_written": self.bytes_written,
                                        "overflows": self.overflows, "state": self.state, "samples_in_window": count})

    def _shutdown_pipeline(self) -> None:
        """Stop capture, let the writer finish the queue, close the file. Safe to call more than once."""
        self._meter_stop.set()
        if self._backend is not None:
            try:
                self._backend.stop()
            except Exception as e:  # noqa: BLE001
                log.warning("backend stop failed: %s", e)
        if self._writer is not None and self._writer.is_alive():
            self._put_sentinel()
            self._writer_done.wait(timeout=30)
            if not self._writer_done.is_set():
                self.notes.append("The writer thread did not finish within 30 s; the file may be missing its last blocks.")
        self._close_file()
        if self._meter is not None and self._meter.is_alive():
            self._meter.join(timeout=2)

    def _measure_duration(self) -> float:
        assert self.path is not None
        try:
            info = sf.info(str(self.path))
            return round(info.frames / info.samplerate, 4) if info.samplerate else 0.0
        except Exception as e:  # noqa: BLE001 — unreadable header (e.g. nothing was ever written)
            log.warning("cannot read %s: %s", self.path, e)
            self.notes.append(f"The recording file could not be read back: {e}")
            return 0.0

    # ------------------------------------------------------------------ events
    def _emit(self, name: str, data: dict[str, Any]) -> None:
        try:
            self._on_event(name, data)
        except Exception:  # noqa: BLE001 — a broken transport must not take the audio thread down
            log.exception("record event %s failed", name)

    def _emit_state(self, state: str, reason: str | None = None, code: str | None = None) -> None:
        data: dict[str, Any] = {"session_id": self.session_id, "state": state, "elapsed_s": self.elapsed_s}
        if reason:
            data["reason"] = reason
        if code:
            data["code"] = code
        self._emit("record.state", data)
