"""Tests for recommender/app/db.py — migrator bootstrap and migration logic.

Covers:
  (a) fresh-DB → canonical schema_migrations table created on first boot
  (b) legacy filename-TEXT schema → backfilled to canonical (version + checksum)
  (c) checksum mismatch → RuntimeError by default; WARN + continue only under
      the ALLOW_MIGRATION_CHECKSUM_MISMATCH=1 escape hatch
  (d) _lf_normalize handles non-ASCII text correctly (byte-safe CRLF replacement)
  (e) _has_drop_table detects multi-line DROP TABLE (DROP\nTABLE)
  (f) _check_backup_gate raises RuntimeError when server.db is absent
  (g) _check_backup_gate raises RuntimeError when backup is stale
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Import the private helpers under test.
# We import from app.db to ensure the module-level CONFIG does not break
# tests running without a real exchange.db on disk.
# ---------------------------------------------------------------------------
from app.db import (
    _bootstrap_schema_migrations,
    _check_backup_gate,
    _has_drop_table,
    _has_destructive_annotation,
    _lf_normalize,
    _sha256,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn(db_path: Path) -> sqlite3.Connection:
    """Open a plain sqlite3 connection (no sqlite_vec) for test fixture work."""
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return [r["name"] for r in rows]


# ---------------------------------------------------------------------------
# (a) Fresh DB → canonical schema_migrations
# ---------------------------------------------------------------------------


def test_bootstrap_creates_canonical_table_on_fresh_db(tmp_path: Path) -> None:
    """_bootstrap_schema_migrations creates the canonical 3-column table on a fresh DB."""
    db = tmp_path / "exchange.db"
    conn = _make_conn(db)
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()

    _bootstrap_schema_migrations(conn, migrations_dir)

    cols = _table_columns(conn, "schema_migrations")
    assert cols == ["version", "applied_at", "checksum"], (
        f"expected [version, applied_at, checksum], got {cols}"
    )
    conn.close()


def test_bootstrap_is_idempotent_on_canonical_table(tmp_path: Path) -> None:
    """Calling _bootstrap_schema_migrations twice on a canonical table is a no-op."""
    db = tmp_path / "exchange.db"
    conn = _make_conn(db)
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()

    _bootstrap_schema_migrations(conn, migrations_dir)
    _bootstrap_schema_migrations(conn, migrations_dir)

    # Still 3 columns, no duplicate table, no exception.
    cols = _table_columns(conn, "schema_migrations")
    assert cols == ["version", "applied_at", "checksum"]
    conn.close()


# ---------------------------------------------------------------------------
# (b) Legacy filename-TEXT schema → backfilled
# ---------------------------------------------------------------------------


def test_bootstrap_backfills_legacy_filename_schema(tmp_path: Path) -> None:
    """Legacy schema_migrations(filename TEXT PRIMARY KEY) is rebuilt to canonical shape."""
    db = tmp_path / "exchange.db"
    conn = _make_conn(db)

    # Create a legacy-shaped migrations dir with one real file.
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    sql_file = migrations_dir / "0001_initial.sql"
    sql_content = "CREATE TABLE foo (id INTEGER PRIMARY KEY);\n"
    sql_file.write_text(sql_content, encoding="utf-8")
    expected_checksum = _sha256(sql_content)

    # Plant a legacy-shape table with one existing row.
    conn.execute(
        "CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT)"
    )
    conn.execute(
        "INSERT INTO schema_migrations(filename, applied_at) VALUES (?, ?)",
        ("0001_initial.sql", "2026-01-01T00:00:00"),
    )

    _bootstrap_schema_migrations(conn, migrations_dir)

    # Table is now canonical.
    cols = _table_columns(conn, "schema_migrations")
    assert cols == ["version", "applied_at", "checksum"]

    # Row is backfilled.
    row = conn.execute("SELECT * FROM schema_migrations WHERE version = 1").fetchone()
    assert row is not None, "backfilled row should exist for version 1"
    assert row["version"] == 1
    assert row["applied_at"] == "2026-01-01T00:00:00"
    assert row["checksum"] == expected_checksum, (
        f"expected {expected_checksum!r}, got {row['checksum']!r}"
    )
    conn.close()


def test_bootstrap_backfills_missing_file_with_empty_checksum(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """When a legacy row refers to a file not on disk, checksum is '' and WARN is emitted."""
    db = tmp_path / "exchange.db"
    conn = _make_conn(db)
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()

    conn.execute(
        "CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT)"
    )
    conn.execute(
        "INSERT INTO schema_migrations(filename, applied_at) VALUES (?, ?)",
        ("0002_gone.sql", "2026-02-01T00:00:00"),
    )

    with caplog.at_level(logging.WARNING, logger="app.db"):
        _bootstrap_schema_migrations(conn, migrations_dir)

    row = conn.execute("SELECT * FROM schema_migrations WHERE version = 2").fetchone()
    assert row is not None
    assert row["checksum"] == ""
    assert any("0002_gone.sql" in r.message for r in caplog.records), (
        "expected a WARN mentioning the missing file"
    )
    conn.close()


# ---------------------------------------------------------------------------
# (c) Checksum mismatch → RuntimeError (loud), unless the operator escape
#     hatch ALLOW_MIGRATION_CHECKSUM_MISMATCH=1 is set (WARN + continue)
# ---------------------------------------------------------------------------


def _mismatched_migrations(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Apply 0001 for real via migrate(), then edit the file so its checksum
    no longer matches what schema_migrations recorded. Returns the db path."""
    from dataclasses import replace

    import app.db as db_mod
    from app.db import migrate

    db = tmp_path / "exchange.db"
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    sql_file = migrations_dir / "0001_bar.sql"
    sql_file.write_text("CREATE TABLE bar (id INTEGER PRIMARY KEY);\n", encoding="utf-8")

    monkeypatch.setattr(
        db_mod, "CONFIG", replace(db_mod.CONFIG, migrations_dir=migrations_dir)
    )
    applied = migrate(db_path=db)
    assert "0001_bar.sql" in applied

    # Simulate a post-apply edit of the migration file.
    sql_file.write_text(
        "CREATE TABLE bar (id INTEGER PRIMARY KEY, sneaky TEXT);\n", encoding="utf-8"
    )
    return db


