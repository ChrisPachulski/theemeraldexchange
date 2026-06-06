"""Implicit-feedback 'watched' signal: model wiring, schema, migration, endpoint.

The implicit-feedback loop forwards a 'watched' positive when the household
plays >=40% of (or completes) a title. This test pins:
  (a) 'watched' is a positive engagement signal (feeds the centroid),
  (b) the request schemas accept 'watched' and reject unknown signals,
  (c) migration 0008 widens the user_feedback.signal CHECK to allow 'watched',
  (d) POST /events/feedback stores a 'watched' row and clears an opposing
      dislike (watched behaves as a positive in the handler).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import context as context_module
from app import main as main_module
from app.schemas import FeedbackEntry, FeedbackEventRequest


def test_watched_is_a_positive_engagement_signal() -> None:
    assert "watched" in context_module.ENGAGEMENT_FEEDBACK_SIGNALS
    assert "watched" in context_module.POSITIVE_FEEDBACK_SIGNALS


def test_feedback_schemas_accept_watched_reject_unknown() -> None:
    assert FeedbackEntry(tmdb_id=1, signal="watched").signal == "watched"
    assert FeedbackEventRequest(sub="plex:494190801", kind="movie", tmdb_id=1, signal="watched").signal == "watched"
    with pytest.raises(ValidationError):
        FeedbackEntry(tmdb_id=1, signal="bingewatched")  # type: ignore[arg-type]


def _user_feedback_0001(conn: sqlite3.Connection) -> None:
    # The pre-0008 user_feedback definition (from 0001_initial.sql) — the table
    # 0008 rebuilds. Created inline so this test doesn't need sqlite-vec / the
    # full migration set.
    conn.executescript(
        """
        CREATE TABLE user_feedback (
          sub     TEXT    NOT NULL,
          kind    TEXT    NOT NULL,
          tmdb_id INTEGER NOT NULL,
          signal  TEXT    NOT NULL CHECK (signal IN ('like','dislike','reject','shown','clicked','added')),
          ts      TEXT    NOT NULL,
          PRIMARY KEY (sub, kind, tmdb_id, signal)
        );
        """
    )


def test_migration_0008_is_annotated_destructive() -> None:
    # 0008 contains DROP TABLE; the migrator refuses to apply a DROP-TABLE
    # migration (RuntimeError on boot) unless it carries '-- DESTRUCTIVE' on its
    # own line. Guard that annotation so the recommender can't crash-loop on
    # deploy if someone edits this migration.
    sql = (Path(__file__).resolve().parents[1] / "migrations" / "0008_user_feedback_watched.sql").read_text()
    assert "DROP TABLE" in sql.upper()
    assert any(line.strip() == "-- DESTRUCTIVE" for line in sql.splitlines())


def test_migration_0008_allows_watched_and_preserves_rows() -> None:
    sql = (Path(__file__).resolve().parents[1] / "migrations" / "0008_user_feedback_watched.sql").read_text()
    conn = sqlite3.connect(":memory:")
    try:
        _user_feedback_0001(conn)
        conn.execute(
            "INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES (?,?,?,?,?)",
            ("plex:494190801", "movie", 42, "like", "2026-06-06T00:00:00Z"),
        )
        # Pre-0008 the CHECK rejects 'watched'.
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES (?,?,?,?,?)",
                ("plex:494190801", "movie", 7, "watched", "2026-06-06T00:00:00Z"),
            )
        conn.executescript(sql)
        # Pre-existing row survived the rebuild.
        assert conn.execute("SELECT COUNT(*) FROM user_feedback WHERE signal='like'").fetchone()[0] == 1
        # 'watched' now accepted.
        conn.execute(
            "INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES (?,?,?,?,?)",
            ("plex:494190801", "movie", 7, "watched", "2026-06-06T00:00:00Z"),
        )
        assert conn.execute("SELECT COUNT(*) FROM user_feedback WHERE signal='watched'").fetchone()[0] == 1
        # An unknown signal is still rejected by the rebuilt CHECK.
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES (?,?,?,?,?)",
                ("plex:494190801", "movie", 8, "nope", "2026-06-06T00:00:00Z"),
            )
    finally:
        conn.close()


def _handler_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    _user_feedback_0001(conn)
    conn.executescript(
        (Path(__file__).resolve().parents[1] / "migrations" / "0008_user_feedback_watched.sql").read_text()
    )
    # The feedback handler reads rec_log for outcome attribution; create it so
    # the (no-match) lookup runs cleanly. 'watched' isn't an attributable
    # outcome, so no rec_outcomes row is expected.
    conn.execute(
        "CREATE TABLE rec_log (id INTEGER PRIMARY KEY, sub TEXT, kind TEXT, tmdb_id INTEGER, ts TEXT)"
    )
    return conn


def test_events_feedback_watched_is_stored_and_clears_dislike() -> None:
    conn = _handler_conn()
    main_module.app.dependency_overrides[main_module.get_db] = lambda: conn
    main_module.app.dependency_overrides[main_module.require_event_secret] = lambda: None
    main_module.app.dependency_overrides[main_module.internal_principal_dep] = lambda: None
    try:
        client = TestClient(main_module.app)
        # User first disliked a title.
        r1 = client.post(
            "/events/feedback",
            json={"sub": "plex:494190801", "kind": "movie", "tmdb_id": 555, "signal": "dislike"},
        )
        assert r1.status_code == 200, r1.text
        assert conn.execute(
            "SELECT COUNT(*) FROM user_feedback WHERE tmdb_id=555 AND signal='dislike'"
        ).fetchone()[0] == 1
        # Then actually watched it >=40% -> implicit positive. As a positive
        # engagement signal it must clear the opposing dislike.
        r2 = client.post(
            "/events/feedback",
            json={"sub": "plex:494190801", "kind": "movie", "tmdb_id": 555, "signal": "watched"},
        )
        assert r2.status_code == 200, r2.text
        assert conn.execute(
            "SELECT COUNT(*) FROM user_feedback WHERE tmdb_id=555 AND signal='watched'"
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM user_feedback WHERE tmdb_id=555 AND signal='dislike'"
        ).fetchone()[0] == 0
    finally:
        main_module.app.dependency_overrides.pop(main_module.get_db, None)
        main_module.app.dependency_overrides.pop(main_module.require_event_secret, None)
        main_module.app.dependency_overrides.pop(main_module.internal_principal_dep, None)
        conn.close()
