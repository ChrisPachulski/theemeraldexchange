"""/health introspection + body-sub precedence over the verified principal.

Closes the body-spoofing channel: when a verified internal-principal is
present, its sub is authoritative; in enforce mode a disagreeing body sub is
rejected. /health surfaces the enforcement mode so operators can detect an
identity-unauthenticated deployment.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
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
    assert main_module.authoritative_sub(None, "plex:body") == "plex:body"


def test_authoritative_sub_prefers_principal_in_log_mode(monkeypatch):
    _set_mode(monkeypatch, "log")
    # Even if the body claims a different sub, the verified principal wins.
    assert main_module.authoritative_sub(_principal("plex:real"), "plex:other") == "plex:real"


def test_authoritative_sub_enforce_rejects_mismatch(monkeypatch):
    _set_mode(monkeypatch, "enforce")
    with pytest.raises(HTTPException) as exc:
        main_module.authoritative_sub(_principal("plex:real"), "plex:other")
    assert exc.value.status_code == 403


def test_authoritative_sub_enforce_allows_match(monkeypatch):
    _set_mode(monkeypatch, "enforce")
    assert main_module.authoritative_sub(_principal("plex:real"), "plex:real") == "plex:real"


def _seeded_conn() -> sqlite3.Connection:
    """Minimal in-memory DB carrying just the tables /health reads.

    `check_same_thread=False` because FastAPI's TestClient runs the route in a
    worker thread (via run_in_threadpool) while this connection is created on
    the test thread; without it sqlite raises ProgrammingError on cross-thread
    use. Safe here: the test issues one request at a time, no concurrent access.
    """
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE titles (tmdb_id INTEGER)")
    conn.execute("CREATE TABLE title_vec (tmdb_id INTEGER)")
    conn.execute("CREATE TABLE model_config (version TEXT, active INTEGER)")
    return conn


@contextmanager
def _score_client(monkeypatch, mode: str, principal_sub: str):
    """TestClient for /score with a verified principal and a spied context load.

    ``load_user_context`` is replaced by a spy that records the sub it was
    handed and then aborts with a sentinel 599 — the sub binding is the only
    thing under test, so the real scoring pipeline (recipes, model_config,
    vectors) is out of scope and would need a fully migrated DB.
    """
    seen: list[str] = []

    def _spy(conn, req, *, persist_library=False):
        seen.append(req.sub)
        raise HTTPException(status_code=599, detail="stopped after sub binding")

    _set_mode(monkeypatch, mode)
    monkeypatch.setattr(main_module, "load_user_context", _spy)
    overrides = main_module.app.dependency_overrides
    overrides[main_module.get_db] = lambda: None
    overrides[main_module.require_event_secret] = lambda: None
    overrides[main_module.internal_principal_dep] = lambda: _principal(principal_sub)
    try:
        yield TestClient(main_module.app), seen
    finally:
        for dep in (
            main_module.get_db,
            main_module.require_event_secret,
            main_module.internal_principal_dep,
        ):
            overrides.pop(dep, None)


def test_score_enforce_mode_rejects_body_sub_spoof(monkeypatch):
    """A caller with the shared event secret must not read another sub's picks.

    /score reads stored feedback + recently_shown for `req.sub`, so a body sub
    that disagrees with the verified principal is a cross-user read, not just a
    write concern. Enforce mode rejects it BEFORE any context load.
    """
    with _score_client(monkeypatch, "enforce", "plex:494190801") as (client, seen):
        r = client.post("/score", json={"sub": "plex:999000111", "kind": "movie", "n": 5})
    assert r.status_code == 403, r.text
    assert seen == [], "context must not be loaded for a rejected sub"


def test_score_log_mode_binds_sub_to_verified_principal(monkeypatch):
    """Log mode doesn't reject, but the verified principal still wins."""
    with _score_client(monkeypatch, "log", "plex:494190801") as (client, seen):
        r = client.post("/score", json={"sub": "plex:999000111", "kind": "movie", "n": 5})
    assert r.status_code == 599, r.text
    assert seen == ["plex:494190801"], "body sub leaked past the verified principal"


def test_score_off_mode_still_uses_body_sub(monkeypatch):
    """No principal bridge (mode=off) -> unchanged behavior, body sub is used."""
    _set_mode(monkeypatch, "off")
    seen: list[str] = []

    def _spy(conn, req, *, persist_library=False):
        seen.append(req.sub)
        raise HTTPException(status_code=599, detail="stopped after sub binding")

    monkeypatch.setattr(main_module, "load_user_context", _spy)
    overrides = main_module.app.dependency_overrides
    overrides[main_module.get_db] = lambda: None
    overrides[main_module.require_event_secret] = lambda: None
    overrides[main_module.internal_principal_dep] = lambda: None
    try:
        r = TestClient(main_module.app).post(
            "/score", json={"sub": "plex:999000111", "kind": "movie", "n": 5}
        )
    finally:
        for dep in (
            main_module.get_db,
            main_module.require_event_secret,
            main_module.internal_principal_dep,
        ):
            overrides.pop(dep, None)
    assert r.status_code == 599, r.text
    assert seen == ["plex:999000111"]


def test_health_surfaces_principal_mode(monkeypatch):
    _set_mode(monkeypatch, "off")
    conn = _seeded_conn()
    # Override the per-request DB dependency so /health doesn't need a real
    # on-disk migrated database for this introspection assertion.
    main_module.app.dependency_overrides[main_module.get_db] = lambda: conn
    try:
        client = TestClient(main_module.app)
        body = client.get("/health").json()
    finally:
        main_module.app.dependency_overrides.pop(main_module.get_db, None)
        conn.close()
    assert body["ok"] is True
    assert body["internal_principal_mode"] == "off"
    assert body["optimizer"]["mode"] in {"active", "record-only", "unknown"}
