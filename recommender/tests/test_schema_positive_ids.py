"""tmdb_id > 0 is enforced on EVERY event schema, not just /score.

The Sonarr tmdbId:0 incident proved zero ids reach this service. A zero id
accepted by /events/rejection writes a junk row into the PERMANENT
household_rejections table (vetoes are never FIFO'd out), so every event
endpoint must 422 non-positive and non-int ids at the schema boundary.
"""

from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import main as main_module
from app.schemas import (
    ClearFeedbackRequest,
    FeedbackEventRequest,
    ImpressionItem,
    LibrarySyncItem,
    RejectionEventRequest,
    ShownEventRequest,
)

SUB = "plex:494190801"
BAD_IDS = [0, -1, "42"]  # zero, negative, stringly-typed (strict mode rejects)


# ---------------------------------------------------------------------------
# Schema-level: every event model rejects non-positive / non-int ids
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad", BAD_IDS)
def test_feedback_event_rejects_bad_tmdb_id(bad) -> None:
    with pytest.raises(ValidationError):
        FeedbackEventRequest(sub=SUB, kind="movie", tmdb_id=bad, signal="like")


@pytest.mark.parametrize("bad", BAD_IDS)
def test_clear_feedback_rejects_bad_tmdb_id(bad) -> None:
    with pytest.raises(ValidationError):
        ClearFeedbackRequest(sub=SUB, kind="movie", tmdb_id=bad)


@pytest.mark.parametrize("bad", BAD_IDS)
def test_library_sync_item_rejects_bad_tmdb_id(bad) -> None:
    with pytest.raises(ValidationError):
        LibrarySyncItem(tmdb_id=bad)


@pytest.mark.parametrize("bad", BAD_IDS)
def test_shown_event_rejects_bad_tmdb_id(bad) -> None:
    with pytest.raises(ValidationError):
        ShownEventRequest(sub=SUB, kind="movie", tmdb_ids=[1, bad])


@pytest.mark.parametrize("bad", BAD_IDS)
def test_impression_item_rejects_bad_tmdb_id(bad) -> None:
    with pytest.raises(ValidationError):
        ImpressionItem(tmdb_id=bad, rank=0, score=0.5, provenance="discover", model_version="v0")


@pytest.mark.parametrize("bad", BAD_IDS)
def test_rejection_event_rejects_bad_tmdb_id(bad) -> None:
    with pytest.raises(ValidationError):
        RejectionEventRequest(kind="movie", tmdb_id=bad)


def test_positive_ids_still_accepted() -> None:
    assert FeedbackEventRequest(sub=SUB, kind="movie", tmdb_id=1, signal="like").tmdb_id == 1
    assert RejectionEventRequest(kind="tv", tmdb_id=1399).tmdb_id == 1399
    assert ShownEventRequest(sub=SUB, kind="tv", tmdb_ids=[1, 2]).tmdb_ids == [1, 2]


# ---------------------------------------------------------------------------
# Endpoint-level: FastAPI surfaces the schema rejection as a 422, and no row
# is written (the rejection table stays clean — the incident's failure mode)
# ---------------------------------------------------------------------------


@pytest.fixture()
def client():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE household_rejections ("
        "kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, ts TEXT NOT NULL, "
        "PRIMARY KEY (kind, tmdb_id))"
    )
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


@pytest.mark.parametrize("bad", BAD_IDS)
def test_events_rejection_422s_and_writes_nothing(client, bad) -> None:
    tc, conn = client
    r = tc.post("/events/rejection", json={"kind": "movie", "tmdb_id": bad})
    assert r.status_code == 422, r.text
    assert conn.execute("SELECT COUNT(*) FROM household_rejections").fetchone()[0] == 0


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/events/feedback", {"sub": SUB, "kind": "movie", "tmdb_id": 0, "signal": "like"}),
        ("/events/feedback/clear", {"sub": SUB, "kind": "movie", "tmdb_id": -5}),
        ("/events/library/sync", {"kind": "movie", "items": [{"tmdb_id": 0}]}),
        ("/events/shown", {"sub": SUB, "kind": "movie", "tmdb_ids": [0]}),
        (
            "/events/impressions",
            {
                "sub": SUB,
                "kind": "movie",
                "items": [
                    {
                        "tmdb_id": 0,
                        "rank": 0,
                        "score": 0.1,
                        "provenance": "discover",
                        "model_version": "v0",
                    }
                ],
            },
        ),
    ],
)
def test_event_endpoints_422_on_zero_id(client, path, payload) -> None:
    tc, _conn = client
    r = tc.post(path, json=payload)
    assert r.status_code == 422, f"{path}: {r.text}"
