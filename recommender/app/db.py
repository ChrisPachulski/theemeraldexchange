"""SQLite + sqlite-vec connection helper.

Two connection flavors:

* :func:`connect` returns a connection with the vec0 extension loaded and the
  per-connection PRAGMAs we want (WAL, NORMAL synchronous, mmap).
* :func:`migrate` applies any unapplied SQL files from ``migrations/`` plus
  the vec0 virtual table that depends on the extension being loaded.

The vec0 virtual table (``title_vec``) lives here rather than in the .sql
migrations because it requires the extension to be loaded first.
"""

from __future__ import annotations

import argparse
import logging
import sqlite3
import struct
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import numpy as np
import sqlite_vec

from .config import CONFIG

log = logging.getLogger(__name__)


VEC_TABLE_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS title_vec USING vec0(
  rowid         INTEGER PRIMARY KEY,
  kind          TEXT    PARTITION KEY,
  embedding     float[{dim}] distance_metric=cosine
);
"""

SCHEMA_VERSION_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
"""


def connect(*, db_path: Path | None = None, readonly: bool = False) -> sqlite3.Connection:
    target = db_path or CONFIG.db_path
    target.parent.mkdir(parents=True, exist_ok=True)
    uri = f"file:{target}?mode={'ro' if readonly else 'rwc'}"
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA mmap_size=268435456")  # 256 MiB
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn


@contextmanager
def cursor(conn: sqlite3.Connection) -> Iterator[sqlite3.Cursor]:
    cur = conn.cursor()
    try:
        yield cur
    finally:
        cur.close()


def serialize_f32(vec: np.ndarray) -> bytes:
    if vec.dtype != np.float32:
        vec = vec.astype(np.float32)
    return struct.pack(f"{vec.size}f", *vec.tolist())


def deserialize_f32(blob: bytes, dim: int | None = None) -> np.ndarray:
    arr = np.frombuffer(blob, dtype=np.float32)
    if dim is not None and arr.size != dim:
        raise ValueError(f"vector length {arr.size} != expected {dim}")
    return arr


def migrate(*, db_path: Path | None = None) -> list[str]:
    """Apply any unapplied migrations in order; return the list applied."""
    conn = connect(db_path=db_path)
    applied: list[str] = []
    with cursor(conn) as cur:
        cur.execute(SCHEMA_VERSION_DDL)
        cur.execute("SELECT filename FROM schema_migrations")
        seen = {row["filename"] for row in cur.fetchall()}

        files = sorted(p for p in CONFIG.migrations_dir.glob("*.sql"))
        for f in files:
            if f.name in seen:
                continue
            log.info("applying migration %s", f.name)
            cur.executescript(f.read_text())
            cur.execute(
                "INSERT INTO schema_migrations(filename, applied_at) VALUES (?, datetime('now'))",
                (f.name,),
            )
            applied.append(f.name)

        # vec0 virtual table; depends on the loaded extension.
        cur.execute(VEC_TABLE_DDL.format(dim=CONFIG.embed_dim))

    return applied


def _cli() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--migrate", action="store_true", help="apply pending migrations")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.migrate:
        applied = migrate()
        if applied:
            print("applied:", ", ".join(applied))
        else:
            print("no migrations to apply")
    else:
        ap.print_help()


if __name__ == "__main__":
    _cli()
