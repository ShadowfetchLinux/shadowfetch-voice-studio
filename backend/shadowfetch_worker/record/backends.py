"""Capture backends behind one small interface.

Two implementations:

* `SoundDeviceBackend` — PortAudio through the `sounddevice` wheel. The wheel needs the system
  `libportaudio2`; when it is missing, `import sounddevice` raises ``OSError('PortAudio library not found')``.
* `FfmpegPulseBackend` — `ffmpeg -f pulse` reading a PulseAudio/PipeWire source, streaming float32 mono
  PCM over a pipe. Used whenever PortAudio is unavailable.

Both deliver float32 mono blocks to an `on_block` callback from a background thread, and report a capture
failure (device gone, process died) through `on_error`. `create_backend()` / `list_input_devices()` pick the
same backend so device indices stay consistent between listing and recording.
"""
from __future__ import annotations

import logging
import re
import shutil
import subprocess
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from ..protocol import DEVICE_UNAVAILABLE, INVALID_PARAMS, WorkerError

log = logging.getLogger("record.backends")

BlockCallback = Callable[[np.ndarray], None]
ErrorCallback = Callable[[BaseException], None]

SOUNDDEVICE = "sounddevice"
FFMPEG_PULSE = "ffmpeg-pulse"
DEFAULT_BLOCKSIZE = 2048


class CaptureBackend(ABC):
    """One microphone capture stream. Blocks are float32 mono arrays delivered from a backend thread."""

    name: str = ""

    def __init__(self, sample_rate: int, blocksize: int = DEFAULT_BLOCKSIZE):
        self.sample_rate = int(sample_rate)
        self.blocksize = int(blocksize)
        self.overflows = 0            # input overflows reported by the capture API (0 when it cannot report them)
        self._stopping = threading.Event()

    @abstractmethod
    def start(self, on_block: BlockCallback, on_error: ErrorCallback) -> dict[str, Any]:
        """Open the device and start delivering blocks. Returns the negotiated stream description."""

    @abstractmethod
    def stop(self) -> None:
        """Stop delivering blocks and release the device. Idempotent."""


# --------------------------------------------------------------------------- sounddevice / PortAudio
_sd_import_error: str | None = None


def _import_sounddevice():
    """Import `sounddevice` lazily. Returns (module | None, reason). A missing PortAudio lib is not an error."""
    global _sd_import_error
    try:
        import sounddevice as sd  # noqa: WPS433 (lazy on purpose: the import loads libportaudio)
        return sd, None
    except OSError as e:               # 'PortAudio library not found'
        reason = f"sounddevice cannot load PortAudio ({e}); install the system package libportaudio2 to use it"
    except ImportError as e:
        reason = f"sounddevice is not installed ({e})"
    if _sd_import_error != reason:
        _sd_import_error = reason
        log.warning("%s — falling back to the ffmpeg/PulseAudio capture backend", reason)
    return None, reason


