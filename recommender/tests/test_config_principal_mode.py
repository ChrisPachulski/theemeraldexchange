"""Production-default + fail-fast behavior for the internal-principal mode.

Covers the secure-by-default resolution added for the caller-identity gate:
in production, an unset RECOMMENDER_INTERNAL_PRINCIPAL_MODE resolves to
"enforce" (not "off"), load() fail-fasts when a verifying mode has no secret,
and an explicit "off" still opts out.
"""

from __future__ import annotations

import pytest

from app import config as config_module


def _set_env(monkeypatch: pytest.MonkeyPatch, **env: str | None) -> None:
    # Start from a clean slate for the vars load() reads.
    for key in (
        "NODE_ENV",
        "RECOMMENDER_INTERNAL_PRINCIPAL_MODE",
        "INTERNAL_PRINCIPAL_SECRET",
        "RECOMMENDER_EVENT_SECRET",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        if value is not None:
            monkeypatch.setenv(key, value)


def test_mode_defaults_off_outside_production(monkeypatch):
    _set_env(monkeypatch)
    assert config_module.load().internal_principal_mode == "off"


def test_mode_defaults_enforce_in_production(monkeypatch):
    _set_env(
        monkeypatch,
        NODE_ENV="production",
        RECOMMENDER_EVENT_SECRET="x" * 40,
        INTERNAL_PRINCIPAL_SECRET="y" * 40,
    )
    assert config_module.load().internal_principal_mode == "enforce"


def test_production_default_fails_fast_without_secret(monkeypatch):
    _set_env(
        monkeypatch,
        NODE_ENV="production",
        RECOMMENDER_EVENT_SECRET="x" * 40,
    )
    with pytest.raises(ValueError):
        config_module.load()


def test_production_explicit_off_opts_out_without_secret(monkeypatch):
    _set_env(
        monkeypatch,
        NODE_ENV="production",
        RECOMMENDER_INTERNAL_PRINCIPAL_MODE="off",
        RECOMMENDER_EVENT_SECRET="x" * 40,
    )
    assert config_module.load().internal_principal_mode == "off"


def test_explicit_log_in_production_requires_secret(monkeypatch):
    _set_env(
        monkeypatch,
        NODE_ENV="production",
        RECOMMENDER_INTERNAL_PRINCIPAL_MODE="log",
        RECOMMENDER_EVENT_SECRET="x" * 40,
    )
    with pytest.raises(ValueError):
        config_module.load()


def test_invalid_mode_still_raises(monkeypatch):
    _set_env(monkeypatch, RECOMMENDER_INTERNAL_PRINCIPAL_MODE="bogus")
    with pytest.raises(ValueError):
        config_module.load()
