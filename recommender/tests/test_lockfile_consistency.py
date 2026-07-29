"""Every pyproject.toml dependency floor must be satisfied by the pin in
requirements.lock.

The lock began as a production-container freeze (see its header), with
deliberate security and compatibility bumps layered on top. A naive freeze
regen can silently revert those bumps — exactly how the setuptools security
floor (PYSEC-2026-3447, >=83.0.0) would regress. These tests make such a revert
a loud CI failure instead of silent drift.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import struct
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

RECOMMENDER_DIR = Path(__file__).resolve().parents[1]
EXPECTED_EMBEDDINGS_SHA256 = "c62435ea899eddc1149eff4c49e078e4781381fcabcce472054129e39f48630b"


def _locked_entries() -> dict[str, tuple[Version, int]]:
    """name -> (version, hash_count), parsed from the hash-pinned lock format:

        name==version \\
            --hash=sha256:... \\
            --hash=sha256:...
    """
    out: dict[str, tuple[Version, int]] = {}
    current: str | None = None
    for line in (RECOMMENDER_DIR / "requirements.lock").read_text(encoding="utf-8").splitlines():
        line = line.strip().rstrip("\\").strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("--hash="):
            assert current is not None, f"orphaned hash line: {line!r}"
            version, hashes = out[current]
            out[current] = (version, hashes + 1)
            continue
        name, _, version = line.partition("==")
        assert version, f"lock line is not an exact pin: {line!r}"
        # Local version labels (torch's +cpu) are equal to their public
        # version for floor comparison purposes.
        current = canonicalize_name(name)
        out[current] = (Version(version.split("+", 1)[0]), 0)
    return out


def _locked_versions() -> dict[str, Version]:
    return {name: version for name, (version, _) in _locked_entries().items()}


def _pyproject_requirements() -> list[Requirement]:
    with (RECOMMENDER_DIR / "pyproject.toml").open("rb") as fh:
        data = tomllib.load(fh)
    return [Requirement(dep) for dep in data["project"]["dependencies"]]


def test_every_pyproject_floor_is_pinned_and_satisfied() -> None:
    locked = _locked_versions()
    problems: list[str] = []
    for req in _pyproject_requirements():
        name = canonicalize_name(req.name)
        pinned = locked.get(name)
        if pinned is None:
            problems.append(f"{req.name}: declared in pyproject.toml but missing from requirements.lock")
            continue
        if req.specifier and not req.specifier.contains(pinned, prereleases=True):
            problems.append(
                f"{req.name}: lock pins {pinned} which violates pyproject floor {req.specifier}"
            )
    assert not problems, "\n".join(problems)


def test_setuptools_security_floor_held() -> None:
    # PYSEC-2026-3447: the lock header documents this floor explicitly; a
    # freeze-regen from a stale prod container must not drop it.
    locked = _locked_versions()
    assert locked.get("setuptools") is not None, "setuptools pin missing from requirements.lock"
    assert locked["setuptools"] >= Version("83.0.0")


def test_torch_setuptools_resolver_compatibility_floor() -> None:
    # Torch 2.11 and 2.12 declare setuptools<82, which cannot coexist with
    # the PYSEC-2026-3447 security floor above. Torch 2.13 removes that
    # ceiling. Keep stale production freezes from restoring the conflict.
    locked = _locked_versions()
    assert locked.get("torch") is not None, "torch pin missing from requirements.lock"
    assert locked["torch"] >= Version("2.13.0")


def test_embedding_baseline_fixture_is_complete() -> None:
    path = RECOMMENDER_DIR / "tests" / "fixtures" / "torch_2_12_embedding_baseline.json"
    fixture = json.loads(path.read_text(encoding="utf-8"))
    revision = fixture["model_revision"]
    assert len(revision) == 40
    assert all(character in "0123456789abcdef" for character in revision)
    rows, dim = fixture["shape"]
    encoded = fixture["embeddings_base64"].encode("ascii")
    raw = base64.b64decode(encoded, validate=True)
    assert len(raw) == rows * dim * 4
    assert fixture["embeddings_sha256"] == EXPECTED_EMBEDDINGS_SHA256
    assert hashlib.sha256(raw).hexdigest() == EXPECTED_EMBEDDINGS_SHA256

    values = struct.unpack(f"<{rows * dim}f", raw)
    assert all(math.isfinite(value) for value in values)
    assert len(fixture["texts"]) == rows
    assert len(fixture["top3_neighbors"]) == rows
    for index, neighbors in enumerate(fixture["top3_neighbors"]):
        assert len(neighbors) == 3
        assert len(set(neighbors)) == 3
        assert index not in neighbors
        assert all(0 <= neighbor < rows for neighbor in neighbors)


def test_every_pin_is_hash_pinned() -> None:
    # The lock is hash-pinned (supply-chain hardening): pip auto-enables
    # hash-checking mode when ANY entry carries hashes, and that mode
    # requires hashes on EVERY entry — a single hashless pin breaks the
    # Docker/CI install. Regen per the lock-header recipe keeps this green.
    entries = _locked_entries()
    assert entries, "requirements.lock parsed to zero pins"
    missing = [name for name, (_, hashes) in entries.items() if hashes == 0]
    assert not missing, f"pins without --hash entries: {missing}"


def test_removed_apscheduler_stays_out() -> None:
    # The dead scheduler was removed (main.py no longer imports it); a regen
    # from an old container image would silently reintroduce the dependency.
    locked = _locked_versions()
    assert "apscheduler" not in locked
    assert all(canonicalize_name(r.name) != "apscheduler" for r in _pyproject_requirements())