def test_checksum_mismatch_raises_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.db import migrate

    db = _mismatched_migrations(tmp_path, monkeypatch)
    monkeypatch.delenv("ALLOW_MIGRATION_CHECKSUM_MISMATCH", raising=False)
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        migrate(db_path=db)


def test_checksum_mismatch_escape_hatch_warns_and_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from app.db import migrate

    db = _mismatched_migrations(tmp_path, monkeypatch)
    monkeypatch.setenv("ALLOW_MIGRATION_CHECKSUM_MISMATCH", "1")
    with caplog.at_level(logging.WARNING, logger="app.db"):
        applied = migrate(db_path=db)
    assert "0001_bar.sql" not in applied  # not re-applied, just tolerated
    assert any(
        "checksum mismatch" in r.message and r.levelno == logging.WARNING
        for r in caplog.records
    ), "expected a checksum-mismatch WARNING under the escape hatch"


# ---------------------------------------------------------------------------
# (d) _lf_normalize is byte-safe with non-ASCII content
# ---------------------------------------------------------------------------


def test_lf_normalize_handles_non_ascii_comment() -> None:
    """_lf_normalize replaces CRLF→LF correctly even when non-ASCII chars are present."""
    # SQL with a non-ASCII comment (e.g., a Unicode en-dash or accented character)
    sql_with_unicode = (
        "-- Créé par l'équipe\r\n"
        "CREATE TABLE foo (id INTEGER PRIMARY KEY);\r\n"
        "-- 日本語コメント\r\n"
        "CREATE INDEX idx_foo ON foo(id);\r\n"
    )
    normalized = _lf_normalize(sql_with_unicode)

    assert "\r\n" not in normalized, "CRLF sequences should be removed"
    assert "Créé par l'équipe" in normalized, "non-ASCII content should be preserved"
    assert "日本語コメント" in normalized, "CJK comment should survive normalisation"
    # Line count should be preserved (4 non-empty lines → 4 \n-terminated lines)
    assert normalized.count("\n") == 4

    # Checksum of LF-normalised content must be stable (same result on repeated calls).
    assert _sha256(sql_with_unicode) == _sha256(sql_with_unicode)
    # Checksum must differ from the raw CRLF version when hashed without normalisation.
    raw_digest = hashlib.sha256(sql_with_unicode.encode()).hexdigest()
    assert _sha256(sql_with_unicode) != raw_digest, (
        "_sha256 must normalise before hashing to differ from raw-CRLF digest"
    )


