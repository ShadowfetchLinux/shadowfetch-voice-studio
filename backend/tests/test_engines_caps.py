"""Adapters' capabilities() must be importable and truthful without torch (the main worker has no torch)."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from shadowfetch_worker.engines._common import filter_settings
from shadowfetch_worker.engines.base import Capabilities
from shadowfetch_worker.engines.registry import ENGINES, load_adapter_class


@pytest.mark.parametrize("engine_id", list(ENGINES))
def test_capabilities_validate(engine_id):
    cls = load_adapter_class(engine_id)
    adapter = cls()
    caps = adapter.capabilities()
    assert isinstance(caps, Capabilities)
    assert caps.id == engine_id
    assert caps.model_id == ENGINES[engine_id]["model_id"]
    assert caps.output_sample_rate == 24000
    assert caps.max_chars_per_request > 0
    assert caps.supports_seed and caps.supports_reusable_prompt and caps.supports_cancel
    assert caps.cancel_granularity == "segment"
    # round-trip through JSON (what the UI receives)
    dumped = caps.model_dump()
    assert Capabilities.model_validate(dumped) == caps
    ids = [c.id for c in caps.controls]
    assert len(ids) == len(set(ids))
    for c in caps.controls:
        if c.type in ("float", "int"):
            assert c.min is not None and c.max is not None and c.min <= c.default <= c.max, c.id
        if c.type == "bool":
            assert isinstance(c.default, bool)
    assert not adapter.loaded()


def test_capabilities_import_without_torch():
    """A fresh interpreter must import both adapters and build capabilities without importing torch."""
    code = (
        "import sys\n"
        "from shadowfetch_worker.engines.registry import ENGINES, load_adapter_class\n"
        "for eid in ENGINES:\n"
        "    load_adapter_class(eid)().capabilities().model_dump_json()\n"
        "bad = [m for m in ('torch', 'qwen_tts', 'chatterbox', 'transformers', 'faster_whisper') if m in sys.modules]\n"
        "print('BAD=' + ','.join(bad))\n"
    )
    backend = str(Path(__file__).resolve().parent.parent)
    env = {**os.environ, "PYTHONPATH": backend + os.pathsep + os.environ.get("PYTHONPATH", "")}
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60, env=env)
    assert r.returncode == 0, r.stderr
    assert "BAD=\n" in r.stdout or r.stdout.strip().endswith("BAD="), r.stdout


def test_qwen_caps_facts():
    caps = load_adapter_class("qwen3-tts-base")().capabilities()
    codes = {l.code: l.engine_value for l in caps.languages}
    assert codes == {"en": "English", "zh": "Chinese", "de": "German", "it": "Italian", "pt": "Portuguese", "es": "Spanish",
                     "ja": "Japanese", "ko": "Korean", "fr": "French", "ru": "Russian", "auto": "Auto"}
    assert caps.reference.needs_transcript is True
    assert caps.reference.min_seconds == 3 and caps.reference.max_seconds == 30
    assert tuple(caps.reference.recommended_seconds) == (8, 15)
    assert caps.reference.sample_rate == 24000 and caps.reference.channels == 1
    assert "echo" in caps.reference.notes.lower() and "transcript" in caps.reference.notes.lower()
    by = {c.id: c for c in caps.controls}
    assert set(by) == {"temperature", "repetition_penalty", "top_p", "top_k", "subtalker_temperature", "max_new_tokens", "x_vector_only_mode"}
    assert by["temperature"].default == 0.9 and by["temperature"].min == 0.1 and by["temperature"].max == 1.5
    assert by["repetition_penalty"].default == 1.05
    assert by["top_p"].advanced and by["top_k"].advanced and by["max_new_tokens"].advanced and by["x_vector_only_mode"].advanced
    assert by["max_new_tokens"].type == "int" and by["max_new_tokens"].default == 2048 and by["max_new_tokens"].max == 8192
    assert "12.5" in by["max_new_tokens"].description
    assert by["x_vector_only_mode"].type == "bool" and by["x_vector_only_mode"].default is False
    assert caps.tags == []
    assert caps.max_chars_per_request == 400
    assert caps.watermark is None
    assert caps.license == "Apache-2.0"
    assert caps.version in ("not installed",) or caps.version[0].isdigit()
    assert "manual_seed" in caps.notes


def test_chatterbox_caps_facts():
    caps = load_adapter_class("chatterbox-turbo")().capabilities()
    assert [l.code for l in caps.languages] == ["en"]
    assert caps.reference.needs_transcript is False
    assert caps.reference.min_seconds == 5.0 and caps.reference.max_seconds == 15
    assert tuple(caps.reference.recommended_seconds) == (8, 12)
    assert "-27" in caps.reference.notes or "−27" in caps.reference.notes
    by = {c.id: c for c in caps.controls}
    assert set(by) == {"temperature", "top_p", "top_k", "repetition_penalty", "norm_loudness"}
    assert by["temperature"].default == 0.8 and by["temperature"].min == 0.05 and by["temperature"].max == 2.0
    assert by["top_p"].default == 0.95 and by["top_k"].default == 1000 and by["top_k"].type == "int"
    assert by["repetition_penalty"].default == 1.2 and by["repetition_penalty"].max == 2.0
    assert by["norm_loudness"].type == "bool" and by["norm_loudness"].default is True
    # exaggeration / cfg_weight / min_p are ignored by Turbo and must not be exposed
    assert not {"exaggeration", "cfg_weight", "min_p"} & set(by)
    tokens = [t.token for t in caps.tags]
    assert tokens == ["[clear throat]", "[sigh]", "[shush]", "[cough]", "[groan]", "[sniff]", "[gasp]", "[chuckle]", "[laugh]"]
    assert all(t.label for t in caps.tags)
    assert caps.max_chars_per_request == 300
    assert caps.watermark == "perth" and "perth" in caps.notes.lower()
    assert caps.license == "MIT"


def test_filter_settings_restricts_and_clamps():
    from shadowfetch_worker.engines.qwen3_tts import CONTROLS
    out = filter_settings({"temperature": 9.0, "top_k": "7", "x_vector_only_mode": "true", "bogus": 1, "max_new_tokens": 10}, CONTROLS)
    assert out == {"temperature": 1.5, "top_k": 7, "x_vector_only_mode": True, "max_new_tokens": 256}
    assert filter_settings(None, CONTROLS) == {}
    assert filter_settings({"temperature": None}, CONTROLS) == {}


def test_language_mapping():
    from shadowfetch_worker.engines.qwen3_tts import _language_value
    from shadowfetch_worker.protocol import WorkerError
    assert _language_value("en") == "English" and _language_value("English") == "English" and _language_value("ENGLISH") == "English"
    assert _language_value("auto") == "Auto" and _language_value(None) == "Auto"
    with pytest.raises(WorkerError):
        _language_value("klingon")


def test_qwen_custom_voice_caps_prepare_and_generate(tmp_path):
    """Fine-tuned CustomVoice: capabilities and generate_custom_voice without loading torch/qwen_tts."""
    import numpy as np
    import soundfile as sf
    from shadowfetch_worker.engines.qwen3_tts import Qwen3TTSAdapter

    ad = Qwen3TTSAdapter()
    ad.tts_model_type = "custom_voice"
    ad.speakers = ["myvoice"]
    caps = ad.capabilities()
    by = {c.id: c for c in caps.controls}
    assert caps.reference.needs_transcript is False and "speaker" in by
    assert "x_vector_only_mode" not in by and by["speaker"].default == "myvoice"
    assert caps.prompt_controls == []

    cache = tmp_path / "prompt.pt"
    meta = ad.prepare_reference(tmp_path / "unused.wav", "ignored", "en", cache)
    assert cache.read_bytes() == b"qwen3-custom-voice"
    assert meta["meta"]["mode"] == "custom_voice" and meta["meta"]["speakers"] == ["myvoice"]

    class FakeModel:
        def generate_custom_voice(self, **kw):
            assert kw["text"] == "Hello there." and kw["speaker"] == "myvoice" and kw["language"] == "English"
            return [np.sin(np.linspace(0, 20, 4800)).astype(np.float32)], 24000

    ad.model = FakeModel()
    out = tmp_path / "out.wav"
    res = ad.generate("Hello there.", "en", None, "", out, {"speaker": "myvoice", "temperature": 0.7})
    assert Path(res.path).exists() and res.duration_s == pytest.approx(0.2, abs=1e-3)
    assert sf.info(res.path).subtype == "PCM_24"
    ad.unload()
    assert ad.tts_model_type == "base" and ad.speakers == [] and ad.model is None


def test_write_wav_24_and_empty(tmp_path):
    import numpy as np
    import soundfile as sf
    from shadowfetch_worker.engines._common import write_wav_24
    from shadowfetch_worker.protocol import WorkerError
    out = tmp_path / "a.wav"
    dur = write_wav_24(out, np.sin(np.linspace(0, 100, 24000)).astype(np.float32), 24000)
    assert abs(dur - 1.0) < 1e-6
    info = sf.info(str(out))
    assert info.subtype == "PCM_24" and info.samplerate == 24000 and info.channels == 1
    with pytest.raises(WorkerError) as ei:
        write_wav_24(tmp_path / "b.wav", np.zeros(0, dtype=np.float32), 24000)
    assert ei.value.code == "EMPTY_AUDIO"


def test_engine_list_and_capabilities_methods(app, ctx, monkeypatch):
    """engine.list / engine.capabilities with a stub EngineManager (no engine hosts)."""
    from shadowfetch_worker.jobs.engines import EngineParams, engine_capabilities, engine_list
    from shadowfetch_worker.runtime import Runtime

    class StubEM:
        info = {eid: {"state": "unloaded", "model_id": None, "revision": None, "vram_bytes": None, "message": ""} for eid in ENGINES}

        def descriptors(self):
            return [{**d, "installed": True, "env_probe": {}, **self.info[eid]} for eid, d in ENGINES.items()]

        def capabilities(self, eid):
            return load_adapter_class(eid)().capabilities()

    app.state["engines"] = StubEM()
    app.state["runtime"] = Runtime(app.state["paths"])
    res = engine_list(ctx, {})
    by = {e["id"]: e for e in res["engines"]}
    assert set(by) == set(ENGINES)
    assert by["qwen3-tts-base"]["model_id"] == "qwen3-tts-12hz-1.7b-base" and by["qwen3-tts-base"]["model_state"] == "missing"
    assert by["chatterbox-turbo"]["capabilities"]["watermark"] == "perth"
    assert app.state["models"] is not None, "engine.list must initialise the model manager"
    caps = engine_capabilities(ctx, EngineParams(engine_id="qwen3-tts-base"))
    assert caps["id"] == "qwen3-tts-base"
    from shadowfetch_worker.protocol import WorkerError
    with pytest.raises(WorkerError) as ei:
        engine_capabilities(ctx, EngineParams(engine_id="nope"))
    assert ei.value.code == "ENGINE_UNAVAILABLE"


def test_capabilities_device_is_intended_not_adapter_default(monkeypatch):
    """Adapters are never loaded in the main worker: `device` must be the intended device, not the adapter's 'cpu' init value."""
    from shadowfetch_worker.engines import _common
    monkeypatch.setenv("SFVS_FORCE_CPU", "1")
    assert _common.intended_device() == "cpu"
    monkeypatch.delenv("SFVS_FORCE_CPU")
    for eid in ENGINES:
        caps = load_adapter_class(eid)().capabilities()
        assert caps.device == _common.intended_device()
        assert caps.prompt_controls and set(caps.prompt_controls) <= {c.id for c in caps.controls}


