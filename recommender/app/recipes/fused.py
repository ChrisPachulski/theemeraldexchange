"""Content + cast/crew fused item-based re-rank (production port of the research
loop's iteration-3 win: leave-one-out nDCG@10 ~5x the centroid baseline).

WHAT IT DOES
  Retrieves the candidate pool via the existing sqlite-vec ANN around the
  positive centroid (same as baseline_cosine/mmr_diverse), then scores each
  candidate by its MAX FUSED similarity to ANY single library item -- not the
  distance to the averaged centroid (the averaged centroid collapses a diverse
  library; the research showed max-sim-to-an-item is the lever). The fused
  similarity per (candidate, library-item) pair is:

      fused = content_weight * cosine(content_embed)
            + cast_weight   * idf_overlap(top-billed cast)
            + crew_weight   * idf_overlap(key crew: director/writer/...)

  Cast/crew overlap is computed via a per-request inverted index (person -> the
  library items containing them), so it stays sparse/cheap -- no dense
  candidates x library product over the person vocabulary, no scipy.

LINEAGE: item-based scoring (Amazon item-to-item CF, Linden 2003) + multi-feature
item representation (Pinterest ItemSage, Baltescu 2022). IDF down-weights common
people so a shared character actor counts less than a shared lead/director.

HONEST SCOPE: the lift is creator-affinity (shared cast/crew). It does NOT recall
titles that share no cast/crew with the library (content alone is not
discriminative enough -- demonstrated). The co-engagement retrieval layer (the
further ~2x, needs an imported co-rating graph) is a separate follow-up.

Pure numpy + sqlite (the production deps); no scipy/torch/pandas at serve time.
"""

from __future__ import annotations

import math
import sqlite3

import numpy as np

from ..context import UserContext
from ..db import table_generation
from ..reasons import discover_reason, personalized_reason, trending_reason
from ..retrieval import cold_start_pool, retrieve_candidates
from ..schemas import ScoredItem
from . import RecipeResult

DEFAULTS: dict[str, float | int | str] = {
    "pool_size": 800,
    "negative_weight": 0.30,
    "popularity_weight": 0.05,
    "min_vote_count": 50,
    "personalized_threshold": 0.45,  # FUSED-sim threshold for personalized provenance
    "content_weight": 1.0,
    "cast_weight": 0.7,
    "crew_weight": 0.5,
    "cast_topn": 10,                 # top-billed cast only (order_idx < cast_topn)
}

KEY_CREW_JOBS = ("Director", "Writer", "Screenplay", "Story", "Creator", "Author", "Novel")
EMBED_EPS = 1e-9

# Global IDF over the catalog, cached per (kind, which, cast_topn). df is the
# number of titles a person appears in (top-billed cast / key crew). cast_topn
# is part of the key because it changes the df counts (only relevant for
# which == "cast"; crew entries always use cast_topn=0). The nightly ingest
# rehydrates title_cast/title_crew via DELETE+INSERT, so each entry carries the
# table_generation fingerprint it was computed against and is recomputed when
# the underlying tables move.
_IDF: dict[tuple[str, str, int], tuple[tuple, dict[int, float]]] = {}


def _normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def _idf_map(
    conn: sqlite3.Connection,
    kind: str,
    which: str,
    cast_topn: int = int(DEFAULTS["cast_topn"]),
) -> dict[int, float]:
    key = (kind, which, cast_topn if which == "cast" else 0)
    gen = table_generation(conn, "titles", "title_cast" if which == "cast" else "title_crew")
    cached = _IDF.get(key)
    if cached is not None and cached[0] == gen:
        return cached[1]
    if which == "cast":
        rows = conn.execute(
            "SELECT person_id, COUNT(DISTINCT tmdb_id) AS df FROM title_cast "
            "WHERE kind = ? AND order_idx < ? GROUP BY person_id",
            (kind, cast_topn),
        ).fetchall()
    else:
        placeholders = ",".join("?" for _ in KEY_CREW_JOBS)
        rows = conn.execute(
            f"SELECT person_id, COUNT(DISTINCT tmdb_id) AS df FROM title_crew "
            f"WHERE kind = ? AND job IN ({placeholders}) GROUP BY person_id",
            (kind, *KEY_CREW_JOBS),
        ).fetchall()
    n_titles = conn.execute(
        "SELECT COUNT(*) FROM titles WHERE kind = ?", (kind,)
    ).fetchone()[0] or 1
    idf = {r["person_id"]: math.log((1.0 + n_titles) / (1.0 + r["df"])) + 1.0 for r in rows}
    _IDF[key] = (gen, idf)
    return idf


def _person_vectors(
    conn: sqlite3.Connection,
    kind: str,
    ids: list[int],
    which: str,
    idf: dict[int, float],
    cast_topn: int = int(DEFAULTS["cast_topn"]),
) -> dict[int, dict[int, float]]:
    """tmdb_id -> {person_id: l2-normalized idf weight} for the given title ids."""
    out: dict[int, dict[int, float]] = {}
    if not ids:
        return out
    for i in range(0, len(ids), 500):
        batch = ids[i : i + 500]
        ph = ",".join("?" for _ in batch)
        if which == "cast":
            q = (f"SELECT tmdb_id, person_id FROM title_cast "
                 f"WHERE kind = ? AND order_idx < ? AND tmdb_id IN ({ph})")
            args = (kind, cast_topn, *batch)
        else:
            jph = ",".join("?" for _ in KEY_CREW_JOBS)
            q = (f"SELECT tmdb_id, person_id FROM title_crew "
                 f"WHERE kind = ? AND job IN ({jph}) AND tmdb_id IN ({ph})")
            args = (kind, *KEY_CREW_JOBS, *batch)
        for r in conn.execute(q, args).fetchall():
            out.setdefault(r["tmdb_id"], {})[r["person_id"]] = idf.get(r["person_id"], 1.0)
    # L2-normalize each title's person vector so overlap is a cosine in [0,1].
    for tid, vec in out.items():
        norm = math.sqrt(sum(w * w for w in vec.values())) or 1.0
        for pid in vec:
            vec[pid] /= norm
    return out


