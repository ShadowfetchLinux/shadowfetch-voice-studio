"""Recording pipeline tests: a fake capture backend feeds synthetic blocks; no microphone or model needed.

Run: cd backend && .venv-spine/bin/python -m pytest tests/test_record.py -q
"""
from __future__ import annotations

import errno
import math
import os
import stat
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from shadowfetch_worker.paths import AppPaths
from shadowfetch_worker.protocol import DEVICE_UNAVAILABLE, DISK_FULL, INVALID_PARAMS, NOT_FOUND, WorkerError
from shadowfetch_worker.record import backends as be
from shadowfetch_worker.record.backends import CaptureBackend, FfmpegPulseBackend, PulseSource
from shadowfetch_worker.record.scripts import reading_scripts
from shadowfetch_worker.record.session import PRECISION_NOTE, RecordSession, basic_stats, dbfs
from shadowfetch_worker.rpc import Ctx

RATE = 48000
BLOCK = 2048


# ----------------------------------------------------------------------------- fixtures / fakes
class FakeBackend(CaptureBackend):
    """Delivers a precomputed signal in fixed blocks on a timer thread, at (roughly) real time."""

    name = "fake"

    def __init__(self, segments: list[tuple[str, float, float]], sample_rate: int = RATE, blocksize: int = BLOCK,
                 speed: float = 1.0, loop: bool = True):
        super().__init__(sample_rate, blocksize)
        self.signal = np.concatenate([self._segment(kind, amp, secs) for kind, amp, secs in segments]).astype(np.float32)
        self.speed, self.loop = speed, loop
        self.blocks_delivered = 0
        self.stopped = False
        self._on_error = None
        self._thread: threading.Thread | None = None
        self._delivered = threading.Condition()

    def _segment(self, kind: str, amp: float, secs: float) -> np.ndarray:
        n = int(secs * self.sample_rate)
        t = np.arange(n) / self.sample_rate
        if kind == "sine":
            return amp * np.sin(2 * math.pi * 440.0 * t)
        if kind == "clip":                       # an overdriven sine, hard-limited to full scale
            return np.clip(1.5 * amp * np.sin(2 * math.pi * 440.0 * t), -1.0, 1.0)
        return np.zeros(n)

    def start(self, on_block, on_error):
        self._on_error = on_error

        def run():
            pos, period = 0, self.blocksize / self.sample_rate / self.speed
            nxt = time.monotonic()
            while not self._stopping.is_set():
                if pos + self.blocksize > len(self.signal):
                    if not self.loop:
                        break
                    pos = 0
                on_block(self.signal[pos:pos + self.blocksize].copy())
                pos += self.blocksize
                with self._delivered:
                    self.blocks_delivered += 1
                    self._delivered.notify_all()
                nxt += period
                delay = nxt - time.monotonic()
                if delay > 0:
                    time.sleep(delay)

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()
        return {"backend": self.name, "device_index": 0, "device_name": "Fake microphone", "hostapi": "fake",
                "sample_rate": self.sample_rate, "channels": 1, "dtype": "float32 from fake", "latency_s": 0.0,
                "blocksize": self.blocksize, "notes": ["fake backend"]}

    def wait_blocks(self, n: int, timeout: float = 5.0) -> None:
        with self._delivered:
            ok = self._delivered.wait_for(lambda: self.blocks_delivered >= n, timeout)
        assert ok, f"only {self.blocks_delivered} blocks delivered, wanted {n}"

    def fail(self, exc: BaseException) -> None:
        """Simulate the device disappearing."""
        self._stopping.set()
        if self._on_error:
            self._on_error(exc)

    def stop(self) -> None:
        self._stopping.set()
        self.stopped = True
        if self._thread and self._thread.is_alive() and threading.current_thread() is not self._thread:
            self._thread.join(timeout=2)


