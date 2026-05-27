"""Internal-principal verification per cross-service contract §4.

Hono mints a 60-second JWE on every outbound call to this service and
attaches it as ``Authorization: Bearer <jwe>``. We decrypt + time-check
it via the PyO3 binding (`emerald_contracts`), which calls the same
canonical Rust code Hono used to mint it.

Three modes, controlled by ``RECOMMENDER_INTERNAL_PRINCIPAL_MODE``:

- ``off`` (default): ignore the header entirely. Keeps current behavior
  for deployments that haven't provisioned ``INTERNAL_PRINCIPAL_SECRET``
  yet. The dependency does no work — returns None unconditionally.
- ``log``: verify when present, log failures, never block. Use during
  rollout to confirm Hono is supplying the header on every endpoint.
- ``enforce``: verify always; missing or invalid → 401. M3 cutover
  state — the recommender now trusts ``principal.sub`` and friends as
  authoritative caller identity (no need to re-verify cookies/tokens).

The receiver-side wire-up sits dormant in ``off`` mode — the dependency
is wired on every event route but returns None. That makes M3 cutover
a one-env-var flip with no code change on this side.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Optional

from fastapi import Header, HTTPException

from .config import CONFIG

log = logging.getLogger(__name__)

try:
    import emerald_contracts as _ec  # type: ignore

    _AVAILABLE = True
except ImportError:  # pragma: no cover — covered by Dockerfile install
    _ec = None  # type: ignore[assignment]
    _AVAILABLE = False
    if CONFIG.internal_principal_mode != "off":
        log.error(
            "emerald_contracts unavailable but internal-principal mode=%s; "
            "verification will fail closed in enforce mode",
            CONFIG.internal_principal_mode,
        )


INTERNAL_PRINCIPAL_KID = "internal-v1"


@dataclass(frozen=True)
class InternalPrincipal:
    """Decrypted internal-principal claim set.

    Mirrors the Rust ``InternalClaims`` struct field-for-field. Routes
    that want to read caller identity should depend on this type via
    :func:`internal_principal_dep` and inspect ``principal.sub``,
    ``principal.role``, etc.
    """

    sub: str
    role: str
    auth_mode: str
    server_id: str
    device_id: Optional[str]
    iat: int
    exp: int
    req_id: str
    iss: str


def _derive_key() -> Optional[bytes]:
    if not _AVAILABLE:
        return None
    secret = CONFIG.internal_principal_secret
    if secret is None:
        return None
    return bytes(_ec.hkdf_internal_principal(secret.encode("utf-8")))


# Derived once at import time. Tests that mutate CONFIG.internal_principal_secret
# should call _reset_key_for_tests() to pick up the change.
_KEY: Optional[bytes] = _derive_key()


def _reset_key_for_tests() -> None:
    """Re-derive the HKDF key after a test mutates the secret."""
    global _KEY
    _KEY = _derive_key()


def _bearer_token(header_value: Optional[str]) -> Optional[str]:
    if not header_value:
        return None
    parts = header_value.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def _verify(token: str, key: bytes) -> InternalPrincipal:
    """Decrypt + time-window check. Raises on any failure."""
    claims = _ec.internal_principal_decrypt({INTERNAL_PRINCIPAL_KID: key}, token)
    _ec.internal_principal_enforce_time_window(claims["exp"], int(time.time()))
    return InternalPrincipal(
        sub=claims["sub"],
        role=claims["role"],
        auth_mode=claims["auth_mode"],
        server_id=claims["server_id"],
        device_id=claims["device_id"],
        iat=claims["iat"],
        exp=claims["exp"],
        req_id=claims["req_id"],
        iss=claims["iss"],
    )


def internal_principal_dep(
    authorization: Optional[str] = Header(default=None, alias="authorization"),
) -> Optional[InternalPrincipal]:
    """FastAPI dependency: verify the inbound internal-principal.

    Behavior depends on ``CONFIG.internal_principal_mode``:

    - ``off``: returns ``None`` without inspecting the header.
    - ``log``: returns the verified principal, or ``None`` on any
      failure (missing header, unavailable binding, decrypt error,
      expired). Logs every failure path.
    - ``enforce``: returns the verified principal or raises
      ``HTTPException(401)`` (or 503 if the runtime is misconfigured —
      the binding isn't installed or the secret isn't set).
    """
    mode = CONFIG.internal_principal_mode
    if mode == "off":
        return None

    token = _bearer_token(authorization)
    if token is None:
        if mode == "enforce":
            raise HTTPException(status_code=401, detail="internal-principal required")
        log.warning("internal-principal: missing on request (mode=log)")
        return None

    if not _AVAILABLE:
        if mode == "enforce":
            raise HTTPException(status_code=503, detail="emerald_contracts unavailable")
        log.error("internal-principal: emerald_contracts unavailable (mode=log)")
        return None

    if _KEY is None:
        if mode == "enforce":
            raise HTTPException(status_code=503, detail="INTERNAL_PRINCIPAL_SECRET not configured")
        log.error("internal-principal: secret unset but mode=log — cannot verify")
        return None

    try:
        return _verify(token, _KEY)
    except Exception as e:
        if mode == "enforce":
            raise HTTPException(
                status_code=401, detail=f"invalid internal-principal: {e!s}"
            ) from e
        log.warning("internal-principal: verify failed: %s (mode=log)", e)
        return None
