"""ModelManager against a fake Hugging Face cache layout (no network, no torch)."""
from __future__ import annotations

import json
import os
import sys
import textwrap
from pathlib import Path

import pytest

from shadowfetch_worker.jobs.models import get_models
from shadowfetch_worker.models.registry import MODELS
from shadowfetch_worker.protocol import WorkerError
from tests.conftest import make_hf_snapshot

QWEN = "qwen3-tts-12hz-1.7b-base"
QWEN_SHA = MODELS[QWEN]["revision"]
QWEN_FILES = {f: 100 for f in MODELS[QWEN]["required_files"]} | {"README.md": b"# readme"}
WHISPER = "faster-whisper-small.en"


def test_missing_by_default(app, ctx):
    mm = get_models(ctx)
    assert app.state["models"] is mm
    st = mm.state(QWEN)
    assert st["state"] == "missing" and st["path"] is None and st["revision_pinned"] == QWEN_SHA
    with pytest.raises(WorkerError) as ei:
        mm.resolve_installed_dir(QWEN)
    assert ei.value.code == "MODEL_MISSING"
    assert "Settings → Engines & models" in ei.value.message and "4.5 GB" in ei.value.message
    assert {m["id"] for m in mm.list()} == set(MODELS)


def test_installed_pinned_snapshot(app, ctx):
    mm = get_models(ctx)
    snap = make_hf_snapshot(mm.hf_cache, MODELS[QWEN]["repo"], QWEN_SHA, QWEN_FILES)
    st = mm.state(QWEN)
    assert st["state"] == "installed"
    assert Path(st["path"]) == snap
    assert st["revision_installed"] == QWEN_SHA
    assert st["size_bytes"] == len(MODELS[QWEN]["required_files"]) * 100 + len(b"# readme")
    assert mm.resolve_installed_dir(QWEN) == snap
    assert mm.installed_revision(QWEN) == QWEN_SHA
    row = app.state["db"].one("SELECT * FROM models WHERE id = ?", (QWEN,))
    assert row["state"] == "installed" and row["revision_installed"] == QWEN_SHA


def test_wrong_revision_is_missing(app, ctx):
    mm = get_models(ctx)
    make_hf_snapshot(mm.hf_cache, MODELS[QWEN]["repo"], "0" * 40, QWEN_FILES)
    assert mm.state(QWEN)["state"] == "missing"


def test_unpinned_model_uses_refs_main(app, ctx):
    mm = get_models(ctx)
    assert MODELS[WHISPER]["revision"] is None
    snap = make_hf_snapshot(mm.hf_cache, MODELS[WHISPER]["repo"], "abc123", {"model.bin": 50, "config.json": b"{}", "tokenizer.json": b"{}", "vocabulary.txt": b"a"})
    st = mm.state(WHISPER)
    assert st["state"] == "installed" and st["revision_installed"] == "abc123" and Path(st["path"]) == snap
    assert mm.installed_revision(WHISPER) == "abc123"


def test_incomplete_blob_marks_invalid(app, ctx):
    mm = get_models(ctx)
    make_hf_snapshot(mm.hf_cache, MODELS[QWEN]["repo"], QWEN_SHA, QWEN_FILES, incomplete=1)
    st = mm.state(QWEN)
    assert st["state"] == "error" and "incomplete" in st["error"].lower()
    with pytest.raises(WorkerError) as ei:
        mm.resolve_installed_dir(QWEN)
    assert ei.value.code == "MODEL_INVALID"
    v = mm.verify(QWEN)
    assert v["ok"] is False and v["incomplete_blobs"] == ["partial0.incomplete"]


def test_missing_required_file_and_broken_link(app, ctx):
    mm = get_models(ctx)
    files = dict(QWEN_FILES)
    files.pop("speech_tokenizer/model.safetensors")
    snap = make_hf_snapshot(mm.hf_cache, MODELS[QWEN]["repo"], QWEN_SHA, files)
    v = mm.verify(QWEN)
    assert v["ok"] is False and v["missing_files"] == ["speech_tokenizer/model.safetensors"]
    # a dangling symlink (blob deleted) is also detected
    link = snap / "config.json"
    target = (link.parent / os.readlink(link)).resolve()
    target.unlink()
    v = mm.verify(QWEN)
    assert "config.json" in v["missing_files"]


