"""Cosine recall + Maximal Marginal Relevance for genre spread.

Same retrieval and scoring as ``baseline_cosine``, then re-rank the top-K
with MMR so the final 20 isn't all the same neighborhood. λ controls the
relevance/diversity trade-off — 0.7 is the default (relevance-heavy).
"""

from __future__ import annotations

import sqlite3

import numpy as np

from ..context import Candidate, UserContext
from ..reasons import discover_reason, neighbors_for, personalized_reason, trending_reason
from ..retrieval import cold_start_pool, retrieve_candidates
from ..schemas import ScoredItem
from . import RecipeResult, _normalize, EMBED_EPS

DEFAULTS: dict[str, float | int | str] = {
    "pool_size": 800,
    "negative_weight": 0.30,
    "popularity_weight": 0.05,
    "min_vote_count": 50,
    "personalized_threshold": 0.45,
    "mmr_lambda": 0.70,
    "mmr_input_k": 200,
}


def _mmr(
    cands: list[Candidate],
    relevance: list[float],
    *,
    lam: float,
    n: int,
) -> list[int]:
    """Return indices into ``cands`` representing the MMR-selected order."""
    if not cands:
        return []
    embs = np.vstack([c.embedding for c in cands])
    norms = np.linalg.norm(embs, axis=1)
    valid = np.isfinite(embs).all(axis=1) & np.isfinite(norms) & (norms > EMBED_EPS)
    if not valid.any():
        return []
    valid_indices = np.flatnonzero(valid)
    embs = embs[valid] / norms[valid, None]
    rel = np.array(relevance, dtype=np.float32)[valid]
    selected: list[int] = []
    remaining = list(range(len(valid_indices)))

    while remaining and len(selected) < n:
        if not selected:
            best = max(remaining, key=lambda i: rel[i])
            selected.append(best)
            remaining.remove(best)
            continue
        sel_mat = embs[selected]
        sims_to_selected = embs[remaining] @ sel_mat.T  # (R, S)
        max_sim = sims_to_selected.max(axis=1)
        scores = lam * rel[remaining] - (1.0 - lam) * max_sim
        best_local = int(scores.argmax())
        best = remaining[best_local]
        selected.append(best)
        remaining.pop(best_local)
    return [int(valid_indices[i]) for i in selected]


def score(ctx: UserContext, conn: sqlite3.Connection, *, n: int, params: dict) -> RecipeResult:
    p = {**DEFAULTS, **params}
    pool_size = int(p["pool_size"])
    neg_w = float(p["negative_weight"])
    pop_w = float(p["popularity_weight"])
    min_votes = int(p["min_vote_count"])
    tau = float(p["personalized_threshold"])
    lam = float(p["mmr_lambda"])
    mmr_k = max(n, int(p["mmr_input_k"]))

    pos = ctx.positive_centroid()
    if pos is None:
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
        return RecipeResult(items=items, diag={"path": "cold_start", "pool": len(items)})

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

    # Rank by sim + popularity prior; keep mmr_k for MMR re-rank.
    pop_max = max((c.title.popularity for c in batch.candidates), default=1.0) or 1.0
    pre = []
    for cand, dist in zip(batch.candidates, batch.distances, strict=True):
        sim = 1.0 - dist
        pop_prior = (cand.title.popularity / pop_max) if pop_max else 0.0
        pre.append((sim + pop_w * pop_prior, sim, cand))
    pre.sort(key=lambda t: t[0], reverse=True)
    pre = pre[:mmr_k]

    cands = [t[2] for t in pre]
    relevance = [t[0] for t in pre]
    order = _mmr(cands, relevance, lam=lam, n=n)

    items: list[ScoredItem] = []
    for idx in order:
        combined, sim, cand = pre[idx]
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

    return RecipeResult(
        items=items,
        diag={"path": "mmr", **batch.diag, "lambda": lam, "mmr_input": len(pre), "tau": tau},
    )
