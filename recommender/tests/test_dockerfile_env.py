"""Guards the prod-image binding policy declared in app/sub_validation.py.

EEX_REQUIRE_BINDING=1 must be baked into the runtime image so a broken/
missing emerald_contracts wheel is a hard startup failure in prod, not a
silent pass-through validator. Nothing else sets this env var, so the
Dockerfile is the only place it can come from.
"""

from __future__ import annotations

from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


def test_dockerfile_sets_require_binding():
    lines = DOCKERFILE.read_text().splitlines()
    assert any(
        "EEX_REQUIRE_BINDING=1" in line for line in lines
    ), "Dockerfile must set ENV EEX_REQUIRE_BINDING=1 in the runtime stage"
