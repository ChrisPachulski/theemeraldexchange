"""/health introspection + body-sub precedence over the verified principal.

Closes the body-spoofing channel: when a verified internal-principal is
present, its sub is authoritative; in enforce mode a disagreeing body sub is
rejected. /health surfaces the enforcement mode so operators can detect an
identity-unauthenticated deployment.
"""

from __future__ import annotations

from dataclasses import replace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import config as config_module
from app import main as main_module
from app.internal_principal import InternalPrincipal


def _principal(sub: str) -> InternalPrincipal:
    return InternalPrincipal(
        sub=sub,
        role="user",
        auth_mode="plex",
        server_id="srv-1",
        device_id=None,
        iat=0,
        exp=0,
        req_id="req-1",
        iss="eex",
    )


def _set_mode(monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    new = replace(config_module.CONFIG, internal_principal_mode=mode)
    monkeypatch.setattr(config_module, "CONFIG", new)
    monkeypatch.setattr(main_module, "CONFIG", new)


def test_authoritative_sub_off_mode_uses_body(monkeypatch):
    _set_mode(monkeypatch, "off")
    assert main_module._authoritative_sub(None, "plex:body") == "plex:body"


def test_authoritative_sub_prefers_principal_in_log_mode(monkeypatch):
    _set_mode(monkeypatch, "log")
    # Even if the body claims a different sub, the verified principal wins.
    assert main_module._authoritative_sub(_principal("plex:real"), "plex:other") == "plex:real"


def test_authoritative_sub_enforce_rejects_mismatch(monkeypatch):
    _set_mode(monkeypatch, "enforce")
    with pytest.raises(HTTPException) as exc:
        main_module._authoritative_sub(_principal("plex:real"), "plex:other")
    assert exc.value.status_code == 403


def test_authoritative_sub_enforce_allows_match(monkeypatch):
    _set_mode(monkeypatch, "enforce")
    assert main_module._authoritative_sub(_principal("plex:real"), "plex:real") == "plex:real"


def test_health_surfaces_principal_mode(monkeypatch):
    _set_mode(monkeypatch, "off")
    client = TestClient(main_module.app)
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["internal_principal_mode"] == "off"
    assert "optimizer" in body
    assert body["optimizer"]["mode"] in {"active", "record-only", "unknown"}
