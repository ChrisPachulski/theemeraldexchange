"""Optimizer recipe eligibility: offline-only recipes must never auto-promote.

item_knn's candidate_pool default is "full" — its own docstring calls that
mode "brute-force, offline-only" — and the serve-time DEFAULTS re-merge means
a promoted item_knn config would brute-force the whole catalog per request.
Two layers guard against this: the eligibility list (what the nightly prompt
offers Claude) and a validate_proposal check on the module's OFFLINE_ONLY flag
(in case the eligibility list ever regresses).
"""

from __future__ import annotations

from app import recipes
from workers import optimizer


def test_item_knn_declares_offline_only() -> None:
    assert getattr(recipes.get("item_knn"), "OFFLINE_ONLY", False) is True


def test_eligible_recipes_exclude_offline_only_and_orchestration_only() -> None:
    assert "item_knn" not in optimizer.OPTIMIZER_ELIGIBLE_RECIPES
    assert "cold_start_trending" not in optimizer.OPTIMIZER_ELIGIBLE_RECIPES
    # The production serve recipes stay eligible.
    assert {"baseline_cosine", "mmr_diverse", "fused"} <= set(optimizer.OPTIMIZER_ELIGIBLE_RECIPES)


def test_validate_proposal_rejects_offline_only_recipe() -> None:
    proposed = {"recipe": "item_knn", "params": {"pool_size": 800}, "notes": "x"}
    assert optimizer.validate_proposal(proposed, "fused", dict(recipes.get("fused").DEFAULTS)) is None


def test_validate_proposal_rejects_offline_only_even_if_eligibility_regresses(monkeypatch) -> None:
    # Belt-and-braces: force item_knn back onto the eligibility list and verify
    # the OFFLINE_ONLY module flag still blocks it.
    monkeypatch.setattr(
        optimizer,
        "OPTIMIZER_ELIGIBLE_RECIPES",
        (*optimizer.OPTIMIZER_ELIGIBLE_RECIPES, "item_knn"),
    )
    proposed = {"recipe": "item_knn", "params": {}, "notes": "x"}
    assert optimizer.validate_proposal(proposed, "fused", dict(recipes.get("fused").DEFAULTS)) is None


def test_validate_proposal_still_accepts_serve_recipe() -> None:
    active_params = dict(recipes.get("fused").DEFAULTS)
    proposed = {"recipe": "fused", "params": {"cast_weight": 0.8}, "notes": "bump cast"}
    validated = optimizer.validate_proposal(proposed, "fused", active_params)
    assert validated is not None
    recipe, params, notes = validated
    assert recipe == "fused"
    assert params["cast_weight"] == 0.8
    assert notes == "bump cast"
