"""POST /events/feedback — signal routing after the dead-'shown' cleanup.

The handler once cleared user_feedback rows with signal='shown', but nothing
in the codebase has ever written such rows under the current schema (the only
user_feedback INSERT in the handler is unreachable for 'shown', and the bulk
impression path POST /events/shown writes recently_shown only). That legacy
DELETE — and the 'shown' member of the reject branch's clear-list — were
removed. These tests pin the surviving contract:

  * every REAL signal (like/dislike/reject/clicked/added/watched) still lands
    in user_feedback and clears its opposing signals,
  * signal='shown' stays accepted for schema compat but writes ONLY
    recently_shown — never user_feedback.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as main_module

SUB = "plex:494190801"
MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def _handler_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # The post-0008 user_feedback shape (the live CHECK still allows 'shown'
    # for compat) + recently_shown from 0001 + rec_log for attribution.
    conn.executescript(
        """
        CREATE TABLE user_feedback (
          sub     TEXT    NOT NULL,
          kind    TEXT    NOT NULL,
          tmdb_id INTEGER NOT NULL,
          signal  TEXT    NOT NULL CHECK (signal IN ('like','dislike','reject','shown','clicked','added','watched')),
          ts      TEXT    NOT NULL,
          PRIMARY KEY (sub, kind, tmdb_id, signal)
        );
        CREATE TABLE recently_shown (
          sub     TEXT    NOT NULL,
          kind    TEXT    NOT NULL,
          tmdb_id INTEGER NOT NULL,
          ts      TEXT    NOT NULL,
          PRIMARY KEY (sub, kind, tmdb_id)
        );
        CREATE TABLE rec_log (
          id INTEGER PRIMARY KEY, sub TEXT, kind TEXT, tmdb_id INTEGER, ts TEXT
        );
        CREATE TABLE rec_outcomes (
          rec_id INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          ts TEXT NOT NULL,
          PRIMARY KEY (rec_id, outcome)
        );
        """
    )
    return conn


@pytest.fixture()
def client():
    conn = _handler_conn()
    main_module.app.dependency_overrides[main_module.get_db] = lambda: conn
    main_module.app.dependency_overrides[main_module.require_event_secret] = lambda: None
    main_module.app.dependency_overrides[main_module.internal_principal_dep] = lambda: None
    try:
        yield TestClient(main_module.app), conn
    finally:
        main_module.app.dependency_overrides.pop(main_module.get_db, None)
        main_module.app.dependency_overrides.pop(main_module.require_event_secret, None)
        main_module.app.dependency_overrides.pop(main_module.internal_principal_dep, None)
        conn.close()


def _post(client: TestClient, signal: str, tmdb_id: int = 555) -> None:
    r = client.post(
        "/events/feedback",
        json={"sub": SUB, "kind": "movie", "tmdb_id": tmdb_id, "signal": signal},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}


def _signals(conn: sqlite3.Connection, tmdb_id: int = 555) -> set[str]:
    return {
        r["signal"]
        for r in conn.execute(
            "SELECT signal FROM user_feedback WHERE tmdb_id = ?", (tmdb_id,)
        ).fetchall()
    }


@pytest.mark.parametrize(
    "signal", ["like", "dislike", "reject", "clicked", "added", "watched"]
)
def test_real_signals_are_stored(client, signal) -> None:
    tc, conn = client
    _post(tc, signal)
    assert _signals(conn) == {signal}


def test_reject_clears_all_opposing_signals(client) -> None:
    tc, conn = client
    for s in ("like", "clicked", "added", "watched"):
        _post(tc, s)
    assert _signals(conn) == {"like", "clicked", "added", "watched"}
    _post(tc, "reject")
    assert _signals(conn) == {"reject"}


def test_positive_clears_dislike_and_reject(client) -> None:
    tc, conn = client
    _post(tc, "dislike")
    _post(tc, "reject")
    _post(tc, "like")
    assert _signals(conn) == {"like"}


def test_shown_writes_recently_shown_only_never_user_feedback(client) -> None:
    tc, conn = client
    _post(tc, "shown")
    assert _signals(conn) == set(), (
        "signal='shown' must never land in user_feedback"
    )
    rows = conn.execute(
        "SELECT sub, kind, tmdb_id FROM recently_shown"
    ).fetchall()
    assert [(r["sub"], r["kind"], r["tmdb_id"]) for r in rows] == [(SUB, "movie", 555)]
    # Idempotent on repeat (ON CONFLICT ... DO UPDATE ts).
    _post(tc, "shown")
    assert conn.execute("SELECT COUNT(*) FROM recently_shown").fetchone()[0] == 1


def test_nothing_in_the_app_writes_user_feedback_shown_rows() -> None:
    """Greppable proof the legacy cleanup stays dead: no INSERT statement in
    app/ or workers/ targets user_feedback with a literal 'shown' signal, and
    the only user_feedback INSERT in the feedback handler is unreachable for
    'shown' (that branch returns early)."""
    root = Path(__file__).resolve().parents[1]
    for py in [*(root / "app").rglob("*.py"), *(root / "workers").rglob("*.py")]:
        text = py.read_text(encoding="utf-8")
        for chunk in text.split("INSERT INTO user_feedback")[1:]:
            assert "'shown'" not in chunk[:300], (
                f"{py} appears to insert signal='shown' into user_feedback — "
                "the /events/feedback 'shown' branch relies on this never happening"
            )
