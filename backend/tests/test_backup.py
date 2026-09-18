"""backup.export / backup.import round trip and archive hardening."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from shadowfetch_worker.jobs.backup import MAX_ENTRY_BYTES, _check_entry
from shadowfetch_worker.protocol import CORRUPT_FILE, INVALID_PARAMS, NOT_FOUND, UNSUPPORTED_FILE, WorkerError
try:
    from tests.test_store import call, install_fake_audio, make_server, make_voice
except ImportError:  # pragma: no cover
    from test_store import call, install_fake_audio, make_server, make_voice


@pytest.fixture
def server(tmp_path, monkeypatch):
    install_fake_audio(monkeypatch)
    return make_server(tmp_path / "src")


def build_project(server):
    v = make_voice(server, "Backup voice", tags=["t1"])
    p = call(server, "projects.create", {"name": "Round trip", "voice_id": v["id"], "tags": ["demo"], "folder": "Tests",
                                         "script_text": "Alpha beta gamma. Delta epsilon.\n\nZeta eta."})
    call(server, "projects.save_script", {"id": p["id"], "text": "Alpha beta gamma. Delta epsilon.\n\nZeta eta theta."})
    call(server, "tts.plan", {"project_id": p["id"], "engine_id": "fake-engine", "options": {"max_chars": 30}})
    gen = call(server, "tts.generate", {"project_id": p["id"], "seed": 7})
    call(server, "tts.generate", {"project_id": p["id"], "segment_indices": [0]})     # segment 0 has two takes
    call(server, "tts.assemble", {"project_id": p["id"]})
    return v, p, gen


def test_export_import_round_trip(server, tmp_path, monkeypatch):
    v, p, gen = build_project(server)
    src_view = call(server, "projects.get", {"id": p["id"]})
    res = call(server, "backup.export", {"project_id": p["id"]})
    zpath = Path(res["path"])
    assert zpath.exists() and zpath.parent == server.state["paths"].exports and res["size_bytes"] == zpath.stat().st_size
    with zipfile.ZipFile(zpath) as z:
        names = set(z.namelist())
        m = json.loads(z.read("manifest.json"))
    assert m["format"] == "sfvs-backup" and m["version"] == 1 and m["exported_at"]
    assert m["project"]["name"] == "Round trip" and m["script"]["text"].endswith("theta.") and len(m["scripts"]) == 2
    assert len(m["segments"]) == 3 and len(m["takes"]) == 4 and m["voice"]["name"] == "Backup voice" and len(m["references"]) == 1
    assert "assets/master.wav" in names and all(t["file"] in names for t in m["takes"])
    ref = m["references"][0]
    assert ref["original_file"] in names and ref["working_file"] in names and ref["derived_files"]["fake-engine"] in names
    assert all(not n.startswith("/") and ".." not in n for n in names)

    # import into a completely separate installation
    dst = make_server(tmp_path / "dst")
    imp = call(dst, "backup.import", {"path": str(zpath)})
    assert imp["takes"] == 4 and imp["segments"] == 3 and imp["warnings"] == []
    assert imp["project_id"] != p["id"] and imp["voice_id"] != v["id"] and imp["reference_ids"] != [v["selected_reference_id"]]
    view = call(dst, "projects.get", {"id": imp["project_id"]})
    proj = view["project"]
    assert proj["name"] == "Round trip" and proj["tags"] == ["demo"] and proj["folder"] == "Tests" and proj["voice_id"] == imp["voice_id"]
    assert proj["reference_id"] == imp["reference_ids"][0] and proj["plan_version"] == 1 and proj["voice_name"] == "Backup voice"
    assert view["script"]["text"] == src_view["script"]["text"] and view["script"]["version"] == 2
    assert [s["text"] for s in view["segments"]] == [s["text"] for s in src_view["segments"]]
    for s_new, s_old in zip(view["segments"], src_view["segments"]):
        assert s_new["id"] != s_old["id"] and len(s_new["takes"]) == len(s_old["takes"])
        assert s_new["selected_take_id"] and s_new["selected_take_id"] in {t["id"] for t in s_new["takes"]}
        sel_old = next(t for t in s_old["takes"] if t["id"] == s_old["selected_take_id"])
        sel_new = next(t for t in s_new["takes"] if t["id"] == s_new["selected_take_id"])
        assert sel_new["seed"] == sel_old["seed"] and sel_new["duration_s"] == sel_old["duration_s"]
        for t in s_new["takes"]:
            path = Path(t["path"])
            assert path.exists() and path.is_relative_to(dst.state["paths"].projects / imp["project_id"])
    assert Path(proj["master_path"]).exists() and Path(proj["master_path"]).is_relative_to(dst.state["paths"].projects)
    assert Path(proj["master_path"]).read_bytes() == Path(src_view["project"]["master_path"]).read_bytes()

    voice = call(dst, "voices.get", {"id": imp["voice_id"]})
    assert voice["tags"] == ["t1"] and voice["rights_confirmed"] is True and "Imported from backup" in voice["rights_note"]
    r_new = voice["references"][0]
    r_old = call(server, "voices.get", {"id": v["id"]})["references"][0]
    assert r_new["transcript"] == r_old["transcript"] and r_new["trim"] == r_old["trim"] and r_new["fingerprint"] == r_old["fingerprint"]
    assert Path(r_new["derived"]["fake-engine"]["path"]).exists() and r_new["derived"]["fake-engine"]["fingerprint"] == r_new["fingerprint"]
    asset = dst.state["db"].require("assets", r_new["asset_id"])
    src_asset = server.state["db"].require("assets", r_old["asset_id"])
    assert Path(asset["original_path"]).exists() and Path(asset["working_path"]).exists() and asset["sha256"] == src_asset["sha256"]
    assert Path(asset["original_path"]).is_relative_to(dst.state["paths"].recordings)
    # the source installation is untouched
    assert call(server, "projects.get", {"id": p["id"]})["project"]["master_path"] == src_view["project"]["master_path"]

    # a project without a voice exports/imports too, and include_voice=False drops the voice
    res2 = call(server, "backup.export", {"project_id": p["id"], "include_voice": False, "out_path": str(tmp_path / "novoice.zip")})
    imp2 = call(dst, "backup.import", {"path": res2["path"], "folder": "Imported"})
    view2 = call(dst, "projects.get", {"id": imp2["project_id"]})
    assert imp2["voice_id"] is None and view2["project"]["voice_id"] is None and view2["project"]["folder"] == "Imported"
    assert len(view2["segments"]) == 3


def test_export_validation(server, tmp_path):
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.export", {"project_id": "proj_missing"})
    assert ei.value.code == NOT_FOUND
    p = call(server, "projects.create", {"name": "Empty"})
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.export", {"project_id": p["id"], "out_path": "relative/path.zip"})
    assert ei.value.code == INVALID_PARAMS
    out = tmp_path / "e.zip"
    out.write_bytes(b"existing")
    res = call(server, "backup.export", {"project_id": p["id"], "out_path": str(out)})
    assert Path(res["path"]) != out and out.read_bytes() == b"existing"       # never overwrites


def _zip(path: Path, entries: dict[str, bytes], manifest: dict | None = None) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        if manifest is not None:
            z.writestr("manifest.json", json.dumps(manifest))
        for name, data in entries.items():
            z.writestr(name, data)
    return path


def _manifest(**over) -> dict:
    m = {"format": "sfvs-backup", "version": 1, "exported_at": "x", "project": {"name": "P"}, "script": {"version": 1, "text": "Hi."},
         "segments": [{"id": "s1", "index": 0, "paragraph": 0, "text": "Hi.", "normalized_text": "Hi.", "selected_take_id": "t1"}],
         "takes": [{"id": "t1", "segment_id": "s1", "engine_id": "e", "file": "assets/takes/t1.wav"}], "voice": None, "references": []}
    m.update(over)
    return m


def test_import_rejects_unsafe_archives(server, tmp_path):
    wav = b"RIFF" + b"\0" * 40
    cases = {
        "traversal": ({"../evil.wav": wav}, CORRUPT_FILE),
        "absolute": ({"/tmp/evil.wav": wav}, CORRUPT_FILE),
        "backslash": ({"assets\\..\\evil.wav": wav}, CORRUPT_FILE),
        "drive": ({"C:/evil.wav": wav}, CORRUPT_FILE),
        "extension": ({"assets/run.sh": b"#!/bin/sh\nrm -rf /\n"}, UNSUPPORTED_FILE),
    }
    for name, (entries, code) in cases.items():
        zp = _zip(tmp_path / f"{name}.zip", {"assets/takes/t1.wav": wav, **entries}, _manifest())
        with pytest.raises(WorkerError) as ei:
            call(server, "backup.import", {"path": str(zp)})
        assert ei.value.code == code, name
        assert not ei.value.recoverable
    # symlink entry
    zp = tmp_path / "symlink.zip"
    with zipfile.ZipFile(zp, "w") as z:
        z.writestr("manifest.json", json.dumps(_manifest()))
        z.writestr("assets/takes/t1.wav", wav)
        zi = zipfile.ZipInfo("assets/link.wav")
        zi.external_attr = (0o120777 << 16)
        z.writestr(zi, "/etc/passwd")
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.import", {"path": str(zp)})
    assert ei.value.code == CORRUPT_FILE and "symbolic" in ei.value.message
    # missing / invalid manifest, missing referenced file, newer format
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.import", {"path": str(_zip(tmp_path / "nomanifest.zip", {"assets/takes/t1.wav": wav}))})
    assert ei.value.code == CORRUPT_FILE and "manifest" in ei.value.message
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.import", {"path": str(_zip(tmp_path / "badmanifest.zip", {}, {"format": "other"}))})
    assert ei.value.code == CORRUPT_FILE
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.import", {"path": str(_zip(tmp_path / "missingfile.zip", {}, _manifest()))})
    assert ei.value.code == CORRUPT_FILE and "t1" in ei.value.message
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.import", {"path": str(_zip(tmp_path / "newer.zip", {"assets/takes/t1.wav": wav}, _manifest(version=9)))})
    assert ei.value.code == UNSUPPORTED_FILE
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.import", {"path": str(tmp_path / "nope.zip")})
    assert ei.value.code == NOT_FOUND
    notzip = tmp_path / "text.zip"
    notzip.write_text("hello")
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.import", {"path": str(notzip)})
    assert ei.value.code == UNSUPPORTED_FILE
    # a truncated archive is reported as corrupt, not as an internal error
    good = _zip(tmp_path / "good.zip", {"assets/takes/t1.wav": wav * 200}, _manifest())
    broken = tmp_path / "broken.zip"
    broken.write_bytes(good.read_bytes()[:-200])
    with pytest.raises(WorkerError) as ei:
        call(server, "backup.import", {"path": str(broken)})
    assert ei.value.code in (CORRUPT_FILE, UNSUPPORTED_FILE)
    # nothing was created in the database by any of the rejected archives
    db = server.state["db"]
    assert db.one("SELECT COUNT(*) AS n FROM projects")["n"] == 0 and db.one("SELECT COUNT(*) AS n FROM voices")["n"] == 0


def test_size_caps():
    big = zipfile.ZipInfo("assets/takes/big.wav")
    big.file_size = MAX_ENTRY_BYTES + 1
    with pytest.raises(WorkerError) as ei:
        _check_entry(big, 0)
    assert ei.value.code == UNSUPPORTED_FILE and "4 GB" in ei.value.message
    ok = zipfile.ZipInfo("assets/takes/ok.wav")
    ok.file_size = MAX_ENTRY_BYTES
    total = 0
    for _ in range(5):
        total = _check_entry(ok, total)
    with pytest.raises(WorkerError) as ei:
        _check_entry(ok, total)
    assert "20 GB" in ei.value.message
    assert _check_entry(zipfile.ZipInfo("assets/"), 0) == 0