def _block_bonus(
    cand_ids: list[int],
    lib_ids: list[int],
    cand_vecs: dict[int, dict[int, float]],
    lib_vecs: dict[int, dict[int, float]],
) -> np.ndarray:
    """(n_cand, n_lib) cosine-overlap matrix via an inverted index (sparse fill)."""
    n_c, n_l = len(cand_ids), len(lib_ids)
    bonus = np.zeros((n_c, n_l), dtype=np.float32)
    if n_l == 0:
        return bonus
    lib_col = {tid: j for j, tid in enumerate(lib_ids)}
    # inverted index: person_id -> [(lib_col, weight), ...]
    inv: dict[int, list[tuple[int, float]]] = {}
    for tid, vec in lib_vecs.items():
        j = lib_col.get(tid)
        if j is None:
            continue
        for pid, w in vec.items():
            inv.setdefault(pid, []).append((j, w))
    for i, ctid in enumerate(cand_ids):
        cvec = cand_vecs.get(ctid)
        if not cvec:
            continue
        row = bonus[i]
        for pid, cw in cvec.items():
            for (j, lw) in inv.get(pid, ()):  # only library items sharing this person
                row[j] += cw * lw
    return bonus


def score(ctx: UserContext, conn: sqlite3.Connection, *, n: int, params: dict) -> RecipeResult:
    p = {**DEFAULTS, **params}
    pool_size = int(p["pool_size"])
    neg_w = float(p["negative_weight"])
    min_votes = int(p["min_vote_count"])
    tau = float(p["personalized_threshold"])
    w_content = float(p["content_weight"])
    w_cast = float(p["cast_weight"])
    w_crew = float(p["crew_weight"])
    pop_w = float(p["popularity_weight"])
    cast_topn = int(p["cast_topn"])

    pos = ctx.positive_centroid()
    if pos is None:
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

    neg = ctx.negative_centroid()
    query_vec = _normalize(pos - neg_w * neg) if neg is not None else _normalize(pos)
    batch = retrieve_candidates(
        conn, kind=ctx.kind, query_vec=query_vec, user=ctx,
        pool_size=pool_size, min_vote_count=min_votes,
    )
    if not batch.candidates:
        return RecipeResult(items=[], diag={"path": "empty_pool", **batch.diag})

    cand_ids = [c.title.tmdb_id for c in batch.candidates]
    # Library item embeddings (the source of "max sim to an item"). Fall back to
    # the centroid path's content if the library has no stored embeddings.
    lib_ids = list(ctx.library_embedding_ids)
    lib_mat = ctx.library_embeddings
    if lib_mat is None or len(lib_ids) == 0:
        return RecipeResult(items=[], diag={"path": "no_library_embeddings"})
    lib_norm = lib_mat / np.clip(np.linalg.norm(lib_mat, axis=1, keepdims=True), EMBED_EPS, None)
    cand_mat = np.vstack([c.embedding for c in batch.candidates]).astype(np.float32)
    cand_norm = cand_mat / np.clip(np.linalg.norm(cand_mat, axis=1, keepdims=True), EMBED_EPS, None)

    content = cand_norm @ lib_norm.T  # (n_cand, n_lib) cosine

    fused = w_content * content
    if w_cast:
        idf_c = _idf_map(conn, ctx.kind, "cast", cast_topn)
        cv = _person_vectors(conn, ctx.kind, cand_ids, "cast", idf_c, cast_topn)
        lv = _person_vectors(conn, ctx.kind, lib_ids, "cast", idf_c, cast_topn)
        fused = fused + w_cast * _block_bonus(cand_ids, lib_ids, cv, lv)
    if w_crew:
        idf_k = _idf_map(conn, ctx.kind, "crew")
        cv = _person_vectors(conn, ctx.kind, cand_ids, "crew", idf_k)
        lv = _person_vectors(conn, ctx.kind, lib_ids, "crew", idf_k)
        fused = fused + w_crew * _block_bonus(cand_ids, lib_ids, cv, lv)

    fused_score = fused.max(axis=1)  # max FUSED sim to any single library item

    pop_max = max((c.title.popularity for c in batch.candidates), default=1.0) or 1.0
    combined = fused_score + pop_w * np.array(
        [(c.title.popularity / pop_max) if pop_max else 0.0 for c in batch.candidates],
        dtype=np.float32,
    )

    order = np.argsort(-combined)
    items: list[ScoredItem] = []
    for idx in order[:n]:
        cand = batch.candidates[int(idx)]
        fsim = float(fused_score[int(idx)])
        provenance = "personalized" if fsim >= tau else "discover"
        reason = personalized_reason(cand, []) if provenance == "personalized" else discover_reason(cand)
        items.append(
            ScoredItem(
                tmdb_id=cand.title.tmdb_id, title=cand.title.title, year=cand.title.year,
                poster_path=cand.title.poster_path, overview=cand.title.overview,
                score=float(combined[int(idx)]), provenance=provenance, reason=reason,
            )
        )

    return RecipeResult(
        items=items,
        diag={"path": "fused", **batch.diag, "lib": len(lib_ids),
              "weights": {"content": w_content, "cast": w_cast, "crew": w_crew}, "tau": tau},
    )
