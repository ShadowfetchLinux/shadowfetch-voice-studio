"""library.* methods: cross-entity search, folders and tags."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from ..rpc import Ctx, method
from ..store import repo


def S(ctx: Ctx) -> dict[str, Any]:
    return ctx.server.state


def _speak_id(ctx: Ctx) -> str:
    """The Speak screen's scratch project is internal and never listed ("" matches no row)."""
    settings = S(ctx).get("settings")
    return (settings.value.speak_project_id if settings is not None else None) or ""


class Search(BaseModel):
    query: str = ""
    include_archived: bool = False
    limit: int = 50


@method("library.search", params=Search)
def search(ctx: Ctx, p: Search) -> dict[str, Any]:
    """Case-insensitive substring search over names, tags, notes and (for projects) the latest script text."""
    db = S(ctx)["db"]
    like = f"%{p.query.strip()}%"
    arch = "" if p.include_archived else " AND archived = 0"
    projects = db.all(
        "SELECT * FROM projects p WHERE (name LIKE ? OR tags_json LIKE ? OR IFNULL(notes,'') LIKE ? OR folder LIKE ? "
        "OR EXISTS (SELECT 1 FROM scripts s WHERE s.project_id = p.id AND s.text LIKE ? "
        "AND s.version = (SELECT MAX(version) FROM scripts WHERE project_id = p.id)))" + arch + " AND id != ?"
        " ORDER BY updated_at DESC, rowid DESC LIMIT ?", (like, like, like, like, like, _speak_id(ctx), p.limit))
    voices = db.all("SELECT * FROM voices WHERE (name LIKE ? OR tags_json LIKE ? OR IFNULL(notes,'') LIKE ?)" + arch +
                    " ORDER BY updated_at DESC, rowid DESC LIMIT ?", (like, like, like, p.limit))
    return {"projects": [repo.project_dict(r) for r in projects],
            "voices": [repo.voice_dict(db, r, with_references=False) for r in voices]}


@method("library.folders")
def folders(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    db = S(ctx)["db"]
    rows = db.all("SELECT folder, COUNT(*) AS n, SUM(archived) AS archived FROM projects WHERE id != ? GROUP BY folder "
                  "ORDER BY folder COLLATE NOCASE", (_speak_id(ctx),))
    return {"folders": [{"name": r["folder"], "count": int(r["n"]), "archived": int(r["archived"] or 0)} for r in rows]}


@method("library.tags")
def tags(ctx: Ctx, params: dict[str, Any]) -> dict[str, Any]:
    db = S(ctx)["db"]
    counts: dict[str, dict[str, int]] = {}
    for table in ("projects", "voices"):
        for r in db.all(f"SELECT j.value AS tag, COUNT(*) AS n FROM {table} t, json_each(t.tags_json) j GROUP BY j.value"):
            counts.setdefault(str(r["tag"]), {"projects": 0, "voices": 0})[table] = int(r["n"])
    return {"tags": [{"name": t, "count": c["projects"] + c["voices"], **c} for t, c in sorted(counts.items(), key=lambda kv: kv[0].lower())]}
