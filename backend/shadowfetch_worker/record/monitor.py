"""Input monitoring: play the capture stream back to an output device while recording.

Off by default (`settings.monitor_input`) because speakers + a live mic make a feedback loop.
When on, the session feeds every captured block here. Failures never abort the recording.
"""
from __future__ import annotations

import logging
import queue
import shutil
import subprocess
import threading
from typing import Any, Protocol

import numpy as np

from ..protocol import DEVICE_UNAVAILABLE, WorkerError
from .backends import _import_sounddevice, _pactl

log = logging.getLogger("record.monitor")

MONITOR_QUEUE_BLOCKS = 8   # ~0.3 s at 48 kHz / 2048 — drop rather than grow latency


class InputMonitor(Protocol):
    name: str

    def start(self) -> dict[str, Any]: ...
    def write(self, block: np.ndarray) -> None: ...
    def stop(self) -> None: ...


class MemoryMonitor:
    """Test double: records the blocks it was asked to play."""

    name = "memory"

    def __init__(self) -> None:
        self.blocks: list[np.ndarray] = []
        self.started = False
        self.stopped = False

    def start(self) -> dict[str, Any]:
        self.started = True
        return {"backend": self.name}

    def write(self, block: np.ndarray) -> None:
        self.blocks.append(np.asarray(block, dtype=np.float32).copy())

    def stop(self) -> None:
        self.stopped = True


class SoundDeviceMonitor:
    """PortAudio output stream. The callback pulls the most recent queued block (drops when the UI/thread lags)."""

    name = "sounddevice"

    def __init__(self, sample_rate: int, device_index: int | None, blocksize: int = 2048):
        self.sample_rate = int(sample_rate)
        self.device_index = device_index
        self.blocksize = int(blocksize)
        self._q: queue.Queue[np.ndarray] = queue.Queue(maxsize=MONITOR_QUEUE_BLOCKS)
        self._stream = None
        self._sd = None

    def start(self) -> dict[str, Any]:
        sd, reason = _import_sounddevice()
        if sd is None:
            raise WorkerError(DEVICE_UNAVAILABLE, reason or "sounddevice unavailable", recoverable=True)
        self._sd = sd
        try:
            info = sd.query_devices(self.device_index, "output") if self.device_index is not None else sd.query_devices(kind="output")
        except (ValueError, sd.PortAudioError) as e:
            raise WorkerError(DEVICE_UNAVAILABLE, f"Output device {self.device_index!r} is not available: {e}",
                              {"device_index": self.device_index}, True) from e
        if info["max_output_channels"] < 1:
            raise WorkerError(DEVICE_UNAVAILABLE, f"Device {info['name']!r} has no output channels",
                              {"device_index": self.device_index}, True)
        device = int(info["index"])
        rate = self._negotiate_rate(sd, device, float(info["default_samplerate"]))

        def callback(outdata, frames, _time_info, _status) -> None:
            try:
                block = self._q.get_nowait()
            except queue.Empty:
                outdata.fill(0)
                return
            n = min(int(block.shape[0]), int(frames))
            outdata[:n, 0] = block[:n]
            if n < frames:
                outdata[n:] = 0

        try:
            self._stream = sd.OutputStream(device=device, channels=1, samplerate=rate, dtype="float32",
                                           blocksize=self.blocksize, callback=callback)
            self._stream.start()
        except (sd.PortAudioError, ValueError) as e:
            self._stream = None
            raise WorkerError(DEVICE_UNAVAILABLE, f"Could not open output device {info['name']!r}: {e}",
                              {"device_index": device, "sample_rate": rate}, True) from e
        return {"backend": self.name, "device_index": device, "device_name": info["name"], "sample_rate": rate}

    def _negotiate_rate(self, sd, device: int, default_rate: float) -> int:
        try:
            sd.check_output_settings(device=device, channels=1, samplerate=self.sample_rate, dtype="float32")
            return self.sample_rate
        except (sd.PortAudioError, ValueError):
            fallback = int(round(default_rate)) if default_rate > 0 else self.sample_rate
            sd.check_output_settings(device=device, channels=1, samplerate=fallback, dtype="float32")
            return fallback

    def write(self, block: np.ndarray) -> None:
        data = np.asarray(block, dtype=np.float32).reshape(-1)
        try:
            self._q.put_nowait(data)
        except queue.Full:
            try:
                self._q.get_nowait()
            except queue.Empty:
                pass
            try:
                self._q.put_nowait(data)
            except queue.Full:
                pass

    def stop(self) -> None:
        stream, self._stream = self._stream, None
        if stream is None:
            return
        try:
            stream.stop()
            stream.close()
        except Exception as e:  # noqa: BLE001
            log.warning("closing monitor stream failed: %s", e)


