"""transcribe.run with a monkeypatched WhisperModel (no faster-whisper, no torch)."""
from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from shadowfetch_worker.jobs.models import get_models
from shadowfetch_worker.jobs.transcribe import RunParams, transcribe_models, transcribe_run
from shadowfetch_worker.models.registry import MODELS
from shadowfetch_worker.protocol import WorkerError
from tests.conftest import make_hf_snapshot

WHISPER = "faster-whisper-small.en"


class FakeWhisperModel:
    instances: list["FakeWhisperModel"] = []

    def __init__(self, path, device="cpu", compute_type="default", cpu_threads=0, local_files_only=False, **kw):
        self.path, self.device, self.compute_type, self.cpu_threads = path, device, compute_type, cpu_threads
        self.calls: list[dict] = []
        FakeWhisperModel.instances.append(self)

    def transcribe(self, audio, **kw):
        self.calls.append({"audio": audio, **kw})
        data, sr = sf.read(audio, dtype="float32")
        assert sr == 16000 and data.ndim == 1, "selection must be 16 kHz mono"
        dur = len(data) / sr
        info = SimpleNamespace(language="en", language_probability=0.99, duration=dur)

        def gen():
            yield SimpleNamespace(start=0.0, end=min(1.0, dur), text=" Hello there,")
            yield SimpleNamespace(start=min(1.0, dur), end=dur, text=" this is a test.")
            yield SimpleNamespace(start=dur, end=dur, text="   ")

        return gen(), info


@pytest.fixture
def fake_whisper(monkeypatch):
    FakeWhisperModel.instances.clear()
    mod = types.ModuleType("faster_whisper")
    mod.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", mod)
    return FakeWhisperModel


@pytest.fixture
def wav(tmp_path):
    sr = 48000
    t = np.arange(int(sr * 3.0)) / sr
    data = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    p = tmp_path / "in.wav"
    sf.write(str(p), data, sr, subtype="PCM_24")
    return p


def _install(app):
    mm = get_models(app)
    make_hf_snapshot(mm.hf_cache, MODELS[WHISPER]["repo"], "abc123", {"model.bin": 10, "config.json": b"{}", "tokenizer.json": b"{}", "vocabulary.txt": b"a"})
    return mm


def test_models_list(app, ctx):
    _install(app)
    res = transcribe_models(ctx, {})
    ids = {m["id"]: m for m in res["models"]}
    assert set(ids) == {m for m, s in MODELS.items() if s["kind"] == "asr"}
    assert ids[WHISPER]["installed"] is True and ids[WHISPER]["default"] is True and ids[WHISPER]["device"] == "cpu"
    assert ids["faster-whisper-base.en"]["installed"] is False


def test_run_cpu(app, ctx, fake_whisper, wav):
    _install(app)
    res = transcribe_run(ctx, RunParams(path=str(wav), start_s=0.5, end_s=2.5))
    assert res["text"] == "Hello there, this is a test."
    assert res["language"] == "en" and res["language_probability"] == 0.99
    assert [s["text"] for s in res["segments"]] == ["Hello there,", "this is a test."]
    assert abs(res["duration_s"] - 2.0) < 0.05
    assert res["model_id"] == WHISPER and res["device"] == "cpu" and res["elapsed_s"] >= 0
    m = fake_whisper.instances[-1]
    assert m.device == "cpu" and m.compute_type == "int8" and m.cpu_threads >= 1
    call = m.calls[-1]
    assert call["beam_size"] == 5 and call["language"] == "en" and call["vad_filter"] is True
    assert call["word_timestamps"] is False and call["condition_on_previous_text"] is False
    assert not list(app.state["paths"].tmp.glob("asr-*.wav")), "temp selection must be removed"
    # model is cached in server.state
    transcribe_run(ctx, RunParams(path=str(wav)))
    assert len(fake_whisper.instances) == 1
    assert app.state["asr_models"].models


def test_run_cuda_takes_gpu_lock(app, ctx, fake_whisper, wav):
    _install(app)
    seen = {}
    real_acquire, real_release = app.gpu.acquire, app.gpu.release

    def acquire(c):
        seen["acquired"] = True
        real_acquire(c)

    def release():
        seen["released"] = True
        real_release()

    app.gpu.acquire, app.gpu.release = acquire, release
    res = transcribe_run(ctx, RunParams(path=str(wav), device="cuda"))
    assert res["device"] == "cuda"
    assert seen == {"acquired": True, "released": True}
    m = fake_whisper.instances[-1]
    assert m.device == "cuda" and m.compute_type == "float16"
    assert app.gpu.holder is None


