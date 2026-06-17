"""Inbound `sub` field validation — every event/score request runs the
canonical regex from emerald_contracts before any handler code touches
the value."""

from __future__ import annotations

import importlib
import sys

import pytest
from pydantic import ValidationError

from app.schemas import (
    ClearFeedbackRequest,
    FeedbackEventRequest,
    ImpressionEventRequest,
    ScoreRequest,
    ShownEventRequest,
)
from app.sub_validation import _handle_import_failure, is_available


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


# ---------------------------------------------------------------------------
# Binding-availability policy (EEX_REQUIRE_BINDING)
#
# CI/prod set EEX_REQUIRE_BINDING=1 so a missing PyO3 wheel is a hard
# startup failure instead of a silent soft-disable; local dev (flag
# unset) keeps the warn-and-continue behavior. Both modes are exercised
# here — via the policy hook directly AND via a real module re-import
# with the binding blocked out of sys.modules.
# ---------------------------------------------------------------------------


def test_handle_import_failure_hard_fails_when_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EEX_REQUIRE_BINDING", "1")
    with pytest.raises(RuntimeError, match="EEX_REQUIRE_BINDING=1"):
        _handle_import_failure(ImportError("No module named 'emerald_contracts'"))


def test_handle_import_failure_soft_disables_by_default(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("EEX_REQUIRE_BINDING", raising=False)
    with caplog.at_level("WARNING", logger="app.sub_validation"):
        _handle_import_failure(ImportError("No module named 'emerald_contracts'"))
    assert any("sub-namespace validation disabled" in r.message for r in caplog.records)


def test_handle_import_failure_noop_when_binding_loaded() -> None:
    # The successful-import path must never raise or warn, required or not.
    _handle_import_failure(None)


def _reimport_sub_validation_without_binding(monkeypatch: pytest.MonkeyPatch):
    """Re-import app.sub_validation with `import emerald_contracts` forced
    to fail (None in sys.modules raises ImportError), restoring the real
    modules afterwards via monkeypatch's teardown."""
    monkeypatch.setitem(sys.modules, "emerald_contracts", None)
    saved = sys.modules["app.sub_validation"]
    del sys.modules["app.sub_validation"]
    try:
        return importlib.import_module("app.sub_validation")
    finally:
        # Always restore the real (binding-backed) module for later tests.
        sys.modules["app.sub_validation"] = saved


def test_module_import_hard_fails_when_required_and_binding_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EEX_REQUIRE_BINDING", "1")
    with pytest.raises(RuntimeError, match="refusing to start"):
        _reimport_sub_validation_without_binding(monkeypatch)


def test_module_import_soft_disables_when_not_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("EEX_REQUIRE_BINDING", raising=False)
    mod = _reimport_sub_validation_without_binding(monkeypatch)
    assert mod.is_available() is False
    # Pass-through behavior: validation is skipped, value returned untouched.
    assert mod.validate_sub("garbage") == "garbage"
    # LOW-31: but an empty/whitespace sub must still be rejected even in the
    # no-binding fallback — otherwise it acts as a wildcard principal.
    for empty in ("", "   ", "\t"):
        with pytest.raises(ValueError):
            mod.validate_sub(empty)
