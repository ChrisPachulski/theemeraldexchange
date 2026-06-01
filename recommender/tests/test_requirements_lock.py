"""Drift guard for the committed dependency lockfile.

Pure-stdlib, network-free, no heavy imports (no torch / sentence-transformers).
Asserts that ``requirements.lock`` exists, is fully pinned, and covers every
top-level runtime dependency declared in ``pyproject.toml``.

The authoritative regeneration / strict-diff guard lives in CI
(.github/workflows/ci.yml, "Verify requirements.lock in sync with
pyproject.toml"); this test is the deterministic local proof that does not
depend on pip-compile's network behavior.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

RECOMMENDER_DIR = Path(__file__).resolve().parent.parent
PYPROJECT = RECOMMENDER_DIR / "pyproject.toml"
LOCKFILE = RECOMMENDER_DIR / "requirements.lock"

# A package line in a pip-compile lock: ``name==version`` (annotations, blank
# lines, ``--extra-index-url`` lines and ``#`` comments are not package lines).
_PIN_RE = re.compile(r"^([A-Za-z0-9_.\-]+)==")


def _normalize(name: str) -> str:
    """PEP 503 normalization: lowercase, collapse runs of ``-_.`` to ``-``."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _project_dependencies() -> list[str]:
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    return data["project"]["dependencies"]


def _dep_name(spec: str) -> str:
    """Strip extras and version specifiers from a dependency spec.

    ``uvicorn[standard]>=0.32`` -> ``uvicorn``
    ``python-dateutil>=2.9``    -> ``python-dateutil``
    """
    # Drop extras: everything from the first '[' up to the matching ']'.
    spec = re.sub(r"\[.*?\]", "", spec)
    # Name is the leading run of name-legal characters before any specifier.
    match = re.match(r"^\s*([A-Za-z0-9_.\-]+)", spec)
    assert match, f"could not parse dependency name from {spec!r}"
    return match.group(1)


def _locked_pins() -> dict[str, str]:
    """Map of normalized package name -> pinned version from the lockfile."""
    pins: dict[str, str] = {}
    for line in LOCKFILE.read_text(encoding="utf-8").splitlines():
        match = _PIN_RE.match(line)
        if match:
            name = match.group(1)
            version = line.split("==", 1)[1].strip()
            pins[_normalize(name)] = version
    return pins


def test_lockfile_exists_and_non_empty() -> None:
    assert LOCKFILE.is_file(), f"missing lockfile: {LOCKFILE}"
    assert LOCKFILE.stat().st_size > 0, "requirements.lock is empty"


def test_every_runtime_dependency_is_pinned() -> None:
    pins = _locked_pins()
    assert pins, "no pinned packages found in requirements.lock"
    missing = []
    for spec in _project_dependencies():
        name = _normalize(_dep_name(spec))
        if name not in pins:
            missing.append(name)
    assert not missing, (
        "pyproject.toml runtime dependencies absent from requirements.lock "
        f"(regenerate the lock): {sorted(missing)}"
    )


def test_no_dependency_floats_in_lockfile() -> None:
    """Every package line in the lock must be the pinned ``name==version`` form."""
    floats = []
    for line in LOCKFILE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("--"):
            continue
        # Annotation continuation lines start with '#', already skipped above.
        if not _PIN_RE.match(stripped):
            floats.append(line)
    assert not floats, f"unpinned / floating lines in requirements.lock: {floats}"
