"""Inbound `sub` field validation — every event/score request runs the
canonical regex from emerald_contracts before any handler code touches
the value."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import (
    ClearFeedbackRequest,
    FeedbackEventRequest,
    ImpressionEventRequest,
    ScoreRequest,
    ShownEventRequest,
)
from app.sub_validation import is_available


pytestmark = pytest.mark.skipif(
    not is_available(),
    reason="emerald_contracts PyO3 binding not installed — run `maturin develop --release` "
    "in crates/emerald-contracts-pyo3",
)


VALID_SUBS = [
    "plex:12345",
    "plex:0",  # documented exception per sub-namespace.json valid-plex-zero
    "local:01HABCDEFGHJKMNPQRSTVWXYZ0",
    "apple:001126.d3c6971f4faa4ccd80027e3654fa404a.1616",
]

INVALID_SUBS = [
    "12345",  # no provider prefix
    "google:abc",  # unknown provider
    "plex:007",  # leading zero past the documented exception
    "local:lowercase01HABCDEFGHJKMNPQR",  # ulid must be uppercase
    "apple:bad-format",  # apple regex mismatch
    "",  # empty
]


@pytest.mark.parametrize("sub", VALID_SUBS)
def test_score_request_accepts_valid_sub(sub: str) -> None:
    r = ScoreRequest(sub=sub, kind="movie", n=5)
    assert r.sub == sub


@pytest.mark.parametrize("sub", INVALID_SUBS)
def test_score_request_rejects_invalid_sub(sub: str) -> None:
    with pytest.raises(ValidationError):
        ScoreRequest(sub=sub, kind="movie", n=5)


@pytest.mark.parametrize(
    "model_cls,kwargs",
    [
        (FeedbackEventRequest, {"kind": "movie", "tmdb_id": 1, "signal": "like"}),
        (
            ClearFeedbackRequest,
            {"kind": "movie", "tmdb_id": 1, "signal": "like"},
        ),
        (ShownEventRequest, {"kind": "movie", "tmdb_ids": []}),
        (ImpressionEventRequest, {"kind": "movie", "items": []}),
    ],
    ids=["feedback", "clear-feedback", "shown", "impression"],
)
def test_event_models_validate_sub(model_cls: type, kwargs: dict) -> None:
    # Each event-request type carries `sub` and must reject malformed.
    with pytest.raises(ValidationError):
        model_cls(sub="garbage", **kwargs)
    # And accept the canonical form.
    ok = model_cls(sub="plex:12345", **kwargs)
    assert ok.sub == "plex:12345"
