"""workers/tmdb_ingest._hydrate_loop — bounded stall handling.

Regression under test: a batch whose workers all come back "deferred" (a
persistent non-"database is locked" open-db failure) or crash outright leaves
every row at status='pending', so the drain loop's SELECT re-fetches the exact
same batch. Only the "locked" result used to count toward the no-progress
bound — an all-"deferred" batch hot-spun forever with no backoff and no
escape. The loop must now back off on ANY zero-progress batch and abort after
MAX_STALLED_NO_PROGRESS_BATCHES consecutive stalls.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from workers import tmdb_ingest

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def _mk_conn(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "exchange.db"
    conn = _mk_conn(path)
    conn.executescript((MIGRATIONS / "0001_initial.sql").read_text(encoding="utf-8"))
    conn.close()
    return path


@pytest.fixture()
def conn(db_path: Path):
    c = _mk_conn(db_path)
    yield c
    c.close()


@pytest.fixture()
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    recorded: list[float] = []

    async def fake_sleep(delay: float) -> None:
        recorded.append(delay)

    monkeypatch.setattr(tmdb_ingest.asyncio, "sleep", fake_sleep)
    return recorded


def _enqueue(conn: sqlite3.Connection, *tmdb_ids: int) -> None:
    conn.executemany(
        "INSERT INTO ingest_queue(tmdb_id, kind, status, attempts, updated_at) "
        "VALUES (?, 'movie', 'pending', 0, datetime('now'))",
        [(t,) for t in tmdb_ids],
    )


class FakeClient:
    """Stands in for TmdbClient; detail() raises or returns a canned payload."""

    def __init__(self, *, exc: Exception | None = None) -> None:
        self.exc = exc

    async def detail(self, kind: str, tmdb_id: int) -> dict:
        if self.exc is not None:
            raise self.exc
        return {
            "id": tmdb_id,
            "title": f"Title {tmdb_id}",
            "vote_count": 100,
            "release_date": "2020-01-01",
        }


def test_all_deferred_batches_back_off_and_abort(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    sleeps: list[float],
) -> None:
    """The 'deferred' path must not hot-spin: exponential backoff, then abort."""
    _enqueue(conn, 1, 2)

    def broken_connect(*args, **kwargs):
        # NOT "database is locked" → the worker classifies it as "deferred".
        raise sqlite3.OperationalError("unable to open database file")

    monkeypatch.setattr(tmdb_ingest, "connect", broken_connect)
    client = FakeClient(exc=RuntimeError("tmdb down"))

    with pytest.raises(RuntimeError, match="no progress"):
        asyncio.run(tmdb_ingest._hydrate_loop(client, conn, concurrency=2))

    assert sleeps == [2, 4], "must back off between consecutive stalled batches"
    statuses = {
        r["status"] for r in conn.execute("SELECT status FROM ingest_queue").fetchall()
    }
    assert statuses == {"pending"}, "stalled rows stay pending for the next run"


def test_crashing_workers_also_hit_the_stall_bound(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    sleeps: list[float],
) -> None:
    """Unexpected worker exceptions (gather-captured) count as a stall too."""
    _enqueue(conn, 1)

    def exploding_connect(*args, **kwargs):
        raise RuntimeError("boom")  # escapes the worker's OperationalError handling

    monkeypatch.setattr(tmdb_ingest, "connect", exploding_connect)
    client = FakeClient(exc=RuntimeError("tmdb down"))

    with pytest.raises(RuntimeError, match="no progress"):
        asyncio.run(tmdb_ingest._hydrate_loop(client, conn, concurrency=1))
    assert len(sleeps) == tmdb_ingest.MAX_STALLED_NO_PROGRESS_BATCHES - 1


def test_stall_counter_resets_once_a_batch_makes_progress(
    db_path: Path,
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    sleeps: list[float],
) -> None:
    """A transient failure (one deferred batch, then recovery) must complete."""
    _enqueue(conn, 7)
    calls = {"n": 0}

    def flaky_connect(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("unable to open database file")
        return _mk_conn(db_path)

    monkeypatch.setattr(tmdb_ingest, "connect", flaky_connect)

    done, skipped = asyncio.run(
        tmdb_ingest._hydrate_loop(FakeClient(), conn, concurrency=1)
    )

    assert (done, skipped) == (1, 0)
    assert sleeps == [2], "exactly one backoff for the single deferred batch"
    row = conn.execute(
        "SELECT status FROM ingest_queue WHERE tmdb_id = 7 AND kind = 'movie'"
    ).fetchone()
    assert row["status"] == "done"
