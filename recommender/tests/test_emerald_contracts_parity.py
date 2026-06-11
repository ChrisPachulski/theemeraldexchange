"""Cross-language byte-equality tests for the emerald_contracts PyO3 binding.

Every assertion here is also enforced on the Rust side via
``cargo test`` and (where applicable) on the TS side via ``npm test``.
If this file fails, the recommender is producing different bytes than
Hono — which means M3 will silently break when Hono mints an
internal-principal that Python can't decode.

Binding-availability policy (mirrors ``app/sub_validation.py``):
when ``EEX_REQUIRE_BINDING=1`` (CI + prod image) a missing
``emerald_contracts`` module is a HARD collection failure — a
green-skip here would let CI pass while enforcing none of the
cross-language byte-equality assertions. Without the flag (local dev
machine without maturin) the module skips as before.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

try:
    import emerald_contracts
except ImportError as exc:
    if os.environ.get("EEX_REQUIRE_BINDING") == "1":
        raise RuntimeError(
            "EEX_REQUIRE_BINDING=1 but the emerald_contracts PyO3 binding failed "
            "to import — the cross-language parity suite must run, not skip. "
            "Build it via `maturin develop --release` in "
            f"crates/emerald-contracts-pyo3. Original import error: {exc}"
        ) from exc
    pytest.skip(
        "emerald_contracts not installed — run `maturin develop --release` in "
        "crates/emerald-contracts-pyo3 first (set EEX_REQUIRE_BINDING=1 to make "
        "this a hard failure, as CI does)",
        allow_module_level=True,
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
# PII scrub — denylist contents + the §15.3 vector file (the same oracle
# the Rust harness and the TS binding-backed scrubber execute)
# ---------------------------------------------------------------------------


def test_pii_scrub_keys_nonempty_and_lowercase() -> None:
    keys = emerald_contracts.pii_scrub_keys()
    assert len(keys) > 0
    # Crate-level invariant: entries are stored lowercase — the matcher
    # lowercases only the key, so an uppercase entry could never match.
    assert all(k == k.lower() for k in keys), [k for k in keys if k != k.lower()]
    # Spot-check entries pinned by the §15.3 contract.
    for must_include in ("plexauthtoken", "password", "token", "cookie"):
        assert must_include in keys


def test_pii_scrub_replaces_known_keys() -> None:
    payload = {
        "plexAuthToken": "abc",
        "password": "hunter2",
        "username": "alice",
    }
    scrubbed = json.loads(emerald_contracts.pii_scrub_value(json.dumps(payload)))
    assert scrubbed["plexAuthToken"] == "REDACTED"
    assert scrubbed["password"] == "REDACTED"
    assert scrubbed["username"] == "alice"


def _pii_scrub_cases() -> list[dict]:
    return json.loads((VECTOR_DIR / "telemetry-pii-scrub.json").read_text())["cases"]


@pytest.mark.parametrize("case", _pii_scrub_cases(), ids=lambda c: c["id"])
def test_pii_scrub_vector(case: dict) -> None:
    scrubbed = json.loads(
        emerald_contracts.pii_scrub_value(json.dumps(case["input"]))
    )
    assert scrubbed == case["expected"], (
        f"{case['id']}: scrubbed output diverged from vector"
    )


# ---------------------------------------------------------------------------
# Internal-principal — recommender *verifies* inbound principals minted
# by Hono. tests/vectors/internal-principal.json drives the round trip;
# the Rust harness and the TS binding (mint side) execute the same file.
# ---------------------------------------------------------------------------


def _internal_principal_vector() -> dict:
    return json.loads((VECTOR_DIR / "internal-principal.json").read_text())


def test_internal_principal_vector_key_derivation() -> None:
    rt = _internal_principal_vector()["round_trip_vector"]
    derived = emerald_contracts.hkdf_internal_principal(
        rt["secret_hex_utf8"].encode("utf-8")
    )
    assert derived.hex() == rt["derived_key_hex"]


def test_internal_principal_vector_round_trip() -> None:
    vec = _internal_principal_vector()
    rt = vec["round_trip_vector"]
    kid = vec["jwe_shape"]["protected_header"]["kid"]
    key = bytes.fromhex(rt["derived_key_hex"])
    claims = rt["claims_input"]

    token = emerald_contracts.internal_principal_encrypt(key, kid, claims)
    decoded = emerald_contracts.internal_principal_decrypt({kid: key}, token)
    assert decoded == claims

    # negative_checks.nonce-uniqueness: random IV per encrypt is mandatory.
    token2 = emerald_contracts.internal_principal_encrypt(key, kid, claims)
    assert token2 != token


def test_internal_principal_vector_unknown_kid_rejects() -> None:
    vec = _internal_principal_vector()
    rt = vec["round_trip_vector"]
    key = bytes.fromhex(rt["derived_key_hex"])
    token = emerald_contracts.internal_principal_encrypt(
        key, "internal-v99", rt["claims_input"]
    )
    # Verifier must miss the map — never brute-force all keys.
    with pytest.raises(KeyError):
        emerald_contracts.internal_principal_decrypt({"internal-v1": key}, token)


def test_internal_principal_enforce_time_window_rejects_expired() -> None:
    # exp = 100, now = 200 → expired
    with pytest.raises(ValueError):
        emerald_contracts.internal_principal_enforce_time_window(100, 200)


def test_internal_principal_enforce_time_window_accepts_within() -> None:
    # exp = 100, now = 50 → fine
    emerald_contracts.internal_principal_enforce_time_window(100, 50)
