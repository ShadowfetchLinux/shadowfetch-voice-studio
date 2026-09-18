"""REAL Qwen3-TTS run through the actual engine-host process (SFVS_REAL_MODELS=1, backend/.venv).

What this proves: the pinned model loads from the HF cache (also with HF_HUB_OFFLINE=1), capabilities agree with the
runtime's supported languages, a prompt cache is built and persisted, generation produces 24 kHz audio, seeds repeat.
The reference voice is espeak-ng (synthetic speech with an exactly known transcript): intelligibility is checked by
test_real_whisper on the produced audio; voice *fidelity* is not asserted (no human recording is available here).
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest
import soundfile as sf

from tests import realharness as H

pytestmark = [pytest.mark.realmodel, H.realmodel]

ENGINE = "qwen3-tts-base"
MODEL = "qwen3-tts-12hz-1.7b-base"


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    srv = H.make_server(tmp_path_factory.mktemp("qwen"), offline=True)   # offline: must load from the cache
    yield srv
    srv.state["engines"].shutdown_all()
    srv.pool.shutdown(wait=False, cancel_futures=True)


@pytest.fixture(scope="module")
def clip():
    p = H.espeak_clip(H.SCRATCH / "espeak-reference.wav")
    if p is None:
        pytest.skip("espeak-ng is not installed — no authorized speech sample on this machine")
    return p


def test_model_installed_and_offline_download_blocked(server):
    from shadowfetch_worker.protocol import WorkerError
    mm = server.state["models"]
    st = mm.state(MODEL)
    assert st["state"] == "installed", st
    assert st["revision_installed"] == mm.spec(MODEL)["revision"]
    assert st["size_bytes"] > 4_000_000_000
    with pytest.raises(WorkerError) as ei:
        mm.download(H.make_ctx(server), MODEL)
    assert ei.value.code == "OFFLINE_BLOCKED"
    H.record("qwen", {"model_state": st})


def test_load_and_runtime_capabilities(server):
    from shadowfetch_worker.jobs.engines import engine_load, engine_capabilities, EngineParams, LoadParams
    ctx = H.make_ctx(server, "load")
    t0 = time.time()
    res = engine_load(ctx, LoadParams(engine_id=ENGINE))
    wall = time.time() - t0
    assert res["engine_id"] == ENGINE and res["model_id"] == MODEL
    assert res["revision"] == server.state["models"].spec(MODEL)["revision"]
    assert res.get("vram_bytes") and res["vram_bytes"] > 2_000_000_000, "expected the bf16 weights on the GPU"
    em = server.state["engines"]
    host = em.hosts[ENGINE]
    health = host.call("engine.health", {}, timeout=30)
    assert health["loaded"] and health["device"].startswith("cuda") and health["dtype"] == "bfloat16"
    # the host env really is offline
    assert host.proc.poll() is None
    # runtime language list vs declared capabilities
    caps = engine_capabilities(ctx, EngineParams(engine_id=ENGINE))
    declared = {l["engine_value"].lower() for l in caps["languages"]}
    runtime_langs = {str(x).lower() for x in (health.get("supported_languages") or [])}
    assert runtime_langs, "model.get_supported_languages() returned nothing"
    assert declared <= runtime_langs, f"declared languages not all supported at runtime: {declared - runtime_langs}"
    states = [e["data"]["state"] for e in server.transport.events("engine.state")]
    assert "loading" in states and states[-1] == "loaded"
    H.record("qwen", {"load_ms": res.get("load_ms"), "load_wall_s": round(wall, 1), "vram_bytes": res.get("vram_bytes"),
                      "revision": res["revision"], "runtime_languages": sorted(runtime_langs), "health": health,
                      "package_version": caps["version"]})


def test_prepare_reference_and_generate(server, clip):
    from shadowfetch_worker.jobs.engines import (GenerateParams, PrepareParams, engine_generate, engine_prepare_reference)
    ref_id = H.seed_reference(server, clip, H.REFERENCE_TEXT)
    ctx = H.make_ctx(server, "prep")
    t0 = time.time()
    prep = engine_prepare_reference(ctx, PrepareParams(engine_id=ENGINE, reference_id=ref_id))
    prep_s = time.time() - t0
    assert Path(prep["path"]).exists() and Path(prep["path"]).stat().st_size > 1000
    assert prep["model_revision"] == server.state["models"].spec(MODEL)["revision"]
    assert prep["meta"]["items"] == 1 and prep["meta"]["icl_mode"] is True
    ref_wav = Path(prep["reference_path"])
    info = sf.info(str(ref_wav))
    assert info.samplerate == 24000 and info.channels == 1, "derived reference must match caps.reference"
    # second call reuses the cache row
    prep2 = engine_prepare_reference(H.make_ctx(server, "prep2"), PrepareParams(engine_id=ENGINE, reference_id=ref_id))
    assert prep2["prompt_cache_id"] == prep["prompt_cache_id"]

    out_dir = server.state["paths"].tmp / "gen"
    t0 = time.time()
    gen = engine_generate(H.make_ctx(server, "gen"), GenerateParams(engine_id=ENGINE, reference_id=ref_id, text=H.GENERATE_TEXT,
                                                                   language="en", settings={"temperature": 0.8}, seed=1234,
                                                                   out_dir=str(out_dir), tag="qwen-espeak"))
    wall = time.time() - t0
    out = Path(gen["path"])
    assert out.exists()
    oi = sf.info(str(out))
    assert oi.samplerate == 24000 and oi.channels == 1 and oi.subtype == "PCM_24"
    assert gen["sample_rate"] == 24000 and gen["seed"] == 1234
    assert 1.0 < gen["duration_s"] < 30.0, gen
    assert abs(oi.duration - gen["duration_s"]) < 0.01
    # same seed → identical audio (same machine/env); different seed → different
    gen_b = engine_generate(H.make_ctx(server, "gen-b"), GenerateParams(engine_id=ENGINE, reference_id=ref_id, text=H.GENERATE_TEXT,
                                                                       language="en", settings={"temperature": 0.8}, seed=1234,
                                                                       out_dir=str(out_dir), tag="qwen-espeak-b"))
    a, _ = sf.read(str(out), dtype="float32")
    b, _ = sf.read(gen_b["path"], dtype="float32")
    same_seed_identical = a.shape == b.shape and bool((a == b).all())
    assert same_seed_identical, "same seed must reproduce identical audio on the same machine/environment"
    gen_c = engine_generate(H.make_ctx(server, "gen-c"), GenerateParams(engine_id=ENGINE, reference_id=ref_id, text=H.GENERATE_TEXT,
                                                                       language="en", settings={"temperature": 0.8}, seed=99,
                                                                       out_dir=str(out_dir), tag="qwen-espeak-c"))
    c, _ = sf.read(gen_c["path"], dtype="float32")
    assert not (a.shape == c.shape and bool((a == c).all())), "different seeds produced identical audio"
    # keep the output for the whisper test
    keep = H.SCRATCH / "qwen-output.wav"
    keep.parent.mkdir(parents=True, exist_ok=True)
    keep.write_bytes(out.read_bytes())
    (H.SCRATCH / "qwen-output.txt").write_text(H.GENERATE_TEXT)
    health = server.state["engines"].health(ENGINE)
    H.record("qwen", {"prepare_s": round(prep_s, 2), "prepare_meta": prep["meta"], "generate": gen, "generate_wall_s": round(wall, 2),
                      "same_seed_identical": same_seed_identical, "gen_b_elapsed_s": gen_b["elapsed_s"], "gen_c_elapsed_s": gen_c["elapsed_s"],
                      "health_after": health, "note": "reference = espeak-ng synthetic speech; smoke/intelligibility test, not a fidelity test"})


def test_unload_frees_process(server):
    from shadowfetch_worker.jobs.engines import EngineParams, engine_unload
    em = server.state["engines"]
    pid = em.hosts[ENGINE].proc.pid
    engine_unload(H.make_ctx(server, "unload"), EngineParams(engine_id=ENGINE))
    assert ENGINE not in em.hosts
    time.sleep(0.5)
    import os
    try:
        os.kill(pid, 0)
        alive = True
    except OSError:
        alive = False
    assert not alive or em.info[ENGINE]["state"] == "unloaded"
    assert server.transport.events("engine.state")[-1]["data"]["state"] == "unloaded"
