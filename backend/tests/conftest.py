"""Shared fixtures: isolated app dirs, a fake transport/server/ctx, and a fake Hugging Face cache layout."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def pytest_configure(config):
    config.addinivalue_line("markers", "realmodel: needs the real models + GPU (SFVS_REAL_MODELS=1)")


class FakeTransport:
    def __init__(self):
        self.messages: list[dict] = []

    def send(self, obj: dict) -> None:
        self.messages.append(obj)

    def event(self, name: str, data: dict) -> None:
        from shadowfetch_worker.protocol import envelope_event
        self.send(envelope_event(name, data))

    def events(self, name: str | None = None) -> list[dict]:
        return [m for m in self.messages if m.get("type") == "event" and (name is None or m.get("event") == name)]

    def progress(self) -> list[dict]:
        return [m for m in self.messages if m.get("type") == "progress"]


@pytest.fixture
def app(tmp_path, monkeypatch):
    """Isolated AppPaths + SettingsStore + Database + Server (no engines)."""
    from shadowfetch_worker.paths import AppPaths
    from shadowfetch_worker.rpc import Server
    from shadowfetch_worker.settings import SettingsStore
    from shadowfetch_worker.store.db import Database
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    paths = AppPaths.build(str(tmp_path / "data"), str(tmp_path / "config"), str(tmp_path / "cache"))
    settings = SettingsStore(paths.settings_file)
    db = Database(paths.db_file)
    transport = FakeTransport()
    server = Server(transport, worker_name="test", gpu_slots=1)
    server.state.update({"paths": paths, "settings": settings, "db": db})
    yield server
    server.pool.shutdown(wait=False, cancel_futures=True)


@pytest.fixture
def ctx(app):
    from shadowfetch_worker.rpc import Ctx
    return Ctx(req_id="req-1", method="test", transport=app.transport, server=app)


def make_hf_snapshot(hf_cache: Path, repo: str, sha: str, files: dict[str, int | bytes], incomplete: int = 0, set_main: bool = True) -> Path:
    """Create <hf_cache>/models--Org--Name/{refs/main, snapshots/<sha>/..., blobs/...} the way huggingface_hub does."""
    root = hf_cache / ("models--" + repo.replace("/", "--"))
    snap = root / "snapshots" / sha
    blobs = root / "blobs"
    (root / "refs").mkdir(parents=True, exist_ok=True)
    snap.mkdir(parents=True, exist_ok=True)
    blobs.mkdir(parents=True, exist_ok=True)
    if set_main:
        (root / "refs" / "main").write_text(sha)
    for i, (rel, content) in enumerate(files.items()):
        data = content if isinstance(content, bytes) else (b"x" * int(content))
        blob = blobs / f"blob{sha[:6]}{i:03d}"
        blob.write_bytes(data)
        target = snap / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        rel_link = os.path.relpath(blob, target.parent)
        os.symlink(rel_link, target)
    for j in range(incomplete):
        (blobs / f"partial{j}.incomplete").write_bytes(b"y" * 10)
    return snap