def test_model_missing_message(app, ctx, fake_whisper, wav):
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path=str(wav)))
    assert ei.value.code == "MODEL_MISSING"
    assert "Settings → Engines & models" in ei.value.message and "490 MB" in ei.value.message
    app.state["settings"].patch({"offline": True})
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path=str(wav)))
    assert ei.value.code == "MODEL_MISSING" and "Offline mode" in ei.value.message and ei.value.details["hint"] == "OFFLINE_BLOCKED"


def test_bad_params(app, ctx, fake_whisper, wav):
    _install(app)
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path=str(wav), device="tpu"))
    assert ei.value.code == "INVALID_PARAMS"
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path=str(wav.with_name("missing.wav"))))
    assert ei.value.code == "NOT_FOUND"
    # PROTOCOL: paths are absolute and re-validated — relative paths, directories and pseudo-filesystems are refused
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path="relative/in.wav"))
    assert ei.value.code == "INVALID_PARAMS"
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path=str(wav.parent)))
    assert ei.value.code == "UNSUPPORTED_FILE"
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path="/proc/self/status"))
    assert ei.value.code == "PERMISSION_DENIED"
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path=str(wav), start_s=2.0, end_s=1.0))
    assert ei.value.code == "INVALID_PARAMS"
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path=str(wav), model_id="qwen3-tts-12hz-1.7b-base"))
    assert ei.value.code == "INVALID_PARAMS"


def test_empty_speech(app, ctx, fake_whisper, wav, monkeypatch):
    _install(app)

    def empty(self, audio, **kw):
        return iter(()), SimpleNamespace(language="en", language_probability=0.1, duration=3.0)

    monkeypatch.setattr(FakeWhisperModel, "transcribe", empty)
    with pytest.raises(WorkerError) as ei:
        transcribe_run(ctx, RunParams(path=str(wav)))
    assert ei.value.code == "EMPTY_AUDIO"


def test_cut_selection_direct_ffmpeg(tmp_path, wav, monkeypatch):
    """The direct-ffmpeg fallback path (audio.ffmpeg unavailable) produces 16 kHz mono float32."""
    import builtins
    from shadowfetch_worker.transcribe import whisper as w
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name.startswith("shadowfetch_worker.audio"):
            raise ImportError("simulated")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    out = w.cut_selection(wav, tmp_path / "sel.wav", 1.0, 2.0)
    info = sf.info(str(out))
    assert info.samplerate == 16000 and info.channels == 1 and info.subtype == "FLOAT"
    assert abs(info.frames / 16000 - 1.0) < 0.02


def test_missing_tokenizer_json_refused_before_load(app, ctx, fake_whisper, wav):
    """faster-whisper would fetch openai/whisper-* from the Hub (ignoring HF_HUB_OFFLINE) without tokenizer.json."""
    from shadowfetch_worker.transcribe.whisper import load_model
    mm = get_models(app)
    snap = make_hf_snapshot(mm.hf_cache, MODELS[WHISPER]["repo"], "abc123", {"model.bin": 10, "config.json": b"{}", "vocabulary.txt": b"a"})
    with pytest.raises(WorkerError) as ei:
        load_model(snap, "cpu")
    assert ei.value.code == "MODEL_INVALID" and "tokenizer.json" in ei.value.message
    assert not fake_whisper.instances
    with pytest.raises(WorkerError) as ei:          # the manager refuses it even earlier
        transcribe_run(ctx, RunParams(path=str(wav)))
    assert ei.value.code == "MODEL_INVALID"


def test_cuda_failure_during_decoding_gets_cpu_hint(app, ctx, fake_whisper, wav, monkeypatch):
    """The decoder runs while the segments generator is consumed: GPU failures there map to the same recoverable hint."""
    from shadowfetch_worker.transcribe.whisper import transcribe

    class Boom(FakeWhisperModel):
        def transcribe(self, audio, **kw):
            info = SimpleNamespace(language="en", language_probability=0.99, duration=1.0)

            def gen():
                yield SimpleNamespace(start=0.0, end=0.5, text=" hi")
                raise RuntimeError("CUDA failed to launch kernel: cublas error")

            return gen(), info

    with pytest.raises(WorkerError) as ei:
        transcribe(Boom("x"), wav, None, WHISPER, device="cuda")
    assert ei.value.code == "MODEL_LOAD_FAILED" and "CPU" in ei.value.message and ei.value.recoverable
    with pytest.raises(WorkerError) as ei:
        transcribe(Boom("x"), wav, None, WHISPER, device="cpu")
    assert ei.value.code == "INTERNAL"
