"""Real models, real worker process: the simple workflow exactly as the Speak screen and Clone Voice drive it.

Clone:  audio.import → audio.suggest_reference → transcribe.run (that range) → voices.create
Speak:  speak.session → tts.plan → tts.generate(only_changed) → tts.assemble → speak.remember → export.render
Then: re-speak unchanged text (takes reused, no GPU work), edit one sentence (only it regenerates), restart the worker
(text, voice and Recent survive), offline mode with installed models.

Runs only with SFVS_REAL_MODELS=1. Reference speech comes from espeak-ng (intelligible, known words) — this proves the
pipeline, not voice fidelity.
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest
import soundfile as sf

from tests.realharness import espeak_clip, models_dir, realmodel, record, word_overlap
from tests.test_real_e2e import WorkerClient

LONG_REFERENCE = ("The quick brown fox jumps over the lazy dog near the river bank. "
                  "Please remember to water the garden before the sun goes down this evening. "
                  "A gentle breeze carried the smell of rain across the quiet little town. "
                  "Everyone agreed that the old library was the best place to read on a cold afternoon.")
SPEAK_TEXT = "Welcome to Shadowfetch. This is my cloned voice speaking from my own computer."


@realmodel
@pytest.mark.timeout(1800)
def test_clone_then_speak_through_the_worker(tmp_path: Path):
    clip = espeak_clip(tmp_path / "long.wav", LONG_REFERENCE, wpm=145)
    if clip is None:
        pytest.skip("espeak-ng not available")
    data, config, cache = tmp_path / "data", tmp_path / "config", tmp_path / "cache"
    for d in (data, config, cache):
        d.mkdir()
    rep: dict = {}
    w = WorkerClient(data, config, cache, models_dir())
    try:
        w.call("system.settings.set", {"patch": {"idle_unload_minutes": 0}})
        # ---- Clone Voice (Use Audio File), fully automatic
        imp = w.call("audio.import", {"path": str(clip), "kind": "reference"})
        assert Path(imp["original_path"]).read_bytes() == clip.read_bytes()      # original kept untouched
        sug = w.call("audio.suggest_reference", {"asset_id": imp["asset_id"], "engine_id": "qwen3-tts-base"})
        rep["suggest"] = {k: sug[k] for k in ("start_s", "end_s", "duration_s", "reliable", "speech_ratio", "snr_db", "issues")}
        assert sug["reliable"], sug
        assert 3.0 < sug["duration_s"] <= 30.0 and not [i for i in sug["issues"] if i["severity"] == "block"]
        tr = w.call("transcribe.run", {"path": imp["working_path"], "start_s": sug["start_s"], "end_s": sug["end_s"]})
        rep["asr_text"], rep["asr_confidence"] = tr["text"], tr.get("confidence")
        # the automatic range starts and ends between words, so its transcript is a run of whole words of the passage
        assert word_overlap(tr["text"], LONG_REFERENCE) >= 0.8, tr["text"]
        voice = w.call("voices.create", {"name": "Speak test", "tags": [], "language": "en", "rights_confirmed": True,
                                         "asset_id": imp["asset_id"], "trim": {"start_s": sug["start_s"], "end_s": sug["end_s"]},
                                         "transcript": tr["text"], "transcript_source": "asr", "transcript_confirmed": False,
                                         "asr_model": tr["model_id"], "engine_id": "qwen3-tts-base"})
        ref_id = voice["selected_reference_id"]
        assert voice["references"][0]["derived"].get("qwen3-tts-base"), "derived engine reference was prepared at create time"

        # ---- Speak
        sess = w.call("speak.session", {})
        pid = sess["project_id"]
        assert w.call("projects.list", {})["projects"] == []                  # the scratch project is hidden
        w.call("projects.update", {"id": pid, "patch": {"voice_id": voice["id"]}})
        caps = w.call("engine.capabilities", {"engine_id": "qwen3-tts-base"})
        controls = {c["id"]: c["default"] for c in caps["controls"]}

        def speak(text: str, **mode) -> tuple[dict, dict, float]:
            t0 = time.time()
            w.call("tts.plan", {"project_id": pid, "script_text": text, "engine_id": "qwen3-tts-base"})
            gen = w.call("tts.generate", {"project_id": pid, "engine_id": "qwen3-tts-base", "reference_id": ref_id, "language": "en",
                                          "settings": controls, **(mode or {"only_changed": True})})
            w.call("tts.assemble", {"project_id": pid})
            entry = w.call("speak.remember", {"project_id": pid, "text": text, "voice_id": voice["id"]})
            return gen, entry, time.time() - t0

        gen1, e1, t1 = speak(SPEAK_TEXT)
        rep["first_speak_s"] = round(t1, 1)
        assert len(gen1["takes"]) >= 1 and Path(e1["path"]).is_file() and e1["voice_name"] == "Speak test"
        info = sf.info(e1["path"])
        assert info.samplerate == 24000 and info.duration > 2.0
        back = w.call("transcribe.run", {"path": e1["path"]})
        rep["speak_readback"] = back["text"]
        rep["speak_overlap"] = word_overlap(SPEAK_TEXT, back["text"])
        assert rep["speak_overlap"] >= 0.6, back["text"]

        # unchanged text + voice: every take is reused, nothing is generated
        gen2, e2, t2 = speak(SPEAK_TEXT)
        rep["respeak_unchanged_s"] = round(t2, 1)
        assert gen2["takes"] == [] and gen2["model_revision"] is None and Path(e2["path"]) != Path(e1["path"])
        # "say it again": a fresh reading of everything
        gen3, _e3, _ = speak(SPEAK_TEXT, regenerate_all=True)
        assert len(gen3["takes"]) == len(gen1["takes"])

        # edit one paragraph of a two-paragraph text: only that part is generated again
        two = SPEAK_TEXT + "\n\nThe second paragraph is short."
        speak(two)
        gen4, e4, _ = speak(SPEAK_TEXT + "\n\nThe second paragraph changed.")
        assert [t["segment_index"] for t in gen4["takes"]] == [1], gen4
        history = w.call("speak.history", {})["history"]
        assert [h["id"] for h in history][:1] == [e4["id"]] and all(Path(h["path"]).is_file() for h in history)
        assert Path(e1["path"]).is_file()                                       # older results kept their own files

        # Save Audio: the Recent file, 24-bit WAV, never the master
        out = w.call("export.render", {"project_id": pid, "master_path": e1["path"], "format": "wav", "out_path": str(tmp_path / "saved.wav"),
                                       "wav_bit_depth": 24, "ai_metadata": True})
        assert Path(out["path"]).is_file() and out["probe"]["duration_s"] > 2.0
    finally:
        w.shutdown()

    # ---- restart: the text, the voice and Recent come back
    w2 = WorkerClient(data, config, cache, models_dir())
    try:
        s2 = w2.call("speak.session", {})
        assert s2["project_id"] == pid and s2["voice_id"] == voice["id"]
        assert s2["text"] == SPEAK_TEXT + "\n\nThe second paragraph changed."
        assert s2["history"][0]["id"] == e4["id"]
        # offline mode with installed models: Speak still works, downloads are refused
        w2.call("system.set_offline", {"offline": True})
        with pytest.raises(Exception) as ei:
            w2.call("models.download", {"model_id": "faster-whisper-base.en"})
        assert "OFFLINE_BLOCKED" in str(ei.value)
        w2.call("tts.plan", {"project_id": pid, "script_text": "Offline and still speaking.", "engine_id": "qwen3-tts-base"})
        gen = w2.call("tts.generate", {"project_id": pid, "engine_id": "qwen3-tts-base", "reference_id": ref_id, "language": "en",
                                       "settings": controls, "only_changed": True})
        assert len(gen["takes"]) == 1
        w2.call("system.set_offline", {"offline": False})
    finally:
        w2.shutdown()
    record("speak", rep)