class Events:
    def __init__(self):
        self.items: list[tuple[str, dict[str, Any]]] = []
        self._lock = threading.Lock()

    def __call__(self, name: str, data: dict[str, Any]) -> None:
        with self._lock:
            self.items.append((name, dict(data)))

    def levels(self) -> list[dict[str, Any]]:
        with self._lock:
            return [d for n, d in self.items if n == "record.level" and d.get("samples_in_window", 1) > 0]

    def states(self) -> list[dict[str, Any]]:
        with self._lock:
            return [d for n, d in self.items if n == "record.state"]

    def wait_state(self, state: str, timeout: float = 5.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for d in self.states():
                if d["state"] == state:
                    return d
            time.sleep(0.02)
        raise AssertionError(f"no record.state {state!r} event; got {self.states()}")


@pytest.fixture
def paths(tmp_path: Path) -> AppPaths:
    return AppPaths.build(str(tmp_path / "data"), str(tmp_path / "config"), str(tmp_path / "cache"))


def sine_session(paths: AppPaths, events: Events, amp: float = 0.5, **kw) -> tuple[RecordSession, FakeBackend]:
    fake = FakeBackend([("sine", amp, 4.0)], **kw)
    s = RecordSession(backend=fake)
    s.start(paths, None, RATE, 1, "PCM_24", on_event=events)
    return s, fake


# ----------------------------------------------------------------------------- session behaviour
def test_incremental_growth_levels_and_stop(paths: AppPaths):
    ev = Events()
    s, fake = sine_session(paths, ev, amp=0.5)
    start = s.path
    assert start is not None and start.name == "original.wav" and start.parent.parent == paths.recordings
    assert stat.S_IMODE(start.stat().st_mode) == 0o600
    assert ev.wait_state("recording")["session_id"] == s.session_id

    fake.wait_blocks(8)
    size1 = start.stat().st_size
    fake.wait_blocks(20)
    size2 = start.stat().st_size
    assert size1 > 44 and size2 > size1, "audio must reach the disk while recording"

    levels = ev.levels()
    assert len(levels) >= 3
    for lv in levels:
        assert abs(lv["peak_dbfs"] - dbfs(0.5)) < 0.5, lv
        assert abs(lv["rms_dbfs"] - dbfs(0.5 / math.sqrt(2))) < 0.5, lv
        assert lv["clipped"] is False and lv["clip_count_total"] == 0 and lv["overflows"] == 0
        assert lv["session_id"] == s.session_id and lv["bytes_written"] >= 0
    assert levels[-1]["elapsed_s"] > 0 and levels[-1]["bytes_written"] == s.frames_written * 3

    res = s.stop()
    assert res["session_id"] == s.session_id and res["error"] is None and res["state"] == "stopped"
    info = sf.info(res["path"])
    assert info.subtype == "PCM_24" and info.samplerate == RATE and info.channels == 1
    assert res["duration_s"] == pytest.approx(info.frames / RATE, abs=1e-4)
    assert info.frames == s.frames_written == s.frames_captured and info.frames >= 20 * BLOCK
    neg = res["negotiated"]
    for key in ("backend", "device_name", "hostapi", "sample_rate", "dtype", "subtype", "file_subtype", "precision_note"):
        assert key in neg, key
    assert neg["file_subtype"] == "PCM_24" and neg["precision_note"] == PRECISION_NOTE and PRECISION_NOTE in res["notes"]
    assert abs(res["stats"]["peak_dbfs"] - dbfs(0.5)) < 0.5 and res["stats"]["clipping_samples"] == 0
    assert ev.states()[-1]["state"] == "stopped" and fake.stopped
    assert s.stop() is res, "stop() is idempotent"


def test_silence_then_clipping(paths: AppPaths):
    ev = Events()
    fake = FakeBackend([("silence", 0.0, 0.5), ("clip", 1.0, 0.5)], loop=False)
    s = RecordSession(backend=fake)
    s.start(paths, None, RATE, 1, "PCM_24", on_event=ev)
    fake.wait_blocks(23)          # the whole 1 s signal
    time.sleep(0.25)              # let the meter see the last window
    levels = ev.levels()
    quiet = [lv for lv in levels if lv["peak_dbfs"] <= -119.0]
    loud = [lv for lv in levels if lv["clipped"]]
    assert quiet and loud, levels
    assert all(lv["clip_count_total"] == 0 for lv in quiet)
    assert loud[-1]["clip_count_total"] > 0 and abs(loud[-1]["peak_dbfs"]) < 0.5
    res = s.stop()
    assert res["clip_count_total"] > 0 and res["stats"]["clipping_samples"] > 0
    assert any(w["code"].upper() == "CLIPPING" for w in res["stats"]["warnings"])


def test_pause_resume_excludes_paused_time(paths: AppPaths):
    ev = Events()
    s, fake = sine_session(paths, ev)
    fake.wait_blocks(10)
    s.pause()
    assert ev.wait_state("paused") and s.state == "paused"
    captured_at_pause = s.frames_captured
    delivered_at_pause = fake.blocks_delivered
    fake.wait_blocks(delivered_at_pause + 10)
    assert s.frames_captured == captured_at_pause, "blocks delivered while paused must be dropped"
    with pytest.raises(WorkerError) as ei:
        s.pause()
    assert ei.value.code == INVALID_PARAMS
    s.resume()
    delivered_at_resume = fake.blocks_delivered
    fake.wait_blocks(delivered_at_resume + 10)
    res = s.stop()
    frames = sf.info(res["path"]).frames
    assert frames == s.frames_captured
    assert frames >= 20 * BLOCK
    assert frames <= (fake.blocks_delivered - 10) * BLOCK, "paused time leaked into the file"
    assert res["duration_s"] == pytest.approx(frames / RATE, abs=1e-4)
    states = [d["state"] for d in ev.states()]
    assert states == ["recording", "paused", "recording", "stopped"]
    assert all(lv["elapsed_s"] <= res["duration_s"] + 1e-6 for lv in ev.levels())


def test_discard_removes_files(paths: AppPaths):
    ev = Events()
    s, fake = sine_session(paths, ev)
    fake.wait_blocks(5)
    d = s.path.parent
    assert d.exists()
    assert s.discard() == {"ok": True, "session_id": s.session_id}
    assert not d.exists() and s.state == "discarded" and fake.stopped
    assert ev.states()[-1] == {"session_id": s.session_id, "state": "stopped", "reason": "discarded", "elapsed_s": s.elapsed_s}
    with pytest.raises(WorkerError):
        s.stop()
    assert s.discard()["ok"] is True


class FailingFile:
    """Wraps a SoundFile; raises ENOSPC after `limit` writes."""

    def __init__(self, inner, limit: int):
        self.inner, self.limit, self.writes = inner, limit, 0

    def write(self, data):
        if self.writes >= self.limit:
            raise OSError(errno.ENOSPC, "No space left on device")
        self.writes += 1
        self.inner.write(data)

    def __getattr__(self, name):
        return getattr(self.inner, name)


def test_enospc_keeps_partial_file(paths: AppPaths, monkeypatch):
    real_open = RecordSession._open_file
    monkeypatch.setattr(RecordSession, "_open_file", lambda self, *a: FailingFile(real_open(self, *a), 5))
    ev = Events()
    s, fake = sine_session(paths, ev)
    err = ev.wait_state("error")
    assert err["code"] == DISK_FULL and "disk" in err["reason"].lower()
    assert s.state == "error" and fake.stopped, "capture must stop after a writer failure"
    info = sf.info(s.path)
    assert info.frames == 5 * BLOCK and info.subtype == "PCM_24"
    res = s.stop()
    assert res["error"]["code"] == DISK_FULL and res["duration_s"] == pytest.approx(5 * BLOCK / RATE, abs=1e-4)
    assert res["stats"] is not None and res["frames_written"] == 5 * BLOCK
    assert ev.states()[-1]["state"] == "stopped" and "DISK_FULL" in ev.states()[-1]["reason"]


def test_device_removed_keeps_partial_file(paths: AppPaths):
    ev = Events()
    s, fake = sine_session(paths, ev)
    fake.wait_blocks(6)
    fake.fail(WorkerError(DEVICE_UNAVAILABLE, "USB microphone unplugged"))
    err = ev.wait_state("error")
    assert err["code"] == DEVICE_UNAVAILABLE and s.state == "error"
    res = s.stop()
    assert res["error"]["code"] == DEVICE_UNAVAILABLE
    assert sf.info(res["path"]).frames >= 6 * BLOCK and res["duration_s"] > 0


def test_start_validation_and_backend_failure(paths: AppPaths):
    with pytest.raises(WorkerError) as ei:
        RecordSession(backend=FakeBackend([("silence", 0, 1)])).start(paths, None, RATE, 2, "PCM_24")
    assert ei.value.code == INVALID_PARAMS
    with pytest.raises(WorkerError) as ei:
        RecordSession(backend=FakeBackend([("silence", 0, 1)])).start(paths, None, RATE, 1, "PCM_99")
    assert ei.value.code == INVALID_PARAMS

    class Broken(CaptureBackend):
        def start(self, on_block, on_error):
            raise WorkerError(DEVICE_UNAVAILABLE, "no such device")

        def stop(self):
            pass

    s = RecordSession(backend=Broken(RATE))
    with pytest.raises(WorkerError) as ei:
        s.start(paths, 7, RATE, 1, "PCM_24")
    assert ei.value.code == DEVICE_UNAVAILABLE and s.state == "error"
    assert not list(paths.recordings.iterdir()), "no recording folder is left behind"


def test_basic_stats_and_dbfs(tmp_path: Path):
    p = tmp_path / "x.wav"
    t = np.arange(RATE) / RATE
    sf.write(p, (0.25 * np.sin(2 * math.pi * 1000 * t)).astype(np.float32), RATE, subtype="PCM_24")
    st = basic_stats(p)
    assert st["duration_s"] == 1.0 and st["sample_rate"] == RATE and st["channels"] == 1
    assert abs(st["peak_dbfs"] - dbfs(0.25)) < 0.05 and abs(st["rms_dbfs"] - dbfs(0.25 / math.sqrt(2))) < 0.05
    assert st["clipping_samples"] == 0 and st["warnings"] == []
    assert dbfs(0.0) == -120.0 and dbfs(1.0) == 0.0


# ----------------------------------------------------------------------------- scripts
def test_reading_scripts():
    scripts = reading_scripts()
    assert [s["style"] for s in scripts] == ["conversational", "calm_narration", "energetic_presentation"]
    for s in scripts:
        assert s["id"] and s["title"] and 40 <= s["approx_seconds"] <= 70
        assert any(ch.isdigit() for ch in s["text"]) and "?" in s["text"] and s["word_count"] >= 100


# ----------------------------------------------------------------------------- backend helpers (no hardware)
def test_pulse_source_parsing_and_monitor_rule(monkeypatch):
    listing = ("59\talsa_output.usb-1130.analog-stereo.monitor\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n"
               "61\talsa_input.usb-mic.mono-fallback\tPipeWire\ts16le 1ch 44100Hz\tRUNNING\n")
    monkeypatch.setattr(be, "_pactl", lambda *a, **k: listing if a[0] == "list" else "alsa_input.usb-mic.mono-fallback\n")
    src = be.pulse_sources()
    assert [s.index for s in src] == [59, 61] and src[0].is_monitor and not src[1].is_monitor
    assert (src[1].channels, src[1].sample_rate, src[1].driver) == (1, 44100, "PipeWire")
    assert [s.index for s in be.recordable_pulse_sources(src)] == [61], "monitors are hidden when a real input exists"
    assert [s.index for s in be.recordable_pulse_sources([src[0]])] == [59], "…but shown when nothing else exists"
    assert be.pulse_default_source() == "alsa_input.usb-mic.mono-fallback"

    monkeypatch.setattr(be, "select_backend", lambda: (be.FFMPEG_PULSE, ["portaudio missing"]))
    monkeypatch.setattr(be, "ffmpeg_has_pulse", lambda: True)
    devs = be.list_input_devices()
    assert devs["backend"] == be.FFMPEG_PULSE and devs["default_input"] == 61
    assert devs["inputs"] == [{"index": 61, "name": "alsa_input.usb-mic.mono-fallback", "hostapi": "PipeWire", "max_input_channels": 1,
                               "default_samplerate": 44100, "backend": be.FFMPEG_PULSE, "state": "RUNNING"}]
    backend, notes = be.create_backend(None, RATE)
    assert isinstance(backend, FfmpegPulseBackend) and backend.source == "alsa_input.usb-mic.mono-fallback" and notes == ["portaudio missing"]
    with pytest.raises(WorkerError) as ei:
        be.create_backend(999, RATE)
    assert ei.value.code == DEVICE_UNAVAILABLE


def _fake_ffmpeg(tmp_path: Path, body: str) -> Path:
    exe = tmp_path / "ffmpeg"
    exe.write_text("#!/bin/sh\n" + body)
    exe.chmod(0o755)
    return exe


def test_ffmpeg_backend_reports_early_failure(tmp_path: Path, monkeypatch):
    exe = _fake_ffmpeg(tmp_path, "echo 'Connection refused' >&2; exit 1\n")
    monkeypatch.setattr(be.shutil, "which", lambda name: str(exe) if name == "ffmpeg" else None)
    errors: list[BaseException] = []
    b = FfmpegPulseBackend("default", RATE)
    with pytest.raises(WorkerError) as ei:
        b.start(lambda blk: None, errors.append)
    assert ei.value.code == DEVICE_UNAVAILABLE and "Connection refused" in ei.value.message
    time.sleep(0.2)
    assert errors == [], "an early death is reported once, by start()"
    b.stop()


def test_ffmpeg_backend_reports_process_death(tmp_path: Path, monkeypatch):
    # 5 blocks of float32 zeros, then the process dies after the start grace period
    exe = _fake_ffmpeg(tmp_path, f"head -c {5 * BLOCK * 4} /dev/zero; sleep 0.7; echo 'stream died' >&2; exit 3\n")
    monkeypatch.setattr(be.shutil, "which", lambda name: str(exe) if name == "ffmpeg" else None)
    blocks: list[np.ndarray] = []
    errors: list[BaseException] = []
    b = FfmpegPulseBackend("default", RATE, source_info=PulseSource(5, "mic", "PipeWire", "s16le 2ch 44100Hz", "RUNNING"))
    neg = b.start(blocks.append, errors.append)
    assert neg["backend"] == "ffmpeg-pulse" and neg["dtype"] == "float32 from ffmpeg" and neg["device_index"] == 5
    assert any("44100" in n for n in neg["notes"])
    deadline = time.monotonic() + 5
    while not errors and time.monotonic() < deadline:
        time.sleep(0.05)
    assert len(blocks) == 5 and all(blk.dtype == np.float32 and blk.shape == (BLOCK,) for blk in blocks)
    assert errors and isinstance(errors[0], WorkerError) and errors[0].code == DEVICE_UNAVAILABLE
    assert "stream died" in errors[0].message and errors[0].details["returncode"] == 3
    b.stop()


def test_ffmpeg_backend_clean_stop(tmp_path: Path, monkeypatch):
    exe = _fake_ffmpeg(tmp_path, "trap 'exit 0' TERM; while :; do head -c 8192 /dev/zero || exit 0; sleep 0.02; done\n")
    monkeypatch.setattr(be.shutil, "which", lambda name: str(exe) if name == "ffmpeg" else None)
    errors: list[BaseException] = []
    b = FfmpegPulseBackend("default", RATE)
    b.start(lambda blk: None, errors.append)
    time.sleep(0.2)
    b.stop()
    time.sleep(0.2)
    assert errors == [], "a requested stop is not a device error"


# ----------------------------------------------------------------------------- record.* RPC handlers
class FakeTransport:
    def __init__(self):
        self.events = Events()

    def event(self, name, data):
        self.events(name, data)

    def send(self, obj):
        pass


@pytest.fixture
def rpc(paths: AppPaths, monkeypatch):
    from shadowfetch_worker.jobs import record as jobs_record
    from shadowfetch_worker.settings import SettingsStore
    from shadowfetch_worker.store.db import Database

    transport = FakeTransport()
    server = SimpleNamespace(state={"paths": paths, "settings": SettingsStore(paths.settings_file), "db": Database(paths.db_file)},
                             transport=transport)
    fakes: list[FakeBackend] = []

    def make_session():
        fakes.append(FakeBackend([("sine", 0.3, 4.0)]))
        return RecordSession(backend=fakes[-1])

    monkeypatch.setattr(jobs_record, "RecordSession", make_session)
    ctx = Ctx(req_id="r1", method="record.*", transport=transport, server=server)  # type: ignore[arg-type]
    return SimpleNamespace(ctx=ctx, jobs=jobs_record, server=server, fakes=fakes, events=transport.events)


def test_rpc_flow_start_pause_stop_inserts_rows(rpc):
    j, ctx = rpc.jobs, rpc.ctx
    rpc.server.state["settings"].value.monitor_input = False
    rpc.server.state["settings"].value.record_subtype = "PCM_24"
    res = j.start(ctx, j.StartParams(session_name="Take one", script_id="conversational", take_number=2))
    sid = res["session_id"]
    assert res["negotiated"]["subtype"] == "PCM_24" and res["monitoring"] is False
    assert rpc.server.state["record_sessions"][sid].active

    with pytest.raises(WorkerError) as ei:
        j.start(ctx, j.StartParams())
    assert ei.value.code == INVALID_PARAMS and ei.value.details["active_session_id"] == sid
    with pytest.raises(WorkerError) as ei:
        j.start(ctx, j.StartParams(script_id="nope"))
    assert ei.value.code == INVALID_PARAMS

    rpc.fakes[-1].wait_blocks(6)
    assert j.pause(ctx, j.SessionParams(session_id=sid))["state"] == "paused"
    assert j.resume(ctx, j.SessionParams(session_id=sid))["state"] == "recording"
    rpc.fakes[-1].wait_blocks(12)
    out = j.stop(ctx, j.SessionParams(session_id=sid))
    assert out["asset_id"] == sid and out["recording_id"].startswith("take_") and out["duration_s"] > 0
    assert out["script_id"] == "conversational" and out["take_number"] == 2
    assert sid not in rpc.server.state["record_sessions"]

    db = rpc.server.state["db"]
    asset = dict(db.require("assets", sid))
    assert asset["kind"] == "reference" and asset["source"] == "recording" and asset["original_path"] == out["path"]
    assert asset["bit_depth"] == 24 and asset["codec"] == "pcm_s24le" and asset["sample_rate"] == RATE and asset["channels"] == 1
    assert asset["original_name"] == "Take one.wav" and len(asset["sha256"]) == 64 and asset["size_bytes"] == os.path.getsize(out["path"])
    assert asset["stats_json"] and asset["duration_s"] == out["duration_s"]
    if out["working_path"] is None:          # audio.ffmpeg.decode_to_wav belongs to another module and may be absent
        assert asset["working_path"] is None and any("working.wav" in n for n in out["notes"])
    else:
        winfo = sf.info(out["working_path"])
        assert asset["working_path"] == out["working_path"] and winfo.subtype == "FLOAT" and winfo.channels == 1
        assert winfo.samplerate == 48000 and abs(winfo.frames / 48000 - out["duration_s"]) < 0.01
    rec = dict(db.one("SELECT * FROM recordings WHERE asset_id = ?", (sid,)))
    assert rec["id"] == out["recording_id"] and rec["script_id"] == "conversational" and rec["take_number"] == 2
    assert rec["device_name"] == "Fake microphone" and '"file_subtype": "PCM_24"' in rec["negotiated_json"]

    with pytest.raises(WorkerError) as ei:
        j.stop(ctx, j.SessionParams(session_id=sid))
    assert ei.value.code == NOT_FOUND
    # a new session may start now
    res2 = j.start(ctx, j.StartParams())
    assert j.discard(ctx, j.SessionParams(session_id=res2["session_id"]))["ok"] is True
    assert not (Path(res2["path"]).parent).exists() and rpc.server.state["record_sessions"] == {}
    states = [d["state"] for d in rpc.events.states()]
    assert states[:4] == ["recording", "paused", "recording", "stopped"]


def test_session_feeds_input_monitor_including_while_paused(paths: AppPaths):
    from shadowfetch_worker.record.monitor import MemoryMonitor

    ev = Events()
    fake = FakeBackend([("sine", 0.5, 4.0)])
    mon = MemoryMonitor()
    mon.start()
    s = RecordSession(backend=fake)
    s.attach_monitor(mon)
    s.start(paths, None, RATE, 1, "PCM_24", on_event=ev)
    fake.wait_blocks(8)
    assert len(mon.blocks) >= 8
    s.pause()
    n = len(mon.blocks)
    fake.wait_blocks(fake.blocks_delivered + 4)
    assert len(mon.blocks) >= n + 4, "paused capture must still be played back"
    res = s.stop()
    assert mon.stopped and s.monitoring is False and res["error"] is None


def test_monitor_write_error_does_not_stop_recording(paths: AppPaths):
    ev = Events()
    s, fake = sine_session(paths, ev)

    class Boom:
        name = "boom"

        def write(self, _block):
            raise RuntimeError("sink closed")

        def stop(self):
            self.stopped = True

    boom = Boom()
    s.attach_monitor(boom)
    fake.wait_blocks(10)
    assert s.monitoring is False and any("Input monitoring stopped" in n for n in s.notes)
    res = s.stop()
    assert res["error"] is None and res["duration_s"] > 0 and boom.stopped


def test_sounddevice_monitor_drops_oldest_when_full():
    from shadowfetch_worker.record.monitor import MONITOR_QUEUE_BLOCKS, SoundDeviceMonitor

    mon = SoundDeviceMonitor(RATE, None)
    for i in range(MONITOR_QUEUE_BLOCKS + 5):
        mon.write(np.full(8, float(i), dtype=np.float32))
    assert mon._q.qsize() == MONITOR_QUEUE_BLOCKS
    assert mon._q.get_nowait()[0] == 5.0


def test_rpc_monitor_failure_keeps_recording(rpc, monkeypatch):
    from shadowfetch_worker.protocol import DEVICE_UNAVAILABLE

    def boom(sample_rate, output_device_index):
        raise WorkerError(DEVICE_UNAVAILABLE, "no output", recoverable=True)

    monkeypatch.setattr("shadowfetch_worker.record.monitor.create_monitor", boom)
    rpc.server.state["settings"].value.monitor_input = True
    res = rpc.jobs.start(rpc.ctx, rpc.jobs.StartParams())
    assert res["monitoring"] is False
    assert any("could not be started" in n.lower() for n in res["notes"])
    assert rpc.jobs.discard(rpc.ctx, rpc.jobs.SessionParams(session_id=res["session_id"]))["ok"] is True


def test_rpc_monitor_attaches_when_create_succeeds(rpc, monkeypatch):
    from shadowfetch_worker.record.monitor import MemoryMonitor

    mon = MemoryMonitor()

    def fake_create(sample_rate, output_device_index):
        mon.start()
        return mon

    monkeypatch.setattr("shadowfetch_worker.record.monitor.create_monitor", fake_create)
    rpc.server.state["settings"].value.monitor_input = True
    res = rpc.jobs.start(rpc.ctx, rpc.jobs.StartParams(session_name="Monitored"))
    assert res["monitoring"] is True
    assert any("headphones" in n.lower() for n in res["notes"])
    rpc.fakes[-1].wait_blocks(4)
    assert mon.started and len(mon.blocks) >= 1
    out = rpc.jobs.discard(rpc.ctx, rpc.jobs.SessionParams(session_id=res["session_id"]))
    assert out["ok"] is True and mon.stopped


def test_rpc_devices_and_scripts(rpc):
    j, ctx = rpc.jobs, rpc.ctx
    devs = j.devices(ctx, {})
    assert devs["backend"] in (be.SOUNDDEVICE, be.FFMPEG_PULSE) and isinstance(devs["inputs"], list) and "notes" in devs
    for d in devs["inputs"]:
        assert {"index", "name", "hostapi", "max_input_channels", "default_samplerate", "backend"} <= set(d)
    assert [s["id"] for s in j.scripts(ctx, {})["scripts"]] == ["conversational", "calm_narration", "energetic_presentation"]
    with pytest.raises(WorkerError) as ei:
        j.pause(ctx, j.SessionParams(session_id="rec_missing"))
    assert ei.value.code == NOT_FOUND


# ----------------------------------------------------------------------------- real devices (skipped when absent)
def _portaudio_available() -> bool:
    sd, _ = be._import_sounddevice()
    return sd is not None


def test_real_ffmpeg_pulse_capture(paths: AppPaths):
    sources = be.pulse_sources()
    if not sources:
        pytest.skip("no PulseAudio/PipeWire sources (pactl) on this machine")
    if not be.ffmpeg_has_pulse():
        pytest.skip("ffmpeg lacks the pulse demuxer")
    try:
        backend, notes = be.create_backend(None, RATE)
    except WorkerError as e:
        pytest.skip(f"cannot build the ffmpeg backend here: {e.message}")
    if not isinstance(backend, FfmpegPulseBackend):        # PortAudio present: force the ffmpeg path explicitly
        src = be.recordable_pulse_sources(sources)[0]
        backend = FfmpegPulseBackend(src.name, RATE, source_info=src)
    ev = Events()
    s = RecordSession(backend=backend)
    try:
        res = s.start(paths, None, RATE, 1, "PCM_24", on_event=ev)
    except WorkerError as e:
        pytest.skip(f"ffmpeg could not open the Pulse source in this environment: {e.message}")
    time.sleep(1.0)
    out = s.stop()
    if out["error"]:
        pytest.skip(f"capture failed in this environment: {out['error']}")
    info = sf.info(out["path"])
    assert info.subtype == "PCM_24" and info.samplerate == RATE and info.channels == 1
    assert out["duration_s"] >= 0.5 and res["negotiated"]["backend"] == "ffmpeg-pulse"
    assert out["stats"] is not None and ev.levels(), "level events must flow from a real capture"


def test_real_sounddevice_capture(paths: AppPaths):
    if not _portaudio_available():
        pytest.skip("sounddevice cannot load PortAudio (libportaudio2 not installed)")
    devs = be.list_input_devices()
    if devs["backend"] != be.SOUNDDEVICE or not devs["inputs"]:
        pytest.skip("PortAudio reports no input devices")
    s = RecordSession(backend=be.SoundDeviceBackend(None, RATE))
    try:
        res = s.start(paths, None, RATE, 1, "PCM_24")
    except WorkerError as e:
        pytest.skip(f"PortAudio could not open the default input: {e.message}")
    time.sleep(1.0)
    out = s.stop()
    if out["error"]:
        pytest.skip(f"capture failed in this environment: {out['error']}")
    assert sf.info(out["path"]).subtype == "PCM_24" and out["duration_s"] >= 0.5
    assert res["negotiated"]["backend"] == "sounddevice" and res["negotiated"]["dtype"] == "float32 from PortAudio"
