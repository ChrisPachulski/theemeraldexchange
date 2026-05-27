"""Boundary validation for the `sub` field on inbound requests.

The recommender historically treated `sub` as an opaque string — any
shape made it through to SQL queries. The canonical contract (§8 in the
cross-service spec) is `<provider>:<id>` where provider is one of
`plex`, `local`, or `apple`. This module enforces that shape via the
PyO3 binding to `emerald_contracts`, so Hono + recommender reject
malformed subs the same way at the same boundary.

If `emerald_contracts` isn't installed (developer machine without the
PyO3 build), we log once at import time and skip validation — the
recommender keeps working but loses the cross-language parity gate
until the operator rebuilds the wheel. CI guarantees the wheel is
present in the prod image.
"""

from __future__ import annotations

import logging

_log = logging.getLogger(__name__)

try:
    import emerald_contracts as _ec

    _AVAILABLE = True
except ImportError:  # pragma: no cover — covered by Dockerfile install
    _ec = None  # type: ignore[assignment]
    _AVAILABLE = False
    _log.warning(
        "emerald_contracts unavailable — sub-namespace validation disabled. "
        "Build the wheel via `cd crates/emerald-contracts-pyo3 && maturin develop --release` "
        "or run the recommender Docker image which installs it at build time."
    )


def is_available() -> bool:
    """True when the PyO3 binding loaded successfully."""
    return _AVAILABLE


def validate_sub(value: str) -> str:
    """Return `value` unchanged when it parses; raise `ValueError` otherwise.

    When the PyO3 binding isn't available we pass the value through
    untouched — see module docstring for rationale.
    """
    if not _AVAILABLE:
        return value
    # Pydantic field validators run before the model handler, so we
    # surface the same `ValueError` the binding raises. FastAPI maps
    # that to a 422 with field-level detail.
    _ec.parse_sub(value)  # type: ignore[union-attr]
    return value
