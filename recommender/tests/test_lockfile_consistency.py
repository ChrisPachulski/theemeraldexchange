"""Every pyproject.toml dependency floor must be satisfied by the pin in
requirements.lock.

The lock is hand-frozen from the production container (see its header), so a
naive freeze-regen can silently revert a deliberate floor bump — exactly how
the setuptools security bump (PYSEC-2025-49, >=78.1.1) would regress. This
test makes such a revert a loud CI failure instead of a silent drift.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

RECOMMENDER_DIR = Path(__file__).resolve().parents[1]


def _locked_versions() -> dict[str, Version]:
    out: dict[str, Version] = {}
    for line in (RECOMMENDER_DIR / "requirements.lock").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, _, version = line.partition("==")
        assert version, f"lock line is not an exact pin: {line!r}"
        # Local version labels (torch's +cpu) are equal to their public
        # version for floor comparison purposes.
        out[canonicalize_name(name)] = Version(version.split("+", 1)[0])
    return out


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
    # PYSEC-2025-49: the lock header documents this floor explicitly; a
    # freeze-regen from a stale prod container must not drop it.
    locked = _locked_versions()
    assert locked.get("setuptools") is not None, "setuptools pin missing from requirements.lock"
    assert locked["setuptools"] >= Version("78.1.1")


def test_removed_apscheduler_stays_out() -> None:
    # The dead scheduler was removed (main.py no longer imports it); a regen
    # from an old container image would silently reintroduce the dependency.
    locked = _locked_versions()
    assert "apscheduler" not in locked
    assert all(canonicalize_name(r.name) != "apscheduler" for r in _pyproject_requirements())
