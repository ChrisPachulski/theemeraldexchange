"""Receiver-side verification for the internal-principal JWE per
contract §4. Mirrors the symmetric mint-side in server/services/
internalPrincipal.ts; both sides call the same canonical Rust crate
through their respective bindings.

Tests cover all three modes (off/log/enforce) plus failure paths
(missing header, wrong scheme, expired token, wrong kid, malformed
JWE). Off mode is the default; M3 cutover flips to enforce.
"""

from __future__ import annotations

import time
from dataclasses import replace
from typing import Iterator

import pytest

from app import config as config_module
from app import internal_principal as ip_module
from app.internal_principal import (
    INTERNAL_PRINCIPAL_KID,
    InternalPrincipal,
    internal_principal_dep,
)

pytestmark = pytest.mark.skipif(
    not ip_module._AVAILABLE,
    reason="emerald_contracts PyO3 binding not installed — run `maturin develop --release` "
    "in crates/emerald-contracts-pyo3",
)


SECRET = "test-internal-principal-secret-zzzzzzzzzzzzzzzzzzzz"


@pytest.fixture
def configure_mode(monkeypatch: pytest.MonkeyPatch) -> Iterator[callable]:
    """Reconfigure CONFIG and re-derive the HKDF key.

    CONFIG is a frozen dataclass loaded once at import time; we swap it
    for a clone with the requested mode + secret, then call the module's
    test reset so :func:`_KEY` is re-derived from the new secret.
    """

    original = config_module.CONFIG

    def _apply(mode: str, secret: str | None = SECRET) -> None:
        new = replace(
            original,
            internal_principal_mode=mode,
            internal_principal_secret=secret,
        )
        monkeypatch.setattr(config_module, "CONFIG", new)
        monkeypatch.setattr(ip_module, "CONFIG", new)
        ip_module._reset_key_for_tests()

    yield _apply

    monkeypatch.setattr(config_module, "CONFIG", original)
    monkeypatch.setattr(ip_module, "CONFIG", original)
    ip_module._reset_key_for_tests()


def _mint(secret: str = SECRET, *, ttl_secs: int = 60, kid: str | None = None) -> str:
    import emerald_contracts as ec

    key = ec.hkdf_internal_principal(secret.encode("utf-8"))
    now = int(time.time())
    claims = {
        "iss": "eex",
        "sub": "plex:12345",
        "role": "user",
        "auth_mode": "plex",
        "server_id": "srv-uuid-1",
        "device_id": None,
        "req_id": "req-test",
        "iat": now,
        "exp": now + ttl_secs,
    }
    return ec.internal_principal_encrypt(key, kid or INTERNAL_PRINCIPAL_KID, claims)


# ---------------------------------------------------------------------------
# off mode — never inspects the header
# ---------------------------------------------------------------------------


def test_off_mode_returns_none_for_missing_header(configure_mode) -> None:
    configure_mode("off", secret=None)
    assert internal_principal_dep(authorization=None) is None


def test_off_mode_returns_none_for_invalid_header(configure_mode) -> None:
    configure_mode("off", secret=None)
    # Wouldn't decrypt even if we tried — off mode short-circuits.
    assert internal_principal_dep(authorization="Bearer not-a-jwe") is None


def test_off_mode_returns_none_for_valid_token(configure_mode) -> None:
    configure_mode("off")
    token = _mint()
    assert internal_principal_dep(authorization=f"Bearer {token}") is None


# ---------------------------------------------------------------------------
# log mode — verify, but never raise
# ---------------------------------------------------------------------------


def test_log_mode_returns_principal_for_valid_token(configure_mode) -> None:
    configure_mode("log")
    token = _mint()
    got = internal_principal_dep(authorization=f"Bearer {token}")
    assert isinstance(got, InternalPrincipal)
    assert got.sub == "plex:12345"
    assert got.role == "user"
    assert got.auth_mode == "plex"
    assert got.server_id == "srv-uuid-1"
    assert got.device_id is None
    assert got.iss == "eex"


def test_log_mode_returns_none_for_missing_header(configure_mode, caplog) -> None:
    configure_mode("log")
    caplog.set_level("WARNING")
    assert internal_principal_dep(authorization=None) is None
    assert any("missing" in r.getMessage() for r in caplog.records)


