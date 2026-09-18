"""XDG-style directory layout and path validation."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from .protocol import PERMISSION_DENIED, WorkerError

APP_SLUG = "com.shadowfetch.voicestudio"   # matches the Tauri identifier so the shell, worker and asset scope agree


def _xdg(var: str, default: str) -> Path:
    return Path(os.environ.get(var) or (Path.home() / default))


@dataclass
class AppPaths:
    data: Path
    config: Path
    cache: Path
    models: Path

    @classmethod
    def build(cls, data: str | None = None, config: str | None = None, cache: str | None = None,
              models: str | None = None) -> "AppPaths":
        d = Path(data) if data else _xdg("XDG_DATA_HOME", ".local/share") / APP_SLUG
        c = Path(config) if config else _xdg("XDG_CONFIG_HOME", ".config") / APP_SLUG
        k = Path(cache) if cache else _xdg("XDG_CACHE_HOME", ".cache") / APP_SLUG
        m = Path(models) if models else d / "models"
        p = cls(d, c, k, m)
        p.ensure()
        return p

    # subdirectories
    @property
    def recordings(self) -> Path: return self.data / "recordings"
    @property
    def voices(self) -> Path: return self.data / "voices"
    @property
    def projects(self) -> Path: return self.data / "projects"
    @property
    def exports(self) -> Path: return self.data / "exports"
    @property
    def tmp(self) -> Path: return self.cache / "tmp"
    @property
    def peaks(self) -> Path: return self.cache / "peaks"
    @property
    def prompts(self) -> Path: return self.cache / "prompts"
    @property
    def logs(self) -> Path: return self.data / "logs"
    @property
    def db_file(self) -> Path: return self.data / "studio.db"
    @property
    def settings_file(self) -> Path: return self.config / "settings.json"
    @property
    def hf_cache(self) -> Path: return self.models / "hf"

    def ensure(self) -> None:
        for d in (self.data, self.config, self.cache, self.models, self.recordings, self.voices, self.projects,
                  self.exports, self.tmp, self.peaks, self.prompts, self.logs, self.hf_cache):
            d.mkdir(parents=True, exist_ok=True)
        # recordings / voices contain personal audio: restrict permissions
        for d in (self.data, self.recordings, self.voices, self.projects):
            try:
                os.chmod(d, 0o700)
            except OSError:
                pass

    # ---- validation
    def allowed_roots(self) -> list[Path]:
        return [self.data, self.cache, self.models]

    def resolve_inside(self, path: str | Path, extra_roots: list[Path] | None = None) -> Path:
        """Resolve `path` and make sure it lives under a managed root (or an explicitly allowed one)."""
        p = Path(path).expanduser().resolve()
        roots = self.allowed_roots() + list(extra_roots or [])
        for r in roots:
            try:
                p.relative_to(r.resolve())
                return p
            except ValueError:
                continue
        raise WorkerError(PERMISSION_DENIED, f"Path is outside the managed storage: {p}", {"path": str(p)}, False)


_SAFE_NAME = re.compile(r"[^\w\-. ()\[\]&,'+]+", re.UNICODE)


def safe_filename(name: str, default: str = "untitled", max_len: int = 120) -> str:
    """Filesystem-safe base name (no path separators, control chars, or leading dots)."""
    s = _SAFE_NAME.sub("_", (name or "").strip()).strip(" .")
    s = re.sub(r"\s+", " ", s)
    return (s[:max_len] or default)


def unique_path(path: Path) -> Path:
    """Return `path` or `name (2).ext`, `name (3).ext` … if it exists."""
    if not path.exists():
        return path
    n = 2
    while True:
        cand = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not cand.exists():
            return cand
        n += 1


def free_bytes(path: Path) -> int:
    st = os.statvfs(path if path.exists() else path.parent)
    return st.f_bavail * st.f_frsize


def require_free_space(path: Path, needed: int, what: str = "this operation") -> None:
    free = free_bytes(path)
    if free < needed:
        raise WorkerError("DISK_FULL", f"Not enough free disk space for {what}: {free // 1_000_000} MB free, "
                          f"{needed // 1_000_000} MB needed.", {"free_bytes": free, "needed_bytes": needed}, True)
