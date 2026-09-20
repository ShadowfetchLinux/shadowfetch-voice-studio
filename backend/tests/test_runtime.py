"""Managed runtime must not follow a leftover symlink into the git checkout."""
from __future__ import annotations

from pathlib import Path

from shadowfetch_worker.paths import AppPaths
from shadowfetch_worker.runtime import Runtime


def test_refuses_checkout_linked_env(tmp_path, monkeypatch):
    data, config, cache = tmp_path / "data", tmp_path / "config", tmp_path / "cache"
    monkeypatch.setattr("shadowfetch_worker.runtime.BACKEND_DIR", tmp_path / "pkg-backend")
    checkout = tmp_path / "checkout" / ".venv" / "bin"
    checkout.mkdir(parents=True)
    (checkout / "python").write_text("#!/bin/true\n")
    (checkout / "python").chmod(0o755)
    runtime_root = data / "runtime"
    (runtime_root / "envs").mkdir(parents=True)
    linked = runtime_root / "envs" / "chatterbox"
    linked.symlink_to(tmp_path / "checkout" / ".venv")
    monkeypatch.delenv("SFVS_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("SFVS_ENV_CHATTERBOX_PYTHON", raising=False)
    paths = AppPaths.build(str(data), str(config), str(cache))
    rt = Runtime(paths)
    assert rt.env_python("chatterbox") is None
    assert rt._usable_env_python(linked / "bin" / "python") is None


def test_accepts_real_runtime_env(tmp_path, monkeypatch):
    monkeypatch.setattr("shadowfetch_worker.runtime.BACKEND_DIR", tmp_path / "pkg-backend")
    data, config, cache = tmp_path / "data", tmp_path / "config", tmp_path / "cache"
    py = data / "runtime" / "envs" / "chatterbox" / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text("#!/bin/true\n")
    py.chmod(0o755)
    monkeypatch.delenv("SFVS_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("SFVS_ENV_CHATTERBOX_PYTHON", raising=False)
    paths = AppPaths.build(str(data), str(config), str(cache))
    rt = Runtime(paths)
    assert rt.env_python("chatterbox") == py