def test_verify_ok_and_events(app, ctx):
    mm = get_models(ctx)
    make_hf_snapshot(mm.hf_cache, MODELS[QWEN]["repo"], QWEN_SHA, QWEN_FILES)
    v = mm.verify(QWEN)
    assert v["ok"] and v["missing_files"] == [] and v["revision"] == QWEN_SHA and v["size_bytes"] > 0
    states = [e["data"]["state"] for e in app.transport.events("model.state")]
    assert states[:2] == ["verifying", "installed"]


def test_read_tts_model_type_and_custom_voice_warning(app, ctx, tmp_path):
    from shadowfetch_worker.models.verify import read_tts_model_type

    empty = tmp_path / "empty"
    empty.mkdir()
    assert read_tts_model_type(empty) is None
    (empty / "config.json").write_text("{not json")
    assert read_tts_model_type(empty) is None
    mm = get_models(ctx)
    custom = tmp_path / "ft-qwen"
    for f in MODELS[QWEN]["required_files"]:
        (custom / f).parent.mkdir(parents=True, exist_ok=True)
        if f == "config.json":
            (custom / f).write_text(json.dumps({"tts_model_type": "custom_voice", "speakers": ["myvoice"]}))
        else:
            (custom / f).write_bytes(b"z" * 10)
    assert read_tts_model_type(custom) == "custom_voice"
    res = mm.use_existing_dir(QWEN, str(custom))
    assert res["ok"] and any("CustomVoice" in w for w in res["warnings"])


def test_custom_dir(app, ctx, tmp_path):
    mm = get_models(ctx)
    custom = tmp_path / "my-qwen"
    for f in MODELS[QWEN]["required_files"]:
        (custom / f).parent.mkdir(parents=True, exist_ok=True)
        (custom / f).write_bytes(b"z" * 10)
    res = mm.use_existing_dir(QWEN, str(custom))
    assert res["ok"] and res["revision"] == "local" and res["warnings"]
    st = mm.state(QWEN)
    assert st["state"] == "installed" and Path(st["path"]) == custom.resolve() and st["revision_installed"] == "local"
    assert mm.resolve_installed_dir(QWEN) == custom.resolve()
    assert mm.installed_revision(QWEN) == "local"
    # incomplete custom dir is refused
    (custom / "model.safetensors").unlink()
    with pytest.raises(WorkerError) as ei:
        mm.use_existing_dir(QWEN, str(custom))
    assert ei.value.code == "MODEL_INVALID" and "model.safetensors" in ei.value.message
    with pytest.raises(WorkerError):
        mm.use_existing_dir(QWEN, str(tmp_path / "nope"))
    # removing a custom dir only unlinks it: files stay
    (custom / "model.safetensors").write_bytes(b"z" * 10)
    mm.use_existing_dir(QWEN, str(custom))
    res = mm.remove(QWEN, confirm=True)
    assert res["ok"] and res["deleted"] is False
    assert (custom / "config.json").exists()
    assert mm.state(QWEN)["state"] == "missing"


def test_remove_managed_dir(app, ctx):
    mm = get_models(ctx)
    make_hf_snapshot(mm.hf_cache, MODELS[QWEN]["repo"], QWEN_SHA, QWEN_FILES)
    root = mm.hf_cache / "models--Qwen--Qwen3-TTS-12Hz-1.7B-Base"
    assert root.is_dir()
    with pytest.raises(WorkerError):
        mm.remove(QWEN, confirm=False)
    res = mm.remove(QWEN, confirm=True)
    assert res["ok"] and res["deleted"] and res["freed_bytes"] > 0
    assert not root.exists()
    assert mm.state(QWEN)["state"] == "missing"
    assert app.transport.events("model.state")[-1]["data"]["state"] == "missing"


def test_offline_blocks_download(app, ctx):
    mm = get_models(ctx)
    app.state["settings"].patch({"offline": True})
    with pytest.raises(WorkerError) as ei:
        mm.download(ctx, QWEN)
    assert ei.value.code == "OFFLINE_BLOCKED"
    # the MODEL_MISSING message carries the offline hint too
    with pytest.raises(WorkerError) as ei:
        mm.resolve_installed_dir(QWEN)
    assert ei.value.code == "MODEL_MISSING" and "Offline mode" in ei.value.message and ei.value.details["hint"] == "OFFLINE_BLOCKED"


