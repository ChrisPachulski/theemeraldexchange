"""Recipe registry.

Each recipe is a module exposing:

    DEFAULTS: dict[str, float | int | str]   # default params
    def score(ctx, conn, *, n, params) -> ScoreResult

The active recipe + its params live in ``model_config``. The optimizer
writes new rows here on each nightly run.
"""

from __future__ import annotations

from importlib import import_module
from typing import Protocol

from ..schemas import ScoredItem


class RecipeScore(Protocol):
    def __call__(self, ctx, conn, *, n: int, params: dict) -> "RecipeResult":  # noqa: D401
        ...


class RecipeResult:
    def __init__(self, items: list[ScoredItem], diag: dict[str, object] | None = None):
        self.items = items
        self.diag = diag or {}


REGISTRY: dict[str, str] = {
    "baseline_cosine": "app.recipes.baseline_cosine",
    "mmr_diverse": "app.recipes.mmr_diverse",
    "cold_start_trending": "app.recipes.cold_start_trending",
    # Research variants (not yet promoted to production):
    "item_knn": "app.recipes.item_knn",
}


def get(recipe_name: str):
    module_path = REGISTRY.get(recipe_name)
    if module_path is None:
        raise KeyError(f"unknown recipe: {recipe_name}")
    return import_module(module_path)