def test_generation_defaults_are_applied():
    """Omitted controls get the declared default (Qwen's wrapper would otherwise use generation_config's 8192)."""
    from shadowfetch_worker.engines._common import apply_control_defaults
    from shadowfetch_worker.engines.qwen3_tts import CONTROLS, GEN_KWARG_IDS
    cfg = apply_control_defaults(filter_settings({"temperature": 0.7}, CONTROLS), CONTROLS)
    assert cfg["max_new_tokens"] == 2048 and cfg["temperature"] == 0.7 and cfg["x_vector_only_mode"] is False
    assert {k for k in GEN_KWARG_IDS} <= set(cfg)


def test_prompt_identity_and_settings():
    from shadowfetch_worker.engines._common import prompt_settings
    from shadowfetch_worker.jobs.engines import prompt_identity
    cb = load_adapter_class("chatterbox-turbo")().capabilities()
    ps, suffix = prompt_identity(cb, {"temperature": 1.3})           # non-prompt controls do not change the identity
    assert ps == {"norm_loudness": True} and suffix == ""
    ps, suffix = prompt_identity(cb, {"norm_loudness": False})
    assert ps == {"norm_loudness": False} and len(suffix) == 10
    assert prompt_identity(cb, {"norm_loudness": "false"})[1] == suffix   # coerced like every control
    qw = load_adapter_class("qwen3-tts-base")().capabilities()
    assert prompt_identity(qw, None) == ({"x_vector_only_mode": False}, "")
    assert prompt_identity(qw, {"x_vector_only_mode": True})[0] == {"x_vector_only_mode": True}
    assert prompt_settings({"norm_loudness": 0, "junk": 1}, cb.controls, cb.prompt_controls) == {"norm_loudness": False}