class SoundDeviceBackend(CaptureBackend):
    """PortAudio input stream (float32, mono, blocksize 2048, 'high' latency for robustness)."""

    name = SOUNDDEVICE

    def __init__(self, device_index: int | None, sample_rate: int, blocksize: int = DEFAULT_BLOCKSIZE):
        super().__init__(sample_rate, blocksize)
        self.device_index = device_index
        self._stream = None
        self._on_error: ErrorCallback | None = None
        self._sd = None

    def start(self, on_block: BlockCallback, on_error: ErrorCallback) -> dict[str, Any]:
        sd, reason = _import_sounddevice()
        if sd is None:
            raise WorkerError(DEVICE_UNAVAILABLE, reason or "sounddevice unavailable", recoverable=False)
        self._sd = sd
        self._on_error = on_error
        try:
            info = sd.query_devices(self.device_index, "input") if self.device_index is not None else sd.query_devices(kind="input")
        except (ValueError, sd.PortAudioError) as e:
            raise WorkerError(DEVICE_UNAVAILABLE, f"Input device {self.device_index!r} is not available: {e}",
                              {"device_index": self.device_index}) from e
        if info["max_input_channels"] < 1:
            raise WorkerError(INVALID_PARAMS, f"Device {info['name']!r} has no input channels", {"device_index": self.device_index})
        device = int(info["index"])
        rate, notes = self._negotiate_rate(sd, device, float(info["default_samplerate"]))

        def callback(indata, frames, _time_info, status) -> None:
            if status and status.input_overflow:
                self.overflows += 1
            try:
                on_block(indata[:, 0].astype(np.float32, copy=True))
            except Exception as exc:  # noqa: BLE001 — a failing consumer must not crash the audio thread
                log.exception("record block consumer failed")
                self._fail(exc)

        def finished() -> None:
            if not self._stopping.is_set():
                self._fail(WorkerError(DEVICE_UNAVAILABLE, f"The input stream on {info['name']!r} stopped unexpectedly "
                                       "(device removed or driver error).", {"device_index": device}))

        try:
            self._stream = sd.InputStream(device=device, channels=1, samplerate=rate, dtype="float32",
                                          blocksize=self.blocksize, latency="high", callback=callback, finished_callback=finished)
            self._stream.start()
        except (sd.PortAudioError, ValueError) as e:
            self._stream = None
            raise WorkerError(DEVICE_UNAVAILABLE, f"Could not open input device {info['name']!r}: {e}",
                              {"device_index": device, "sample_rate": rate}) from e
        hostapis = sd.query_hostapis()
        hostapi = hostapis[info["hostapi"]]["name"] if 0 <= info["hostapi"] < len(hostapis) else ""
        return {
            "backend": self.name, "device_index": device, "device_name": info["name"], "hostapi": hostapi,
            "sample_rate": int(round(self._stream.samplerate)), "requested_sample_rate": self.sample_rate,
            "channels": 1, "dtype": "float32 from PortAudio", "latency_s": float(self._stream.latency),
            "blocksize": self.blocksize, "notes": notes,
        }

    def _negotiate_rate(self, sd, device: int, default_rate: float) -> tuple[int, list[str]]:
        """Prefer the requested rate; otherwise the device default. Raises DEVICE_UNAVAILABLE if neither works."""
        notes: list[str] = []
        try:
            sd.check_input_settings(device=device, channels=1, samplerate=self.sample_rate, dtype="float32")
            return self.sample_rate, notes
        except (sd.PortAudioError, ValueError) as e:
            fallback = int(round(default_rate)) if default_rate > 0 else 0
            notes.append(f"{self.sample_rate} Hz is not supported by this device ({e}); using its default {fallback} Hz.")
        try:
            sd.check_input_settings(device=device, channels=1, samplerate=fallback, dtype="float32")
        except (sd.PortAudioError, ValueError) as e:
            raise WorkerError(DEVICE_UNAVAILABLE, f"Device does not accept mono float32 input at {self.sample_rate} or {fallback} Hz: {e}",
                              {"device_index": device}) from e
        return fallback, notes

    def _fail(self, exc: BaseException) -> None:
        if self._stopping.is_set():
            return
        self._stopping.set()
        if self._on_error:
            self._on_error(exc)

    def stop(self) -> None:
        self._stopping.set()
        stream, self._stream = self._stream, None
        if stream is None:
            return
        try:
            stream.stop()
            stream.close()
        except Exception as e:  # noqa: BLE001 — PortAudioError when the device already vanished
            log.warning("closing input stream failed: %s", e)


# --------------------------------------------------------------------------- ffmpeg + PulseAudio/PipeWire
@dataclass
class PulseSource:
    """One line of `pactl list sources short`."""
    index: int
    name: str
    driver: str
    format: str          # e.g. "s16le 2ch 48000Hz"
    state: str

    @property
    def is_monitor(self) -> bool:
        return self.name.endswith(".monitor")

    @property
    def channels(self) -> int:
        m = re.search(r"(\d+)ch", self.format)
        return int(m.group(1)) if m else 0

    @property
    def sample_rate(self) -> int:
        m = re.search(r"(\d+)Hz", self.format)
        return int(m.group(1)) if m else 0


def _pactl(*args: str, timeout: float = 5.0) -> str | None:
    exe = shutil.which("pactl")
    if not exe:
        return None
    try:
        r = subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        log.debug("pactl %s failed: %s", args, e)
        return None
    return r.stdout if r.returncode == 0 else None


