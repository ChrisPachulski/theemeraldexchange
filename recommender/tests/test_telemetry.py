"""Tests for the DSN-optional crash-telemetry init.

These tests must pass WITHOUT `sentry-sdk` installed, proving the deferred
import guard in `app.telemetry` works. They never depend on the real package:
a fake `sentry_sdk` module is injected into `sys.modules` via monkeypatch when
SDK presence is required. Every test starts from a clean env for the three
vars `init_telemetry` reads, so no env state leaks between tests.
"""

from __future__ import annotations

import sys
import types

import pytest

from app import telemetry


def _set_env(monkeypatch: pytest.MonkeyPatch, **env: str | None) -> None:
    # Start from a clean slate for the vars init_telemetry/_resolve_dsn read.
    for key in ("EEX_TELEMETRY_DSN", "SENTRY_DSN", "GLITCHTIP_DSN", "NODE_ENV"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        if value is not None:
            monkeypatch.setenv(key, value)


def test_no_dsn_skips(monkeypatch):
    _set_env(monkeypatch)
    assert telemetry._resolve_dsn() is None
    assert telemetry.init_telemetry() is False


def test_resolve_prefers_sentry_dsn(monkeypatch):
    # Canonical EEX_TELEMETRY_DSN wins over SENTRY_DSN/GLITCHTIP_DSN (matches the
    # server stack; this is what makes the sidecar actually init in prod).
    _set_env(
        monkeypatch,
        EEX_TELEMETRY_DSN="eex-value",
        SENTRY_DSN="sentry-value",
        GLITCHTIP_DSN="glitchtip-value",
    )
    assert telemetry._resolve_dsn() == "eex-value"

    # Without EEX_TELEMETRY_DSN: SENTRY_DSN wins over GLITCHTIP_DSN.
    _set_env(monkeypatch, SENTRY_DSN="sentry-value", GLITCHTIP_DSN="glitchtip-value")
    assert telemetry._resolve_dsn() == "sentry-value"

    # Only GLITCHTIP_DSN set -> Glitchtip value is used.
    _set_env(monkeypatch, GLITCHTIP_DSN="glitchtip-value")
    assert telemetry._resolve_dsn() == "glitchtip-value"

    # Empty SENTRY_DSN is ignored (non-empty stripped rule); Glitchtip wins.
    _set_env(monkeypatch, SENTRY_DSN="", GLITCHTIP_DSN="glitchtip-value")
    assert telemetry._resolve_dsn() == "glitchtip-value"

    # Whitespace-only is also treated as empty.
    _set_env(monkeypatch, SENTRY_DSN="   ", GLITCHTIP_DSN="glitchtip-value")
    assert telemetry._resolve_dsn() == "glitchtip-value"


def test_dsn_set_but_sdk_missing_skips(monkeypatch):
    _set_env(monkeypatch, SENTRY_DSN="https://fake@example.test/1")
    # A None entry in sys.modules makes `import sentry_sdk` raise ImportError.
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)
    assert telemetry.init_telemetry() is False


def test_dsn_set_with_fake_sdk_initializes(monkeypatch):
    _set_env(
        monkeypatch,
        SENTRY_DSN="https://fake@example.test/42",
        NODE_ENV="production",
    )
    recorded: list[dict] = []
    fake = types.ModuleType("sentry_sdk")
    fake.init = lambda **kwargs: recorded.append(kwargs)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)

    assert telemetry.init_telemetry() is True
    assert len(recorded) == 1
    kwargs = recorded[0]
    assert kwargs["dsn"] == "https://fake@example.test/42"
    assert kwargs["send_default_pii"] is False
    assert kwargs["traces_sample_rate"] == 0.0
    assert kwargs["environment"] == "production"


def test_init_failure_is_swallowed(monkeypatch):
    _set_env(monkeypatch, SENTRY_DSN="https://fake@example.test/9")

    def _boom(**_kwargs):
        raise RuntimeError("sdk exploded")

    fake = types.ModuleType("sentry_sdk")
    fake.init = _boom  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake)

    # Must not propagate the exception.
    assert telemetry.init_telemetry() is False
