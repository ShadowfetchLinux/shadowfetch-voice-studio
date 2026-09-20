"""Model directory verification (pure filesystem checks — no network, no torch).

HF cache layout: <hf_cache>/models--Org--Name/{refs/<rev>, snapshots/<sha>/<files as symlinks>, blobs/<sha256>[.incomplete]}
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def repo_cache_dir(hf_cache: Path, repo: str) -> Path:
    return Path(hf_cache) / ("models--" + repo.replace("/", "--"))


def read_ref(hf_cache: Path, repo: str, ref: str = "main") -> str | None:
    p = repo_cache_dir(hf_cache, repo) / "refs" / ref
    try:
        s = p.read_text().strip()
        return s or None
    except OSError:
        return None


def snapshot_dir(hf_cache: Path, repo: str, revision: str | None) -> Path | None:
    """Snapshot directory for the pinned revision (or refs/main when unpinned). None when it does not exist."""
    root = repo_cache_dir(hf_cache, repo)
    sha = revision or read_ref(hf_cache, repo, "main")
    if not sha:
        return None
    d = root / "snapshots" / sha
    return d if d.is_dir() else None


def incomplete_blobs(hf_cache: Path, repo: str) -> list[str]:
    blobs = repo_cache_dir(hf_cache, repo) / "blobs"
    if not blobs.is_dir():
        return []
    return sorted(p.name for p in blobs.iterdir() if p.name.endswith(".incomplete"))


def dir_size(path: Path) -> int:
    """Bytes of every regular file under path (each blob counted once).

    Symlinked FILES are followed (HF snapshots are symlinks into blobs/) but directories are never descended twice:
    every visited directory is tracked by (st_dev, st_ino), so a directory-symlink cycle terminates instead of
    walking forever.
    """
    seen_files: set[tuple[int, int]] = set()
    seen_dirs: set[tuple[int, int]] = set()
    total = 0
    try:
        root_st = os.stat(path)
    except OSError:
        return 0
    seen_dirs.add((root_st.st_dev, root_st.st_ino))
    for root, dirs, files in os.walk(path, followlinks=True):
        keep = []
        for d in dirs:
            try:
                st = os.stat(os.path.join(root, d))
            except OSError:
                continue
            key = (st.st_dev, st.st_ino)
            if key in seen_dirs:
                continue           # already visited (symlink cycle or duplicate link) → prune
            seen_dirs.add(key)
            keep.append(d)
        dirs[:] = keep
        for f in files:
            try:
                st = os.stat(os.path.join(root, f))
            except OSError:
                continue
            key = (st.st_dev, st.st_ino)
            if key in seen_files:
                continue
            seen_files.add(key)
            total += st.st_size
    return total


@dataclass
class VerifyResult:
    ok: bool
    path: str | None
    revision: str | None
    missing_files: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    size_bytes: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "path": self.path, "revision": self.revision, "missing_files": self.missing_files,
                "errors": self.errors, "size_bytes": self.size_bytes}


def verify_dir(model_dir: Path, required_files: list[str], revision: str | None, extra_errors: list[str] | None = None) -> VerifyResult:
    """Every required file present (symlink targets exist, size > 0) and no dangling symlink anywhere in the dir."""
    model_dir = Path(model_dir)
    res = VerifyResult(ok=False, path=str(model_dir), revision=revision, errors=list(extra_errors or []))
    if not model_dir.is_dir():
        res.errors.append(f"directory does not exist: {model_dir}")
        return res
    for rel in required_files:
        p = model_dir / rel
        if not p.exists():   # follows symlinks: a dangling link counts as missing
            res.missing_files.append(rel)
            continue
        try:
            if p.stat().st_size <= 0:
                res.errors.append(f"{rel} is empty")
        except OSError as e:
            res.errors.append(f"{rel}: {e}")
    # any dangling symlink in the snapshot means an interrupted download
    for root, _dirs, files in os.walk(model_dir):
        for f in files:
            fp = Path(root) / f
            if fp.is_symlink() and not fp.exists():
                rel = str(fp.relative_to(model_dir))
                if rel not in res.missing_files:
                    res.errors.append(f"{rel}: broken link (blob missing)")
    res.ok = not res.missing_files and not res.errors
    if res.ok:
        res.size_bytes = dir_size(model_dir)
    return res


def read_tts_model_type(model_dir: Path) -> str | None:
    """`config.json` `tts_model_type` when present (Qwen3-TTS: base / custom_voice / voice_design). No torch."""
    try:
        import json
        cfg = json.loads((Path(model_dir) / "config.json").read_text())
    except (OSError, ValueError, TypeError):
        return None
    val = cfg.get("tts_model_type")
    return str(val) if val else None


def verify_hf_snapshot(hf_cache: Path, repo: str, revision: str | None, required_files: list[str]) -> VerifyResult:
    snap = snapshot_dir(hf_cache, repo, revision)
    rev = revision or read_ref(hf_cache, repo, "main")
    if snap is None:
        return VerifyResult(ok=False, path=None, revision=rev, missing_files=list(required_files),
                            errors=["snapshot not present"])
    partial = incomplete_blobs(hf_cache, repo)
    extra = [f"partial download present ({len(partial)} incomplete blob{'s' if len(partial) != 1 else ''})"] if partial else []
    return verify_dir(snap, required_files, rev, extra_errors=extra)
