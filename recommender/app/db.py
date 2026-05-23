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


# sqlite-vec PARTITION KEY routes queries by partition but the rowid is
# still a globally-unique INTEGER PRIMARY KEY (it's the underlying
# vec0_chunks key). Using the raw tmdb_id as rowid collides across
# kinds — a movie and a TV show can both have id 1399, and the second
# insert violates the primary key constraint. Encode kind into bit 32
# so movie rows keep their natural id and TV rows live above the
# bit-32 boundary. TMDB ids fit in ~25 bits in practice, so bit 32+ is
# safely unused.
_KIND_BIT = 1 << 32


def encode_vec_rowid(kind: str, tmdb_id: int) -> int:
    if kind == "movie":
        return tmdb_id
    if kind == "tv":
        return tmdb_id | _KIND_BIT
    raise ValueError(f"unknown kind: {kind!r}")


def decode_vec_rowid(rowid: int) -> tuple[str, int]:
    if rowid & _KIND_BIT:
        return ("tv", rowid & ~_KIND_BIT)
    return ("movie", rowid)


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
    try:
        return _migrate(conn)
    finally:
        # Startup-only function, but leaking a connection across reloads
        # (e.g. test runs that import-and-reimport the module) holds the
        # WAL open and shows up as a dangling reader in sqlite3 stats.
        conn.close()


def _migrate(conn: sqlite3.Connection) -> list[str]:
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

        # One-shot migration: the vec rowid scheme changed from "tmdb_id
        # alone" to "kind-encoded" (see encode_vec_rowid). Detect legacy
        # rows by looking for TV rows with a rowid below _KIND_BIT and,
        # if any exist, wipe title_vec + title_features so the featurize
        # worker rebuilds under the new scheme. Re-ingest is cheap on
        # the typical NAS catalog (< 30 minutes).
        try:
            legacy = cur.execute(
                "SELECT 1 FROM title_vec WHERE kind = 'tv' AND rowid < ? LIMIT 1",
                (_KIND_BIT,),
            ).fetchone()
        except sqlite3.OperationalError:
            # Table doesn't exist yet — first boot, nothing to migrate.
            legacy = None
        if legacy is not None:
            log.warning(
                "wiping title_vec/title_features to migrate to kind-encoded rowids",
            )
            cur.execute("DROP TABLE title_vec")
            cur.execute("DELETE FROM title_features")
            applied.append("(internal) vec_rowid_migration")

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