def test_lf_normalize_standalone_cr_is_preserved() -> None:
    """Bare \\r (no \\n) is not touched by _lf_normalize — only CRLF pairs are replaced."""
    text = "line1\rline2\r\nline3"
    result = _lf_normalize(text)
    assert result == "line1\rline2\nline3"


# ---------------------------------------------------------------------------
# (e) _has_drop_table detects multi-line DROP TABLE
# ---------------------------------------------------------------------------


def test_has_drop_table_detects_inline() -> None:
    assert _has_drop_table("DROP TABLE foo;")


def test_has_drop_table_detects_multiline() -> None:
    sql = "DROP\nTABLE foo;"
    assert _has_drop_table(sql), "_has_drop_table must detect DROP\\nTABLE"


def test_has_drop_table_detects_multiline_with_extra_whitespace() -> None:
    sql = "DROP  \n  TABLE   foo;"
    assert _has_drop_table(sql)


def test_has_drop_table_ignores_drop_index() -> None:
    assert not _has_drop_table("DROP INDEX idx_foo;")


def test_has_destructive_annotation_present() -> None:
    sql = "-- DESTRUCTIVE\nDROP TABLE foo;"
    assert _has_destructive_annotation(sql)


def test_has_destructive_annotation_absent() -> None:
    sql = "-- just a comment\nDROP TABLE foo;"
    assert not _has_destructive_annotation(sql)


# ---------------------------------------------------------------------------
# _check_backup_gate — auto-backup-first behavior (primary), with the legacy
# sibling-server.db proof as the fallback when auto-backup cannot be written.
# ---------------------------------------------------------------------------


def _make_real_db(path: Path) -> None:
    """Create a minimal but valid SQLite db so _auto_backup can snapshot it."""
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE t (x INTEGER)")
    conn.commit()
    conn.close()


def _force_autobackup_failure(monkeypatch: "pytest.MonkeyPatch") -> None:
    """Make _auto_backup raise so the gate exercises its fallback branch."""

    def _boom(*_args, **_kwargs):
        raise OSError("forced auto-backup failure (test)")

    monkeypatch.setattr("app.db._auto_backup", _boom)


def test_check_backup_gate_autobackup_success_passes(tmp_path: Path) -> None:
    """Primary path: a consistent auto-backup is written and the gate passes
    WITHOUT requiring a sibling server.db (the production volume layout)."""
    db = tmp_path / "exchange.db"
    _make_real_db(db)

    # No server.db present; auto-backup alone must satisfy the gate.
    _check_backup_gate(db, "0099_drop_foo.sql")

    backups = list(tmp_path.glob("exchange.db.pre0099-*.bak"))
    assert backups, "expected an auto-backup file beside the db"


def test_check_backup_gate_raises_when_server_db_missing(
    tmp_path: Path, monkeypatch: "pytest.MonkeyPatch"
) -> None:
    """Fallback path: when auto-backup fails AND no sibling server.db exists,
    a -- DESTRUCTIVE migration is aborted."""
    db = tmp_path / "exchange.db"
    _make_real_db(db)
    _force_autobackup_failure(monkeypatch)

    with pytest.raises(RuntimeError, match="server.db was not found"):
        _check_backup_gate(db, "0099_drop_foo.sql")


def test_check_backup_gate_raises_when_backup_stale(
    tmp_path: Path, monkeypatch: "pytest.MonkeyPatch"
) -> None:
    """Fallback path: when auto-backup fails and the external backup timestamp
    is older than _BACKUP_MAX_AGE_S, the migration is aborted."""
    db = tmp_path / "exchange.db"
    _make_real_db(db)
    server_db = tmp_path / "server.db"
    _force_autobackup_failure(monkeypatch)

    stale_ts = (datetime.now(tz=timezone.utc) - timedelta(minutes=25)).isoformat()
    sconn = sqlite3.connect(str(server_db))
    sconn.execute("CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT)")
    sconn.execute(
        "INSERT INTO server_state(key, value) VALUES ('last_backup_at', ?)",
        (stale_ts,),
    )
    sconn.commit()
    sconn.close()

    with pytest.raises(RuntimeError, match="last backup is"):
        _check_backup_gate(db, "0099_drop_foo.sql")


