"""Fresh-volume boot regression test for the recommender service.

The container ships with an EMPTY ``/data`` volume on first deploy — there is no
``exchange.db`` yet. The service must, on boot, run ``migrate()`` from the
FastAPI lifespan to build the whole schema (including the sqlite-vec ``title_vec``
virtual table) and then serve ``/health`` off that freshly-migrated database.

This has broken in fresh-boot-only ways that production DBs masked because they
predated the offending migration:

* 0007 issues ``DELETE FROM title_vec`` — which only works if the migrator
  creates the vec0 table BEFORE the .sql loop runs (see ``_migrate`` in app/db.py).
  A prod DB already had ``title_vec``, so the ordering bug never fired there.
* 0007 / 0005 carry ``DROP TABLE`` under a ``-- DESTRUCTIVE`` annotation; the
  destructive backup gate must be satisfiable on a fresh volume that has NO
  sibling ``server.db`` (the auto-backup path), or every cold boot aborts.

The existing tests cover ``migrate()`` in isolation and ``/health`` over a
hand-seeded in-memory DB (which never triggers the lifespan). This test closes
the gap between them: it drives the REAL boot path end-to-end — lifespan →
``migrate()`` against an empty on-disk volume → ``/health`` over the real
per-request connection — exactly what a cold container does, minus the
gosu/cap/read-only-rootfs container layer (proven separately by the Docker boot
script; see scripts/recommender-fresh-volume-boot-proof.sh).
"""

from __future__ import annotations

import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config as config_module
from app import db as db_module
from app import main as main_module


def _point_config_at(monkeypatch: pytest.MonkeyPatch, db_path: Path) -> None:
    """Repoint every module-level CONFIG reference at a cold volume's db_path.

    db.py, main.py and config.py each bound ``CONFIG`` at import time, so a
    single monkeypatch on one of them would leave the others pointing at the
    real ./data/exchange.db. migrations_dir stays the REAL one so the boot
    applies the production migration set.
    """
    cold = replace(config_module.CONFIG, db_path=db_path)
    monkeypatch.setattr(config_module, "CONFIG", cold)
    monkeypatch.setattr(db_module, "CONFIG", cold)
    monkeypatch.setattr(main_module, "CONFIG", cold)


def test_fresh_volume_boot_serves_health(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cold /data volume must boot through the lifespan and serve /health.

    tmp_path stands in for an empty ``/data`` bind mount: the directory exists
    but ``exchange.db`` does not. Entering the TestClient context manager runs
    the app's real lifespan, which calls ``migrate()``.
    """
    data_dir = tmp_path / "data"
    data_dir.mkdir()  # the volume exists but is empty (no exchange.db)
    db_path = data_dir / "exchange.db"
    _point_config_at(monkeypatch, db_path)

    assert not db_path.exists(), "precondition: the volume must start cold"

    # `with TestClient(app)` triggers startup → lifespan → migrate(). Without
    # the context-manager form the lifespan never runs (that's why the existing
    # /health test can hand-seed an in-memory DB).
    with TestClient(main_module.app) as client:
        resp = client.get("/health")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    # Fresh volume → no catalog ingested yet.
    assert body["titles"] == 0
    assert body["title_vectors"] == 0
    assert body["db_path"] == str(db_path)

    # The boot must have materialised the DB on the cold volume and applied the
    # full migration set, with the vec0 table present (the 0007 DELETE target).
    assert db_path.exists(), "boot must create exchange.db on the cold volume"
    conn = sqlite3.connect(str(db_path))
    try:
        applied = {
            r[0] for r in conn.execute("SELECT version FROM schema_migrations")
        }
        on_disk = {
            int(p.name[:4]) for p in config_module.CONFIG.migrations_dir.glob("*.sql")
        }
        assert applied == on_disk, (
            f"every on-disk migration must be applied on a fresh boot; "
            f"applied={sorted(applied)} on_disk={sorted(on_disk)}"
        )
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
            )
        }
        assert "titles" in tables
        assert "title_vec" in tables, "the vec0 virtual table must exist after boot"
    finally:
        conn.close()


def test_fresh_volume_boot_fails_loudly_when_vec_table_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Proof the test catches a real cold-boot failure.

    Reproduces the documented fresh-boot-only regression: if the migrator does
    NOT create ``title_vec`` before the .sql loop, migration 0007's
    ``DELETE FROM title_vec`` hits a non-existent table and the boot must crash
    rather than come up half-migrated. We simulate the missing pre-loop creation
    by stubbing the vec0 DDL to a harmless no-op, then assert the lifespan
    raises on a fresh volume.
    """
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    db_path = data_dir / "exchange.db"
    _point_config_at(monkeypatch, db_path)

    # Neuter the vec0 table creation. _migrate() formats this string with the
    # embed dim, so it must remain a valid (no-op) SQL statement with no rows
    # of effect — "SELECT 1" creates nothing, mirroring the pre-fix code path
    # where title_vec only existed AFTER the migration loop.
    monkeypatch.setattr(db_module, "VEC_TABLE_DDL", "SELECT 1;")

    with pytest.raises(sqlite3.OperationalError, match="title_vec"):
        with TestClient(main_module.app):
            pass

    # And the boot must not have left a fully-migrated DB behind: 0007 (and
    # everything after it) never applied.
    if db_path.exists():
        conn = sqlite3.connect(str(db_path))
        try:
            applied = {
                r[0]
                for r in conn.execute("SELECT version FROM schema_migrations")
            }
        finally:
            conn.close()
        assert 7 not in applied, "0007 must not record as applied when its body failed"
