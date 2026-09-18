"""SQLite access: migrations, per-thread connections, helpers."""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..protocol import DB_ERROR, NOT_FOUND, WorkerError

log = logging.getLogger("db")
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def new_id(prefix: str = "") -> str:
    return (prefix + "_" if prefix else "") + uuid.uuid4().hex[:16]


def dumps(o: Any) -> str:
    return json.dumps(o, ensure_ascii=False)


def loads(s: str | None, default: Any = None) -> Any:
    if not s:
        return default
    try:
        return json.loads(s)
    except ValueError:
        return default


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._local = threading.local()
        self._write_lock = threading.RLock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(str(self.path), timeout=30, isolation_level=None, check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA foreign_keys=ON")
            c.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = c
        return c

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """Serialized write transaction."""
        with self._write_lock:
            c = self.conn()
            try:
                c.execute("BEGIN IMMEDIATE")
                yield c
                c.execute("COMMIT")
            except Exception:
                c.execute("ROLLBACK")
                raise

    # ---- migrations
    def migrate(self) -> None:
        c = self.conn()
        c.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
        row = c.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
        current = row["v"] or 0
        files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        for f in files:
            m = re.match(r"(\d+)_", f.name)
            if not m:
                continue
            version = int(m.group(1))
            if version <= current:
                continue
            log.info("applying migration %s", f.name)
            # executescript() commits any open transaction first, so the migration is its own scripted transaction
            with self._write_lock:
                c.executescript("BEGIN;\n" + f.read_text() + f"\nINSERT INTO schema_version(version) VALUES ({version});\nCOMMIT;")

    # ---- helpers
    def one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        return self.conn().execute(sql, params).fetchone()

    def all(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return self.conn().execute(sql, params).fetchall()

    def require(self, table: str, id_: str) -> sqlite3.Row:
        row = self.one(f"SELECT * FROM {table} WHERE id = ?", (id_,))
        if row is None:
            raise WorkerError(NOT_FOUND, f"{table[:-1] if table.endswith('s') else table} not found: {id_}", {"table": table, "id": id_}, False)
        return row

    def update(self, table: str, id_: str, fields: dict[str, Any], touch: bool = True) -> None:
        if not fields:
            return
        cols = list(fields)
        sets = ", ".join(f"{k} = ?" for k in cols)
        if touch:
            sets += ", updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
        with self.tx() as c:
            c.execute(f"UPDATE {table} SET {sets} WHERE id = ?", tuple(fields[k] for k in cols) + (id_,))

    def insert(self, table: str, row: dict[str, Any]) -> None:
        cols = list(row)
        with self.tx() as c:
            c.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", tuple(row[k] for k in cols))


def row_to_dict(row: sqlite3.Row | None, json_cols: tuple[str, ...] = ()) -> dict[str, Any] | None:
    if row is None:
        return None
    d = dict(row)
    for col in json_cols:
        if col in d:
            d[col[:-5] if col.endswith("_json") else col] = loads(d.pop(col), [] if col in ("tags_json", "processing_json", "substitutions_json") else {})
    for k in list(d):
        if k in ("favorite", "archived", "rights_confirmed", "transcript_confirmed"):
            d[k] = bool(d[k])
    return d
