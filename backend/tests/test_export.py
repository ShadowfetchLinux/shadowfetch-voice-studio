"""Tests for audio/export.py (loudness measurement, rendering) and the export.* jobs. Synthetic audio only."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from shadowfetch_worker.audio import export as ex
from shadowfetch_worker.audio.ffmpeg import probe, run_ffprobe
from shadowfetch_worker.paths import AppPaths
from shadowfetch_worker.protocol import WorkerError
from shadowfetch_worker.rpc import Ctx
from shadowfetch_worker.store.db import Database

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg/ffprobe not on PATH")


def _encoders() -> str:
    try:
        return subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


ENCODERS = _encoders()
HAS_MP3 = " libmp3lame " in ENCODERS
HAS_FLAC = " flac " in ENCODERS
needs_mp3 = pytest.mark.skipif(not HAS_MP3, reason="this ffmpeg build has no libmp3lame encoder")
needs_flac = pytest.mark.skipif(not HAS_FLAC, reason="this ffmpeg build has no flac encoder")


def tone(seconds: float, sr: int = 48000, amp: float = 0.1, hz: float = 1000.0, channels: int = 1) -> np.ndarray:
    t = np.arange(int(round(seconds * sr))) / sr
    x = (amp * np.sin(2 * np.pi * hz * t)).astype(np.float32)
    return np.stack([x] * channels, axis=1) if channels > 1 else x


def master(path: Path, seconds: float = 8.0, sr: int = 48000, amp: float = 0.1) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), tone(seconds, sr, amp), sr, subtype="PCM_24")
    return path


def tags(path: Path) -> dict:
    r = run_ffprobe(["-v", "error", "-print_format", "json", "-show_format", str(path)])
    return (json.loads(r.stdout).get("format") or {}).get("tags") or {}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class FakeTransport:
    def __init__(self):
        self.messages: list[dict] = []

    def send(self, obj):
        self.messages.append(obj)

    def event(self, name, data):
        self.messages.append({"type": "event", "event": name, "data": data})


@pytest.fixture
def app(tmp_path: Path):
    paths = AppPaths.build(str(tmp_path / "data"), str(tmp_path / "config"), str(tmp_path / "cache"))
    db = Database(paths.db_file)
    state = {"paths": paths, "db": db, "settings": SimpleNamespace(value=SimpleNamespace(offline=False))}
    transport = FakeTransport()
    server = SimpleNamespace(state=state, started=0.0)
    return SimpleNamespace(paths=paths, db=db, state=state, transport=transport,
                           ctx=Ctx(req_id="r1", method="export.render", transport=transport, server=server))


# ---------------------------------------------------------------- targets / measurement
def test_loudness_targets_are_named_and_documented():
    ids = [t["id"] for t in ex.LOUDNESS_TARGETS]
    assert ids == ["podcast-16", "streaming-14", "broadcast-r128-23"]
    for t in ex.LOUDNESS_TARGETS:
        assert t["label"] and t["description"] and t["true_peak_dbtp"] == -1 and t["lra"] > 0
    assert [t["integrated_lufs"] for t in ex.LOUDNESS_TARGETS] == [-16, -14, -23]
    assert ex.loudness_target("streaming-14")["integrated_lufs"] == -14
    assert ex.loudness_target("ebu-r128-podcast-16")["id"] == "podcast-16"          # PROTOCOL.md alias
    assert ex.loudness_target("broadcast-23")["id"] == "broadcast-r128-23"
    with pytest.raises(WorkerError) as e:
        ex.loudness_target("loud-as-possible")
    assert e.value.code == "INVALID_PARAMS"


def test_measure_loudness_on_a_sine(tmp_path):
    # a 1 kHz sine at 0 dBFS reads -3.01 LUFS (BS.1770), so -20 dBFS peak → about -23 LUFS, true peak -20 dBTP
    m = ex.measure_loudness(master(tmp_path / "m.wav", 8.0, 48000, 0.1))
    assert abs(m["integrated_lufs"] - (-23.0)) < 0.5
    assert abs(m["true_peak_dbtp"] - (-20.0)) < 0.3
    assert m["lra"] is not None and m["lra"] < 1.0 and m["threshold"] is not None and m["target_offset"] is not None
    silent = tmp_path / "silent.wav"
    sf.write(str(silent), np.zeros(48000 * 4, dtype=np.float32), 48000, subtype="PCM_16")
    s = ex.measure_loudness(silent)
    assert s["integrated_lufs"] is None and s["true_peak_dbtp"] is None


def test_estimate_output_bytes():
    p = {"duration_s": 60.0, "sample_rate": 48000, "channels": 1}
    assert ex.estimate_output_bytes(p, "wav", 24) == 60 * 48000 * 3 + 1_000_000
    assert ex.estimate_output_bytes(p, "wav", 16, 96000) == 60 * 96000 * 2 + 1_000_000
    assert ex.estimate_output_bytes(p, "mp3", mp3_bitrate_kbps=192) == 60 * 192000 // 8 + 1_000_000


# ---------------------------------------------------------------- render
def test_render_wav_24_metadata_validation_and_collision(tmp_path):
    m = master(tmp_path / "master.wav")
    before = sha(m)
    out = tmp_path / "exports" / "My Project.wav"
    res = ex.render(m, out, "wav", engine_label="Qwen3-TTS 1.7B Base")
    assert res["path"] == str(out) and res["collision_renamed"] is False and res["loudness_measured"] is None
    assert res["size_bytes"] == out.stat().st_size and res["format"] == "wav"
    assert res["probe"]["codec"] == "pcm_s24le" and res["probe"]["sample_rate"] == 48000 and res["probe"]["bit_depth"] == 24
    assert not out.with_name(out.name + ".tmp").exists()
    t = tags(out)
    assert t["comment"] == "AI-generated speech — Shadowfetch Voice Studio (Qwen3-TTS 1.7B Base)" and t["encoded_by"] == "Shadowfetch Voice Studio"
    a, _ = sf.read(str(m), dtype="float32")
    b, _ = sf.read(str(out), dtype="float32")
    assert a.shape == b.shape and np.max(np.abs(a - b)) < 2 / 2 ** 23        # untouched samples (24-bit quantisation only)
    assert sha(m) == before
    # collision → "name (2).wav"; the first export is untouched
    first = sha(out)
    res2 = ex.render(m, out, "wav")
    assert res2["collision_renamed"] is True and Path(res2["path"]).name == "My Project (2).wav" and sha(out) == first
    # never overwrite the master
    with pytest.raises(WorkerError) as e:
        ex.render(m, m, "wav")
    assert e.value.code == "PERMISSION_DENIED"
    # no AI metadata when asked
    res3 = ex.render(m, tmp_path / "plain.wav", "wav", ai_metadata=False)
    assert "comment" not in tags(Path(res3["path"])) and "encoded_by" not in tags(Path(res3["path"]))


def test_render_wav_bit_depths_and_resample(tmp_path):
    m = master(tmp_path / "master24k.wav", 4.0, 24000)
    r16 = ex.render(m, tmp_path / "o16.wav", "wav", wav_bit_depth=16)
    assert r16["probe"]["codec"] == "pcm_s16le" and r16["probe"]["sample_rate"] == 24000
    r32 = ex.render(m, tmp_path / "o32.wav", "wav", wav_bit_depth=32, sample_rate=48000)
    assert r32["probe"]["codec"] == "pcm_f32le" and r32["probe"]["sample_rate"] == 48000 and abs(r32["probe"]["duration_s"] - 4.0) < 0.002
    d, sr = sf.read(r32["path"], dtype="float32")
    assert sr == 48000 and abs(np.max(np.abs(d)) - 0.1) < 0.002
    with pytest.raises(WorkerError) as e:
        ex.render(m, tmp_path / "bad.wav", "wav", wav_bit_depth=20)
    assert e.value.code == "INVALID_PARAMS"
    with pytest.raises(WorkerError) as e:
        ex.render(m, tmp_path / "bad.ogg", "ogg")
    assert e.value.code == "INVALID_PARAMS"


@needs_flac
def test_render_flac(tmp_path):
    m = master(tmp_path / "master.wav")
    res = ex.render(m, tmp_path / "out.flac", "flac", engine_label="Chatterbox-Turbo")
    p = res["probe"]
    assert p["codec"] == "flac" and p["sample_rate"] == 48000 and p["bit_depth"] == 24 and p["format"] == "flac"
    assert tags(Path(res["path"]))["comment"].startswith("AI-generated speech") and sf.info(res["path"]).subtype == "PCM_24"
    a, _ = sf.read(str(m), dtype="float32")
    b, _ = sf.read(res["path"], dtype="float32")
    assert np.max(np.abs(a - b)) < 2 / 2 ** 23                                  # lossless


@needs_mp3
def test_render_mp3_cbr_and_vbr(tmp_path):
    m = master(tmp_path / "master.wav")
    res = ex.render(m, tmp_path / "out.mp3", "mp3", mp3_bitrate_kbps=192)
    p = res["probe"]
    assert p["codec"] == "mp3" and p["sample_rate"] == 48000 and p["format"] == "mp3" and abs(p["bitrate"] - 192000) < 4000
    assert abs(p["duration_s"] - 8.0) < 0.1 and tags(Path(res["path"]))["encoded_by"] == "Shadowfetch Voice Studio"
    vbr = ex.render(m, tmp_path / "vbr.mp3", "mp3", mp3_vbr_quality=2)
    assert vbr["probe"]["codec"] == "mp3" and vbr["size_bytes"] > 0
    with pytest.raises(WorkerError) as e:
        ex.render(m, tmp_path / "bad.mp3", "mp3", mp3_bitrate_kbps=77)
    assert e.value.code == "INVALID_PARAMS"


@pytest.mark.parametrize("target_id,fmt", [("podcast-16", "wav"), ("broadcast-r128-23", "wav"), ("streaming-14", "flac")])
def test_render_two_pass_loudnorm_hits_target(tmp_path, target_id, fmt):
    if fmt == "flac" and not HAS_FLAC:
        pytest.skip("no flac encoder")
    sr = 48000
    # speech-like level variation: alternating louder/quieter 1 kHz bursts so LRA is not degenerate
    t = np.arange(sr * 10) / sr
    env = np.where((t % 2.0) < 1.0, 0.1, 0.03)
    x = (env * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    m = tmp_path / "master.wav"
    sf.write(str(m), x, sr, subtype="PCM_24")
    target = ex.loudness_target(target_id)
    res = ex.render(m, tmp_path / f"out.{fmt}", fmt, loudness_target=target)
    lm = res["loudness_measured"]
    assert lm is not None and abs(lm["integrated_lufs"] - target["integrated_lufs"]) <= 1.0, lm
    assert lm["true_peak_dbtp"] <= target["true_peak_dbtp"] + 0.5
    assert res["probe"]["sample_rate"] == sr                                     # loudnorm's internal 192 kHz was resampled back
    check = ex.measure_loudness(Path(res["path"]))
    assert abs(check["integrated_lufs"] - target["integrated_lufs"]) <= 1.0


def test_render_reports_progress_and_rejects_silent_loudnorm(tmp_path, app):
    m = master(tmp_path / "master.wav")
    ex.render(m, tmp_path / "p.wav", "wav", loudness_target=ex.loudness_target("podcast-16"), ctx=app.ctx)
    prog = [x for x in app.transport.messages if x["type"] == "progress"]
    assert [p["current"] for p in prog] == [1, 2, 3] and all(p["total"] == 3 for p in prog)
    silent = tmp_path / "silent.wav"
    sf.write(str(silent), np.zeros(48000 * 4, dtype=np.float32), 48000, subtype="PCM_24")
    with pytest.raises(WorkerError) as e:
        ex.render(silent, tmp_path / "s.wav", "wav", loudness_target=ex.loudness_target("podcast-16"))
    assert e.value.code == "EMPTY_AUDIO"


# ---------------------------------------------------------------- jobs
def test_job_loudness_targets(app):
    from shadowfetch_worker.jobs import export as jobs
    res = jobs.export_loudness_targets(app.ctx, {})
    assert [t["id"] for t in res["targets"]] == ["podcast-16", "streaming-14", "broadcast-r128-23"] and res["default"] is None


def test_job_render_with_project_records_export(app, tmp_path):
    from shadowfetch_worker.jobs import export as jobs
    m = master(app.paths.projects / "proj_1" / "master.wav")
    app.db.insert("projects", {"id": "proj_1", "name": "Intro: Episode 1", "engine_id": "qwen3-tts-base", "master_path": str(m)})
    res = jobs.export_render(app.ctx, jobs.RenderParams(project_id="proj_1", format="wav"))
    assert Path(res["path"]) == app.paths.exports / "Intro_ Episode 1.wav" and Path(res["path"]).is_file()
    assert res["export_id"].startswith("export_") and res["settings"]["engine_label"] == "Qwen3-TTS 1.7B Base"
    assert tags(Path(res["path"]))["comment"].endswith("(Qwen3-TTS 1.7B Base)")
    row = app.db.require("exports", res["export_id"])
    assert row["project_id"] == "proj_1" and row["format"] == "wav" and row["size_bytes"] == res["size_bytes"]
    assert json.loads(row["probe_json"])["codec"] == "pcm_s24le" and row["loudness_json"] is None
    # explicit out path with the wrong extension gets the format's extension; loudness recorded when used
    res2 = jobs.export_render(app.ctx, jobs.RenderParams(project_id="proj_1", format="wav", out_path=str(tmp_path / "picked" / "take.mp3"),
                                                          loudness={"target_id": "podcast-16"}, sample_rate="48000"))
    assert Path(res2["path"]) == tmp_path / "picked" / "take.wav" and res2["loudness_measured"]["integrated_lufs"] is not None
    assert json.loads(app.db.require("exports", res2["export_id"])["loudness_json"])["integrated_lufs"] == res2["loudness_measured"]["integrated_lufs"]
    with pytest.raises(WorkerError) as e:
        jobs.export_render(app.ctx, jobs.RenderParams(project_id="proj_1", format="wav", loudness={"target_id": "nope"}))
    assert e.value.code == "INVALID_PARAMS"
    f32 = jobs.export_render(app.ctx, jobs.RenderParams(project_id="proj_1", format="wav", wav_bit_depth="32f", out_path=str(tmp_path / "f.wav")))
    assert f32["probe"]["codec"] == "pcm_f32le" and f32["settings"]["wav_bit_depth"] == 32


def test_job_render_without_project_and_missing_master(app, tmp_path):
    from shadowfetch_worker.jobs import export as jobs
    m = master(tmp_path / "loose.wav", 3.0)
    res = jobs.export_render(app.ctx, jobs.RenderParams(master_path=str(m), format="wav", engine_label="Test Engine"))
    assert Path(res["path"]) == app.paths.exports / "loose.wav" and "export_id" not in res
    assert tags(Path(res["path"]))["comment"].endswith("(Test Engine)")
    app.db.insert("projects", {"id": "proj_2", "name": "No master yet"})
    with pytest.raises(WorkerError) as e:
        jobs.export_render(app.ctx, jobs.RenderParams(project_id="proj_2", format="wav"))
    assert e.value.code == "NOT_FOUND"
    with pytest.raises(WorkerError) as e:
        jobs.export_render(app.ctx, jobs.RenderParams(format="wav"))
    assert e.value.code == "INVALID_PARAMS"
    with pytest.raises(WorkerError) as e:
        jobs.export_render(app.ctx, jobs.RenderParams(project_id="missing", format="wav"))
    assert e.value.code == "NOT_FOUND"
    assert probe(Path(res["path"]))["duration_s"] == pytest.approx(3.0, abs=0.002)
