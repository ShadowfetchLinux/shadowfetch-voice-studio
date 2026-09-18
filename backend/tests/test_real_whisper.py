"""REAL faster-whisper small.en on real speech (SFVS_REAL_MODELS=1, backend/.venv).

Input: the Qwen3-TTS output produced by test_real_qwen (real synthesized speech) when present, else the espeak-ng
reference clip. Asserts that most of the spoken words come back — on CPU (int8) and on CUDA (float16).
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from tests import realharness as H

pytestmark = [pytest.mark.realmodel, H.realmodel]

MODEL = "faster-whisper-small.en"


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    srv = H.make_server(tmp_path_factory.mktemp("whisper"), offline=True)
    yield srv
    srv.pool.shutdown(wait=False, cancel_futures=True)


@pytest.fixture(scope="module")
def speech():
    """(path, expected text, source)"""
    q = H.SCRATCH / "qwen-output.wav"
    if q.exists() and (H.SCRATCH / "qwen-output.txt").exists():
        return q, (H.SCRATCH / "qwen-output.txt").read_text(), "qwen3-tts output"
    p = H.espeak_clip(H.SCRATCH / "espeak-reference.wav")
    if p is None:
        pytest.skip("no speech sample available (run test_real_qwen first or install espeak-ng)")
    return p, H.REFERENCE_TEXT, "espeak-ng"


def test_models_listed(server):
    from shadowfetch_worker.jobs.transcribe import transcribe_models
    res = transcribe_models(H.make_ctx(server), {})
    by = {m["id"]: m for m in res["models"]}
    assert by[MODEL]["installed"] is True and by[MODEL]["size_bytes"] > 400_000_000
    st = server.state["models"].state(MODEL)
    assert st["revision_installed"] and len(st["revision_installed"]) == 40
    H.record("whisper", {"model_state": st})


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_transcribe_real_speech(server, speech, device):
    from shadowfetch_worker.jobs.transcribe import RunParams, transcribe_run
    path, expected, source = speech
    t0 = time.time()
    res = transcribe_run(H.make_ctx(server, f"asr-{device}"), RunParams(path=str(path), device=device, model_id=MODEL))
    wall = time.time() - t0
    overlap = H.word_overlap(expected, res["text"])
    H.record("whisper", {device: {"text": res["text"], "expected": expected, "source": source, "word_overlap": round(overlap, 3),
                                  "elapsed_s": res["elapsed_s"], "wall_s": round(wall, 2), "language": res["language"],
                                  "language_probability": res["language_probability"], "segments": len(res["segments"]),
                                  "duration_s": res["duration_s"]}})
    assert res["device"] == device and res["model_id"] == MODEL
    assert res["language"] == "en"
    assert res["segments"] and all(s["end"] >= s["start"] for s in res["segments"])
    assert overlap >= 0.6, f"only {overlap:.0%} of the expected words were recognised: {res['text']!r}"
