"""Cosine sim against the user's positive centroid + small popularity prior.

This is the simplest recipe and the optimizer's starting point. It's also a
useful sanity-check baseline — if mmr_diverse or some future recipe doesn't
beat this on the eval holdout, we know the change isn't helping.
"""

from __future__ import annotations

import sqlite3

from ..context import Candidate, UserContext
from ..reasons import discover_reason, neighbors_for, personalized_reason
from ..retrieval import retrieve_candidates
from ..schemas import ScoredItem
from . import RecipeResult, _normalize, cold_start_result

DEFAULTS: dict[str, float | int | str] = {
    "pool_size": 500,
    "negative_weight": 0.30,
    "popularity_weight": 0.05,
    "min_vote_count": 50,
    "personalized_threshold": 0.45,  # cosine sim threshold for personalized provenance
}


def score(ctx: UserContext, conn: sqlite3.Connection, *, n: int, params: dict) -> RecipeResult:
    p = {**DEFAULTS, **params}
    pool_size = int(p["pool_size"])
    neg_w = float(p["negative_weight"])
    pop_w = float(p["popularity_weight"])
    min_votes = int(p["min_vote_count"])
    tau = float(p["personalized_threshold"])

    # Cold start: no positive signal at all — fall back to popularity.
    pos = ctx.positive_centroid()
    if pos is None:
        return cold_start_result(conn, ctx, n=n, min_vote_count=min_votes)

    neg = ctx.negative_centroid()
    query_vec = _normalize(pos - neg_w * neg) if neg is not None else _normalize(pos)

    batch = retrieve_candidates(
        conn,
        kind=ctx.kind,
        query_vec=query_vec,
        user=ctx,
        pool_size=pool_size,
        min_vote_count=min_votes,
    )
    if not batch.candidates:
        return RecipeResult(items=[], diag={"path": "empty_pool", **batch.diag})

    # sqlite-vec returns cosine *distance* (0=identical, 2=opposite). Convert
    # back to sim and add a tiny popularity prior so two near-identical
    # neighbors don't surface a no-name title above a beloved one.
    pop_max = max((c.title.popularity for c in batch.candidates), default=1.0) or 1.0
    scored: list[tuple[float, float, Candidate]] = []
    for cand, dist in zip(batch.candidates, batch.distances, strict=True):
        sim = 1.0 - dist
        pop_prior = (cand.title.popularity / pop_max) if pop_max else 0.0
        combined = sim + pop_w * pop_prior
        scored.append((combined, sim, cand))

    scored.sort(key=lambda t: t[0], reverse=True)
    top = scored[:n]

    items: list[ScoredItem] = []
    for combined, sim, cand in top:
        provenance = "personalized" if sim >= tau else "discover"
        if provenance == "personalized":
            neighbors = neighbors_for(cand, ctx, k=2)
            reason = personalized_reason(cand, neighbors)
        else:
            reason = discover_reason(cand)
        items.append(
            ScoredItem(
                tmdb_id=cand.title.tmdb_id,
                title=cand.title.title,
                year=cand.title.year,
                poster_path=cand.title.poster_path,
                overview=cand.title.overview,
                score=float(combined),
                provenance=provenance,
                reason=reason,
            )
        )

    diag: dict[str, object] = {"path": "personalized", **batch.diag, "tau": tau}
    return RecipeResult(items=items, diag=diag)
