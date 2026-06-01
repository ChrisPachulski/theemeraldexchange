"""Crash-telemetry init for the recommender sidecar.

Mirrors the Hono server's crash-telemetry tier on the project's MANDATORY
Glitchtip (Sentry-protocol) channel per §15. The init is DSN-optional: a
complete no-op when no DSN env var is set, so dev/CI/test behavior is
unchanged.

The `sentry_sdk` import is deliberately deferred inside `init_telemetry`
(behind try/except ImportError) because the recommender CI harness does NOT
install `sentry-sdk`. This module must import cleanly without the package
present; the DSN is read from the environment only and never hardcoded.
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger("recommender.telemetry")


def _resolve_dsn() -> str | None:
    """Return the first non-empty DSN from SENTRY_DSN, then GLITCHTIP_DSN.

    §15 distributes a Glitchtip DSN server->app at boot, so either env var
    name is accepted. Values are stripped; empty/whitespace-only values are
    ignored. SENTRY_DSN takes precedence over GLITCHTIP_DSN.
    """
    for name in ("SENTRY_DSN", "GLITCHTIP_DSN"):
        value = os.environ.get(name)
        if value is not None:
            stripped = value.strip()
            if stripped:
                return stripped
    return None


def init_telemetry() -> bool:
    """Initialize crash telemetry if a DSN is configured.

    Returns True only when the SDK was successfully initialized. Returns False
    (without raising) when no DSN is set, when `sentry-sdk` is not installed,
    or when the SDK's own init raises. Safe to call unconditionally at startup.
    """
    dsn = _resolve_dsn()
    if dsn is None:
        log.debug("telemetry: no DSN set; skipping init")
        return False

    try:
        import sentry_sdk
    except ImportError:
        log.warning("telemetry: DSN set but sentry-sdk not installed; skipping")
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            traces_sample_rate=0.0,
            send_default_pii=False,
            environment=os.environ.get("NODE_ENV", "development"),
        )
    except Exception:
        log.warning("telemetry: sentry_sdk.init failed; skipping", exc_info=True)
        return False

    log.info("telemetry: initialized")
    return True
