"""SQLite + sqlite-vec connection helper.

Two connection flavors:

* :func:`connect` returns a connection with the vec0 extension loaded and the
  per-connection PRAGMAs we want (WAL, NORMAL synchronous, mmap).
* :func:`migrate` applies any unapplied SQL files from ``migrations/`` plus
  the vec0 virtual table that depends on the extension being loaded.

The vec0 virtual table (``title_vec``) lives here rather than in the .sql
migrations because it requires the extension to be loaded first.

Migration table shape (canonical per §7.1):

    schema_migrations(
      version    INTEGER NOT NULL PRIMARY KEY,
      applied_at TEXT,
      checksum   TEXT NOT NULL   -- sha256 of LF-normalised .sql at apply time
    )

Legacy detection: if the DB contains the old ``schema_migrations(filename TEXT
PRIMARY KEY)`` shape the migrator performs a table-rebuild (CREATE NEW / INSERT
SELECT / DROP / RENAME) before any migration runs, backfilling ``version`` from
the filename prefix and ``checksum`` from the current file content.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import sqlite3
import struct
import time
from contextlib import contextmanager
from datetime import datetime, timezone
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

# How long a single migration may run before we emit a warning (seconds).
_SLOW_MIGRATION_THRESHOLD_S = 30

# How recent the last backup must be to permit a DESTRUCTIVE migration (seconds).
_BACKUP_MAX_AGE_S = 600  # 10 minutes


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _lf_normalize(text: str) -> str:
    """Return *text* with CRLF sequences replaced by LF."""
    return text.replace("\r\n", "\n")


def _sha256(text: str) -> str:
    """SHA-256 hex digest of *text* after LF normalisation."""
    return hashlib.sha256(_lf_normalize(text).encode()).hexdigest()


def _bootstrap_schema_migrations(
    conn: sqlite3.Connection,
    migrations_dir: Path,
) -> None:
    """Ensure schema_migrations is in the canonical shape.

    Idempotent: if the canonical table already exists this is a fast no-op.
    If the legacy ``filename TEXT PRIMARY KEY`` shape is found the table is
    rebuilt in-place via CREATE/INSERT/DROP/RENAME, backfilling ``version``
    from the filename prefix and ``checksum`` from the current file content.
    """
    rows = conn.execute("PRAGMA table_info(schema_migrations)").fetchall()

    if rows:
        first_col = rows[0][1] if isinstance(rows[0], (list, tuple)) else rows[0]["name"]
        if first_col == "version":
            # Already canonical — nothing to do.
            return
        if first_col != "filename":
            log.warning(
                "schema_migrations has unexpected first column %r; skipping reshape",
                first_col,
            )
            return

        # Legacy shape detected: schema_migrations(filename TEXT PRIMARY KEY, applied_at TEXT).
        log.info("schema_migrations: reshaping legacy filename-keyed table to canonical shape")

        # Read existing rows so we can backfill checksums.
        legacy_rows = conn.execute(
            "SELECT filename, applied_at FROM schema_migrations"
        ).fetchall()

        # Compute checksums from current file content where available.
        def _backfill_checksum(filename: str) -> str:
            f = migrations_dir / filename
            if f.exists():
                return _sha256(f.read_text(encoding="utf-8"))
            log.warning(
                "schema_migrations bootstrap: migration file %s not found on disk; "
                "storing empty-string checksum",
                filename,
            )
            return ""

        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                """
                CREATE TABLE schema_migrations_new (
                  version    INTEGER NOT NULL PRIMARY KEY,
                  applied_at TEXT,
                  checksum   TEXT    NOT NULL
                )
                """
            )
            for row in legacy_rows:
                filename = row[0] if isinstance(row, (list, tuple)) else row["filename"]
                applied_at = row[1] if isinstance(row, (list, tuple)) else row["applied_at"]
                version = int(filename[:4])
                checksum = _backfill_checksum(filename)
                conn.execute(
                    "INSERT INTO schema_migrations_new(version, applied_at, checksum) VALUES (?, ?, ?)",
                    (version, applied_at, checksum),
                )
            conn.execute("DROP TABLE schema_migrations")
            conn.execute(
                "ALTER TABLE schema_migrations_new RENAME TO schema_migrations"
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    else:
        # Table does not exist yet — create the canonical shape.
        conn.execute(
            """
            CREATE TABLE schema_migrations (
              version    INTEGER NOT NULL PRIMARY KEY,
              applied_at TEXT,
              checksum   TEXT    NOT NULL
            )
            """
        )


def _last_backup_at(db_path: Path) -> datetime | None:
    """Return the ``last_backup_at`` timestamp from the sibling server.db, or None."""
    server_db = db_path.parent / "server.db"
    if not server_db.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{server_db}?mode=ro", uri=True)
        try:
            row = conn.execute(
                "SELECT value FROM server_state WHERE key = 'last_backup_at'"
            ).fetchone()
            if row is None:
                return None
            return datetime.fromisoformat(row[0]).replace(tzinfo=timezone.utc)
        finally:
            conn.close()
    except (sqlite3.OperationalError, ValueError):
        return None


def _auto_backup(db_path: Path, migration_name: str) -> Path:
    """Write a consistent, timestamped backup of *db_path* beside it.

    Uses SQLite's online-backup API so the snapshot is consistent even though
    the migrator already holds a WAL-mode connection to the same database. The
    page-level copy does not need the sqlite-vec extension loaded (vec0 shadow
    tables are ordinary tables). Returns the backup path; raises on I/O failure
    so the caller can fall back to the external-backup gate.
    """
    stem = migration_name.split("_", 1)[0]
    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = db_path.with_name(f"{db_path.name}.pre{stem}-{ts}.bak")
    src = sqlite3.connect(str(db_path))
    try:
        dst = sqlite3.connect(str(backup_path))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return backup_path


def _check_backup_gate(db_path: Path, migration_name: str) -> None:
    """Abort (raise) unless a recent backup protects a ``-- DESTRUCTIVE`` migration.

    Satisfied by either path:
    1. An automatic, consistent backup of *db_path* taken here (primary). This
       is the most direct expression of the gate's intent — a recoverable copy
       must exist before a destructive change — and does not depend on a
       co-located ``server.db``, which the production volume layout does not
       provide (exchange.db and server.db live in separate Docker volumes).
    2. The legacy sibling-``server.db`` backup proof (fallback), for callers
       that manage an external backup and cannot write beside *db_path*.

    Raises ``RuntimeError`` only if neither can be established.
    """
    try:
        backup = _auto_backup(db_path, migration_name)
        log.info("[migration] wrote pre-migration backup: %s", backup)
        return
    except (OSError, sqlite3.Error) as exc:
        log.warning(
            "[migration] automatic backup failed (%s); falling back to the "
            "external server.db backup gate",
            exc,
        )

    server_db = db_path.parent / "server.db"
    if not server_db.exists():
        raise RuntimeError(
            f"[migration] ABORT: {migration_name} is marked -- DESTRUCTIVE but "
            f"the sibling server.db was not found at {server_db}. "
            "Verify the deployment layout (exchange.db and server.db must be "
            "co-located) and run POST /api/admin/backup before retrying."
        )
    backup_at = _last_backup_at(db_path)
    if backup_at is None:
        raise RuntimeError(
            f"[migration] ABORT: {migration_name} is marked -- DESTRUCTIVE but no "
            "backup timestamp found in server_state.last_backup_at. "
            "Run POST /api/admin/backup before applying destructive migrations."
        )
    age_s = (datetime.now(tz=timezone.utc) - backup_at).total_seconds()
    if age_s > _BACKUP_MAX_AGE_S:
        raise RuntimeError(
            f"[migration] ABORT: {migration_name} is marked -- DESTRUCTIVE but the "
            f"last backup is {age_s:.0f}s old (limit {_BACKUP_MAX_AGE_S}s). "
            "Run POST /api/admin/backup and retry."
        )


def _has_drop_table(sql: str) -> bool:
    """Return True if *sql* contains a ``DROP TABLE`` statement.

    Handles both single-line and multi-line forms (``DROP\\nTABLE foo``).
    The check collapses all whitespace runs to a single space before scanning
    so that a keyword split across a line-break is still detected.
    """
    collapsed = re.sub(r"\s+", " ", sql.upper())
    return "DROP TABLE" in collapsed


def _has_destructive_annotation(sql: str) -> bool:
    """Return True if *sql* contains the ``-- DESTRUCTIVE`` annotation on its own line."""
    for line in sql.splitlines():
        if line.strip() == "-- DESTRUCTIVE":
            return True
    return False


# ---------------------------------------------------------------------------
# Public connect/transaction/cursor
# ---------------------------------------------------------------------------


def connect(*, db_path: Path | None = None, readonly: bool = False) -> sqlite3.Connection:
    target = db_path or CONFIG.db_path
    if not readonly:
        target.parent.mkdir(parents=True, exist_ok=True)
    uri = f"file:{target}?mode={'ro' if readonly else 'rwc'}"
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA mmap_size=268435456")  # 256 MiB
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection, *, mode: str = "IMMEDIATE") -> Iterator[None]:
    if mode not in {"DEFERRED", "IMMEDIATE", "EXCLUSIVE"}:
        raise ValueError(f"unsupported transaction mode: {mode!r}")
    conn.execute(f"BEGIN {mode}")
    try:
        yield
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


@contextmanager
def cursor(conn: sqlite3.Connection) -> Iterator[sqlite3.Cursor]:
    cur = conn.cursor()
    try:
        yield cur
    finally:
        cur.close()


# ---------------------------------------------------------------------------
# Vec rowid encoding
# ---------------------------------------------------------------------------

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
        if tmdb_id >= _KIND_BIT:
            raise ValueError(f"tmdb_id too large for vec rowid encoding: {tmdb_id}")
        return tmdb_id
    if kind == "tv":
        if tmdb_id >= _KIND_BIT:
            raise ValueError(f"tmdb_id too large for vec rowid encoding: {tmdb_id}")
        return tmdb_id | _KIND_BIT
    raise ValueError(f"unknown kind: {kind!r}")


def decode_vec_rowid(rowid: int, expected_kind: str | None = None) -> tuple[str, int]:
    kind = "tv" if rowid & _KIND_BIT else "movie"
    if expected_kind is not None and kind != expected_kind:
        raise ValueError(
            f"vec rowid kind mismatch: rowid={rowid} encodes {kind}, expected {expected_kind}"
        )
    return (kind, rowid & ~_KIND_BIT if kind == "tv" else rowid)


_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def table_generation(
    conn: sqlite3.Connection, *tables: str | tuple[str, str]
) -> tuple[tuple, ...]:
    """Cheap fingerprint of catalog tables for module-level cache invalidation.

    Each entry is a table name, optionally paired with a timestamp column the
    ingest stamps on every write. (COUNT(*), MAX(rowid)) catches the
    DELETE+INSERT rehydration pattern (title_cast/title_crew/title_genres get
    fresh rowids); the timestamp catches in-place upserts that keep rowids
    stable (titles / title_features use ON CONFLICT DO UPDATE).
    """
    parts: list[tuple] = []
    for spec in tables:
        table, ts_col = spec if isinstance(spec, tuple) else (spec, None)
        if not _IDENT_RE.match(table) or (ts_col is not None and not _IDENT_RE.match(ts_col)):
            raise ValueError(f"invalid identifier in table_generation spec: {spec!r}")
        cols = "COUNT(*), COALESCE(MAX(rowid), 0)"
        if ts_col is not None:
            cols += f", COALESCE(MAX({ts_col}), '')"
        parts.append(tuple(conn.execute(f"SELECT {cols} FROM {table}").fetchone()))
    return tuple(parts)


def serialize_f32(vec: np.ndarray) -> bytes:
    if vec.dtype != np.float32:
        vec = vec.astype(np.float32)
    return struct.pack(f"{vec.size}f", *vec.tolist())


def deserialize_f32(blob: bytes, dim: int | None = None) -> np.ndarray:
    arr = np.frombuffer(blob, dtype=np.float32)
    if dim is not None and arr.size != dim:
        raise ValueError(f"vector length {arr.size} != expected {dim}")
    return arr


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------


def migrate(*, db_path: Path | None = None) -> list[str]:
    """Apply any unapplied migrations in order; return the list applied."""
    conn = connect(db_path=db_path)
    try:
        return _migrate(conn, db_path=db_path or CONFIG.db_path)
    finally:
        # Startup-only function, but leaking a connection across reloads
        # (e.g. test runs that import-and-reimport the module) holds the
        # WAL open and shows up as a dangling reader in sqlite3 stats.
        conn.close()


def _migration_statements(sql: str) -> list[str]:
    statements: list[str] = []
    pending: list[str] = []
    for line in sql.splitlines():
        pending.append(line)
        candidate = "\n".join(pending).strip()
        if candidate and sqlite3.complete_statement(candidate):
            statements.append(candidate)
            pending = []

    trailing = "\n".join(pending).strip()
    if trailing:
        raise sqlite3.OperationalError("incomplete SQL migration statement")
    return statements


def _migrate(conn: sqlite3.Connection, *, db_path: Path) -> list[str]:
    applied: list[str] = []

    # ------------------------------------------------------------------ #
    # Bootstrap: ensure schema_migrations is in the canonical shape.      #
    # This runs on every boot; it is a no-op if already canonical.        #
    # ------------------------------------------------------------------ #
    _bootstrap_schema_migrations(conn, CONFIG.migrations_dir)

    with cursor(conn) as cur:
        seen: dict[int, str] = {}  # version → checksum
        for row in cur.execute(
            "SELECT version, checksum FROM schema_migrations"
        ).fetchall():
            v = row[0] if isinstance(row, (list, tuple)) else row["version"]
            c = row[1] if isinstance(row, (list, tuple)) else row["checksum"]
            seen[v] = c

        files = sorted(p for p in CONFIG.migrations_dir.glob("*.sql"))
        for f in files:
            version = int(f.name[:4])
            raw_text = f.read_text(encoding="utf-8")
            lf_text = _lf_normalize(raw_text)
            checksum = _sha256(raw_text)

            if version in seen:
                # Already applied — verify checksum. An edited migration file
                # means the DB schema no longer matches what the file would
                # produce, so fail the boot rather than run against an unknown
                # schema. ALLOW_MIGRATION_CHECKSUM_MISMATCH=1 is the operator
                # escape hatch for deliberate repairs (after which the stored
                # checksum should be fixed up to match the file).
                if checksum != seen[version]:
                    if os.environ.get("ALLOW_MIGRATION_CHECKSUM_MISMATCH") == "1":
                        log.warning(
                            "[migration] checksum mismatch on %d allowed by "
                            "ALLOW_MIGRATION_CHECKSUM_MISMATCH=1: file may have been edited",
                            version,
                        )
                        continue
                    raise RuntimeError(
                        f"[migration] ABORT: checksum mismatch on applied migration "
                        f"{version} ({f.name}): the file no longer matches what was "
                        "applied to this database. Restore the original file, or set "
                        "ALLOW_MIGRATION_CHECKSUM_MISMATCH=1 for a deliberate repair."
                    )
                continue

            # ---------------------------------------------------------- #
            # DESTRUCTIVE guard (§7.4)                                    #
            # ---------------------------------------------------------- #
            if _has_drop_table(lf_text):
                if not _has_destructive_annotation(lf_text):
                    raise RuntimeError(
                        f"[migration] ABORT: {f.name} contains DROP TABLE but is not "
                        "annotated with '-- DESTRUCTIVE' on its own line. "
                        "Add the annotation and ensure a recent backup exists before retrying."
                    )
                # Annotation present — verify backup freshness.
                _check_backup_gate(db_path, f.name)

            log.info("[migration] applying %s", f.name)
            t0 = time.monotonic()

            with transaction(conn):
                for statement in _migration_statements(lf_text):
                    cur.execute(statement)
                cur.execute(
                    "INSERT INTO schema_migrations(version, applied_at, checksum) "
                    "VALUES (?, datetime('now'), ?)",
                    (version, checksum),
                )

            elapsed_s = time.monotonic() - t0
            if elapsed_s > _SLOW_MIGRATION_THRESHOLD_S:
                log.warning(
                    "[migration] applying %s took %.1fs, this may take several minutes",
                    f.name,
                    elapsed_s,
                )

            applied.append(f.name)

        # -------------------------------------------------------------- #
        # One-shot migration: the vec rowid scheme changed from "tmdb_id  #
        # alone" to "kind-encoded" (see encode_vec_rowid). Detect legacy  #
        # rows by looking for TV rows with a rowid below _KIND_BIT and,   #
        # if any exist, rebuild title_vec from the preserved feature blobs #
        # under the new kind-encoded rowid scheme.                        #
        # -------------------------------------------------------------- #
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
                "rebuilding title_vec to migrate to kind-encoded rowids",
            )
            with transaction(conn):
                cur.execute("DROP TABLE title_vec")
                cur.execute(VEC_TABLE_DDL.format(dim=CONFIG.embed_dim))
                cur.execute(
                    """INSERT INTO title_vec(rowid, kind, embedding)
                       SELECT CASE kind
                                WHEN 'tv' THEN (tmdb_id | ?)
                                ELSE tmdb_id
                              END,
                              kind,
                              embedding
                       FROM title_features
                       WHERE kind IN ('movie', 'tv') AND dim = ?""",
                    (_KIND_BIT, CONFIG.embed_dim),
                )
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
