"""Speak screen backend: scratch project, voice-aware take reuse, Recent history, reference suggestion, migration 0002."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pytest
import shadowfetch_worker.jobs.audio
import shadowfetch_worker.jobs.speak  # noqa: F401
import soundfile as sf
from shadowfetch_worker.audio.analysis import suggest_reference_range
from shadowfetch_worker.protocol import INVALID_PARAMS, NOT_FOUND, WorkerError
from shadowfetch_worker.store.db import MIGRATIONS_DIR, Database
from shadowfetch_worker.transcribe.whisper import transcript_confidence

try:
    from tests.test_store import (
        FakeEngineManager,
        call,
        fake_caps,
        install_fake_audio,
        make_server,
        make_voice,
        seed_asset,
    )
except ImportError:  # pragma: no cover
    from test_store import (
        FakeEngineManager,
        call,
        fake_caps,
        install_fake_audio,
        make_server,
        make_voice,
        seed_asset,
    )

SR = 16000
TEXT = "Hello there. This is the second sentence.\n\nA new paragraph."


@pytest.fixture
def server(tmp_path, monkeypatch):
    install_fake_audio(monkeypatch)
    return make_server(tmp_path)


def speak(server, text: str, voice: dict, *, settings: dict | None = None, language: str = "en") -> dict:
    """What the Speak button does: plan → generate(only_changed) → assemble → remember."""
    sess = call(server, "speak.session", {})
    pid = sess["project_id"]
    call(server, "tts.plan", {"project_id": pid, "script_text": text, "engine_id": "fake-engine", "options": {"max_chars": 30}})
    gen = call(server, "tts.generate", {"project_id": pid, "engine_id": "fake-engine", "reference_id": voice["selected_reference_id"],
                                        "language": language, "settings": settings or {"temperature": 0.9}, "only_changed": True})
    asm = call(server, "tts.assemble", {"project_id": pid})
    mem = call(server, "speak.remember", {"project_id": pid, "text": text, "voice_id": voice["id"]})
    return {"project_id": pid, "gen": gen, "asm": asm, "entry": mem}


# ---------------------------------------------------------------- scratch project
def test_session_creates_hidden_scratch_project_once(server):
    s1 = call(server, "speak.session", {})
    s2 = call(server, "speak.session", {})
    assert s1["project_id"] == s2["project_id"] and s1["text"] == "" and s1["history"] == [] and s1["voice_id"] is None
    assert server.state["settings"].value.speak_project_id == s1["project_id"]
    other = call(server, "projects.create", {"name": "Audiobook"})
    listed = [p["id"] for p in call(server, "projects.list", {})["projects"]]
    assert listed == [other["id"]]
    assert s1["project_id"] in [p["id"] for p in call(server, "projects.list", {"include_speak": True})["projects"]]
    assert [p["id"] for p in call(server, "library.search", {"query": ""})["projects"]] == [other["id"]]
    assert sum(f["count"] for f in call(server, "library.folders", {})["folders"]) == 1


def test_session_restores_text_and_voice_and_survives_deletion(server):
    v = make_voice(server, "Bob")
    pid = call(server, "speak.session", {})["project_id"]
    call(server, "projects.save_script", {"id": pid, "text": "Remember me."})
    call(server, "projects.update", {"id": pid, "patch": {"voice_id": v["id"]}})
    s = call(server, "speak.session", {})
    assert s["text"] == "Remember me." and s["voice_id"] == v["id"]
    # an archived voice is not offered back
    call(server, "voices.update", {"id": v["id"], "patch": {"archived": True}})
    assert call(server, "speak.session", {})["voice_id"] is None
    # the scratch project is recreated if it disappears
    call(server, "projects.delete", {"id": pid, "confirm": True})
    s2 = call(server, "speak.session", {})
    assert s2["project_id"] != pid and s2["text"] == ""


def test_voice_delete_is_not_blocked_by_the_scratch_project(server):
    v = make_voice(server, "Bob")
    pid = call(server, "speak.session", {})["project_id"]
    call(server, "projects.update", {"id": pid, "patch": {"voice_id": v["id"]}})
    r = call(server, "voices.delete", {"id": v["id"]})
    assert r["ok"] and r["unlinked_projects"] == []
    assert call(server, "speak.session", {})["voice_id"] is None


# ---------------------------------------------------------------- voice-aware reuse
def test_only_changed_reuses_matching_takes_and_regenerates_the_rest(server):
    eng: FakeEngineManager = server.state["engines"]
    bob, sara = make_voice(server, "Bob"), make_voice(server, "Sara")
    r1 = speak(server, TEXT, bob)
    assert len(r1["gen"]["takes"]) == 3 and r1["gen"]["skipped"] == []
    # same text, same voice: nothing to generate, and the engine is not even touched
    calls = len(eng.calls)
    r2 = speak(server, TEXT, bob)
    assert r2["gen"]["takes"] == [] and sorted(r2["gen"]["skipped"]) == [0, 1, 2] and len(eng.calls) == calls
    # one sentence edited: only that one
    r3 = speak(server, TEXT.replace("second sentence", "2nd line"), bob)
    assert [t["segment_index"] for t in r3["gen"]["takes"]] == [1]
    # another voice: everything, even unchanged text (the stale-voice bug the default mode has)
    r4 = speak(server, TEXT.replace("second sentence", "2nd line"), sara)
    assert len(r4["gen"]["takes"]) == 3
    assert all(c["reference_path"].find(sara["selected_reference_id"]) >= 0 for c in eng.calls[-3:])
    # different controls: everything
    r5 = speak(server, TEXT.replace("second sentence", "2nd line"), sara, settings={"temperature": 0.5})
    assert len(r5["gen"]["takes"]) == 3


def test_only_changed_notices_an_edited_voice_sample_and_legacy_takes(server):
    bob = make_voice(server, "Bob")
    r1 = speak(server, TEXT, bob)
    db = server.state["db"]
    # re-trimming the voice sample changes the reference fingerprint → stale
    call(server, "voices.update_reference", {"reference_id": bob["selected_reference_id"], "patch": {"trim": {"start_s": 0.4, "end_s": 3.4}}})
    r2 = speak(server, TEXT, bob)
    assert len(r2["gen"]["takes"]) == 3
    # takes written before migration 0002 have no fingerprint → never reused
    with db.tx() as c:
        c.execute("UPDATE takes SET reference_fingerprint = NULL WHERE project_id = ?", (r1["project_id"],))
    r3 = speak(server, TEXT, bob)
    assert len(r3["gen"]["takes"]) == 3
    t = db.one("SELECT * FROM takes WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", (r1["project_id"],))
    ref = db.require("voice_references", bob["selected_reference_id"])
    assert t["reference_fingerprint"] == ref["fingerprint"] and t["language"] == "en"


def test_default_generate_mode_is_unchanged(server):
    """Regression guard for the Create page: without only_changed, any selected take is kept (voice not compared)."""
    bob, sara = make_voice(server, "Bob"), make_voice(server, "Sara")
    speak(server, TEXT, bob)
    pid = call(server, "speak.session", {})["project_id"]
    gen = call(server, "tts.generate", {"project_id": pid, "engine_id": "fake-engine", "reference_id": sara["selected_reference_id"]})
    assert gen["takes"] == [] and sorted(gen["skipped"]) == [0, 1, 2]


# ---------------------------------------------------------------- history
def test_remember_snapshots_master_and_prunes(server):
    bob = make_voice(server, "Bob")
    r1 = speak(server, "First version.", bob)
    e1 = r1["entry"]
    assert e1["exists"] and e1["voice_name"] == "Bob" and e1["text"] == "First version." and e1["duration_s"] > 0
    first_bytes = Path(e1["path"]).read_bytes()
    r2 = speak(server, "Second version is longer.", bob)
    # the next assemble replaced master.wav but not the history file
    assert Path(e1["path"]).read_bytes() == first_bytes and Path(r2["entry"]["path"]) != Path(e1["path"])
    hist = call(server, "speak.history", {})["history"]
    assert [h["id"] for h in hist] == [r2["entry"]["id"], e1["id"]]
    # superseded takes are gone (rows + files); the current selection stays
    db = server.state["db"]
    takes = db.all("SELECT * FROM takes WHERE project_id = ?", (r1["project_id"],))
    segs = db.all("SELECT * FROM segments WHERE project_id = ?", (r1["project_id"],))
    assert len(takes) == 1 and len(segs) == 1 and segs[0]["selected_take_id"] == takes[0]["id"] and Path(takes[0]["path"]).exists()
    seg_dirs = list((Path(r1["asm"]["master_path"]).parent / "segments").iterdir())
    assert [d.name for d in seg_dirs] == [segs[0]["id"]]
    assert r2["entry"]["pruned"]["takes_removed"] == 1


def test_history_is_bounded_and_forget_deletes_the_file(server):
    bob = make_voice(server, "Bob")
    pid = call(server, "speak.session", {})["project_id"]
    paths = []
    for i in range(4):
        text = f"Take number {i}."
        call(server, "tts.plan", {"project_id": pid, "script_text": text, "engine_id": "fake-engine"})
        call(server, "tts.generate", {"project_id": pid, "engine_id": "fake-engine", "reference_id": bob["selected_reference_id"],
                                      "only_changed": True, "settings": {}})
        call(server, "tts.assemble", {"project_id": pid})
        paths.append(call(server, "speak.remember", {"project_id": pid, "text": text, "keep": 3})["path"])
    hist = call(server, "speak.history", {})["history"]
    assert len(hist) == 3 and not Path(paths[0]).exists() and all(Path(p).exists() for p in paths[1:])
    call(server, "speak.forget", {"id": hist[0]["id"]})
    assert not Path(hist[0]["path"]).exists() and len(call(server, "speak.history", {})["history"]) == 2
    with pytest.raises(WorkerError) as ei:
        call(server, "speak.forget", {"id": hist[0]["id"]})
    assert ei.value.code == NOT_FOUND


def test_remember_guards(server):
    other = call(server, "projects.create", {"name": "Book"})
    with pytest.raises(WorkerError) as ei:
        call(server, "speak.remember", {"project_id": other["id"], "text": "x"})
    assert ei.value.code == INVALID_PARAMS
    pid = call(server, "speak.session", {})["project_id"]
    with pytest.raises(WorkerError) as ei:
        call(server, "speak.remember", {"project_id": pid, "text": "nothing assembled"})
    assert ei.value.code == NOT_FOUND


def test_save_audio_renders_a_history_entry(server):
    """Save Audio exports the Recent file (not master.wav), so a later Speak cannot change what gets saved."""
    bob = make_voice(server, "Bob")
    r = speak(server, "Save me.", bob)
    out = Path(server.state["paths"].exports) / "saved.wav"
    import shadowfetch_worker.jobs.export  # noqa: F401
    try:
        res = call(server, "export.render", {"project_id": r["project_id"], "master_path": r["entry"]["path"], "format": "wav",
                                             "out_path": str(out)})
    except WorkerError as e:   # ffmpeg missing on this machine
        pytest.skip(f"export needs ffmpeg: {e.message}")
    assert Path(res["path"]).exists() and res["master_path"] == r["entry"]["path"]


# ---------------------------------------------------------------- reference suggestion
def phrases(durations, pause=0.45, amp=0.3, lead=0.6, tail=0.6, noise=0.0, seed=0):
    """Speech-like signal: modulated tone bursts (phrases) separated by pauses."""
    rng = np.random.default_rng(seed)
    parts = [np.zeros(int(lead * SR), np.float32)]
    for i, d in enumerate(durations):
        t = np.arange(int(d * SR)) / SR
        env = 0.6 + 0.4 * np.abs(np.sin(2 * np.pi * 3.0 * t))            # syllable-rate modulation
        parts.append((amp * env * np.sin(2 * np.pi * (180 + 20 * i) * t)).astype(np.float32))
        parts.append(np.zeros(int((pause if i < len(durations) - 1 else tail) * SR), np.float32))
    x = np.concatenate(parts)
    if noise:
        x = x + (noise * rng.standard_normal(len(x))).astype(np.float32)
    return x


def assert_in_pause(x, t, tol=0.02):
    i = int(t * SR)
    seg = x[max(0, i - int(tol * SR)):i + int(tol * SR)]
    assert np.max(np.abs(seg)) < 0.05, f"cut at {t:.2f}s is inside speech"


def test_suggest_picks_whole_phrases_in_the_recommended_window():
    x = phrases([2.5, 3.0, 2.0, 3.5, 2.8, 3.2, 2.2, 3.0, 2.6, 3.1])   # ~33 s
    r = suggest_reference_range(x, SR, 3.0, 30.0, (8.0, 15.0))
    assert r["reliable"] and r["edges_clean"] and 8.0 <= r["duration_s"] <= 15.0, r
    assert_in_pause(x, r["start_s"])
    assert_in_pause(x, r["end_s"] - 0.001)
    assert r["speech_ratio"] > 0.75 and r["issues"] == []


def test_suggest_short_clip_uses_the_speech_bounds():
    x = phrases([3.0, 3.5, 2.5])            # ~10.6 s, silence at both ends
    r = suggest_reference_range(x, SR, 3.0, 30.0, (8.0, 15.0))
    assert r["reliable"] and r["start_s"] > 0.3 and r["end_s"] < len(x) / SR - 0.3
    assert 8.5 <= r["speech_s"] <= 9.5 and r["issues"] == []


def test_suggest_flags_problems_in_plain_codes():
    quiet = suggest_reference_range(phrases([3.0] * 5, amp=0.01), SR, 3.0, 30.0, (8.0, 15.0))
    assert "TOO_QUIET" in {i["code"] for i in quiet["issues"]}
    loud = phrases([3.0] * 5, amp=1.3)
    clipped = suggest_reference_range(np.clip(loud, -1.0, 1.0), SR, 3.0, 30.0, (8.0, 15.0))
    assert "CLIPPING" in {i["code"] for i in clipped["issues"]}
    noisy = suggest_reference_range(phrases([3.0] * 5, amp=0.1, noise=0.03), SR, 3.0, 30.0, (8.0, 15.0))
    assert "NOISY" in {i["code"] for i in noisy["issues"]}
    silent = suggest_reference_range(np.zeros(SR * 10, np.float32), SR, 3.0, 30.0, (8.0, 15.0))
    assert silent["issues"][0]["code"] == "NO_SPEECH" and silent["issues"][0]["severity"] == "block" and not silent["reliable"]
    short = suggest_reference_range(phrases([1.5]), SR, 3.0, 30.0, (8.0, 15.0))
    assert short["issues"][0]["code"] == "TOO_SHORT" and not short["reliable"]


def test_suggest_without_pauses_is_not_reliable():
    t = np.arange(int(25 * SR)) / SR
    x = (0.3 * np.sin(2 * np.pi * 200 * t)).astype(np.float32)       # starts and ends mid-"word"
    r = suggest_reference_range(x, SR, 3.0, 30.0, (8.0, 15.0))
    assert not r["reliable"] and not r["edges_clean"]
    assert 0.0 <= r["start_s"] < r["end_s"] <= 25.0 + 1e-6


def test_suggest_reference_rpc_uses_engine_limits(server, tmp_path):
    x = phrases([2.5, 3.0, 2.0, 3.5, 2.8, 3.2, 2.2, 3.0])
    wav = tmp_path / "speech.wav"
    sf.write(wav, x, SR, subtype="FLOAT")
    server.state["engines"].caps["fake-engine"] = fake_caps(reference=fake_caps().reference.model_copy(update={"recommended_seconds": (6.0, 9.0)}))
    r = call(server, "audio.suggest_reference", {"path": str(wav), "engine_id": "fake-engine"})
    assert r["reliable"] and 6.0 <= r["duration_s"] <= 9.0 and r["recommended_seconds"] == [6.0, 9.0]
    aid = seed_asset(server, 12.0)       # a continuous tone asset: found, but not phrase-aligned
    r2 = call(server, "audio.suggest_reference", {"asset_id": aid, "engine_id": "fake-engine"})
    assert r2["reliable"] is False
    with pytest.raises(WorkerError):
        call(server, "audio.suggest_reference", {})


def test_transcript_confidence():
    assert transcript_confidence([]) is None
    assert transcript_confidence([{"start": 0, "end": 1, "avg_logprob": None}]) is None
    hi = transcript_confidence([{"start": 0, "end": 2, "avg_logprob": -0.1}])
    lo = transcript_confidence([{"start": 0, "end": 2, "avg_logprob": -1.2}])
    assert 0.85 < hi <= 1.0 and lo < 0.4


# ---------------------------------------------------------------- migration
def test_migration_0002_upgrades_a_v1_database(tmp_path):
    path = tmp_path / "studio.db"
    c = sqlite3.connect(path)
    c.executescript("CREATE TABLE schema_version (version INTEGER NOT NULL);" + (MIGRATIONS_DIR / "0001_init.sql").read_text() +
                    "INSERT INTO schema_version(version) VALUES (1);"
                    "INSERT INTO projects (id, name) VALUES ('p1', 'Old');"
                    "INSERT INTO segments (id, project_id, plan_version, idx, text, normalized_text) VALUES ('s1','p1',1,0,'Hi.','Hi.');"
                    "INSERT INTO takes (id, segment_id, project_id, engine_id, path) VALUES ('t1','s1','p1','qwen3-tts-base','/x.wav');")
    c.commit()
    c.close()
    db = Database(path)
    assert db.one("SELECT MAX(version) AS v FROM schema_version")["v"] >= 2
    t = db.one("SELECT * FROM takes WHERE id = 't1'")
    assert t["engine_id"] == "qwen3-tts-base" and t["reference_fingerprint"] is None and t["language"] is None
    assert db.one("SELECT COUNT(*) AS n FROM speak_history")["n"] == 0
    Database(path)   # re-opening does not re-apply


# ---------------------------------------------------------------- review regressions
def test_generate_does_not_erase_stored_controls_or_seed_when_not_sent(server):
    """Speak pressed before the engine list loaded sends no controls and no seed: stored Advanced values stay."""
    bob = make_voice(server, "Bob")
    pid = call(server, "speak.session", {})["project_id"]
    call(server, "projects.update", {"id": pid, "patch": {"settings": {"controls": {"fake-engine": {"temperature": 0.5}}, "seed": 42}}})
    call(server, "tts.plan", {"project_id": pid, "script_text": "One sentence.", "engine_id": "fake-engine"})
    call(server, "tts.generate", {"project_id": pid, "engine_id": "fake-engine", "reference_id": bob["selected_reference_id"], "settings": {}})
    st = call(server, "projects.get", {"id": pid})["project"]["settings"]
    assert st["controls"]["fake-engine"] == {"temperature": 0.5} and st["seed"] == 42
    # an explicit seed / explicit controls are still remembered
    call(server, "tts.generate", {"project_id": pid, "engine_id": "fake-engine", "reference_id": bob["selected_reference_id"],
                                  "settings": {"temperature": 0.7}, "seed": None, "regenerate_all": True})
    st = call(server, "projects.get", {"id": pid})["project"]["settings"]
    assert st["controls"]["fake-engine"] == {"temperature": 0.7} and st["seed"] is None


def test_concurrent_script_saves_get_distinct_versions(server):
    import threading
    pid = call(server, "speak.session", {})["project_id"]
    errors: list[Exception] = []

    def save(i: int) -> None:
        try:
            call(server, "projects.save_script", {"id": pid, "text": f"text {i}"})
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=save, args=(i,)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    versions = [r["version"] for r in server.state["db"].all("SELECT version FROM scripts WHERE project_id = ?", (pid,))]
    assert sorted(versions) == list(range(1, 13))


def test_concurrent_first_sessions_create_one_scratch_project(server):
    import threading
    ids: list[str] = []
    threads = [threading.Thread(target=lambda: ids.append(call(server, "speak.session", {})["project_id"])) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(ids)) == 1
    assert server.state["db"].one("SELECT COUNT(*) AS n FROM projects")["n"] == 1