class PipeMonitor:
    """Raw float32 PCM into paplay or ffmpeg → Pulse/PipeWire."""

    def __init__(self, sample_rate: int, sink: str | None, backend: str):
        self.sample_rate = int(sample_rate)
        self.sink = sink
        self.name = backend
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def start(self) -> dict[str, Any]:
        if self.name == "paplay":
            exe = shutil.which("paplay")
            if not exe:
                raise WorkerError(DEVICE_UNAVAILABLE, "paplay is not installed", recoverable=True)
            cmd = [exe, "--raw", "--format=float32le", f"--rate={self.sample_rate}", "--channels=1"]
            if self.sink:
                cmd += ["--device", self.sink]
        else:
            exe = shutil.which("ffmpeg")
            if not exe:
                raise WorkerError(DEVICE_UNAVAILABLE, "ffmpeg is not installed", recoverable=True)
            cmd = [exe, "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", str(self.sample_rate),
                   "-ac", "1", "-i", "pipe:0", "-f", "pulse", self.sink or "default"]
        try:
            self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as e:
            raise WorkerError(DEVICE_UNAVAILABLE, f"Could not start {self.name}: {e}", recoverable=True) from e
        return {"backend": self.name, "sink": self.sink, "sample_rate": self.sample_rate}

    def write(self, block: np.ndarray) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            return
        data = np.asarray(block, dtype="<f4").reshape(-1).tobytes()
        with self._lock:
            try:
                proc.stdin.write(data)
            except BrokenPipeError as e:
                raise WorkerError(DEVICE_UNAVAILABLE, f"{self.name} monitor pipe closed", recoverable=True) from e

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)


def _pulse_sink_name(device_index: int | None) -> str | None:
    """Resolve Settings' output_device_index against `pactl list sinks short`.

    Diagnostics lists Pulse sinks with a 0-based enumerate index (and the pactl index in the first column).
    Either form is accepted; None means the system default sink.
    """
    out = _pactl("list", "sinks", "short")
    if not out:
        return None
    sinks: list[tuple[int, str]] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2 or not parts[0].strip().isdigit():
            continue
        sinks.append((int(parts[0]), parts[1].strip()))
    if not sinks:
        return None
    if device_index is None:
        return None
    if 0 <= device_index < len(sinks):
        return sinks[device_index][1]
    for idx, name in sinks:
        if idx == device_index:
            return name
    return None


def create_monitor(sample_rate: int, output_device_index: int | None) -> InputMonitor:
    """Pick a playback backend the same way capture does: PortAudio first, then Pulse."""
    errors: list[str] = []
    sd, reason = _import_sounddevice()
    if sd is not None:
        try:
            mon = SoundDeviceMonitor(sample_rate, output_device_index)
            # start() is deferred to the session so a constructed-but-unused monitor is cheap; we still
            # probe here so a missing output fails over to Pulse instead of failing the session later.
            mon.start()
            return mon
        except Exception as e:  # noqa: BLE001 — fall through; session reports the last error if all fail
            errors.append(f"sounddevice: {e}")
            try:
                mon.stop()
            except Exception:  # noqa: BLE001
                pass
    else:
        errors.append(reason or "sounddevice unavailable")
    sink = _pulse_sink_name(output_device_index)
    for backend in ("paplay", "ffmpeg"):
        mon = PipeMonitor(sample_rate, sink, backend)
        try:
            mon.start()
            return mon
        except Exception as e:  # noqa: BLE001
            errors.append(f"{backend}: {e}")
            try:
                mon.stop()
            except Exception:  # noqa: BLE001
                pass
    raise WorkerError(DEVICE_UNAVAILABLE, "No way to play the microphone back: " + "; ".join(errors),
                      {"tried": errors}, True)