def pulse_sources() -> list[PulseSource]:
    """All PulseAudio/PipeWire sources (including monitors). Empty when pactl is missing or no server runs."""
    out = _pactl("list", "sources", "short")
    sources: list[PulseSource] = []
    for line in (out or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 2 or not parts[0].strip().isdigit():
            continue
        parts += [""] * (5 - len(parts))
        sources.append(PulseSource(int(parts[0]), parts[1].strip(), parts[2].strip(), parts[3].strip(), parts[4].strip()))
    return sources


def pulse_default_source() -> str | None:
    out = _pactl("get-default-source")
    return (out or "").strip() or None


def recordable_pulse_sources(sources: list[PulseSource] | None = None) -> list[PulseSource]:
    """Real inputs first; monitor sources only when nothing else exists (labelled by the caller)."""
    src = pulse_sources() if sources is None else sources
    real = [s for s in src if not s.is_monitor]
    return real or [s for s in src if s.is_monitor]


def ffmpeg_has_pulse() -> bool:
    exe = shutil.which("ffmpeg")
    if not exe:
        return False
    try:
        r = subprocess.run([exe, "-hide_banner", "-demuxers"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return any(ln.split()[1:2] == ["pulse"] for ln in r.stdout.splitlines() if ln.strip())


class FfmpegPulseBackend(CaptureBackend):
    """`ffmpeg -f pulse -i <source> -ac 1 -ar <rate> -f f32le -`, blocks read from stdout in a thread.

    PipeWire's Pulse layer silently falls back to the default source for unknown names, so the source is
    validated against `pactl list sources` before ffmpeg is started. ffmpeg does not report input
    overflows, so `overflows` stays 0.
    """

    name = FFMPEG_PULSE
    START_GRACE_S = 0.4       # how long to watch for an immediate ffmpeg failure before declaring success

    def __init__(self, source: str | None, sample_rate: int, blocksize: int = DEFAULT_BLOCKSIZE,
                 source_info: PulseSource | None = None):
        super().__init__(sample_rate, blocksize)
        self.source = source or "default"
        self.source_info = source_info
        self._proc: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None
        self._start_decided = threading.Event()   # start() decides who reports an early ffmpeg death
        self._started_ok = False

    def start(self, on_block: BlockCallback, on_error: ErrorCallback) -> dict[str, Any]:
        exe = shutil.which("ffmpeg")
        if not exe:
            raise WorkerError(DEVICE_UNAVAILABLE, "ffmpeg was not found on PATH (needed for PulseAudio capture).", recoverable=False)
        cmd = [exe, "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "pulse", "-i", self.source,
               "-ac", "1", "-ar", str(self.sample_rate), "-f", "f32le", "-"]
        try:
            self._proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            raise WorkerError(DEVICE_UNAVAILABLE, f"Could not start ffmpeg: {e}") from e
        self._thread = threading.Thread(target=self._read_loop, args=(on_block, on_error), name="record-ffmpeg-reader", daemon=True)
        self._thread.start()
        # ffmpeg fails within a few ms when the Pulse server is unreachable; surface that as a start error
        deadline = time.monotonic() + self.START_GRACE_S
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                self._stopping.set()
                self._start_decided.set()
                self._thread.join(timeout=2)
                raise WorkerError(DEVICE_UNAVAILABLE, f"ffmpeg could not open Pulse source {self.source!r}: {self._stderr_tail()}",
                                  {"source": self.source, "returncode": self._proc.returncode})
            time.sleep(0.02)
        self._started_ok = True
        self._start_decided.set()
        info = self.source_info
        notes: list[str] = []
        if info and info.sample_rate and info.sample_rate != self.sample_rate:
            notes.append(f"Source runs at {info.sample_rate} Hz; ffmpeg resamples to {self.sample_rate} Hz.")
        if info and info.is_monitor:
            notes.append("This is a monitor source: it captures what the sound card plays, not a microphone.")
        return {
            "backend": self.name, "device_index": info.index if info else None,
            "device_name": (info.name if info else self.source) + (" (monitor)" if info and info.is_monitor else ""),
            "hostapi": f"PulseAudio/PipeWire via ffmpeg ({info.driver})" if info and info.driver else "PulseAudio/PipeWire via ffmpeg",
            "sample_rate": self.sample_rate, "requested_sample_rate": self.sample_rate, "channels": 1,
            "dtype": "float32 from ffmpeg", "latency_s": None, "blocksize": self.blocksize,
            "source_format": info.format if info else None, "notes": notes,
        }

    def _read_loop(self, on_block: BlockCallback, on_error: ErrorCallback) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        nbytes = self.blocksize * 4
        try:
            while not self._stopping.is_set():
                buf = proc.stdout.read(nbytes)          # BufferedReader: blocks until nbytes or EOF
                if len(buf) < nbytes:
                    if buf and not self._stopping.is_set():
                        on_block(np.frombuffer(buf[: len(buf) - len(buf) % 4], dtype="<f4").copy())
                    break
                on_block(np.frombuffer(buf, dtype="<f4").copy())
        except Exception as exc:  # noqa: BLE001
            if not self._stopping.is_set():
                log.exception("ffmpeg reader failed")
                self._stopping.set()
                on_error(exc)
            return
        self._start_decided.wait(self.START_GRACE_S + 2)
        if not self._started_ok or self._stopping.is_set():
            return                                   # start() reports an early death; stop() asked for the EOF
        self._stopping.set()
        rc = proc.wait(timeout=5) if proc.poll() is None else proc.returncode
        on_error(WorkerError(DEVICE_UNAVAILABLE, f"ffmpeg capture from {self.source!r} ended unexpectedly (exit {rc}): "
                             f"{self._stderr_tail()}", {"source": self.source, "returncode": rc}))

    def _stderr_tail(self) -> str:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return ""
        try:
            return proc.stderr.read().decode("utf-8", "replace").strip()[-400:] or "(no error output)"
        except (OSError, ValueError):
            return ""

    def stop(self) -> None:
        self._stopping.set()
        proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        if self._thread and self._thread.is_alive() and threading.current_thread() is not self._thread:
            self._thread.join(timeout=3)
        if proc is not None:
            for stream in (proc.stdout, proc.stderr):
                try:
                    stream.close()  # type: ignore[union-attr]
                except (OSError, AttributeError):
                    pass


# --------------------------------------------------------------------------- selection
def select_backend() -> tuple[str, list[str]]:
    """Choose the capture backend for this machine and explain why (notes are shown to the user)."""
    sd, reason = _import_sounddevice()
    notes: list[str] = []
    if sd is not None:
        try:
            sd.query_devices()
            return SOUNDDEVICE, notes
        except Exception as e:  # noqa: BLE001 — PortAudio present but no usable host API
            notes.append(f"PortAudio could not enumerate devices ({e}).")
    else:
        notes.append(reason or "sounddevice unavailable")
    notes.append("Using the ffmpeg + PulseAudio/PipeWire capture backend.")
    return FFMPEG_PULSE, notes


def list_input_devices() -> dict[str, Any]:
    """`{inputs:[{index,name,hostapi,max_input_channels,default_samplerate,backend}], default_input, backend, notes}`."""
    backend, notes = select_backend()
    if backend == SOUNDDEVICE:
        from ..system.diagnostics import audio_devices
        devs = audio_devices()
        inputs = [{**d, "backend": SOUNDDEVICE} for d in devs.get("inputs", [])]
        if devs.get("error"):
            notes.append(str(devs["error"]))
        return {"inputs": inputs, "default_input": devs.get("default_input"), "backend": SOUNDDEVICE, "notes": notes}
    sources = pulse_sources()
    usable = recordable_pulse_sources(sources)
    if not sources:
        notes.append("No PulseAudio/PipeWire sources were found (is a sound server running? is pactl installed?).")
    elif not any(not s.is_monitor for s in usable):
        notes.append("No microphone source found; only monitor sources (what the sound card plays) are available.")
    if not ffmpeg_has_pulse():
        notes.append("ffmpeg on PATH lacks the 'pulse' demuxer; recording will fail until it is installed.")
    inputs = [{"index": s.index, "name": s.name + (" (monitor)" if s.is_monitor else ""), "hostapi": s.driver or "PulseAudio",
               "max_input_channels": s.channels, "default_samplerate": s.sample_rate, "backend": FFMPEG_PULSE, "state": s.state}
              for s in usable]
    default_name = pulse_default_source()
    default_input = next((s.index for s in usable if s.name == default_name), usable[0].index if usable else None)
    return {"inputs": inputs, "default_input": default_input, "backend": FFMPEG_PULSE, "notes": notes}


def create_backend(device_index: int | None, sample_rate: int, blocksize: int = DEFAULT_BLOCKSIZE) -> tuple[CaptureBackend, list[str]]:
    """Build the capture backend for `device_index` (in the index space of `list_input_devices()`)."""
    backend, notes = select_backend()
    if backend == SOUNDDEVICE:
        return SoundDeviceBackend(device_index, sample_rate, blocksize), notes
    sources = pulse_sources()
    if not sources:
        raise WorkerError(DEVICE_UNAVAILABLE, "No PulseAudio/PipeWire sources are available and PortAudio is not installed. "
                          "Install libportaudio2 or make sure a sound server (PipeWire/PulseAudio) is running.", recoverable=False)
    if not ffmpeg_has_pulse():
        raise WorkerError(DEVICE_UNAVAILABLE, "ffmpeg is missing or lacks PulseAudio support (needed while PortAudio is unavailable).",
                          recoverable=False)
    usable = recordable_pulse_sources(sources)
    if device_index is None:
        default_name = pulse_default_source()
        src = next((s for s in usable if s.name == default_name), usable[0])
    else:
        src = next((s for s in sources if s.index == device_index), None)
        if src is None:
            raise WorkerError(DEVICE_UNAVAILABLE, f"Pulse source #{device_index} no longer exists. Pick another input device.",
                              {"device_index": device_index, "available": [s.index for s in usable]})
    return FfmpegPulseBackend(src.name, sample_rate, blocksize, source_info=src), notes