def test_log_mode_returns_none_for_wrong_scheme(configure_mode) -> None:
    configure_mode("log")
    # Basic auth header — not Bearer, so token extractor returns None.
    assert internal_principal_dep(authorization="Basic dXNlcjpwYXNz") is None


def test_log_mode_returns_none_for_malformed_jwe(configure_mode, caplog) -> None:
    configure_mode("log")
    caplog.set_level("WARNING")
    assert internal_principal_dep(authorization="Bearer not.a.real.jwe.token") is None
    assert any("verify failed" in r.getMessage() for r in caplog.records)


def test_log_mode_returns_none_for_expired_token(configure_mode, caplog) -> None:
    configure_mode("log")
    caplog.set_level("WARNING")
    # ttl=-300 means exp is 5 minutes in the past
    token = _mint(ttl_secs=-300)
    assert internal_principal_dep(authorization=f"Bearer {token}") is None
    assert any("verify failed" in r.getMessage() for r in caplog.records)


def test_log_mode_returns_none_when_secret_unset(configure_mode, caplog) -> None:
    configure_mode("log", secret=None)
    caplog.set_level("ERROR")
    token = _mint()
    assert internal_principal_dep(authorization=f"Bearer {token}") is None
    assert any("secret unset" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# enforce mode — verify, raise 401 on any failure
# ---------------------------------------------------------------------------


def test_enforce_mode_returns_principal_for_valid_token(configure_mode) -> None:
    configure_mode("enforce")
    token = _mint()
    got = internal_principal_dep(authorization=f"Bearer {token}")
    assert isinstance(got, InternalPrincipal)
    assert got.sub == "plex:12345"


def test_enforce_mode_401_on_missing_header(configure_mode) -> None:
    from fastapi import HTTPException

    configure_mode("enforce")
    with pytest.raises(HTTPException) as exc_info:
        internal_principal_dep(authorization=None)
    assert exc_info.value.status_code == 401
    assert "required" in exc_info.value.detail


def test_enforce_mode_401_on_wrong_scheme(configure_mode) -> None:
    from fastapi import HTTPException

    configure_mode("enforce")
    with pytest.raises(HTTPException) as exc_info:
        internal_principal_dep(authorization="Basic dXNlcjpwYXNz")
    assert exc_info.value.status_code == 401


def test_enforce_mode_401_on_malformed_jwe(configure_mode) -> None:
    from fastapi import HTTPException

    configure_mode("enforce")
    with pytest.raises(HTTPException) as exc_info:
        internal_principal_dep(authorization="Bearer not.a.real.jwe.token")
    assert exc_info.value.status_code == 401
    assert "invalid" in exc_info.value.detail


def test_enforce_mode_401_on_expired_token(configure_mode) -> None:
    from fastapi import HTTPException

    configure_mode("enforce")
    token = _mint(ttl_secs=-300)
    with pytest.raises(HTTPException) as exc_info:
        internal_principal_dep(authorization=f"Bearer {token}")
    assert exc_info.value.status_code == 401


def test_enforce_mode_503_when_secret_unset(configure_mode) -> None:
    from fastapi import HTTPException

    configure_mode("enforce", secret=None)
    token = _mint()
    with pytest.raises(HTTPException) as exc_info:
        internal_principal_dep(authorization=f"Bearer {token}")
    assert exc_info.value.status_code == 503


def test_enforce_mode_401_on_wrong_kid(configure_mode) -> None:
    """A token minted under a different kid (e.g., post-rotation grace
    window) must still decrypt only if the recommender's keymap includes
    that kid. Today the keymap is single-entry (`internal-v1`); a token
    with kid='internal-v2' should be rejected."""
    from fastapi import HTTPException

    configure_mode("enforce")
    token = _mint(kid="internal-v2")
    with pytest.raises(HTTPException) as exc_info:
        internal_principal_dep(authorization=f"Bearer {token}")
    assert exc_info.value.status_code == 401


def test_enforce_mode_401_on_wrong_secret(configure_mode) -> None:
    """A token minted with a different INTERNAL_PRINCIPAL_SECRET than
    the recommender derives its key from must fail AEAD verification."""
    from fastapi import HTTPException

    configure_mode("enforce", secret=SECRET)
    # Mint with a deliberately different secret.
    token = _mint(secret="different-secret-also-32-chars-zzzzzzzzzzzz")
    with pytest.raises(HTTPException) as exc_info:
        internal_principal_dep(authorization=f"Bearer {token}")
    assert exc_info.value.status_code == 401
