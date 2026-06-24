"""Recipe registry.

Each recipe is a module exposing:

    DEFAULTS: dict[str, float | int | str]   # default params
    def score(ctx, conn, *, n, params) -> ScoreResult

The active recipe + its params live in ``model_config``. The optimizer
writes new rows here on each nightly run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from importlib import import_module

import numpy as np

from ..schemas import ScoredItem

# Shared embedding helpers used across recipe modules. EMBED_EPS is the
# floor used when normalising rows so a zero-norm vector doesn't divide by
# zero; _normalize unit-normalises a single query vector (no-op on a zero
# vector). Previously copied verbatim into each recipe.
EMBED_EPS = 1e-9


def _normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


@dataclass
class RecipeResult:
    items: list[ScoredItem]
    diag: dict[str, object] = field(default_factory=dict)


REGISTRY: dict[str, str] = {
    "baseline_cosine": "app.recipes.baseline_cosine",
    "mmr_diverse": "app.recipes.mmr_diverse",
    "cold_start_trending": "app.recipes.cold_start_trending",
    # Promoted from the research loop: content + cast/crew fused item re-rank.
    "fused": "app.recipes.fused",
    # Research variants (not yet promoted to production):
    "item_knn": "app.recipes.item_knn",
}


def get(recipe_name: str):
    module_path = REGISTRY.get(recipe_name)
    if module_path is None:
        raise KeyError(f"unknown recipe: {recipe_name}")
    return import_module(module_path)