def test_chatterbox_prompt_cache_mismatch_falls_back_to_reference(tmp_path):
    """norm_loudness is applied by prepare_conditionals only; a cache built with a different value must not be reused."""
    from shadowfetch_worker.engines._common import read_prompt_meta, write_prompt_meta
    from shadowfetch_worker.engines.chatterbox_turbo import ChatterboxTurboAdapter
    cache = tmp_path / "p.pt"
    cache.write_bytes(b"conds")
    assert ChatterboxTurboAdapter._cache_matches(cache, True) == (True, "")        # legacy cache without sidecar → default
    assert ChatterboxTurboAdapter._cache_matches(cache, False)[0] is False
    write_prompt_meta(cache, {"norm_loudness": False, "engine_id": "chatterbox-turbo"})
    assert read_prompt_meta(cache)["norm_loudness"] is False
    assert ChatterboxTurboAdapter._cache_matches(cache, False) == (True, "")
    ok, why = ChatterboxTurboAdapter._cache_matches(cache, True)
    assert not ok and "norm_loudness" in why
    # no cache + no reference → INVALID_PARAMS, never a crash
    from shadowfetch_worker.protocol import WorkerError
    with pytest.raises(WorkerError) as ei:
        ChatterboxTurboAdapter()._reference_for_fallback(None, "no prompt cache was given")
    assert ei.value.code == "INVALID_PARAMS"


