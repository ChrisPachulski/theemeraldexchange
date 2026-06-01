"""Item-based kNN: score a candidate by its similarity to the library items the
household ALREADY has, not by distance to a single averaged user vector.

PRODUCTION LINEAGE
  - Amazon item-to-item collaborative filtering (Linden, Smith & York, IEEE
    Internet Computing 2003): the canonical deployed recommender. "Customers who
    bought X" scores each candidate by its relationship to the items already in
    the basket/history -- never an averaged user profile. Battle-tested at
    Amazon scale for two decades.
  - EASE (Steck, "Embarrassingly Shallow Autoencoders", WWW 2019; Zotero corpus
    Steck2019_EASE.pdf): the closed-form item-item model, state of the art on
    sparse data. EASE is item-item similarity learned optimally; this recipe is
    the content-similarity (cosine) analog -- the natural first step before a
    learned item-item Gram matrix, and the right fit for a single household with
    no cross-user co-occurrence signal.

WHY (iteration-1 evidence)
  The deployed mmr_diverse / baseline_cosine recipes query the ANN index with a
  SINGLE positive centroid (mean of ~750 library embeddings). The blind-spot
  probe showed max similarity to ANY library item beats similarity to the
  centroid for 98.9% of movie / 95.7% of tv held-out titles (mean gap +0.20 /
  +0.16). Averaging collapses a diverse library; item-based scoring does not.

AGGREGATION
  candidate score = aggregate over library items of cosine(candidate, lib_item).
  neighbor_topk = 1 -> pure max (nearest-neighbor, Amazon-style). >1 -> mean of
  the top-k nearest library items (smooths single-twin noise). A small
  popularity prior matches the other recipes so two equally-similar candidates
  break ties toward the better-known title.
"""

from __future__ import annotations

import sqlite3

import numpy as np

from ..context import Candidate, TitleRow, UserContext, title_key_variants
from ..db import deserialize_f32
from ..reasons import discover_reason, personalized_reason, trending_reason
from ..retrieval import AVAILABLE_TITLE_PREDICATE, cold_start_pool, retrieve_candidates
from ..schemas import ScoredItem
from . import RecipeResult

DEFAULTS: dict[str, float | int | str] = {
    "popularity_weight": 0.05,
    "min_vote_count": 50,
    "personalized_threshold": 0.45,  # cosine-sim threshold for personalized provenance
    "neighbor_topk": 1,              # 1 = pure max-sim (Amazon item-to-item); >1 = top-k mean
    # Candidate universe:
    #   "full" = score every eligible catalog item (the retrieval-UNBOUNDED
    #            ceiling -- measures the best item-item SCORING can do if
    #            retrieval were perfect; brute-force, offline-only).
    #   "ann"  = restrict to the centroid-ANN pool of pool_size, the SAME
    #            candidate budget the production mmr_diverse/baseline_cosine
    #            recipes get. This is the fair A/B: same candidates, different
    #            scoring -> isolates scoring quality from retrieval reach.
    # The gap between "full" and "ann" is the retrieval-vs-scoring decomposition
    # (skeptic CRITICAL #1, iteration 2).
    "candidate_pool": "full",
    "pool_size": 800,
}

EMBED_EPS = 1e-9

# Module-level catalog cache keyed by (kind, min_vote_count). Loading the full
# eligible-catalog embedding matrix once and reusing it across calls is what
# makes the leave-one-out eval (hundreds of folds) tractable. Production would
# hold this in the ANN index instead; here it is an in-process numpy matrix.
_CATALOG: dict[tuple[str, int], dict] = {}


def _normalize_rows(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms < EMBED_EPS] = 1.0
    return mat / norms


def _load_catalog(conn: sqlite3.Connection, kind: str, min_votes: int) -> dict:
    key = (kind, min_votes)
    cached = _CATALOG.get(key)
    if cached is not None:
        return cached
    rows = conn.execute(
        f"""SELECT t.tmdb_id, t.title, t.year, t.poster_path, t.overview,
                  COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                  (SELECT GROUP_CONCAT(genre_id) FROM (
                     SELECT g.genre_id FROM title_genres g
                     WHERE g.kind = t.kind AND g.tmdb_id = t.tmdb_id
                     ORDER BY g.genre_id
                   )) AS genres,
                  f.embedding AS embedding, f.dim AS dim
           FROM titles t
           JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
           WHERE t.kind = ?
             AND COALESCE(t.vote_count, 0) >= ?
             AND {AVAILABLE_TITLE_PREDICATE}""",
        (kind, min_votes),
    ).fetchall()

    ids: list[int] = []
    titles: dict[int, TitleRow] = {}
    keys: dict[int, set[str]] = {}
    vecs: list[np.ndarray] = []
    pops: list[float] = []
    for r in rows:
        gids = tuple(int(g) for g in r["genres"].split(",")) if r["genres"] else ()
        ids.append(r["tmdb_id"])
        titles[r["tmdb_id"]] = TitleRow(
            tmdb_id=r["tmdb_id"],
            kind=kind,
            title=r["title"],
            year=r["year"],
            poster_path=r["poster_path"],
            overview=r["overview"],
            popularity=r["popularity"] or 0.0,
            vote_average=r["vote_average"],
            genre_ids=gids,
        )
        keys[r["tmdb_id"]] = title_key_variants(r["title"])
        vecs.append(deserialize_f32(r["embedding"], dim=r["dim"]))
        pops.append(float(r["popularity"] or 0.0))

    mat = _normalize_rows(np.vstack(vecs).astype(np.float32)) if vecs else np.zeros((0, 1), np.float32)
    pop_arr = np.asarray(pops, dtype=np.float32)
    cat = {
        "ids": ids,
        "index": {tid: i for i, tid in enumerate(ids)},
        "mat": mat,
        "pop": pop_arr,
        "pop_max": float(pop_arr.max()) if pop_arr.size else 1.0,
        "titles": titles,
        "keys": keys,
    }
    _CATALOG[key] = cat
    return cat


