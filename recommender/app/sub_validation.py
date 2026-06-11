"""Boundary validation for the `sub` field on inbound requests.

The recommender historically treated `sub` as an opaque string — any
shape made it through to SQL queries. The canonical contract (§8 in the
cross-service spec) is `<provider>:<id>` where provider is one of
`plex`, `local`, or `apple`. This module enforces that shape via the
PyO3 binding to `emerald_contracts`, so Hono + recommender reject
malformed subs the same way at the same boundary.

Binding-availability policy (two modes, switched by EEX_REQUIRE_BINDING):

  EEX_REQUIRE_BINDING=1 (CI + prod image): a missing/broken
  `emerald_contracts` import is a HARD startup failure (RuntimeError at
  module import). A soft-disabled validator in CI would green-light a
  build whose prod container then accepts malformed subs — the whole
  point of the gate is to catch the missing wheel before it ships.

  unset / any other value (local dev): log once at import time and skip
  validation — the recommender keeps working without the PyO3 build, but
  loses the cross-language parity gate until the operator rebuilds the
  wheel (`cd crates/emerald-contracts-pyo3 && maturin develop --release`).
"""

from __future__ import annotations

import logging
import os

_log = logging.getLogger(__name__)


def _binding_required() -> bool:
    return os.environ.get("EEX_REQUIRE_BINDING") == "1"


try:
    import emerald_contracts as _ec

    _AVAILABLE = True
except ImportError as exc:  # pragma: no cover — exercised via _handle_import_failure
    _ec = None  # type: ignore[assignment]
    _AVAILABLE = False
    _import_error: ImportError | None = exc
else:
    _import_error = None


def _handle_import_failure(error: ImportError | None) -> None:
    """Apply the availability policy. Split out (and called at import
    time below) so tests can exercise both modes without uninstalling
    the wheel."""
    if error is None:
        return
    if _binding_required():
        raise RuntimeError(
            "EEX_REQUIRE_BINDING=1 but the emerald_contracts PyO3 binding failed "
            "to import — refusing to start with sub-namespace validation disabled. "
            "Build the wheel via `cd crates/emerald-contracts-pyo3 && maturin "
            "develop --release` (the recommender Docker image installs it at "
            f"build time). Original import error: {error}"
        ) from error
    _log.warning(
        "emerald_contracts unavailable — sub-namespace validation disabled. "
        "Build the wheel via `cd crates/emerald-contracts-pyo3 && maturin develop --release` "
        "or run the recommender Docker image which installs it at build time."
    )


_handle_import_failure(_import_error)


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
