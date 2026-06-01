"""Multi-feature item representation (iteration 3).

PRODUCTION LINEAGE
  - ItemSage (Baltescu et al., Pinterest, KDD 2022; Zotero Baltescu2022_ItemSage):
    a SINGLE item embedding fused from MULTIPLE features (text + image + engagement
    metadata), L2-normalized, served by cosine ANN. The production pattern for
    "make the item vector richer than one modality."
  - Spotify audiobook cold-start (DeNadai et al. 2024; Zotero DeNadai2024): under
    data scarcity, content/metadata features carry the item-item signal.

WHY (iteration-2 evidence)
  Iteration 2 proved the ranker is not the bottleneck -- the MiniLM(title+overview)
  representation is. Only 7% movie / 0% tv held-out titles have a strong content
  twin (>=0.8); the mass sits at 0.5-0.7. This module tests whether fusing the
  structured metadata already in the DB (genres, keywords, top-billed cast, key
  crew) sharpens the item-item twin structure -- which, if so, should lift recall.

REPRESENTATION
  fused_sim(c, l) = w_text * cos_minilm(c,l)
                  + w_genre * cos_genre + w_kw * cos_keyword
                  + w_cast * cos_cast + w_crew * cos_crew
  Each metadata block is an IDF-weighted, L2-normalized sparse multi-hot over the
  feature vocabulary (so a shared rare keyword/actor counts more than a common
  one). cos_minilm is the dense MiniLM cosine. This is the additive (concatenated,
  per-block-normalized) form of ItemSage's multi-feature embedding; weights set
  each modality's influence. Item-based kNN scores a candidate by max fused_sim
  to any library item (iteration-2's winning ann_max aggregation).

This is RESEARCH infrastructure (needs scipy; the production app package has no
scipy dep). If a fused config wins, the follow-up is to precompute the fused
vectors into the sqlite-vec index as a registered production recipe.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from scipy import sparse

RECO_DIR = Path(__file__).resolve().parents[1]
if str(RECO_DIR) not in sys.path:
    sys.path.insert(0, str(RECO_DIR))

CAST_TOPN = 10  # top-billed cast only (order_idx < CAST_TOPN)
KEY_CREW_JOBS = ("Director", "Writer", "Screenplay", "Story", "Creator", "Author", "Novel")

_STORE: dict[tuple[str, int], dict] = {}


def _l2_normalize_rows(m: sparse.csr_matrix) -> sparse.csr_matrix:
    norms = np.sqrt(m.multiply(m).sum(axis=1)).A1
    norms[norms == 0] = 1.0
    d = sparse.diags(1.0 / norms)
    return (d @ m).tocsr()


def _build_block(conn, kind, store_index, sql, params) -> sparse.csr_matrix:
    """Build an IDF-weighted, L2-normalized (E x V) sparse block from (tmdb_id, feature_id) rows."""
    n = len(store_index)
    col_of: dict[int, int] = {}
    rows: list[int] = []
    cols: list[int] = []
    for tmdb_id, fid in conn.execute(sql, params):
        ri = store_index.get(tmdb_id)
        if ri is None:
            continue
        ci = col_of.get(fid)
        if ci is None:
            ci = len(col_of)
            col_of[fid] = ci
        rows.append(ri)
        cols.append(ci)
    v = len(col_of)
    if v == 0:
        return sparse.csr_matrix((n, 1), dtype=np.float32)
    data = np.ones(len(rows), dtype=np.float32)
    m = sparse.csr_matrix((data, (rows, cols)), shape=(n, v), dtype=np.float32)
    # IDF over document frequency per column.
    df = np.asarray((m > 0).sum(axis=0)).ravel()
    idf = np.log((1.0 + n) / (1.0 + df)) + 1.0
    m = (m @ sparse.diags(idf.astype(np.float32))).tocsr()
    return _l2_normalize_rows(m)


def build_feature_store(conn, kind: str, min_votes: int) -> dict:
    key = (kind, min_votes)
    if key in _STORE:
        return _STORE[key]
    # Import here to avoid an import cycle with recsys_loop.
    import recsys_loop as L
    from app.db import deserialize_f32
    from app.context import title_key_variants
    from app.retrieval import AVAILABLE_TITLE_PREDICATE

    rows = conn.execute(
        f"""SELECT t.tmdb_id, t.title, t.year, t.poster_path, t.overview,
                  COALESCE(t.popularity,0) AS popularity, t.vote_average,
                  f.embedding AS embedding, f.dim AS dim
           FROM titles t JOIN title_features f ON f.kind=t.kind AND f.tmdb_id=t.tmdb_id
           WHERE t.kind=? AND COALESCE(t.vote_count,0) >= ? AND {AVAILABLE_TITLE_PREDICATE}""",
        (kind, min_votes),
    ).fetchall()
    ids = [r["tmdb_id"] for r in rows]
    index = {tid: i for i, tid in enumerate(ids)}
    minilm = np.vstack([deserialize_f32(r["embedding"], dim=r["dim"]) for r in rows]).astype(np.float32)
    minilm /= np.clip(np.linalg.norm(minilm, axis=1, keepdims=True), 1e-9, None)
    pop = np.asarray([r["popularity"] or 0.0 for r in rows], dtype=np.float32)
    titles = {r["tmdb_id"]: r for r in rows}
    keys = {r["tmdb_id"]: title_key_variants(r["title"]) for r in rows}

    blocks = {
        "genre": _build_block(conn, kind, index,
            "SELECT tmdb_id, genre_id FROM title_genres WHERE kind=?", (kind,)),
        "keyword": _build_block(conn, kind, index,
            "SELECT tmdb_id, keyword_id FROM title_keywords WHERE kind=?", (kind,)),
        "cast": _build_block(conn, kind, index,
            "SELECT tmdb_id, person_id FROM title_cast WHERE kind=? AND order_idx < ?", (kind, CAST_TOPN)),
        "crew": _build_block(conn, kind, index,
            f"SELECT tmdb_id, person_id FROM title_crew WHERE kind=? AND job IN "
            f"({','.join('?' for _ in KEY_CREW_JOBS)})", (kind, *KEY_CREW_JOBS)),
    }
    store = {
        "ids": ids, "index": index, "minilm": minilm, "blocks": blocks,
        "pop": pop, "pop_max": float(pop.max()) if pop.size else 1.0,
        "titles": titles, "keys": keys,
    }
    _STORE[key] = store
    return store


def fused_scores(store: dict, cand_idx: np.ndarray, lib_idx: list[int], weights: dict) -> np.ndarray:
    """Per-candidate MAX fused similarity to any library item (item-knn ann_max, fused)."""
    if not lib_idx:
        return np.zeros(len(cand_idx), dtype=np.float32)
    s = weights.get("text", 1.0) * (store["minilm"][cand_idx] @ store["minilm"][lib_idx].T)
    for name, w in (("genre", weights.get("genre", 0.0)), ("keyword", weights.get("keyword", 0.0)),
                    ("cast", weights.get("cast", 0.0)), ("crew", weights.get("crew", 0.0))):
        if w:
            blk = store["blocks"][name]
            s = s + w * (blk[cand_idx] @ blk[lib_idx].T).toarray()
    return s.max(axis=1)


def _se_recall(p: float, n: int) -> float:
    """Standard error of a recall proportion (binomial)."""
    return round((p * (1 - p) / n) ** 0.5, 4) if n else 0.0


def franchise_stratified(conn, *, kind: str, weights: dict, pool_size: int = 800,
                         min_votes: int = 50) -> dict:
    """Stratify fused (ann_max) recall by whether the held-out title shares
    cast/crew with the library (creator-twin) vs not (novel). Resolves the
    skeptic's franchise-bias concern: is the fusion lift creator-affinity-driven?
    Also verifies reject-leakage stays 0. Committed so the claim is reproducible.
    """
    import numpy as np
    import recsys_loop as L
    from app.retrieval import retrieve_candidates

    store = build_feature_store(conn, kind, min_votes)
    index = store["index"]
    lib = [x["tmdb_id"] for x in L.load_cache_library(kind)]
    rej = L.load_cache_rejections()
    rej_ids = [e["id"] for e in rej.get(kind, [])]
    emb = L.load_embeddings_for(conn, kind, lib + rej_ids)
    positives = [i for i in lib if i in index and i in emb]
    reject_in_catalog = {i for i in rej_ids if i in index}
    pos_set = set(positives)

    def fetch_sets(table, extra, params):
        d: dict[int, set] = {}
        for tid, pid in conn.execute(
            f"SELECT tmdb_id, person_id FROM {table} WHERE kind=? {extra}", (kind, *params)
        ):
            if tid in pos_set:
                d.setdefault(tid, set()).add(pid)
        return d

    cast = fetch_sets("title_cast", "AND order_idx < ?", (CAST_TOPN,))
    crew = fetch_sets("title_crew", f"AND job IN ({','.join('?' for _ in KEY_CREW_JOBS)})", KEY_CREW_JOBS)

    def is_creator_twin(t: int) -> bool:
        ct, kt = cast.get(t, set()), crew.get(t, set())
        for l in pos_set:
            if l != t and (len(ct & cast.get(l, set())) >= 2 or len(kt & crew.get(l, set())) >= 1):
                return True
        return False

    strat = {"creator_twin": [], "novel": []}
    leak = 0
    for t in positives:
        lib_minus = pos_set - {t}
        lib_idx = [index[i] for i in lib_minus]
        ctx = L.build_context(kind=kind, library_ids=lib_minus, emb_map=emb,
                              title_key_set=set(), rejected_ids=reject_in_catalog)
        pc = ctx.positive_centroid()
        if pc is None:
            continue
        batch = retrieve_candidates(conn, kind=kind, query_vec=pc, user=ctx,
                                    pool_size=pool_size, min_vote_count=min_votes)
        cand_ids = [c.title.tmdb_id for c in batch.candidates if c.title.tmdb_id in index]
        if not cand_ids:
            continue
        cand_idx = np.array([index[i] for i in cand_ids])
        sc = fused_scores(store, cand_idx, lib_idx, weights)
        order = np.argsort(-sc)
        excluded = lib_minus | reject_in_catalog
        ranked = []
        for oi in order:
            tid = cand_ids[oi]
            if tid in excluded:
                continue
            ranked.append(tid)
            if len(ranked) >= 50:
                break
        leak += sum(1 for x in ranked if x in reject_in_catalog)  # must stay 0
        b = "creator_twin" if is_creator_twin(t) else "novel"
        strat[b].append((1.0 if t in ranked[:10] else 0.0, 1.0 if t in ranked[:50] else 0.0))

    out = {"kind": kind, "weights": weights, "leakage_filtered@50": leak, "strata": {}}
    for b, v in strat.items():
        if not v:
            continue
        a = np.array(v)
        out["strata"][b] = {
            "n": len(v),
            "recall@10": round(float(a[:, 0].mean()), 4), "se@10": _se_recall(float(a[:, 0].mean()), len(v)),
            "recall@50": round(float(a[:, 1].mean()), 4), "se@50": _se_recall(float(a[:, 1].mean()), len(v)),
        }
    return out


def evaluate_fused(conn, *, kind: str, weights: dict, mode: str = "ann",
                   pool_size: int = 800, min_votes: int = 50, label: str = "",
                   sample: int | None = None, seed: int = 1234) -> dict:
    """Leave-one-out eval of item-knn with FUSED max-sim scoring.

    mode="ann": candidates = the MiniLM-centroid ANN pool of pool_size (the
      production-deployable, fair A/B vs iteration-2 minilm ann_max -- only the
      SCORING representation changes). mode="full": candidates = whole eligible
      catalog (offline ceiling).
    The ANN pool is always retrieved with the production MiniLM centroid (that is
    what ships); fusion only re-scores it.
    """
    import recsys_loop as L
    from app.retrieval import retrieve_candidates
    from app.context import title_key_variants

    store = build_feature_store(conn, kind, min_votes)
    index = store["index"]
    KS = L.KS

    lib = [x["tmdb_id"] for x in L.load_cache_library(kind)]
    rej = L.load_cache_rejections()
    rej_ids_all = [e["id"] for e in rej.get(kind, [])]
    emb_map = L.load_embeddings_for(conn, kind, lib + rej_ids_all)  # MiniLM, for ANN + centroid

    positives = [i for i in lib if i in index and i in emb_map]
    reject_in_catalog = {i for i in rej_ids_all if i in index}
    pos_set = set(positives)

    # Optional fold subsample (for the expensive mode="full" ablation). The
    # library context still uses ALL other positives; only the set of held-out
    # folds is sampled. Deterministic via seed. Reported as an estimate.
    eval_positives = positives
    if sample is not None and sample < len(positives):
        import random as _random
        rng = _random.Random(seed)
        eval_positives = sorted(rng.sample(positives, sample))

    # per-title key variants + frequency (to drop the held-out title's own keys)
    from collections import Counter
    kv = {i: store["keys"][i] for i in positives}
    freq: Counter = Counter()
    for ks in kv.values():
        freq.update(ks)
    full_keys = set(freq)

    full_ids = store["ids"]
    full_idx_all = np.arange(len(full_ids))

    agg = {f"recall@{k}": 0.0 for k in KS}
    agg.update({f"ndcg@{k}": 0.0 for k in KS})
    import time
    t0 = time.monotonic()
    n_folds = 0
    for t in eval_positives:
        lib_minus = pos_set - {t}
        tks = kv[t]
        key_set = {k for k in full_keys if (freq[k] - (1 if k in tks else 0)) > 0}
        lib_idx = [index[i] for i in lib_minus if i in index]

        if mode == "ann":
            ctx = L.build_context(kind=kind, library_ids=lib_minus, emb_map=emb_map,
                                  title_key_set=key_set, rejected_ids=reject_in_catalog)
            pos_centroid = ctx.positive_centroid()
            if pos_centroid is None:
                n_folds += 1
                continue
            batch = retrieve_candidates(conn, kind=kind, query_vec=pos_centroid, user=ctx,
                                        pool_size=pool_size, min_vote_count=min_votes)
            cand_ids = [c.title.tmdb_id for c in batch.candidates if c.title.tmdb_id in index]
        else:
            cand_ids = full_ids
        if not cand_ids:
            n_folds += 1
            continue
        cand_idx = np.array([index[i] for i in cand_ids])
        scores = fused_scores(store, cand_idx, lib_idx, weights)
        order = np.argsort(-scores)
        excluded = lib_minus | reject_in_catalog
        ranked: list[int] = []
        for oi in order:
            tid = cand_ids[oi]
            if tid in excluded:
                continue
            if key_set and store["keys"][tid] & key_set:
                continue
            ranked.append(tid)
            if len(ranked) >= max(KS):
                break
        for k in KS:
            agg[f"recall@{k}"] += L.recall_at_k(ranked, t, k)
            agg[f"ndcg@{k}"] += L.ndcg_at_k(ranked, t, k)
        n_folds += 1
    metrics = {k: round(v / n_folds, 4) if n_folds else 0.0 for k, v in agg.items()}
    return {
        "label": label or f"fused_{mode}",
        "kind": kind, "mode": mode, "weights": weights,
        "n_positive_folds": n_folds, "n_total_positives": len(positives),
        "sampled": sample is not None and sample < len(positives),
        "n_reject_in_catalog": len(reject_in_catalog),
        "metrics": metrics, "eval_seconds": round(time.monotonic() - t0, 1),
    }
