"""Popularity-only fallback for libraries below the cold-start threshold.

Selected by the orchestrator (``main.py``) when ``len(library) <
CONFIG.cold_start_threshold``. Preserves today's behavior — a new household
sees popular titles, not random noise — without making them pay for it.
"""

from __future__ import annotations

import sqlite3

from ..context import UserContext
from ..reasons import trending_reason
from ..retrieval import cold_start_pool
from ..schemas import ScoredItem
from . import RecipeResult

DEFAULTS: dict[str, float | int | str] = {"min_vote_count": 100}


def score(ctx: UserContext, conn: sqlite3.Connection, *, n: int, params: dict) -> RecipeResult:
    p = {**DEFAULTS, **params}
    min_votes = int(p["min_vote_count"])
    rows = cold_start_pool(conn, kind=ctx.kind, user=ctx, pool_size=n, min_vote_count=min_votes)
    items = [
        ScoredItem(
            tmdb_id=r.tmdb_id,
            title=r.title,
            year=r.year,
            poster_path=r.poster_path,
            overview=r.overview,
            score=float(r.popularity or 0.0),
            provenance="trending",
            reason=trending_reason(r),
        )
        for r in rows
    ]
    return RecipeResult(items=items, diag={"path": "cold_start_trending", "pool": len(items)})