class _FakeServer:
    def __init__(self, app):
        self.state = app.state
        self.transport = app.transport
        self.gpu = SimpleNamespace(holder=None)


def _manager_with_fake_host(app, alive: bool):
    from shadowfetch_worker.engines.manager import EngineManager

    class FakeHost:
        killed = 0

        def alive(self):
            return alive

        def kill(self):
            FakeHost.killed += 1

    em = EngineManager.__new__(EngineManager)          # no idle thread
    em.server = _FakeServer(app)
    em.st = app.state
    em.hosts = {"qwen3-tts-base": FakeHost()}
    em.info = {eid: {"state": "loaded" if eid == "qwen3-tts-base" else "unloaded", "model_id": "m", "revision": "r", "last_used": 0.0,
                     "vram_bytes": 1, "device": "cuda", "message": ""} for eid in ENGINES}
    import threading
    em._lock = threading.RLock()
    em._caps = {}
    return em, FakeHost


def test_hard_cancel_unloads_engine_and_emits_event(app):
    """A hard cancel kills the host: the manager must not keep it as 'loaded' until the idle loop notices."""
    from shadowfetch_worker.protocol import CancelledError, WorkerError
    em, FakeHost = _manager_with_fake_host(app, alive=False)
    em._after_call_error("qwen3-tts-base", em.hosts["qwen3-tts-base"], CancelledError({"hard_cancel": True}))
    assert "qwen3-tts-base" not in em.hosts and em.info["qwen3-tts-base"]["state"] == "unloaded" and FakeHost.killed == 1
    ev = app.transport.events("engine.state")[-1]["data"]
    assert ev["engine_id"] == "qwen3-tts-base" and ev["state"] == "unloaded" and ev["message"] == "cancelled"
    # a soft cancel (host still alive) keeps the engine loaded
    em, FakeHost = _manager_with_fake_host(app, alive=True)
    em._after_call_error("qwen3-tts-base", em.hosts["qwen3-tts-base"], CancelledError({}))
    assert em.info["qwen3-tts-base"]["state"] == "loaded" and FakeHost.killed == 0
    # OOM keeps it loaded but records the message; a dead host after any error is unloaded
    em._after_call_error("qwen3-tts-base", em.hosts["qwen3-tts-base"], WorkerError("GPU_OOM", "oom"))
    assert em.info["qwen3-tts-base"]["state"] == "loaded" and em.info["qwen3-tts-base"]["message"] == "GPU out of memory"
    em, FakeHost = _manager_with_fake_host(app, alive=False)
    em._after_call_error("qwen3-tts-base", em.hosts["qwen3-tts-base"], WorkerError("INTERNAL", "x"))
    assert em.info["qwen3-tts-base"]["state"] == "unloaded"


def test_host_call_detects_death_before_registration(tmp_path):
    """The host exits right after alive(): call() must fail with ENGINE_CRASHED instead of spinning until the timeout."""
    import threading
    import time
    from shadowfetch_worker.engines.manager import EngineHost
    from shadowfetch_worker.protocol import WorkerError

    class P:
        def __init__(self):
            self.stdin = SimpleNamespace(write=lambda s: None, flush=lambda: None)
            self._rc = None

        def poll(self):
            return self._rc

    h = EngineHost.__new__(EngineHost)
    h.engine_id = "qwen3-tts-base"
    h.proc = P()
    h._pending = {}
    h._lock = threading.Lock()
    h.dead = threading.Event()
    h.exit_error = None
    threading.Timer(0.3, lambda: (setattr(h.proc, "_rc", 1), setattr(h, "exit_error", "engine host exited with code 1"),
                                  h._pending.clear(), h.dead.set())).start()
    t0 = time.time()
    with pytest.raises(WorkerError) as ei:
        h.call("engine.generate", {}, ctx=None, timeout=30)
    assert ei.value.code == "ENGINE_CRASHED" and time.time() - t0 < 5
