"""REAL Chatterbox-Turbo (SFVS_REAL_MODELS=1): downloads the weights through ModelManager (unless installed), then
loads the engine in its own environment (backend/envs/chatterbox), prepares Conditionals and generates.

Reference voice: espeak-ng synthetic speech (> 5 s). Smoke / intelligibility test — not a fidelity test.
Set SFVS_ALLOW_DOWNLOAD=0 to skip instead of downloading ~3 GB.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
import soundfile as sf

from tests import realharness as H

pytestmark = [pytest.mark.realmodel, H.realmodel]

ENGINE = "chatterbox-turbo"
MODEL = "chatterbox-turbo"


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    srv = H.make_server(tmp_path_factory.mktemp("cb"), offline=False)
    yield srv
    srv.state["engines"].shutdown_all()
    srv.pool.shutdown(wait=False, cancel_futures=True)


@pytest.fixture(scope="module")
def clip():
    p = H.espeak_clip(H.SCRATCH / "espeak-reference.wav")
    if p is None:
        pytest.skip("espeak-ng is not installed — no authorized speech sample on this machine")
    return p


def test_env_installed(server):
    rt = server.state["runtime"]
    py = rt.python_for_engine(ENGINE)
    if py is None:
        pytest.skip("chatterbox environment not installed (scripts/bootstrap.sh --with-chatterbox)")
    probe = rt.probe_env("chatterbox", force=True)
    assert probe.get("pkg_chatterbox") is not None, probe
    assert probe.get("cuda_available") is True, probe
    H.record("chatterbox", {"env_probe": probe})


def test_download_through_manager(server):
    mm = server.state["models"]
    st = mm.state(MODEL)
    if st["state"] == "installed":
        H.record("chatterbox", {"model_state": st, "downloaded_now": False})
        return
    if os.environ.get("SFVS_ALLOW_DOWNLOAD", "1") != "1":
        pytest.skip("chatterbox-turbo not installed and SFVS_ALLOW_DOWNLOAD=0")
    ctx = H.make_ctx(server, "dl")
    t0 = time.time()
    res = mm.download(ctx, MODEL)
    wall = time.time() - t0
    assert res["revision"] == mm.spec(MODEL)["revision"]
    st = mm.state(MODEL)
    assert st["state"] == "installed" and st["size_bytes"] > 2_500_000_000
    # the ignored 1 GB s3gen.safetensors must not have been fetched
    assert not (Path(st["path"]) / "s3gen.safetensors").exists()
    prog = [p for p in server.transport.progress() if p["stage"] == "download"]
    assert prog and prog[-1]["detail"]["bytes_done"] == prog[-1]["detail"]["bytes_total"] > 2_500_000_000
    assert all(p["detail"]["bytes_done"] <= p["detail"]["bytes_total"] for p in prog if p.get("detail", {}).get("bytes_total"))
    states = [e["data"]["state"] for e in server.transport.events("model.state") if e["data"]["model_id"] == MODEL]
    assert states[0] == "downloading" and "verifying" in states and states[-1] == "installed"
    H.record("chatterbox", {"model_state": st, "downloaded_now": True, "download_wall_s": round(wall, 1), "progress_lines": len(prog),
                            "download_result": res})


def test_load_prepare_generate(server, clip):
    from shadowfetch_worker.jobs.engines import (EngineParams, GenerateParams, LoadParams, PrepareParams, engine_generate, engine_load,
                                                 engine_prepare_reference, engine_unload)
    if server.state["runtime"].python_for_engine(ENGINE) is None:
        pytest.skip("chatterbox environment not installed")
    mm = server.state["models"]
    if mm.state(MODEL)["state"] != "installed":
        pytest.skip("chatterbox-turbo weights not installed")
    t0 = time.time()
    res = engine_load(H.make_ctx(server, "load"), LoadParams(engine_id=ENGINE))
    wall = time.time() - t0
    assert res["engine_id"] == ENGINE and res["revision"] == mm.spec(MODEL)["revision"]
    assert res.get("vram_bytes") and res["vram_bytes"] > 1_000_000_000
    health = server.state["engines"].health(ENGINE)
    assert health["alive"] and health["loaded"]
    ref_id = H.seed_reference(server, clip, H.REFERENCE_TEXT, engine_id=ENGINE)
    t0 = time.time()
    prep = engine_prepare_reference(H.make_ctx(server, "prep"), PrepareParams(engine_id=ENGINE, reference_id=ref_id))
    prep_s = time.time() - t0
    assert Path(prep["path"]).exists() and Path(prep["path"]).stat().st_size > 1000
    assert prep["meta"]["ref_seconds"] > 5.0 and prep["meta"]["norm_loudness"] is True
    out_dir = server.state["paths"].tmp / "gen"
    t0 = time.time()
    gen = engine_generate(H.make_ctx(server, "gen"), GenerateParams(engine_id=ENGINE, reference_id=ref_id, text=H.GENERATE_TEXT,
                                                                   language="en", settings={"temperature": 0.8}, seed=7, out_dir=str(out_dir),
                                                                   tag="chatterbox-espeak"))
    gwall = time.time() - t0
    oi = sf.info(gen["path"])
    assert oi.samplerate == 24000 and oi.channels == 1 and oi.subtype == "PCM_24"
    assert 1.0 < gen["duration_s"] < 40.0 and gen["seed"] == 7
    keep = H.SCRATCH / "chatterbox-output.wav"
    keep.write_bytes(Path(gen["path"]).read_bytes())
    # a paralinguistic tag is accepted by the engine
    gen_tag = engine_generate(H.make_ctx(server, "gen-tag"), GenerateParams(engine_id=ENGINE, reference_id=ref_id,
                                                                           text="Well, [chuckle] that went better than expected.",
                                                                           language="en", settings={}, out_dir=str(out_dir), tag="cb-tag"))
    assert gen_tag["duration_s"] > 0.5
    # norm_loudness is a prompt-shaping control: turning it off must build a SEPARATE prompt (own cache row/file with a
    # meta sidecar recording norm_loudness=False) instead of silently reusing the normalised Conditionals
    from shadowfetch_worker.engines._common import read_prompt_meta
    prep_nl = engine_prepare_reference(H.make_ctx(server, "prep-nl"), PrepareParams(engine_id=ENGINE, reference_id=ref_id,
                                                                                    settings={"norm_loudness": False}))
    assert prep_nl["path"] != prep["path"] and prep_nl["prompt_cache_id"] != prep["prompt_cache_id"]
    assert prep_nl["meta"]["norm_loudness"] is False and read_prompt_meta(Path(prep_nl["path"]))["norm_loudness"] is False
    assert read_prompt_meta(Path(prep["path"]))["norm_loudness"] is True
    gen_nl = engine_generate(H.make_ctx(server, "gen-nl"), GenerateParams(engine_id=ENGINE, reference_id=ref_id, text=H.GENERATE_TEXT,
                                                                         language="en", settings={"norm_loudness": False}, seed=7,
                                                                         out_dir=str(out_dir), tag="cb-nonorm"))
    a, _ = sf.read(gen["path"], dtype="float32")
    b, _ = sf.read(gen_nl["path"], dtype="float32")
    assert not (a.shape == b.shape and bool((a == b).all())), "norm_loudness=False must change the prompt (same seed, different audio)"
    # english only
    from shadowfetch_worker.protocol import WorkerError
    with pytest.raises(WorkerError):
        engine_generate(H.make_ctx(server, "gen-de"), GenerateParams(engine_id=ENGINE, reference_id=ref_id, text="Guten Tag", language="de",
                                                                    settings={}, out_dir=str(out_dir)))
    engine_unload(H.make_ctx(server, "unload"), EngineParams(engine_id=ENGINE))
    assert ENGINE not in server.state["engines"].hosts
    H.record("chatterbox", {"load_ms": res.get("load_ms"), "load_wall_s": round(wall, 1), "vram_bytes": res.get("vram_bytes"),
                            "revision": res["revision"], "prepare_s": round(prep_s, 2), "prepare_meta": prep["meta"], "generate": gen,
                            "generate_wall_s": round(gwall, 2), "tag_generate": gen_tag, "health": health,
                            "no_norm_loudness": {"prepare_meta": prep_nl["meta"], "cache_path": prep_nl["path"], "generate": gen_nl},
                            "note": "reference = espeak-ng synthetic speech; smoke/intelligibility test, not a fidelity test; output Perth-watermarked by the engine"})


def test_transcribe_chatterbox_output(server):
    """Real speech check: whisper must recognise most of the words in the Chatterbox output."""
    from shadowfetch_worker.jobs.transcribe import RunParams, transcribe_run
    out = H.SCRATCH / "chatterbox-output.wav"
    if not out.exists():
        pytest.skip("no chatterbox output")
    mm = server.state["models"]
    if mm.state("faster-whisper-small.en")["state"] != "installed":
        pytest.skip("whisper model not installed")
    res = transcribe_run(H.make_ctx(server, "asr"), RunParams(path=str(out), device="cpu", model_id="faster-whisper-small.en"))
    overlap = H.word_overlap(H.GENERATE_TEXT, res["text"])
    H.record("chatterbox", {"asr_text": res["text"], "asr_word_overlap": round(overlap, 3)})
    assert overlap >= 0.6, res["text"]