def _library_matrix(ctx: UserContext) -> np.ndarray | None:
    if ctx.library_embeddings is None and ctx.liked_embeddings is None:
        return None
    chunks = [c for c in (ctx.library_embeddings, ctx.liked_embeddings) if c is not None]
    return _normalize_rows(np.concatenate(chunks, axis=0).astype(np.float32))


def _aggregate_sim(mat: np.ndarray, lib: np.ndarray, topk: int) -> np.ndarray:
    """Per-candidate aggregate similarity to the library (max, or top-k mean)."""
    sims = mat @ lib.T  # (E, nlib)
    if topk == 1 or sims.shape[1] <= topk:
        return sims.max(axis=1)
    part = np.partition(sims, -topk, axis=1)[:, -topk:]
    return part.mean(axis=1)


def _ann_universe(ctx: UserContext, conn: sqlite3.Connection, lib: np.ndarray, *, pool_size: int, min_votes: int):
    """Build a candidate universe from the centroid-ANN pool (same budget the
    production recipes get). Returns (mat, ids, titles, keys, pop, pop_max)."""
    pos = ctx.positive_centroid()
    if pos is None:
        return None
    batch = retrieve_candidates(
        conn, kind=ctx.kind, query_vec=pos, user=ctx,
        pool_size=pool_size, min_vote_count=min_votes,
    )
    if not batch.candidates:
        return None
    ids = [c.title.tmdb_id for c in batch.candidates]
    titles = {c.title.tmdb_id: c.title for c in batch.candidates}
    keys = {c.title.tmdb_id: title_key_variants(c.title.title) for c in batch.candidates}
    mat = _normalize_rows(np.vstack([c.embedding for c in batch.candidates]).astype(np.float32))
    pop = np.asarray([c.title.popularity or 0.0 for c in batch.candidates], dtype=np.float32)
    return mat, ids, titles, keys, pop, (float(pop.max()) if pop.size else 1.0)


def score(ctx: UserContext, conn: sqlite3.Connection, *, n: int, params: dict) -> RecipeResult:
    p = {**DEFAULTS, **params}
    pop_w = float(p["popularity_weight"])
    min_votes = int(p["min_vote_count"])
    tau = float(p["personalized_threshold"])
    topk = max(1, int(p["neighbor_topk"]))
    mode = str(p["candidate_pool"])
    pool_size = int(p["pool_size"])

    lib = _library_matrix(ctx)
    if lib is None or lib.shape[0] == 0:
        rows = cold_start_pool(conn, kind=ctx.kind, user=ctx, pool_size=n, min_vote_count=min_votes)
        items = [
            ScoredItem(
                tmdb_id=r.tmdb_id, title=r.title, year=r.year, poster_path=r.poster_path,
                overview=r.overview, score=float(r.popularity or 0.0),
                provenance="trending", reason=trending_reason(r),
            )
            for r in rows
        ]
        return RecipeResult(items=items, diag={"path": "cold_start", "pool": len(items)})

    if mode == "ann":
        universe = _ann_universe(ctx, conn, lib, pool_size=pool_size, min_votes=min_votes)
        if universe is None:
            return RecipeResult(items=[], diag={"path": "item_knn_ann", "pool": 0})
        mat, ids, titles, keys, pop, pop_max = universe
    else:
        cat = _load_catalog(conn, ctx.kind, min_votes)
        if cat["mat"].shape[0] == 0:
            return RecipeResult(items=[], diag={"path": "empty_catalog"})
        mat, ids, titles, keys, pop, pop_max = (
            cat["mat"], cat["ids"], cat["titles"], cat["keys"], cat["pop"], cat["pop_max"]
        )

    sim_score = _aggregate_sim(mat, lib, topk)
    combined = sim_score + pop_w * (pop / (pop_max or 1.0))

    excluded = ctx.library_ids | ctx.rejected_ids | ctx.recently_shown_ids | ctx.disliked_ids
    order = np.argsort(-combined)  # descending
    lib_keys = ctx.library_title_keys

    items: list[ScoredItem] = []
    for idx in order:
        tid = ids[idx]
        if tid in excluded:
            continue
        if lib_keys and keys[tid] & lib_keys:
            continue
        sim = float(sim_score[idx])
        title = titles[tid]
        provenance = "personalized" if sim >= tau else "discover"
        cand = Candidate(title=title, embedding=mat[idx])
        reason = personalized_reason(cand, []) if provenance == "personalized" else discover_reason(cand)
        items.append(
            ScoredItem(
                tmdb_id=tid, title=title.title, year=title.year, poster_path=title.poster_path,
                overview=title.overview, score=float(combined[idx]),
                provenance=provenance, reason=reason,
            )
        )
        if len(items) >= n:
            break

    return RecipeResult(
        items=items,
        diag={"path": f"item_knn_{mode}", "neighbor_topk": topk, "lib": int(lib.shape[0]),
              "universe": int(mat.shape[0]), "tau": tau, "pop_w": pop_w},
    )