def test_check_backup_gate_passes_with_fresh_backup(
    tmp_path: Path, monkeypatch: "pytest.MonkeyPatch"
) -> None:
    """Fallback path: when auto-backup fails but a FRESH external backup exists,
    the gate passes."""
    db = tmp_path / "exchange.db"
    _make_real_db(db)
    server_db = tmp_path / "server.db"
    _force_autobackup_failure(monkeypatch)

    fresh_ts = datetime.now(tz=timezone.utc).isoformat()
    sconn = sqlite3.connect(str(server_db))
    sconn.execute("CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT)")
    sconn.execute(
        "INSERT INTO server_state(key, value) VALUES ('last_backup_at', ?)",
        (fresh_ts,),
    )
    sconn.commit()
    sconn.close()

    # Should not raise.
    _check_backup_gate(db, "0099_drop_foo.sql")


# ---------------------------------------------------------------------------
# (f) 0005 retroactive -- DESTRUCTIVE annotation + checksum amnesty
# ---------------------------------------------------------------------------


def test_fresh_db_applies_real_migrations_including_destructive_0005(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fresh DB must boot through the REAL migrations dir end-to-end.

    Regression: 0005 contains DROP TABLE; before it carried the
    -- DESTRUCTIVE annotation, the destructive gate aborted every fresh-DB
    boot (prod DBs predated the gate and skipped it, masking the bug).
    """
    from dataclasses import replace

    import app.db as db_mod
    from app.db import migrate

    real_migrations = Path(__file__).resolve().parents[1] / "migrations"
    monkeypatch.setattr(
        db_mod, "CONFIG", replace(db_mod.CONFIG, migrations_dir=real_migrations)
    )
    applied = migrate(db_path=tmp_path / "exchange.db")
    assert "0005_iptv_kinds.sql" in applied


def test_amnesty_constants_match_the_real_0005_file() -> None:
    """If 0005 is edited again, the amnesty's 'new' hash goes stale — fail here."""
    import app.db as db_mod

    real_0005 = Path(__file__).resolve().parents[1] / "migrations" / "0005_iptv_kinds.sql"
    assert (
        _sha256(real_0005.read_text(encoding="utf-8")) == db_mod._CHECKSUM_AMNESTY[5][1]
    ), "0005 changed after the amnesty was recorded — add a new amnesty entry or restore the file"


def _db_with_stored_0005_checksum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stored_checksum: str
) -> Path:
    """Create a DB whose schema_migrations claims 0005 was applied with
    *stored_checksum*, with the REAL (annotated) 0005 file on disk."""
    from dataclasses import replace

    import app.db as db_mod
    from app.db import _bootstrap_schema_migrations

    real_0005 = Path(__file__).resolve().parents[1] / "migrations" / "0005_iptv_kinds.sql"
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    (migrations_dir / "0005_iptv_kinds.sql").write_text(
        real_0005.read_text(encoding="utf-8"), encoding="utf-8"
    )
    monkeypatch.setattr(
        db_mod, "CONFIG", replace(db_mod.CONFIG, migrations_dir=migrations_dir)
    )
    db = tmp_path / "exchange.db"
    conn = _make_conn(db)
    _bootstrap_schema_migrations(conn, migrations_dir)
    conn.execute(
        "DELETE FROM schema_migrations WHERE version = 5",
    )
    conn.execute(
        "INSERT INTO schema_migrations(version, applied_at, checksum) VALUES (5, ?, ?)",
        (datetime.now(tz=timezone.utc).isoformat(), stored_checksum),
    )
    conn.commit()
    conn.close()
    return db


def test_checksum_amnesty_rewrites_known_0005_edit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import app.db as db_mod
    from app.db import migrate

    old_hash, new_hash = db_mod._CHECKSUM_AMNESTY[5]
    db = _db_with_stored_0005_checksum(tmp_path, monkeypatch, old_hash)
    monkeypatch.delenv("ALLOW_MIGRATION_CHECKSUM_MISMATCH", raising=False)

    with caplog.at_level(logging.INFO, logger="app.db"):
        applied = migrate(db_path=db)

    assert "0005_iptv_kinds.sql" not in applied  # tolerated, not re-applied
    assert any("checksum amnesty" in r.message for r in caplog.records)
    conn = _make_conn(db)
    row = conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version = 5"
    ).fetchone()
    conn.close()
    assert row[0] == new_hash


def test_checksum_amnesty_does_not_cover_unknown_edits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.db import migrate

    db = _db_with_stored_0005_checksum(tmp_path, monkeypatch, "deadbeef" * 8)
    monkeypatch.delenv("ALLOW_MIGRATION_CHECKSUM_MISMATCH", raising=False)
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        migrate(db_path=db)
