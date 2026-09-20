"""Persistence tests (voices / projects / library) plus the in-process test harness shared by test_tts/test_backup.

Harness: `make_server(tmp_path)` builds a Server with a capturing DummyTransport and real AppPaths/SettingsStore/
Database under tmp_path, plus a FakeEngineManager that writes short synthetic wavs. `call(server, method, params)`
validates params like the RPC layer and invokes the registered handler directly with a Ctx.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import types
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from pydantic import ValidationError

import shadowfetch_worker.jobs.backup  # noqa: F401  (registers methods)
import shadowfetch_worker.jobs.library  # noqa: F401
import shadowfetch_worker.jobs.projects  # noqa: F401
import shadowfetch_worker.jobs.tts  # noqa: F401
import shadowfetch_worker.jobs.voices  # noqa: F401
from shadowfetch_worker.engines.base import Capabilities, ControlSpec, Language, ReferenceRequirements
from shadowfetch_worker.jobs.voices import ensure_reference_file
from shadowfetch_worker.paths import AppPaths
from shadowfetch_worker.protocol import ENGINE_CRASHED, ENGINE_UNAVAILABLE, INVALID_PARAMS, NOT_FOUND, WorkerError, envelope_event, invalid_params
from shadowfetch_worker.rpc import Ctx, Server, registry
from shadowfetch_worker.runtime import Runtime
from shadowfetch_worker.settings import SettingsStore
from shadowfetch_worker.store import repo
from shadowfetch_worker.store.db import Database, new_id

SR = 48000


# ---------------------------------------------------------------- harness
class DummyTransport:
    def __init__(self):
        self.messages: list[dict[str, Any]] = []

    def send(self, obj: dict[str, Any]) -> None:
        self.messages.append(obj)

    def event(self, name: str, data: dict[str, Any]) -> None:
        self.send(envelope_event(name, data))

    def progress(self) -> list[dict[str, Any]]:
        return [m for m in self.messages if m["type"] == "progress"]


def fake_caps(engine_id: str = "fake-engine", **over) -> Capabilities:
    base = dict(id=engine_id, name=f"Fake {engine_id}", version="0", model_id="fake-model", model_repo="fake/repo", output_sample_rate=24000,
                languages=[Language(code="en", label="English", engine_value="English")],
                reference=ReferenceRequirements(needs_transcript=True, min_seconds=1, max_seconds=30, recommended_seconds=(5, 15),
                                                sample_rate=24000, channels=1),
                controls=[ControlSpec(id="temperature", label="Temperature", type="float", default=0.9, min=0.1, max=1.5)],
                max_chars_per_request=200, supports_cancel=True, supports_seed=True, supports_reusable_prompt=True)
    base.update(over)
    return Capabilities(**base)


def write_tone(path: Path, seconds: float, sr: int = SR, freq: float = 220.0) -> None:
    t = np.arange(int(seconds * sr)) / sr
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32), sr, subtype="FLOAT")


class FakeEngineManager:
    """Stand-in for EngineManager: no processes, writes short synthetic wavs, records every call."""

    def __init__(self, caps: list[Capabilities] | None = None, fail_on_text: str | None = None, cancel_after: int | None = None):
        self.caps = {c.id: c for c in (caps or [fake_caps()])}
        self.loaded: str | None = None
        self.load_order: list[str] = []
        self.calls: list[dict[str, Any]] = []
        self.prepared: list[dict[str, Any]] = []
        self.fail_on_text = fail_on_text
        self.cancel_after = cancel_after

    def capabilities(self, engine_id: str) -> Capabilities:
        if engine_id not in self.caps:
            raise WorkerError(ENGINE_UNAVAILABLE, f"Unknown engine {engine_id}")
        return self.caps[engine_id]

    def ensure_loaded(self, ctx: Ctx, engine_id: str, model_id: str | None = None, device: str = "cuda") -> dict[str, Any]:
        self.capabilities(engine_id)
        if self.loaded != engine_id:
            ctx.progress("engine", f"Loading {engine_id}")
            self.loaded = engine_id
            self.load_order.append(engine_id)
        return {"engine_id": engine_id, "model_id": "fake-model", "revision": "rev1"}

    def prepare_reference(self, ctx, engine_id, reference_path, transcript, language, cache_path, settings=None) -> dict[str, Any]:
        self.ensure_loaded(ctx, engine_id)
        Path(cache_path).write_bytes(b"prompt:" + Path(reference_path).name.encode())
        self.prepared.append({"engine_id": engine_id, "reference_path": str(reference_path), "transcript": transcript})
        return {"path": str(cache_path)}

    def generate(self, ctx, engine_id, text, language, reference_path, transcript, out_path, settings, seed, prompt_cache_path):
        self.ensure_loaded(ctx, engine_id)
        self.calls.append({"engine_id": engine_id, "text": text, "language": language, "reference_path": str(reference_path),
                           "settings": dict(settings), "seed": seed, "prompt": str(prompt_cache_path) if prompt_cache_path else None})
        if self.fail_on_text and self.fail_on_text in text:
            raise WorkerError(ENGINE_CRASHED, "fake engine crashed", {"text": text})
        dur = 0.05 + 0.002 * len(text)
        write_tone(Path(out_path), dur, sr=24000, freq=300.0 + 10 * len(self.calls))
        if self.cancel_after is not None and len(self.calls) >= self.cancel_after:
            ctx.cancel()      # a shell "cancel" arriving while this segment finishes
        return {"path": str(out_path), "sample_rate": 24000, "duration_s": dur, "seed": seed, "elapsed_s": 0.001, "warnings": []}


def install_fake_audio(monkeypatch) -> types.ModuleType:
    """Install a numpy-based stand-in for shadowfetch_worker.audio.edit (the real one belongs to another agent)."""
    import shadowfetch_worker.audio as audio_pkg

    def _read(path):
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        return data.mean(axis=1), sr

    def prepare_reference(working_wav, dst, sample_rate, channels=1, start_s=None, end_s=None, normalize_peak_dbfs=None):
        data, sr = _read(working_wav)
        a = int((start_s or 0) * sr)
        b = int(end_s * sr) if end_s is not None else len(data)
        data = data[a:b]
        n = int(len(data) * sample_rate / sr)
        data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data).astype(np.float32)
        if normalize_peak_dbfs is not None and np.abs(data).max() > 0:
            data = data / np.abs(data).max() * (10 ** (normalize_peak_dbfs / 20))
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        sf.write(dst, data if channels == 1 else np.stack([data] * channels, 1), sample_rate, subtype="PCM_24")
        return {"path": str(dst), "sample_rate": sample_rate, "channels": channels, "duration_s": n / sample_rate}

    def assemble(takes, out_path, sentence_pause_ms, paragraph_pause_ms, sample_rate=None, ctx=None):
        chunks, sr, prev_par = [], None, None
        for t in sorted(takes, key=lambda x: x["index"]):
            data, sr = _read(t["path"])
            if chunks:
                gap = paragraph_pause_ms if t["paragraph"] != prev_par else sentence_pause_ms
                chunks.append(np.zeros(int(sr * gap / 1000), np.float32))
            chunks.append(data)
            prev_par = t["paragraph"]
        out = np.concatenate(chunks)
        sf.write(out_path, out, sr, subtype="PCM_24")
        return {"path": str(out_path), "duration_s": len(out) / sr, "sample_rate": sr, "segments_used": len(takes)}

    def loudness_match_copy(src, dst, target_lufs=-18.0):
        shutil.copy2(src, dst)
        return {"path": str(dst), "target_lufs": target_lufs}

    def trim(src, dst, start_s, end_s):
        data, sr = _read(src)
        sf.write(dst, data[int(start_s * sr):int(end_s * sr)], sr)
        return {"path": str(dst), "duration_s": end_s - start_s}

    def parse_steps(steps):
        allowed = {"normalize_peak", "trim_silence", "highpass", "gain"}
        out = []
        for i, step in enumerate(steps or []):
            if not isinstance(step, dict) or "op" not in step:
                raise WorkerError(INVALID_PARAMS, f"processing step {i} must be an object with an 'op' key")
            if step["op"] not in allowed:
                raise WorkerError(INVALID_PARAMS, f"Unknown processing op {step['op']!r}")
            out.append(step)
        return out

    def apply_processing(src, dst, steps, subtype="FLOAT", ctx=None):
        parse_steps(steps)
        data, sr = _read(src)
        applied = []
        for step in steps:
            op = step["op"]
            if op == "normalize_peak":
                peak = float(np.abs(data).max())
                if peak > 0:
                    data = data / peak * (10 ** (float(step.get("dbfs", -3)) / 20))
                applied.append({"op": op, "dbfs": step.get("dbfs", -3)})
            elif op == "gain":
                data = data * (10 ** (float(step.get("db", 0)) / 20))
                applied.append({"op": op, "db": step.get("db", 0)})
            elif op == "highpass":
                data = data - float(data.mean())
                applied.append({"op": op, "hz": step.get("hz", 80)})
            elif op == "trim_silence":
                applied.append({"op": op})
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        sf.write(dst, data, sr, subtype=subtype)
        return {"path": str(dst), "duration_s": len(data) / sr, "sample_rate": sr, "channels": 1, "steps": applied}

    fake = types.ModuleType("shadowfetch_worker.audio.edit")
    fake.prepare_reference = prepare_reference
    fake.assemble = assemble
    fake.loudness_match_copy = loudness_match_copy
    fake.trim = trim
    fake.parse_steps = parse_steps
    fake.apply_processing = apply_processing
    monkeypatch.setitem(sys.modules, "shadowfetch_worker.audio.edit", fake)
    monkeypatch.setattr(audio_pkg, "edit", fake, raising=False)
    return fake


def make_server(tmp_path: Path, engines: FakeEngineManager | None = None) -> Server:
    paths = AppPaths.build(str(tmp_path / "data"), str(tmp_path / "config"), str(tmp_path / "cache"))
    server = Server(DummyTransport())
    server.state.update({"paths": paths, "settings": SettingsStore(paths.settings_file), "db": Database(paths.db_file),
                         "runtime": Runtime(paths), "engines": engines or FakeEngineManager()})
    return server


def make_ctx(server: Server, method: str = "test") -> Ctx:
    return Ctx(req_id=new_id("req"), method=method, transport=server.transport, server=server)


def call(server: Server, method: str, params: dict[str, Any] | None = None, ctx: Ctx | None = None) -> Any:
    """Validate params exactly like Server._run and invoke the handler synchronously (errors propagate)."""
    spec = registry()[method]
    p: Any = params or {}
    if spec.params_model is not None:
        try:
            p = spec.params_model.model_validate(p)
        except ValidationError as ve:
            raise invalid_params(ve)
    return spec.fn(ctx or make_ctx(server, method), p)


def seed_asset(server: Server, seconds: float = 4.0) -> str:
    """Insert an assets row backed by a real synthetic working.wav/original.wav under paths.recordings."""
    paths, db = server.state["paths"], server.state["db"]
    aid = new_id("asset")
    d = paths.recordings / aid
    write_tone(d / "working.wav", seconds)
    shutil.copy2(d / "working.wav", d / "original.wav")
    sha = hashlib.sha256((d / "original.wav").read_bytes()).hexdigest()
    db.insert("assets", {"id": aid, "kind": "reference", "source": "import", "original_name": "clip.wav",
                         "original_path": str(d / "original.wav"), "working_path": str(d / "working.wav"), "sha256": sha,
                         "format": "wav", "codec": "pcm_f32le", "duration_s": seconds, "sample_rate": SR, "channels": 1,
                         "size_bytes": (d / "original.wav").stat().st_size})
    return aid


def make_voice(server: Server, name: str = "Narrator", seconds: float = 4.0, **over) -> dict[str, Any]:
    aid = seed_asset(server, seconds)
    params = {"name": name, "tags": ["warm"], "language": "en", "rights_confirmed": True, "asset_id": aid,
              "trim": {"start_s": 0.5, "end_s": 3.5}, "transcript": "This is my reference clip."}
    params.update(over)
    return call(server, "voices.create", params)


@pytest.fixture
def server(tmp_path, monkeypatch):
    install_fake_audio(monkeypatch)
    return make_server(tmp_path)


# ---------------------------------------------------------------- voices
def test_voice_create_requires_rights(server):
    aid = seed_asset(server)
    with pytest.raises(WorkerError) as ei:
        call(server, "voices.create", {"name": "X", "asset_id": aid, "trim": {"start_s": 0, "end_s": 2}, "transcript": "hi"})
    assert ei.value.code == INVALID_PARAMS and "rights" in ei.value.message.lower()
    assert server.state["db"].one("SELECT COUNT(*) AS n FROM voices")["n"] == 0


def test_voice_create_validations(server):
    aid = seed_asset(server, 4.0)
    base = {"name": "X", "rights_confirmed": True, "asset_id": aid, "trim": {"start_s": 0, "end_s": 2}, "transcript": "hi"}
    with pytest.raises(WorkerError) as ei:
        call(server, "voices.create", {**base, "asset_id": "asset_missing"})
    assert ei.value.code == NOT_FOUND
    with pytest.raises(WorkerError) as ei:
        call(server, "voices.create", {**base, "trim": {"start_s": 1, "end_s": 9}})
    assert ei.value.code == INVALID_PARAMS and "duration" in ei.value.message
    with pytest.raises(WorkerError) as ei:
        call(server, "voices.create", {**base, "trim": {"start_s": 2, "end_s": 1}})
    assert ei.value.code == INVALID_PARAMS
    with pytest.raises(WorkerError) as ei:
        call(server, "voices.create", {**base, "transcript": "   "})
    assert ei.value.code == INVALID_PARAMS and "transcript" in ei.value.message.lower()
    # a failed create leaves no orphan voice row
    assert server.state["db"].one("SELECT COUNT(*) AS n FROM voices")["n"] == 0


def test_voice_create_and_fingerprint(server):
    v = make_voice(server)
    assert v["rights_confirmed"] is True and v["tags"] == ["warm"] and v["reference_count"] == 1
    ref = v["references"][0]
    assert v["selected_reference_id"] == ref["id"]
    asset = server.state["db"].require("assets", ref["asset_id"])
    expected = hashlib.sha256(f"{asset['sha256']}|0.500|3.500|This is my reference clip.|[]".encode()).hexdigest()
    assert ref["fingerprint"] == expected
    assert ref["trim"] == {"start_s": 0.5, "end_s": 3.5} and ref["derived"] == {}
    got = call(server, "voices.get", {"id": v["id"]})
    assert got["references"][0]["id"] == ref["id"]


def test_voice_list_update_archive(server):
    a = make_voice(server, "Alpha")
    b = make_voice(server, "Beta")
    call(server, "voices.update", {"id": b["id"], "patch": {"archived": True, "favorite": True, "tags": ["x"], "notes": "n"}})
    names = [v["name"] for v in call(server, "voices.list")["voices"]]
    assert names == ["Alpha"]
    names = [v["name"] for v in call(server, "voices.list", {"include_archived": True})["voices"]]
    assert set(names) == {"Alpha", "Beta"}
    with pytest.raises(WorkerError) as ei:
        call(server, "voices.update", {"id": a["id"], "patch": {"selected_reference_id": "nope"}})
    assert ei.value.code == INVALID_PARAMS
    with pytest.raises(WorkerError):
        call(server, "voices.update", {"id": a["id"], "patch": {"name": " "}})


def test_voice_delete_protection_and_force(server):
    v = make_voice(server)
    db, paths = server.state["db"], server.state["paths"]
    proj = call(server, "projects.create", {"name": "Uses voice", "voice_id": v["id"]})
    assert proj["reference_id"] == v["selected_reference_id"]
    (paths.voices / v["id"] / "references" / "x").mkdir(parents=True)
    with pytest.raises(WorkerError) as ei:
        call(server, "voices.delete", {"id": v["id"]})
    assert ei.value.details["used_by_projects"] == [{"id": proj["id"], "name": "Uses voice"}]
    res = call(server, "voices.delete", {"id": v["id"], "force": True})
    assert res["ok"] and res["unlinked_projects"][0]["id"] == proj["id"]
    assert db.one("SELECT COUNT(*) AS n FROM voices")["n"] == 0
    assert db.one("SELECT COUNT(*) AS n FROM voice_references")["n"] == 0
    assert not (paths.voices / v["id"]).exists()
    # assets/recordings survive; the project is unlinked, not deleted
    asset = db.require("assets", v["references"][0]["asset_id"])
    assert Path(asset["original_path"]).exists() and Path(asset["working_path"]).exists()
    p = call(server, "projects.get", {"id": proj["id"]})["project"]
    assert p["voice_id"] is None and p["reference_id"] is None
    with pytest.raises(WorkerError) as ei:
        call(server, "voices.get", {"id": v["id"]})
    assert ei.value.code == NOT_FOUND


def test_reference_add_select_update(server):
    v = make_voice(server)
    db = server.state["db"]
    aid2 = seed_asset(server, 6.0)
    r2 = call(server, "voices.add_reference", {"voice_id": v["id"], "asset_id": aid2, "trim": {"start_s": 0, "end_s": 5},
                                                "transcript": "Second clip.", "label": "second"})
    assert r2["voice_id"] == v["id"] and r2["label"] == "second"
    assert call(server, "voices.get", {"id": v["id"]})["selected_reference_id"] == v["selected_reference_id"]   # unchanged
    sel = call(server, "voices.select_reference", {"voice_id": v["id"], "reference_id": r2["id"]})
    assert sel["selected_reference_id"] == r2["id"]
    other = make_voice(server, "Other")
    with pytest.raises(WorkerError):
        call(server, "voices.select_reference", {"voice_id": other["id"], "reference_id": r2["id"]})

    # derived file + prompt cache exist, then a transcript edit invalidates both
    ref_row = db.require("voice_references", r2["id"])
    derived = ensure_reference_file(server.state, ref_row, "fake-engine")
    assert derived.exists() and derived.name == "reference.fake-engine.wav"
    info = sf.info(str(derived))
    assert info.samplerate == 24000 and info.channels == 1 and abs(info.duration - 5.0) < 0.01
    pc_path = server.state["paths"].prompts / "pc.bin"
    pc_path.write_bytes(b"x")
    db.insert("prompt_cache", {"id": "pc1", "reference_id": r2["id"], "engine_id": "fake-engine", "model_revision": "rev1",
                               "fingerprint": ref_row["fingerprint"], "path": str(pc_path)})
    upd = call(server, "voices.update_reference", {"reference_id": r2["id"], "patch": {"transcript": "Second clip, corrected."}})
    assert upd["transcript"] == "Second clip, corrected." and upd["transcript_source"] == "edited" and upd["transcript_confirmed"] is True
    assert upd["fingerprint"] != ref_row["fingerprint"] and upd["derived"] == {}
    assert not derived.exists() and not pc_path.exists()
    assert db.one("SELECT COUNT(*) AS n FROM prompt_cache WHERE reference_id = ?", (r2["id"],))["n"] == 0
    # label-only edits keep the fingerprint
    upd2 = call(server, "voices.update_reference", {"reference_id": r2["id"], "patch": {"label": "renamed"}})
    assert upd2["fingerprint"] == upd["fingerprint"] and upd2["label"] == "renamed"
    with pytest.raises(WorkerError):
        call(server, "voices.update_reference", {"reference_id": r2["id"], "patch": {"transcript": ""}})
    # changing the trim without reconfirming marks the transcript unreviewed
    confirmed = call(server, "voices.update_reference", {"reference_id": r2["id"], "patch": {"transcript_confirmed": True}})
    assert confirmed["transcript_confirmed"] is True
    retimed = call(server, "voices.update_reference", {"reference_id": r2["id"], "patch": {"trim": {"start_s": 0.2, "end_s": 4.8}}})
    assert retimed["start_s"] == 0.2 and retimed["end_s"] == 4.8
    assert retimed["transcript_confirmed"] is False
    still = call(server, "voices.update_reference", {"reference_id": r2["id"],
                                                    "patch": {"trim": {"start_s": 0.3, "end_s": 4.7}, "transcript_confirmed": True}})
    assert still["transcript_confirmed"] is True


def test_ensure_reference_file_caches_and_rebuilds(server, monkeypatch):
    v = make_voice(server)
    db = server.state["db"]
    ref = db.require("voice_references", v["selected_reference_id"])
    edit = sys.modules["shadowfetch_worker.audio.edit"]
    calls = []
    real = edit.prepare_reference
    monkeypatch.setattr(edit, "prepare_reference", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    p1 = ensure_reference_file(server.state, ref, "fake-engine")
    p2 = ensure_reference_file(server.state, db.require("voice_references", ref["id"]), "fake-engine")
    assert p1 == p2 and len(calls) == 1
    derived = repo.reference_dict(db.require("voice_references", ref["id"]))["derived"]["fake-engine"]
    assert derived["fingerprint"] == ref["fingerprint"] and derived["sample_rate"] == 24000
    p1.unlink()
    ensure_reference_file(server.state, db.require("voice_references", ref["id"]), "fake-engine")
    assert len(calls) == 2 and p1.exists()


def test_ensure_reference_file_applies_processing_then_prepares_without_second_normalize(server, monkeypatch):
    """Stored processing runs at the working rate; prepare_reference must not peak-normalize again."""
    steps = [{"op": "trim_silence"}, {"op": "highpass", "hz": 80}, {"op": "normalize_peak", "dbfs": -3}]
    v = make_voice(server, processing=steps)
    db = server.state["db"]
    ref = db.require("voice_references", v["selected_reference_id"])
    assert json.loads(ref["processing_json"]) == steps
    edit = sys.modules["shadowfetch_worker.audio.edit"]
    applied: list[list] = []
    prepared: list[dict] = []
    real_apply = edit.apply_processing
    real_prep = edit.prepare_reference

    def capture_apply(src, dst, proc_steps, subtype="FLOAT", ctx=None):
        applied.append(list(proc_steps))
        return real_apply(src, dst, proc_steps, subtype=subtype, ctx=ctx)

    def capture_prep(*a, **k):
        prepared.append(k)
        return real_prep(*a, **k)

    monkeypatch.setattr(edit, "apply_processing", capture_apply)
    monkeypatch.setattr(edit, "prepare_reference", capture_prep)
    dst = ensure_reference_file(server.state, ref, "fake-engine")
    assert dst.exists() and applied == [steps]
    assert prepared and prepared[0].get("start_s") is None and prepared[0].get("end_s") is None
    assert prepared[0].get("normalize_peak_dbfs") is None
    stored = repo.reference_dict(db.require("voice_references", ref["id"]))["derived"]["fake-engine"]
    assert stored["processing"] == steps


# ---------------------------------------------------------------- projects
def test_project_create_get_update(server):
    v = make_voice(server)
    p = call(server, "projects.create", {"name": " Intro ", "voice_id": v["id"], "tags": ["promo"], "folder": "Ads", "script_text": "Hello."})
    assert p["name"] == "Intro" and p["voice_id"] == v["id"] and p["engine_id"] == server.state["settings"].value.default_engine
    assert p["settings"]["plan"]["max_chars"] == server.state["settings"].value.max_chars_per_segment
    assert (server.state["paths"].projects / p["id"]).is_dir()
    view = call(server, "projects.get", {"id": p["id"]})
    assert view["script"] == {"text": "Hello.", "version": 1, "updated_at": view["script"]["updated_at"]}
    assert view["segments"] == [] and view["exports"] == [] and view["project"]["voice_name"] == "Narrator"
    up = call(server, "projects.update", {"id": p["id"], "patch": {"name": "Intro v2", "favorite": True, "tags": ["a", "b"],
                                                                  "settings": {"plan": {"spell_numbers": True}}}})
    assert up["name"] == "Intro v2" and up["favorite"] is True and up["tags"] == ["a", "b"]
    assert up["settings"]["plan"]["spell_numbers"] is True and up["settings"]["plan"]["max_chars"] > 0
    with pytest.raises(WorkerError) as ei:
        call(server, "projects.update", {"id": p["id"], "patch": {"bogus": 1}})
    assert ei.value.code == INVALID_PARAMS
    with pytest.raises(WorkerError) as ei:
        call(server, "projects.create", {"name": "x", "voice_id": "voice_missing"})
    assert ei.value.code == NOT_FOUND


def test_project_list_filters_and_sort(server):
    a = call(server, "projects.create", {"name": "Banana", "tags": ["fruit"], "folder": "F1"})
    call(server, "projects.create", {"name": "apple", "tags": ["fruit", "red"], "folder": "F2"})
    c = call(server, "projects.create", {"name": "Cherry", "tags": ["red"]})
    call(server, "projects.update", {"id": c["id"], "patch": {"favorite": True}})
    call(server, "projects.archive", {"id": a["id"], "archived": True})
    names = lambda **kw: [p["name"] for p in call(server, "projects.list", kw)["projects"]]  # noqa: E731
    assert names() == ["Cherry", "apple"]                              # archived hidden, newest update first
    assert names(archived=True) == ["Banana"]
    assert set(names(archived=None)) == {"Banana", "apple", "Cherry"}
    assert names(sort="name", archived=None) == ["apple", "Banana", "Cherry"]
    assert names(tags=["red"], archived=None) == ["Cherry", "apple"]
    assert names(tags=["red", "fruit"], archived=None) == ["apple"]
    assert names(query="app") == ["apple"]
    assert names(favorite=True) == ["Cherry"]
    assert names(folder="F2") == ["apple"]
    row = call(server, "projects.list", {"query": "apple"})["projects"][0]
    assert row["segment_count"] == 0 and row["has_master"] is False and row["script_version"] == 0


def test_script_versioning(server):
    p = call(server, "projects.create", {"name": "S"})
    db = server.state["db"]
    assert call(server, "projects.save_script", {"id": p["id"], "text": "one"}) == {"script_version": 1, "changed": True}
    assert call(server, "projects.save_script", {"id": p["id"], "text": "one"}) == {"script_version": 1, "changed": False}
    assert call(server, "projects.save_script", {"id": p["id"], "text": "two"})["script_version"] == 2
    for i in range(3, 61):
        call(server, "projects.save_script", {"id": p["id"], "text": f"v{i}"})
    rows = db.all("SELECT version FROM scripts WHERE project_id = ? ORDER BY version", (p["id"],))
    assert len(rows) == 50 and rows[0]["version"] == 11 and rows[-1]["version"] == 60
    assert call(server, "projects.get", {"id": p["id"]})["script"]["text"] == "v60"


def test_project_duplicate_delete_and_select_take(server):
    v = make_voice(server)
    p = call(server, "projects.create", {"name": "Orig", "voice_id": v["id"], "script_text": "The first sentence. The second sentence."})
    call(server, "tts.plan", {"project_id": p["id"], "engine_id": "fake-engine", "options": {"max_chars": 20}})
    gen = call(server, "tts.generate", {"project_id": p["id"], "engine_id": "fake-engine"})
    assert len(gen["takes"]) == 2
    call(server, "tts.assemble", {"project_id": p["id"]})
    dup = call(server, "projects.duplicate", {"id": p["id"]})
    assert dup["name"] == "Orig (copy)" and dup["id"] != p["id"] and dup["voice_id"] == v["id"]
    dv = call(server, "projects.get", {"id": dup["id"]})
    ov = call(server, "projects.get", {"id": p["id"]})
    assert dv["script"]["text"] == "The first sentence. The second sentence." and len(dv["segments"]) == 2
    for s in dv["segments"]:
        assert s["id"] not in {o["id"] for o in ov["segments"]}
        assert len(s["takes"]) == 1 and s["selected_take_id"] == s["takes"][0]["id"]
        assert Path(s["takes"][0]["path"]).exists() and dup["id"] in s["takes"][0]["path"]
    assert Path(dv["project"]["master_path"]).exists() and dup["id"] in dv["project"]["master_path"]

    # select_take validation
    seg0 = ov["segments"][0]
    with pytest.raises(WorkerError):
        call(server, "projects.select_take", {"id": p["id"], "segment_index": 0, "take_id": ov["segments"][1]["takes"][0]["id"]})
    r = call(server, "projects.select_take", {"id": p["id"], "segment_index": 0, "take_id": None})
    assert r["ok"] and call(server, "projects.get", {"id": p["id"]})["segments"][0]["selected_take_id"] is None
    call(server, "projects.select_take", {"id": p["id"], "segment_index": 0, "take_id": seg0["takes"][0]["id"]})

    # delete needs confirm, removes only the project dir
    with pytest.raises(WorkerError) as ei:
        call(server, "projects.delete", {"id": p["id"]})
    assert ei.value.code == INVALID_PARAMS
    pdir = server.state["paths"].projects / p["id"]
    assert pdir.exists()
    call(server, "projects.delete", {"id": p["id"], "confirm": True})
    assert not pdir.exists()
    db = server.state["db"]
    assert db.one("SELECT COUNT(*) AS n FROM takes WHERE project_id = ?", (p["id"],))["n"] == 0
    assert db.one("SELECT COUNT(*) AS n FROM voices")["n"] == 1
    assert (server.state["paths"].projects / dup["id"]).exists()
    assert Path(db.require("assets", v["references"][0]["asset_id"])["working_path"]).exists()


# ---------------------------------------------------------------- library
def test_library_search_folders_tags(server):
    make_voice(server, "Deep Narrator", tags=["deep", "male"])
    a = call(server, "projects.create", {"name": "Podcast intro", "tags": ["podcast", "deep"], "folder": "Shows", "script_text": "Welcome to the jungle."})
    call(server, "projects.create", {"name": "Ad read", "tags": ["ad"], "folder": "Ads"})
    arch = call(server, "projects.create", {"name": "Old deep thing", "folder": "Shows"})
    call(server, "projects.archive", {"id": arch["id"], "archived": True})
    res = call(server, "library.search", {"query": "deep"})
    assert [p["name"] for p in res["projects"]] == ["Podcast intro"]
    assert [x["name"] for x in res["voices"]] == ["Deep Narrator"] and "references" not in res["voices"][0]
    assert [p["name"] for p in call(server, "library.search", {"query": "jungle"})["projects"]] == ["Podcast intro"]
    assert [p["name"] for p in call(server, "library.search", {"query": "deep", "include_archived": True})["projects"]] == ["Old deep thing", "Podcast intro"]
    folders = call(server, "library.folders")["folders"]
    assert folders == [{"name": "Ads", "count": 1, "archived": 0}, {"name": "Shows", "count": 2, "archived": 1}]
    tags = {t["name"]: t for t in call(server, "library.tags")["tags"]}
    assert tags["deep"] == {"name": "deep", "count": 2, "projects": 1, "voices": 1}
    assert tags["ad"]["count"] == 1 and tags["male"]["voices"] == 1 and a["id"]
    assert list(tags) == sorted(tags, key=str.lower)
