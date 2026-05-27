"""Cross-language byte-equality tests for the emerald_contracts PyO3 binding.

Every assertion here is also enforced on the Rust side via
``cargo test`` and (where applicable) on the TS side via ``npm test``.
If this file fails, the recommender is producing different bytes than
Hono — which means M3 will silently break when Hono mints an
internal-principal that Python can't decode.

Skipped automatically when the ``emerald_contracts`` module isn't
installed (e.g., dev machine without maturin). CI installs it via
``maturin develop --release`` in the dedicated job.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

emerald_contracts = pytest.importorskip(
    "emerald_contracts",
    reason="run `maturin develop --release` in crates/emerald-contracts-pyo3 first",
)

VECTOR_DIR = Path(__file__).resolve().parents[2] / "tests" / "vectors"


# ---------------------------------------------------------------------------
# parse_sub — drives the same vector Rust + TS run
# ---------------------------------------------------------------------------


def _sub_vectors() -> list[dict]:
    return json.loads((VECTOR_DIR / "sub-namespace.json").read_text())


@pytest.mark.parametrize("case", _sub_vectors(), ids=lambda c: c["name"])
def test_parse_sub_vector(case: dict) -> None:
    if case["valid"]:
        got = emerald_contracts.parse_sub(case["input"])
        assert got["provider"] == case["provider"], (
            f"{case['name']}: provider mismatch — got {got['provider']!r}, "
            f"expected {case['provider']!r}"
        )
        assert got["id"] == case["id"], (
            f"{case['name']}: id mismatch — got {got['id']!r}, expected {case['id']!r}"
        )
        assert got["raw"] == case["input"]
    else:
        with pytest.raises(ValueError):
            emerald_contracts.parse_sub(case["input"])


# ---------------------------------------------------------------------------
# HKDF — byte-for-byte match against the same vector Rust + TS run
# ---------------------------------------------------------------------------


def _hkdf_vectors() -> list[dict]:
    return json.loads((VECTOR_DIR / "hkdf-parity.json").read_text())["vectors"]


@pytest.mark.parametrize("vec", _hkdf_vectors(), ids=lambda v: v["name"])
def test_hkdf_session_vector(vec: dict) -> None:
    ikm = vec["ikm_utf8"].encode("utf-8")
    expected = bytes.fromhex(vec["derivations"]["session"]["okm_hex"])
    assert emerald_contracts.hkdf_session(ikm) == expected


@pytest.mark.parametrize("vec", _hkdf_vectors(), ids=lambda v: v["name"])
def test_hkdf_device_token_vector(vec: dict) -> None:
    ikm = vec["ikm_utf8"].encode("utf-8")
    expected = bytes.fromhex(vec["derivations"]["device_token"]["okm_hex"])
    assert emerald_contracts.hkdf_device_token(ikm) == expected


@pytest.mark.parametrize("vec", _hkdf_vectors(), ids=lambda v: v["name"])
def test_hkdf_internal_principal_vector(vec: dict) -> None:
    ikm = vec["ikm_utf8"].encode("utf-8")
    expected = bytes.fromhex(vec["derivations"]["internal_principal"]["okm_hex"])
    assert emerald_contracts.hkdf_internal_principal(ikm) == expected


# ---------------------------------------------------------------------------
# PII scrub — denylist contents + scrub semantics
# ---------------------------------------------------------------------------


def test_pii_scrub_keys_nonempty_and_lowercase() -> None:
    keys = emerald_contracts.pii_scrub_keys()
    assert len(keys) > 0
    # Crate-level invariant: every denylist entry is already lowercase so
    # the case-insensitive substring match works correctly. If a new entry
    # slips in uppercase, the matcher will still work but the contract
    # gets harder to reason about.
    assert all(k == k.lower() for k in keys), [k for k in keys if k != k.lower()]
    # Spot-check a few entries known to be in the contract.
    for must_include in ("plex_token", "password", "authorization"):
        assert must_include in keys


def test_pii_scrub_replaces_known_keys() -> None:
    payload = {
        "plex_token": "abc",
        "password": "hunter2",
        "username": "alice",
    }
    scrubbed = json.loads(emerald_contracts.pii_scrub_value(json.dumps(payload)))
    assert scrubbed["plex_token"] == "[Filtered]"
    assert scrubbed["password"] == "[Filtered]"
    assert scrubbed["username"] == "alice"


def test_pii_scrub_redacts_bearer_in_string_value() -> None:
    payload = {"url": "GET /api/x with Bearer tok-123"}
    scrubbed = json.loads(emerald_contracts.pii_scrub_value(json.dumps(payload)))
    assert "Bearer" not in scrubbed["url"] or "[Filtered:bearer]" in scrubbed["url"]


# ---------------------------------------------------------------------------
# Internal-principal — recommender will *verify* inbound principals
# minted by Hono. Round-trip test here proves the PyO3 surface can do it.
# ---------------------------------------------------------------------------


def test_internal_principal_enforce_time_window_rejects_expired() -> None:
    # exp = 100, now = 200 → expired
    with pytest.raises(ValueError):
        emerald_contracts.internal_principal_enforce_time_window(100, 200)


def test_internal_principal_enforce_time_window_accepts_within() -> None:
    # exp = 100, now = 50 → fine
    emerald_contracts.internal_principal_enforce_time_window(100, 50)