def test_offline_env_var_blocks_download(app, ctx, monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    mm = get_models(ctx)
    with pytest.raises(WorkerError) as ei:
        mm.download(ctx, WHISPER)
    assert ei.value.code == "OFFLINE_BLOCKED"


def test_download_disk_full_precheck(app, ctx, monkeypatch):
    mm = get_models(ctx)
    monkeypatch.setattr("shadowfetch_worker.models.manager.require_free_space",
                        lambda *a, **k: (_ for _ in ()).throw(WorkerError("DISK_FULL", "no space")))
    with pytest.raises(WorkerError) as ei:
        mm.download(ctx, QWEN)
    assert ei.value.code == "DISK_FULL"


FAKE_DOWNLOADER = textwrap.dedent('''
    import json, os, sys, time
    sys.path.insert(0, os.environ["SFVS_TEST_DIR"])
    from conftest import make_hf_snapshot
    from pathlib import Path
    args = sys.argv[1:]
    repo = args[args.index("--repo") + 1]; cache = Path(args[args.index("--cache-dir") + 1])
    rev = args[args.index("--revision") + 1] if "--revision" in args else "deadbeef"
    mode = os.environ.get("FAKE_MODE", "ok")
    for i in range(3):
        print(json.dumps({"bytes_done": (i + 1) * 100, "bytes_total": 400, "files_done": i, "files_total": 4}), flush=True)
        if mode == "hang":
            time.sleep(0.2)
    if mode == "hang":
        time.sleep(30)
    if mode == "error":
        print(json.dumps({"error": "DOWNLOAD_FAILED", "message": "Network error while downloading: boom"}), flush=True)
        sys.exit(2)
    files = json.loads(os.environ["FAKE_FILES"])
    snap = make_hf_snapshot(cache, repo, rev, {k: int(v) for k, v in files.items()}, incomplete=int(os.environ.get("FAKE_INCOMPLETE", "0")))
    print(json.dumps({"done": True, "path": str(snap), "revision": rev}), flush=True)
''')


@pytest.fixture
def fake_downloader(tmp_path, monkeypatch):
    script = tmp_path / "fake_download_proc.py"
    script.write_text(FAKE_DOWNLOADER)
    monkeypatch.setenv("SFVS_TEST_DIR", str(Path(__file__).parent))
    monkeypatch.setenv("FAKE_FILES", json.dumps({f: 100 for f in MODELS[QWEN]["required_files"]}))
    import subprocess as sp
    real_popen = sp.Popen

    def popen(cmd, *a, **k):
        assert cmd[1:3] == ["-m", "shadowfetch_worker.models.download_proc"]
        assert "--repo" in cmd and "--cache-dir" in cmd and "--revision" in cmd
        return real_popen([sys.executable, str(script)] + cmd[3:], *a, **k)

    monkeypatch.setattr("shadowfetch_worker.models.manager.subprocess.Popen", popen)
    return script


def test_download_flow(app, ctx, fake_downloader):
    mm = get_models(ctx)
    res = mm.download(ctx, QWEN)
    expected = len(MODELS[QWEN]["required_files"]) * 100
    assert res["model_id"] == QWEN and res["revision"] == QWEN_SHA and res["size_bytes"] == expected
    assert mm.state(QWEN)["state"] == "installed"
    prog = app.transport.progress()
    dl = [p for p in prog if p["stage"] == "download"]
    assert dl and dl[-1]["current"] == dl[-1]["total"] == expected   # measured bytes, never a percentage
    assert any(p.get("detail", {}).get("bytes_total") in (400, expected) for p in dl)
    assert all("bytes_done" in p.get("detail", {}) for p in prog if p["stage"] == "download")
    states = [e["data"]["state"] for e in app.transport.events("model.state")]
    assert states[0] == "downloading" and states[-1] == "installed" and "verifying" in states
    row = app.state["db"].one("SELECT * FROM models WHERE id = ?", (QWEN,))
    assert row["state"] == "installed" and row["revision_installed"] == QWEN_SHA and row["size_bytes"] == expected
    assert (app.state["paths"].logs / "download.log").exists()
    assert ctx.subprocesses, "download process must be tracked so cancel kills it"


def test_download_error_propagates(app, ctx, fake_downloader, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "error")
    mm = get_models(ctx)
    with pytest.raises(WorkerError) as ei:
        mm.download(ctx, QWEN)
    assert ei.value.code == "DOWNLOAD_FAILED" and "boom" in ei.value.message
    assert mm.state(QWEN)["state"] == "missing"
    assert app.state["db"].one("SELECT error FROM models WHERE id = ?", (QWEN,))["error"]


def test_download_verify_failure(app, ctx, fake_downloader, monkeypatch):
    monkeypatch.setenv("FAKE_INCOMPLETE", "1")
    mm = get_models(ctx)
    with pytest.raises(WorkerError) as ei:
        mm.download(ctx, QWEN)
    assert ei.value.code == "MODEL_INVALID"
    assert mm.state(QWEN)["state"] == "error"


def test_download_cancel(app, ctx, fake_downloader, monkeypatch):
    import threading
    monkeypatch.setenv("FAKE_MODE", "hang")
    mm = get_models(ctx)
    threading.Timer(0.6, ctx.cancel).start()
    with pytest.raises(WorkerError) as ei:
        mm.download(ctx, QWEN)
    assert ei.value.code == "CANCELLED" and ei.value.details["resumable"] is True
    assert QWEN not in mm.active
    assert mm.state(QWEN)["state"] == "missing"


def test_cancel_download_method(app, ctx, fake_downloader, monkeypatch):
    import threading
    import time
    monkeypatch.setenv("FAKE_MODE", "hang")
    mm = get_models(ctx)
    errors = []

    def run():
        try:
            mm.download(ctx, QWEN)
        except WorkerError as e:
            errors.append(e)

    t = threading.Thread(target=run)
    t.start()
    deadline = time.time() + 5
    while QWEN not in mm.active and time.time() < deadline:
        time.sleep(0.05)
    assert mm.state(QWEN)["state"] == "downloading"
    assert mm.cancel_download(QWEN) is True
    t.join(10)
    # a user cancel is a CANCELLED / resumable outcome, never a persisted DOWNLOAD_FAILED error (PROTOCOL: models.cancel_download)
    assert errors and errors[0].code == "CANCELLED", errors
    assert errors[0].details["resumable"] is True and errors[0].details["cancelled_by"] == "user"
    assert mm.cancel_download(QWEN) is False
    st = mm.state(QWEN)
    assert st["state"] == "missing" and not st.get("error")
    row = app.state["db"].one("SELECT * FROM models WHERE id = ?", (QWEN,))
    assert row["state"] == "missing" and not row["error"]
    assert app.transport.events("model.state")[-1]["data"].get("message") == "Download cancelled"


def test_rpc_methods_registered():
    from shadowfetch_worker.rpc import registry
    import shadowfetch_worker.jobs.models  # noqa: F401
    import shadowfetch_worker.jobs.engines  # noqa: F401
    import shadowfetch_worker.jobs.transcribe  # noqa: F401
    reg = registry()
    for name in ("models.list", "models.download", "models.cancel_download", "models.verify", "models.use_existing_dir", "models.remove",
                 "engine.list", "engine.capabilities", "engine.load", "engine.unload", "engine.prepare_reference", "engine.generate",
                 "transcribe.models", "transcribe.run"):
        assert name in reg, name
    assert reg["engine.load"].gpu and reg["engine.generate"].gpu and reg["engine.prepare_reference"].gpu
    assert not reg["transcribe.run"].gpu and not reg["models.download"].gpu


def test_download_proc_offline_guard(tmp_path, monkeypatch):
    """The subprocess refuses to run when HF_HUB_OFFLINE=1 (belt and braces)."""
    import subprocess
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "PYTHONPATH": str(Path(__file__).resolve().parent.parent)}
    r = subprocess.run([sys.executable, "-m", "shadowfetch_worker.models.download_proc", "--repo", "x/y", "--cache-dir", str(tmp_path)],
                       capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 3
    last = json.loads(r.stdout.strip().splitlines()[-1])
    assert last["error"] == "OFFLINE_BLOCKED"


def test_remove_cleans_shared_blob_store(app, ctx):
    """huggingface_hub 1.x layout: repo blobs are symlinks into <hf_cache>/blobs/<xx>/<sha>; remove() drops orphans only."""
    mm = get_models(ctx)
    store = mm.hf_cache / "blobs" / "ab"
    store.mkdir(parents=True)
    shared_only = store / ("ab" + "1" * 62)
    shared_common = store / ("ab" + "2" * 62)
    shared_only.write_bytes(b"q" * 100)
    shared_common.write_bytes(b"c" * 100)
    snap = make_hf_snapshot(mm.hf_cache, MODELS[QWEN]["repo"], QWEN_SHA, QWEN_FILES)
    repo_blobs = snap.parent.parent / "blobs"
    # turn two of the repo's blobs into symlinks to the shared store (as hub 1.x does)
    for link, target in ((snap / "config.json"), shared_only), ((snap / "model.safetensors"), shared_common):
        real = (link.parent / os.readlink(link)).resolve()
        real.unlink()
        os.symlink(os.path.relpath(target, real.parent), real)
    # another repo shares one of them
    other = make_hf_snapshot(mm.hf_cache, MODELS[WHISPER]["repo"], "zzz", {"model.bin": 10, "config.json": b"{}", "tokenizer.json": b"{}", "vocabulary.txt": b"a"})
    other_blob = (other / "model.bin").parent / os.readlink(other / "model.bin")
    other_blob = other_blob.resolve(); other_blob.unlink(); os.symlink(os.path.relpath(shared_common, other_blob.parent), other_blob)
    assert mm.state(QWEN)["state"] == "installed" and mm.state(WHISPER)["state"] == "installed"
    res = mm.remove(QWEN, confirm=True)
    assert res["deleted"] and res["shared_blobs_removed"] == 2
    assert not shared_only.exists(), "orphaned shared blob must be deleted"
    assert shared_common.exists(), "a blob still referenced by another repo must stay"
    assert mm.state(WHISPER)["state"] == "installed"


def test_use_existing_dir_revalidates_path(app, ctx, tmp_path, monkeypatch):
    """PROTOCOL: paths are absolute and re-validated by the worker — no cwd-relative or '~' paths, no '/' or pseudo-fs."""
    mm = get_models(ctx)
    custom = tmp_path / "rel-qwen"
    for f in MODELS[QWEN]["required_files"]:
        (custom / f).parent.mkdir(parents=True, exist_ok=True)
        (custom / f).write_bytes(b"z" * 10)
    monkeypatch.chdir(tmp_path)
    for bad in ("rel-qwen", "./rel-qwen", "~/rel-qwen", "", "/", "/proc", "/sys/kernel", "/dev"):
        with pytest.raises(WorkerError) as ei:
            mm.use_existing_dir(QWEN, bad)
        assert ei.value.code == "INVALID_PARAMS", bad
    assert mm.use_existing_dir(QWEN, str(custom))["ok"]


def test_dir_size_survives_symlink_cycles(tmp_path):
    from shadowfetch_worker.models.verify import dir_size
    root = tmp_path / "m"
    (root / "sub").mkdir(parents=True)
    (root / "a.bin").write_bytes(b"x" * 100)
    (root / "sub" / "b.bin").write_bytes(b"y" * 50)
    os.symlink(root, root / "sub" / "loop")            # directory symlink cycle
    os.symlink(root / "a.bin", root / "sub" / "a-link")  # file symlink → counted once
    assert dir_size(root) == 150


def test_qwen_required_files_cover_loader_inputs():
    """Everything Qwen3TTSModel.from_pretrained / AutoProcessor open unconditionally must be verified explicitly."""
    req = set(MODELS[QWEN]["required_files"])
    for f in ("config.json", "model.safetensors", "generation_config.json", "preprocessor_config.json", "tokenizer_config.json",
              "vocab.json", "merges.txt", "speech_tokenizer/model.safetensors", "speech_tokenizer/config.json",
              "speech_tokenizer/configuration.json", "speech_tokenizer/preprocessor_config.json"):
        assert f in req, f
    for mid, spec in MODELS.items():
        if spec["kind"] == "asr":
            assert "tokenizer.json" in spec["required_files"], mid          # else faster-whisper fetches openai/whisper-* online
            assert any(f.startswith("vocabulary.") for f in spec["required_files"]), mid


def test_asr_snapshot_without_tokenizer_is_not_installed(app, ctx):
    mm = get_models(ctx)
    make_hf_snapshot(mm.hf_cache, MODELS[WHISPER]["repo"], "abc123", {"model.bin": 50, "config.json": b"{}", "vocabulary.txt": b"a"})
    st = mm.state(WHISPER)
    assert st["state"] == "error" and "tokenizer.json" in st["error"]
    with pytest.raises(WorkerError) as ei:
        mm.resolve_installed_dir(WHISPER)
    assert ei.value.code == "MODEL_INVALID"
