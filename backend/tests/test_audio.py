"""Tests for the audio pipeline (ffmpeg wrappers, analysis, editing, assembly) and the audio.* jobs.

All audio is synthesized with numpy; ffmpeg/ffprobe must be on PATH (they are on the dev machine). No models, no network.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import zlib
import struct
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from shadowfetch_worker.audio import analysis, edit
from shadowfetch_worker.audio.ffmpeg import decode_to_wav, probe, run_ffmpeg
from shadowfetch_worker.paths import AppPaths
from shadowfetch_worker.protocol import WorkerError
from shadowfetch_worker.rpc import Ctx
from shadowfetch_worker.store.db import Database

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg/ffprobe not on PATH")


# ---------------------------------------------------------------- helpers
def tone(seconds: float, sr: int = 48000, amp: float = 0.25, hz: float = 440.0, lead: float = 0.0, trail: float = 0.0,
         channels: int = 1) -> np.ndarray:
    t = np.arange(int(round(seconds * sr))) / sr
    x = amp * np.sin(2 * np.pi * hz * t)
    x = np.concatenate([np.zeros(int(round(lead * sr))), x, np.zeros(int(round(trail * sr)))]).astype(np.float32)
    return np.stack([x] * channels, axis=1) if channels > 1 else x


def write(path: Path, data: np.ndarray, sr: int = 48000, subtype: str = "FLOAT") -> Path:
    sf.write(str(path), data, sr, subtype=subtype)
    return path


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def silent_gaps(x: np.ndarray, sr: int, threshold_dbfs: float = -50.0, min_ms: float = 50.0) -> list[tuple[float, float]]:
    """(start_s, length_s) of every run of samples under the threshold amplitude longer than min_ms — inner gaps only."""
    amp = 10 ** (threshold_dbfs / 20)
    quiet = np.abs(x) < amp
    edges = np.diff(np.concatenate([[0], quiet.astype(np.int8), [0]]))
    starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
    out = [(s / sr, (e - s) / sr) for s, e in zip(starts, ends) if (e - s) >= min_ms / 1000 * sr and s > 0 and e < len(x)]
    return out


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
    server = SimpleNamespace(state=state, started=0.0)
    return SimpleNamespace(paths=paths, db=db, state=state, server=server, transport=FakeTransport())


def make_ctx(app, method: str = "test") -> Ctx:
    return Ctx(req_id="req-1", method=method, transport=app.transport, server=app.server)


# ---------------------------------------------------------------- ffmpeg.probe / decode
def test_probe_wav_and_flac(tmp_path):
    wav = write(tmp_path / "a.wav", tone(2.0, 48000, channels=2), 48000, "PCM_24")
    info = probe(wav)
    assert info["format"] == "wav" and info["codec"] == "pcm_s24le"
    assert info["sample_rate"] == 48000 and info["channels"] == 2 and info["bit_depth"] == 24
    assert abs(info["duration_s"] - 2.0) < 0.01 and info["size_bytes"] == wav.stat().st_size
    flac = tmp_path / "a.flac"
    sf.write(str(flac), tone(1.5, 24000), 24000, subtype="PCM_16")
    f = probe(flac)
    assert f["format"] == "flac" and f["codec"] == "flac" and f["sample_rate"] == 24000 and f["bit_depth"] == 16
    assert abs(f["duration_s"] - 1.5) < 0.01


def test_probe_rejects_non_audio_and_corrupt(tmp_path):
    txt = tmp_path / "notes.txt"
    txt.write_text("this is not audio")
    with pytest.raises(WorkerError) as e:
        probe(txt)
    assert e.value.code == "UNSUPPORTED_FILE"
    broken = tmp_path / "broken.wav"                   # RIFF/WAVE with a garbage fmt chunk → ffprobe cannot parse it
    broken.write_bytes(b"RIFF" + struct.pack("<I", 100) + b"WAVE" + b"fmt " + struct.pack("<I", 16) + b"\xff" * 16 + b"data" + struct.pack("<I", 0))
    with pytest.raises(WorkerError) as e:
        probe(broken)
    assert e.value.code == "CORRUPT_FILE"
    good = write(tmp_path / "good.wav", tone(1.0), 48000, "PCM_16")
    header_only = tmp_path / "empty.wav"
    header_only.write_bytes(good.read_bytes()[:44])      # valid header, zero samples
    with pytest.raises(WorkerError) as e:
        probe(header_only)
    assert e.value.code == "EMPTY_AUDIO"
    # a PNG probes fine but has no audio stream
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = tmp_path / "img.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0))
                    + chunk(b"IDAT", zlib.compress(b"\x00\x00")) + chunk(b"IEND", b""))
    with pytest.raises(WorkerError) as e:
        probe(png)
    assert e.value.code == "UNSUPPORTED_FILE"
    with pytest.raises(WorkerError) as e:
        probe(tmp_path / "missing.wav")
    assert e.value.code == "NOT_FOUND"


def test_decode_to_wav_resamples_and_downmixes(tmp_path):
    src = write(tmp_path / "stereo24k.wav", tone(1.0, 24000, channels=2), 24000, "PCM_16")
    dst = tmp_path / "out" / "working.wav"
    info = decode_to_wav(src, dst, sample_rate=48000, channels=1, sample_fmt="f32")
    assert dst.is_file() and not dst.with_name("working.wav.tmp").exists()
    assert info["sample_rate"] == 48000 and info["channels"] == 1 and info["codec"] == "pcm_f32le"
    assert abs(info["duration_s"] - 1.0) < 0.005
    data, sr = sf.read(str(dst), dtype="float32")
    assert sr == 48000 and data.ndim == 1 and abs(np.max(np.abs(data)) - 0.25) < 0.01


def test_run_ffmpeg_failure_carries_stderr(tmp_path):
    with pytest.raises(WorkerError) as e:
        run_ffmpeg(["-i", str(tmp_path / "nope.wav"), "-f", "null", "-"])
    assert e.value.code == "FFMPEG_FAILED" and "stderr" in e.value.details and e.value.details["exit_code"] != 0


# ---------------------------------------------------------------- analysis
def test_peaks_shape_values_and_cache(tmp_path, monkeypatch):
    wav = write(tmp_path / "s.wav", tone(3.0, 48000, amp=0.5))
    cache = tmp_path / "peaks"
    pk = analysis.peaks(wav, 500, cache_dir=cache)
    assert pk["points"] == 500 and len(pk["peaks"]) == 500 and pk["sample_rate"] == 48000 and abs(pk["duration_s"] - 3.0) < 1e-6
    mx = max(p[1] for p in pk["peaks"])
    mn = min(p[0] for p in pk["peaks"])
    assert abs(mx - 0.5) < 0.01 and abs(mn + 0.5) < 0.01
    assert all(p[0] <= p[1] for p in pk["peaks"])
    cached = analysis.peaks_cache_file(wav, 500, cache)
    assert cached.is_file() and json.loads(cached.read_text()) == pk
    # second call must be served from the cache: computing again would raise
    monkeypatch.setattr(analysis, "_compute_peaks", lambda *a, **k: (_ for _ in ()).throw(AssertionError("recomputed")))
    assert analysis.peaks(wav, 500, cache_dir=cache) == pk
    monkeypatch.undo()
    # changing the file (size/mtime) invalidates the key
    write(wav, tone(2.0, 48000, amp=0.1))
    pk2 = analysis.peaks(wav, 500, cache_dir=cache)
    assert abs(pk2["duration_s"] - 2.0) < 1e-6 and abs(max(p[1] for p in pk2["peaks"]) - 0.1) < 0.01


def test_peaks_streams_in_blocks_consistently(tmp_path, monkeypatch):
    wav = write(tmp_path / "long.wav", tone(4.0, 48000, amp=0.3, hz=7.0))
    full = analysis.peaks(wav, 64)
    monkeypatch.setattr(analysis, "PEAK_BLOCK_FRAMES", 5000)   # force many blocks straddling buckets
    assert analysis.peaks(wav, 64) == full


def test_stats_measurements_and_warnings(tmp_path):
    sr = 48000
    clean = write(tmp_path / "clean.wav", tone(5.0, sr, amp=0.25, lead=0.5, trail=0.3))
    s = analysis.stats(clean)
    assert s["sample_rate"] == sr and s["channels"] == 1 and abs(s["duration_s"] - 5.8) < 1e-6
    assert abs(s["peak_dbfs"] - (-12.04)) < 0.05 and abs(s["rms_dbfs"] - (20 * np.log10(0.25 / np.sqrt(2) * np.sqrt(5 / 5.8)))) < 0.1
    assert s["clipping_samples"] == 0 and abs(s["dc_offset"]) < 1e-3
    assert abs(s["leading_silence_s"] - 0.5) < 0.021 and abs(s["trailing_silence_s"] - 0.3) < 0.021
    assert abs(s["silence_ratio"] - 0.8 / 5.8) < 0.02 and s["warnings"] == []

    codes = lambda st: {w["code"] for w in st["warnings"]}  # noqa: E731
    quiet = write(tmp_path / "quiet.wav", tone(4.0, sr, amp=10 ** (-40 / 20)))
    assert codes(analysis.stats(quiet)) == {"TOO_QUIET"}
    clipped = write(tmp_path / "clipped.wav", np.clip(tone(4.0, sr, amp=1.5), -1, 1))
    st = analysis.stats(clipped)
    assert "CLIPPING" in codes(st) and st["clipping_samples"] >= 3
    mostly = write(tmp_path / "mostly.wav", tone(1.0, sr, lead=2.0, trail=2.0))
    assert "MOSTLY_SILENT" in codes(analysis.stats(mostly))
    short = write(tmp_path / "short.wav", tone(1.0, sr))
    assert codes(analysis.stats(short)) == {"TOO_SHORT"}
    dc = write(tmp_path / "dc.wav", tone(4.0, sr) + 0.05)
    assert "DC_OFFSET" in codes(analysis.stats(dc))
    low = write(tmp_path / "low.wav", tone(4.0, 8000, hz=200), 8000)
    assert "LOW_SAMPLE_RATE" in codes(analysis.stats(low))
    assert all(w["heuristic"] is True and w["message"] for st_ in (analysis.stats(dc), analysis.stats(low)) for w in st_["warnings"])
    # range selection and stereo clipping detection
    stereo = write(tmp_path / "stereo.wav", np.stack([tone(4.0, sr, amp=0.2), np.clip(tone(4.0, sr, amp=2.0), -1, 1)], axis=1))
    st = analysis.stats(stereo, 1.0, 2.0)
    assert st["channels"] == 2 and abs(st["duration_s"] - 1.0) < 1e-6 and st["clipping_samples"] >= 3
    silent = write(tmp_path / "silent.wav", np.zeros(sr * 4, dtype=np.float32))
    st = analysis.stats(silent)
    assert st["peak_dbfs"] == analysis.DB_FLOOR and st["silence_ratio"] == 1.0 and st["leading_silence_s"] == 4.0


def test_find_sound_bounds_is_sample_accurate(tmp_path):
    sr = 48000
    x = tone(1.0, sr, amp=0.25, lead=0.5, trail=0.7)
    b = analysis.find_sound_bounds(x, sr)
    assert b is not None
    assert abs(b[0] / sr - 0.5) < 0.002 and abs(b[1] / sr - 1.5) < 0.002
    assert analysis.find_sound_bounds(np.zeros(sr), sr) is None
    assert analysis.find_sound_bounds(tone(0.5, sr, amp=10 ** (-60 / 20)), sr) is None


def test_read_audio_mixes_to_mono_and_write_wav_is_atomic(tmp_path):
    sr = 48000
    left, right = tone(1.0, sr, amp=0.4), tone(1.0, sr, amp=0.2)
    src = write(tmp_path / "st.wav", np.stack([left, right], axis=1))
    mono, r = analysis.read_audio(src, 0.25, 0.75)
    assert r == sr and mono.ndim == 1 and len(mono) == sr // 2 and abs(np.max(np.abs(mono)) - 0.3) < 0.01
    out = tmp_path / "w.wav"
    analysis.write_wav(out, np.full(1000, 1.7, dtype=np.float32), sr, "PCM_16")
    assert not out.with_name("w.wav.tmp").exists()
    d, _ = sf.read(str(out))
    assert np.max(d) <= 1.0                                    # clipped, never wrapped around
    with pytest.raises(WorkerError) as e:
        analysis.write_wav(out, np.zeros(0, dtype=np.float32), sr)
    assert e.value.code == "EMPTY_AUDIO"


def test_read_audio_falls_back_to_ffmpeg_for_non_libsndfile_formats(tmp_path):
    src = write(tmp_path / "src.wav", tone(1.0, 48000), 48000, "PCM_16")
    m4a = tmp_path / "clip.m4a"
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-c:a", "aac", str(m4a)], capture_output=True, text=True)
    if r.returncode != 0:
        pytest.skip("this ffmpeg build cannot encode aac: " + r.stderr[-200:])
    data, sr = analysis.read_audio(m4a)
    rms = float(np.sqrt(np.mean(data[sr // 10: -sr // 10] ** 2)))     # lossy codec: compare RMS, not the peak
    assert sr == 48000 and abs(len(data) / sr - 1.0) < 0.1 and abs(rms - 0.25 / np.sqrt(2)) < 0.03
    st = analysis.stats(m4a)
    assert st["sample_rate"] == 48000 and analysis.peaks(m4a, 100)["points"] == 100


# ---------------------------------------------------------------- edit
def test_trim_writes_new_file_and_leaves_source(tmp_path):
    src = write(tmp_path / "src.wav", tone(3.0, 48000, channels=2), 48000, "PCM_24")
    before = sha(src)
    res = edit.trim(src, tmp_path / "cut.wav", 1.0, 2.0)
    assert abs(res["duration_s"] - 1.0) < 1e-6 and res["sample_rate"] == 48000 and res["channels"] == 2
    assert sf.info(res["path"]).subtype == "PCM_24" and sha(src) == before
    with pytest.raises(WorkerError) as e:
        edit.trim(src, tmp_path / "x.wav", 1.0, 1.05)
    assert e.value.code == "EMPTY_AUDIO"
    with pytest.raises(WorkerError) as e:
        edit.trim(src, tmp_path / "x.wav", 2.0, 1.0)
    assert e.value.code == "INVALID_PARAMS"
    with pytest.raises(WorkerError):
        edit.trim(src, src, 0.0, 1.0)


def test_prepare_reference_resamples_downmixes_and_normalizes(tmp_path):
    src = write(tmp_path / "working.wav", tone(6.0, 48000, amp=0.1, channels=2), 48000, "FLOAT")
    before = sha(src)
    res = edit.prepare_reference(src, tmp_path / "ref.wav", 24000, 1, 1.0, 5.0, normalize_peak_dbfs=-3.0)
    assert res["sample_rate"] == 24000 and res["channels"] == 1 and abs(res["duration_s"] - 4.0) < 0.002
    info = sf.info(res["path"])
    assert info.samplerate == 24000 and info.channels == 1 and info.subtype == "PCM_24"
    assert abs(res["stats"]["peak_dbfs"] - (-3.0)) < 0.1 and abs(res["gain_db"] - 17.0) < 0.2
    assert sha(src) == before
    same = edit.prepare_reference(src, tmp_path / "ref48.wav", 48000, 1, 0.0, 2.0)
    assert same["sample_rate"] == 48000 and abs(same["stats"]["peak_dbfs"] - (-20.0)) < 0.1 and same["gain_db"] == 0.0
    with pytest.raises(WorkerError) as e:
        edit.prepare_reference(src, tmp_path / "bad.wav", 24000, 1, 1.0, 1.02)
    assert e.value.code == "EMPTY_AUDIO"


def test_apply_processing_ops(tmp_path):
    sr = 48000
    src = write(tmp_path / "in.wav", tone(2.0, sr, amp=0.2, lead=0.4, trail=0.3))
    gain = edit.apply_processing(src, tmp_path / "g.wav", [{"op": "gain", "db": 6.0}])
    d, _ = sf.read(gain["path"], dtype="float32")
    assert abs(np.max(np.abs(d)) - 0.2 * 10 ** (6 / 20)) < 0.005 and gain["steps"][0]["op"] == "gain"
    norm = edit.apply_processing(src, tmp_path / "n.wav", [{"op": "normalize_peak", "dbfs": -1.0}])
    d, _ = sf.read(norm["path"], dtype="float32")
    assert abs(20 * np.log10(np.max(np.abs(d))) + 1.0) < 0.05
    trimmed = edit.apply_processing(src, tmp_path / "t.wav", [{"op": "trim_silence", "threshold_dbfs": -50, "pad_ms": 40}])
    assert abs(trimmed["duration_s"] - (2.0 + 0.08)) < 0.003
    assert abs(trimmed["steps"][0]["removed_leading_s"] - 0.36) < 0.003 and abs(trimmed["steps"][0]["removed_trailing_s"] - 0.26) < 0.003
    # highpass: a 30 Hz tone is attenuated a lot, a 1 kHz tone barely
    low = write(tmp_path / "low.wav", tone(2.0, sr, amp=0.5, hz=30.0))
    hp = edit.apply_processing(low, tmp_path / "hp.wav", [{"op": "highpass", "hz": 80}])
    d, _ = sf.read(hp["path"], dtype="float32")
    assert np.max(np.abs(d[sr // 2:])) < 0.5 * 10 ** (-10 / 20)
    mid = write(tmp_path / "mid.wav", tone(2.0, sr, amp=0.5, hz=1000.0))
    hp2 = edit.apply_processing(mid, tmp_path / "hp2.wav", [{"op": "highpass", "hz": 80}])
    d, _ = sf.read(hp2["path"], dtype="float32")
    assert abs(np.max(np.abs(d[sr // 2:])) - 0.5) < 0.02
    chain = edit.apply_processing(src, tmp_path / "c.wav", [{"op": "trim_silence"}, {"op": "highpass", "hz": 60}, {"op": "normalize_peak", "dbfs": -3}])
    assert [s["op"] for s in chain["steps"]] == ["trim_silence", "highpass", "normalize_peak"]
    with pytest.raises(WorkerError) as e:
        edit.apply_processing(src, tmp_path / "u.wav", [{"op": "reverb"}])
    assert e.value.code == "INVALID_PARAMS"
    with pytest.raises(WorkerError) as e:
        edit.apply_processing(src, tmp_path / "u.wav", [{"op": "gain", "db": "loud"}])
    assert e.value.code == "INVALID_PARAMS"
    assert sf.read(str(src), dtype="float32")[0].shape[0] == int(2.7 * sr)   # source untouched


def test_assemble_pauses_no_overlap_and_resampling(tmp_path):
    sr = 48000
    t0 = write(tmp_path / "t0.wav", tone(0.5, sr, amp=0.3, lead=0.1, trail=0.1), sr, "PCM_24")
    t1 = write(tmp_path / "t1.wav", tone(0.5, 24000, amp=0.3, lead=0.1, trail=0.1), 24000, "PCM_24")   # different rate
    t2 = write(tmp_path / "t2.wav", tone(0.5, sr, amp=0.3, lead=0.1, trail=0.1, channels=2), sr, "PCM_24")
    takes = [{"path": str(t0), "paragraph": 0, "index": 0}, {"path": str(t1), "paragraph": 0, "index": 1},
             {"path": str(t2), "paragraph": 1, "index": 2}]
    res = edit.assemble(takes, tmp_path / "master.wav", sentence_pause_ms=250, paragraph_pause_ms=600)
    assert res["sample_rate"] == sr and res["segments_used"] == 3 and sf.info(res["path"]).subtype == "PCM_24"
    x, r = sf.read(res["path"], dtype="float32")
    assert r == sr and x.ndim == 1
    # each take keeps 40 ms of its own silence on both sides → gaps between sound = pause + 80 ms
    gaps = silent_gaps(x, sr, min_ms=100)
    assert len(gaps) == 2, gaps
    assert abs(gaps[0][1] - 0.330) <= 0.005 and abs(gaps[1][1] - 0.680) <= 0.005
    expected = 3 * (0.5 + 0.08) + 0.25 + 0.6
    assert abs(res["duration_s"] - expected) < 0.005
    segs = res["segments"]
    assert all(segs[i]["end_s"] <= segs[i + 1]["start_s"] for i in range(len(segs) - 1))        # never overlaps
    assert segs[1]["pause_before_ms"] == 250 and segs[2]["pause_before_ms"] == 600 and segs[0]["pause_before_ms"] == 0
    assert abs(segs[1]["start_s"] - segs[0]["end_s"] - 0.25) < 1e-6 and abs(segs[2]["start_s"] - segs[1]["end_s"] - 0.6) < 1e-6
    assert any("resampled 24000" in w for w in res["warnings"])
    assert abs(np.max(np.abs(x)) - 0.3) < 0.02
    with pytest.raises(WorkerError) as e:
        edit.assemble([], tmp_path / "x.wav")
    assert e.value.code == "INVALID_PARAMS"
    with pytest.raises(WorkerError) as e:
        edit.assemble([{"path": str(tmp_path / "gone.wav"), "paragraph": 0, "index": 0}], tmp_path / "x.wav")
    assert e.value.code == "NOT_FOUND"


def test_assemble_explicit_rate_and_fades_avoid_clicks(tmp_path):
    sr = 48000
    # a take with no silence at all: fades must ramp the first/last 5 ms
    t = write(tmp_path / "hard.wav", tone(0.3, sr, amp=0.5, hz=100.0) + 0.3)
    res = edit.assemble([{"path": str(t), "paragraph": 0, "index": 0}], tmp_path / "m.wav", sample_rate=24000)
    assert res["sample_rate"] == 24000
    x, r = sf.read(res["path"], dtype="float32")
    assert r == 24000 and abs(x[0]) < 0.02 and abs(x[-1]) < 0.02 and abs(res["duration_s"] - 0.3) < 0.002


def test_loudness_match_copy_is_gain_only(tmp_path):
    from shadowfetch_worker.audio.export import measure_loudness
    src = write(tmp_path / "s.wav", tone(8.0, 48000, amp=0.1, hz=1000.0))
    res = edit.loudness_match_copy(src, tmp_path / "match.wav", target_lufs=-18.0)
    assert res["preview_only"] is True and abs(res["measured_lufs"] - (-23.0)) < 0.5 and abs(res["gain_db"] - 5.0) < 0.5
    m = measure_loudness(res["path"])
    assert abs(m["integrated_lufs"] - (-18.0)) < 1.0
    a, _ = sf.read(str(src), dtype="float32")
    b, _ = sf.read(res["path"], dtype="float32")
    ratio = b[1000:2000] / a[1000:2000]
    assert np.allclose(ratio, ratio[0], atol=1e-3)               # a constant gain, no dynamics processing


# ---------------------------------------------------------------- jobs
def test_job_probe_and_import(app, tmp_path):
    from shadowfetch_worker.jobs import audio as jobs
    src = write(tmp_path / "My Voice.flac", tone(4.0, 24000, amp=0.3, channels=2), 24000, "PCM_16")
    src_sha = sha(src)
    ctx = make_ctx(app)
    info = jobs.audio_probe(ctx, jobs.PathParams(path=str(src)))
    assert info["format"] == "flac" and info["channels"] == 2
    with pytest.raises(WorkerError) as e:
        jobs.audio_probe(ctx, jobs.PathParams(path="relative.wav"))
    assert e.value.code == "INVALID_PARAMS"
    res = jobs.audio_import(ctx, jobs.ImportParams(path=str(src), kind="reference"))
    asset_dir = app.paths.recordings / res["asset_id"]
    assert Path(res["original_path"]) == asset_dir / "original.flac" and sha(Path(res["original_path"])) == src_sha == res["sha256"]
    w = probe(Path(res["working_path"]))
    assert w["sample_rate"] == 48000 and w["channels"] == 1 and w["codec"] == "pcm_f32le" and abs(w["duration_s"] - 4.0) < 0.01
    assert Path(res["peaks_path"]).is_file() and res["peaks"]["points"] == 2000 and res["stats"]["sample_rate"] == 48000
    assert (asset_dir / "meta.json").is_file()
    row = app.db.require("assets", res["asset_id"])
    assert row["kind"] == "reference" and row["sha256"] == src_sha and row["working_path"] == res["working_path"]
    assert row["sample_rate"] == 24000 and row["channels"] == 2 and json.loads(row["stats_json"])["duration_s"] == res["stats"]["duration_s"]
    stages = [m["stage"] for m in app.transport.messages if m.get("type") == "progress"]
    assert "copy" in stages and "decode" in stages
    assert not list(asset_dir.glob("*.tmp"))


def test_job_import_failure_cleans_up(app, tmp_path):
    from shadowfetch_worker.jobs import audio as jobs
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"RIFF" + b"\x00" * 40)
    with pytest.raises(WorkerError) as e:
        jobs.audio_import(make_ctx(app), jobs.ImportParams(path=str(bad), kind="other"))
    assert e.value.code in ("CORRUPT_FILE", "UNSUPPORTED_FILE")
    assert list(app.paths.recordings.iterdir()) == [] and app.db.all("SELECT id FROM assets") == []


def test_job_peaks_stats_trim_defaults(app, tmp_path):
    from shadowfetch_worker.jobs import audio as jobs
    src = write(tmp_path / "clip.wav", tone(3.0, 48000, amp=0.3), 48000, "PCM_24")
    ctx = make_ctx(app)
    pk = jobs.audio_peaks(ctx, jobs.PeaksParams(path=str(src), points=300))
    assert pk["points"] == 300 and analysis.peaks_cache_file(src, 300, app.paths.peaks).is_file()
    st = jobs.audio_stats(ctx, jobs.StatsParams(path=str(src), start_s=0.5, end_s=1.5))
    assert abs(st["duration_s"] - 1.0) < 1e-6
    with pytest.raises(WorkerError):
        jobs.audio_stats(ctx, jobs.StatsParams(path=str(src), start_s=2.0, end_s=1.0))
    tr = jobs.audio_trim(ctx, jobs.TrimParams(path=str(src), start_s=0.5, end_s=1.5))
    assert Path(tr["path"]).parent == app.paths.exports and abs(tr["duration_s"] - 1.0) < 1e-6
    tr2 = jobs.audio_trim(ctx, jobs.TrimParams(path=str(src), start_s=0.5, end_s=1.5, out_path=str(tmp_path / "picked" / "cut.wav")))
    assert tr2["path"] == str(tmp_path / "picked" / "cut.wav") and Path(tr2["path"]).is_file()
    with pytest.raises(WorkerError) as e:
        jobs.audio_trim(ctx, jobs.TrimParams(path=str(src), start_s=0.5, end_s=1.5, out_path=str(src)))
    assert e.value.code == "INVALID_PARAMS"


def test_job_prepare_reference_uses_engine_capabilities(app, tmp_path):
    from shadowfetch_worker.engines.base import Capabilities, Language, ReferenceRequirements
    from shadowfetch_worker.jobs import audio as jobs
    caps = Capabilities(id="fake-engine", name="Fake Engine", version="0", model_id="m", model_repo="r", output_sample_rate=24000,
                        languages=[Language(code="en", label="English", engine_value="English")],
                        reference=ReferenceRequirements(needs_transcript=True, min_seconds=3, max_seconds=30, recommended_seconds=(8, 15),
                                                        sample_rate=24000, channels=1),
                        max_chars_per_request=400, supports_cancel=True, supports_seed=True, supports_reusable_prompt=True)
    app.state["engines"] = SimpleNamespace(capabilities=lambda eid: caps)
    src = write(tmp_path / "rec.wav", tone(12.0, 48000, amp=0.1, channels=2), 48000, "PCM_24")
    ctx = make_ctx(app)
    imp = jobs.audio_import(ctx, jobs.ImportParams(path=str(src), kind="reference"))
    res = jobs.audio_prepare_reference(ctx, jobs.PrepareReferenceParams(asset_id=imp["asset_id"], start_s=1.0, end_s=9.0, engine_id="fake-engine",
                                                                        processing={"normalize_peak_dbfs": -3.0}))
    expected = app.paths.voices / "_prepared" / imp["asset_id"] / "reference.fake-engine.wav"
    assert Path(res["path"]) == expected and expected.is_file()
    assert res["sample_rate"] == 24000 and res["channels"] == 1 and abs(res["duration_s"] - 8.0) < 0.002
    assert res["reference_id"].startswith("prep_") and len(res["fingerprint"]) == 64 and abs(res["stats"]["peak_dbfs"] + 3.0) < 0.1
    assert res["processing"] == [{"op": "normalize_peak", "dbfs": -3.0}]
    again = jobs.audio_prepare_reference(ctx, jobs.PrepareReferenceParams(asset_id=imp["asset_id"], start_s=1.0, end_s=9.0, engine_id="fake-engine",
                                                                          processing={"normalize_peak_dbfs": -3.0}))
    assert again["fingerprint"] == res["fingerprint"]
    for a, b in ((1.0, 2.0), (0.0, 40.0)):        # shorter than min_seconds / longer than max_seconds
        with pytest.raises(WorkerError) as e:
            jobs.audio_prepare_reference(ctx, jobs.PrepareReferenceParams(asset_id=imp["asset_id"], start_s=a, end_s=b, engine_id="fake-engine"))
        assert e.value.code == "INVALID_PARAMS" and e.value.details["max_seconds"] == 30
    with pytest.raises(WorkerError) as e:
        jobs.audio_prepare_reference(ctx, jobs.PrepareReferenceParams(asset_id="asset_nope", start_s=1.0, end_s=9.0, engine_id="fake-engine"))
    assert e.value.code == "NOT_FOUND"


def test_job_preview_processing_caches_in_tmp(app, tmp_path):
    from shadowfetch_worker.jobs import audio as jobs
    src = write(tmp_path / "v.wav", tone(2.0, 48000, amp=0.2, lead=0.3, trail=0.3))
    ctx = make_ctx(app)
    res = jobs.audio_preview_processing(ctx, jobs.PreviewParams(path=str(src), processing={"trim_silence": True, "normalize_peak_dbfs": -3}))
    assert Path(res["path"]).parent == app.paths.tmp and res["cached"] is False
    assert [s["op"] for s in res["steps"]] == ["trim_silence", "normalize_peak"]
    again = jobs.audio_preview_processing(ctx, jobs.PreviewParams(path=str(src), processing=[{"op": "trim_silence"}, {"op": "normalize_peak", "dbfs": -3}]))
    assert again["cached"] is True and again["path"] == res["path"]
    with pytest.raises(WorkerError) as e:
        jobs.audio_preview_processing(ctx, jobs.PreviewParams(path=str(src), processing={"reverb": 1}))
    assert e.value.code == "INVALID_PARAMS"


def test_job_play_device_test_fallbacks(app, tmp_path, monkeypatch):
    from shadowfetch_worker.jobs import audio as jobs
    ctx = make_ctx(app)
    # no sounddevice, no players → DEVICE_UNAVAILABLE with the reasons
    monkeypatch.setitem(__import__("sys").modules, "sounddevice", None)
    monkeypatch.setattr(jobs.shutil, "which", lambda name: None)
    with pytest.raises(WorkerError) as e:
        jobs.audio_play_device_test(ctx, jobs.DeviceTestParams())
    assert e.value.code == "DEVICE_UNAVAILABLE" and "ffplay: not installed" in e.value.message
    # a fake ffplay on PATH that succeeds → reported backend
    fake = tmp_path / "bin" / "ffplay"
    fake.parent.mkdir()
    fake.write_text("#!/bin/sh\ntest -f \"$5\" || exit 3\nexit 0\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(jobs.shutil, "which", lambda name: str(fake) if name == "ffplay" else None)
    res = jobs.audio_play_device_test(ctx, jobs.DeviceTestParams(device_index=3))
    assert res["ok"] is True and res["backend"] == "ffplay" and any("device_index is ignored" in n for n in res["notes"])
    tone_wav = app.paths.tmp / "device-test-440hz.wav"
    assert tone_wav.is_file() and abs(sf.info(str(tone_wav)).duration - 0.5) < 1e-3


@pytest.mark.skipif(os.environ.get("SFVS_TEST_PLAYBACK") != "1", reason="real playback needs an audio device; set SFVS_TEST_PLAYBACK=1")
def test_job_play_device_test_real(app):
    from shadowfetch_worker.jobs import audio as jobs
    res = jobs.audio_play_device_test(make_ctx(app), jobs.DeviceTestParams())
    assert res["ok"] is True and res["backend"] in ("sounddevice", "ffplay", "paplay")
