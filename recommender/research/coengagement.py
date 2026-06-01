"""Exogenous item-item co-engagement graph (iteration 4, Variant B).

PRODUCTION LINEAGE / WHY NO GNN
  Iteration-3 found content+creator fusion recalls ONLY creator-twins (novel
  stratum = 0 recall) and does nothing for TV (series share audiences, not
  casts). The documented fix is a co-ENGAGEMENT graph (Spotify audiobook GNN,
  DeNadai 2024: a co-listening-edge model lifts long-tail HR@10 +118% by reaching
  items with no content overlap). A single household has no co-occurrence of its
  own, so we IMPORT one from a foreign multi-user population (MovieLens 25M),
  mapped to TMDB ids via links.csv.

  The lift lives in the EDGES, not the neural net: LightGCN strips a GCN to pure
  neighborhood aggregation with no accuracy loss (He 2020 p1-2); Spotify's
  edges-only homogeneous model reaches ~93% of the full model's HR (DeNadai 2024
  p7-8). So this builds a PMI-weighted item-item kNN over the co-rating graph --
  "neighborhood aggregation without the network" -- and late-fuses it with the
  iteration-3 content_fused similarity.

DEBIASING (mandatory -- co-occurrence is proportional to popularity)
  Raw co-counts surface blockbusters for everyone (Abdollahpouri 2019: ItemKNN
  AMPLIFIES popularity bias). PMI's denominator divides out each item's marginal
  popularity in closed form -- the training-free analogue of Spotify's inverse-
  propensity weighting (DeNadai 2024 p6). We use positive PMI and a support floor.
  Confidence-gated fusion (down-weight thin-evidence edges) handles domain shift
  (MovieLens taste != this household); cold/zero-edge items fall back to content.

This is RESEARCH infra (pandas/scipy; the production app has neither). If the
late-fusion wins, promotion = precompute the item-item neighbor lists into a
table the recommender reads at score time.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from scipy import sparse

ML_DIR = Path.home() / "Documents/eex-recsys-lit/movielens/ml-25m"
_GRAPH: dict[tuple, dict] = {}


def _factorize(arr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Map values to contiguous integer codes. Returns (codes, uniques)."""
    uniques, codes = np.unique(arr, return_inverse=True)
    return codes, uniques


def _load_links() -> dict[int, int]:
    """MovieLens movieId -> TMDB id (movies)."""
    import pandas as pd
    df = pd.read_csv(ML_DIR / "links.csv", usecols=["movieId", "tmdbId"])
    df = df.dropna(subset=["tmdbId"])
    return {int(m): int(t) for m, t in zip(df["movieId"], df["tmdbId"])}


def build_cooccurrence(catalog_ids: set[int], *, min_rating: float = 4.0,
                       support_floor: int = 20, topk: int = 50) -> dict:
    """PMI-weighted item-item co-occurrence over MovieLens, restricted to TMDB
    ids present in our catalog. Returns dict with per-item top-k PPMI neighbors.

    Restricting both endpoints to our catalog keeps it tractable and relevant
    (we only ever score candidates/library that are in the catalog).
    """
    key = (min_rating, support_floor, topk, len(catalog_ids))
    if key in _GRAPH:
        return _GRAPH[key]
    import pandas as pd

    links = _load_links()  # movieId -> tmdbId
    # Keep only MovieLens movies that map to a TMDB id in our catalog.
    keep_movie = {m: t for m, t in links.items() if t in catalog_ids}
    keep_movie_ids = set(keep_movie)

    # Stream ratings, binarize positives, keep only kept movies. Vectorized:
    # accumulate filtered (user, tmdb) arrays per chunk, factorize once at the end.
    keep_arr = np.fromiter(keep_movie_ids, dtype=np.int64)
    keep_set = keep_movie_ids
    users_parts: list[np.ndarray] = []
    tmdb_parts: list[np.ndarray] = []
    reader = pd.read_csv(ML_DIR / "ratings.csv",
                         usecols=["userId", "movieId", "rating"],
                         chunksize=4_000_000)
    for chunk in reader:
        chunk = chunk[chunk["rating"] >= min_rating]
        mv = chunk["movieId"].to_numpy()
        mask = np.isin(mv, keep_arr)
        if not mask.any():
            continue
        u = chunk["userId"].to_numpy()[mask]
        m = mv[mask]
        t = np.fromiter((keep_movie[int(x)] for x in m), dtype=np.int64, count=len(m))
        users_parts.append(u.astype(np.int64))
        tmdb_parts.append(t)

    all_users = np.concatenate(users_parts)
    all_tmdb = np.concatenate(tmdb_parts)
    user_codes_arr, _ = _factorize(all_users)
    item_codes_arr, item_uniques = _factorize(all_tmdb)
    n_users = int(user_codes_arr.max()) + 1 if len(user_codes_arr) else 0
    n_items = len(item_uniques)
    tmdb_of_col = {i: int(item_uniques[i]) for i in range(n_items)}
    data = np.ones(len(all_users), dtype=np.float32)
    M = sparse.csr_matrix((data, (user_codes_arr, item_codes_arr)),
                          shape=(n_users, n_items), dtype=np.float32)
    M = (M > 0).astype(np.float32)

    item_count = np.asarray(M.sum(axis=0)).ravel()  # users who liked each item
    # Co-occurrence counts (item x item), users who liked BOTH.
    C = (M.T @ M).tocoo()

    # PMI: log( C_ij * N / (cnt_i * cnt_j) ), positive part; support floor on both.
    neighbors: dict[int, list[tuple[int, float]]] = {}
    by_item: dict[int, list[tuple[float, int]]] = {}
    N = float(n_users)
    for i, j, c in zip(C.row, C.col, C.data):
        if i == j or c <= 0:
            continue
        if item_count[i] < support_floor or item_count[j] < support_floor:
            continue
        pmi = math.log((c * N) / (item_count[i] * item_count[j]) + 1e-12)
        if pmi <= 0:
            continue
        by_item.setdefault(int(i), []).append((pmi, int(j)))

    for i, lst in by_item.items():
        lst.sort(reverse=True)
        neighbors[tmdb_of_col[i]] = [(tmdb_of_col[j], round(p, 4)) for p, j in lst[:topk]]

    graph = {
        "neighbors": neighbors,             # tmdb_id -> [(neighbor_tmdb, ppmi), ...]
        "n_users": n_users, "n_items": n_items,
        "item_support": {tmdb_of_col[i]: int(item_count[i]) for i in range(n_items)},
        "params": {"min_rating": min_rating, "support_floor": support_floor, "topk": topk},
    }
    _GRAPH[key] = graph
    return graph


def coengagement_scores(graph: dict, cand_ids: list[int], lib_ids: set[int]) -> np.ndarray:
    """Per-candidate co-engagement score = max PPMI edge to any library item.

    (max mirrors the iteration-2/3 item-knn aggregation that won.) Candidates
    with no edge to the library get 0 -> they fall back to content in fusion.
    """
    nbr = graph["neighbors"]
    # Build, for each candidate, the best PPMI to a library item. Edges are
    # symmetric in co-occurrence but we stored top-k per source, so check both
    # directions: candidate's neighbors that are in lib, OR lib items' neighbor
    # lists containing the candidate. Use candidate->neighbors (cheaper) plus a
    # reverse index for completeness.
    out = np.zeros(len(cand_ids), dtype=np.float32)
    # reverse: lib item -> {neighbor: ppmi}
    lib_edges: dict[int, float] = {}
    for l in lib_ids:
        for (nb, p) in nbr.get(l, []):
            if p > lib_edges.get(nb, 0.0):
                lib_edges[nb] = p
    for idx, c in enumerate(cand_ids):
        best = lib_edges.get(c, 0.0)
        for (nb, p) in nbr.get(c, []):
            if nb in lib_ids and p > best:
                best = p
        out[idx] = best
    return out


def coverage_and_retrieval_gate(conn, graph: dict, *, kind: str = "movie",
                                pool_size: int = 800, min_votes: int = 50) -> dict:
    """Feasibility + diagnosis (iteration 4): (1) what fraction of the library /
    of the content-NOVEL stratum has a co-engagement edge to another library
    item, and (2) of the novel-stratum titles that DO have an edge, how many are
    present in their own MiniLM-centroid ANN pool. (2)~0 proves co-engagement
    must drive RETRIEVAL (candidate union), not re-scoring, to reach them."""
    import recsys_loop as L
    import fusion as F
    from app.retrieval import retrieve_candidates

    store = F.build_feature_store(conn, kind, min_votes)
    index = store["index"]
    lib = [x["tmdb_id"] for x in L.load_cache_library(kind)]
    lib = [i for i in lib if i in index]
    lib_set = set(lib)
    emb = L.load_embeddings_for(conn, kind, lib)
    nbr = graph["neighbors"]

    def fetch(table, extra, p):
        d: dict[int, set] = {}
        for tid, pid in conn.execute(f"SELECT tmdb_id,person_id FROM {table} WHERE kind=? {extra}", (kind, *p)):
            if tid in lib_set:
                d.setdefault(tid, set()).add(pid)
        return d
    cast = fetch("title_cast", "AND order_idx<?", (F.CAST_TOPN,))
    crew = fetch("title_crew", f"AND job IN ({','.join('?' for _ in F.KEY_CREW_JOBS)})", F.KEY_CREW_JOBS)
    twin = lambda t: any(t != l and (len(cast.get(t, set()) & cast.get(l, set())) >= 2
                                     or len(crew.get(t, set()) & crew.get(l, set())) >= 1) for l in lib_set)
    def has_edge(t):
        if any(b in lib_set for b, _ in nbr.get(t, [])):
            return True
        return any(t == b for l in lib_set for b, _ in nbr.get(l, []))

    novel = [t for t in lib if not twin(t)]
    novel_edge = [t for t in novel if has_edge(t)]
    in_pool = 0
    for t in novel_edge:
        ctx = L.build_context(kind=kind, library_ids=lib_set - {t}, emb_map=emb,
                              title_key_set=set(), rejected_ids=set())
        b = retrieve_candidates(conn, kind=kind, query_vec=ctx.positive_centroid(),
                                user=ctx, pool_size=pool_size, min_vote_count=min_votes)
        if t in {c.title.tmdb_id for c in b.candidates}:
            in_pool += 1
    return {
        "kind": kind, "library": len(lib),
        "library_with_edge_to_another_library_item": sum(1 for t in lib if has_edge(t)),
        "novel_stratum": len(novel),
        "novel_with_coengagement_edge": len(novel_edge),
        "novel_with_edge_in_minilm_ann_pool": in_pool,
        "verdict": "co-engagement must drive RETRIEVAL not re-scoring: "
                   f"{len(novel_edge)-in_pool}/{len(novel_edge)} novel-with-edge titles are "
                   "invisible to the MiniLM-centroid pool",
    }


def _zscore(a: np.ndarray) -> np.ndarray:
    sd = a.std()
    return (a - a.mean()) / sd if sd > 1e-9 else np.zeros_like(a)


def evaluate_latefusion(conn, *, kind: str, content_weights: dict, beta: float,
                        graph: dict, mode: str = "ann", pool_size: int = 800,
                        min_votes: int = 50, label: str = "",
                        content_only: bool = False, cooccur_only: bool = False) -> dict:
    """Late-fusion A/B: score = z(content_fused) + beta*z(cooccur), over the
    MiniLM-ANN pool. Stratified by creator_twin vs novel (the titles content gets
    0 on). The decisive Variant-B test: does co-engagement recall what content
    cannot? Movie-focused (MovieLens is movies-only)."""
    import recsys_loop as L
    import fusion as F
    from app.retrieval import retrieve_candidates

    store = F.build_feature_store(conn, kind, min_votes)
    index = store["index"]
    KS = L.KS
    lib = [x["tmdb_id"] for x in L.load_cache_library(kind)]
    rej = L.load_cache_rejections()
    rej_ids = [e["id"] for e in rej.get(kind, [])]
    emb = L.load_embeddings_for(conn, kind, lib + rej_ids)
    positives = [i for i in lib if i in index and i in emb]
    reject_in_catalog = {i for i in rej_ids if i in index}
    pos_set = set(positives)

    # creator-twin classifier (shared cast/crew with library)
    def fetch_sets(table, extra, params):
        d: dict[int, set] = {}
        for tid, pid in conn.execute(f"SELECT tmdb_id,person_id FROM {table} WHERE kind=? {extra}", (kind, *params)):
            if tid in pos_set:
                d.setdefault(tid, set()).add(pid)
        return d
    cast = fetch_sets("title_cast", "AND order_idx<?", (F.CAST_TOPN,))
    crew = fetch_sets("title_crew", f"AND job IN ({','.join('?' for _ in F.KEY_CREW_JOBS)})", F.KEY_CREW_JOBS)
    def is_twin(t):
        ct, kt = cast.get(t, set()), crew.get(t, set())
        return any(t != l and (len(ct & cast.get(l, set())) >= 2 or len(kt & crew.get(l, set())) >= 1) for l in pos_set)

    strat = {"creator_twin": [], "novel": [], "all": []}
    leak = 0
    import time
    t0 = time.monotonic()
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
        cfs = F.fused_scores(store, cand_idx, lib_idx, content_weights)
        ce = coengagement_scores(graph, cand_ids, lib_minus)
        if content_only:
            total = cfs
        elif cooccur_only:
            total = ce
        else:
            total = _zscore(cfs) + beta * _zscore(ce)
        order = np.argsort(-total)
        excluded = lib_minus | reject_in_catalog
        ranked = []
        for oi in order:
            tid = cand_ids[oi]
            if tid in excluded:
                continue
            ranked.append(tid)
            if len(ranked) >= max(KS):
                break
        leak += sum(1 for x in ranked if x in reject_in_catalog)
        rec = (1.0 if t in ranked[:10] else 0.0, 1.0 if t in ranked[:50] else 0.0,
               (1.0 / math.log2(ranked.index(t) + 2)) if t in ranked[:10] else 0.0)
        strat["all"].append(rec)
        strat["creator_twin" if is_twin(t) else "novel"].append(rec)

    def agg(v):
        if not v:
            return {}
        a = np.array(v)
        return {"n": len(v), "recall@10": round(float(a[:, 0].mean()), 4),
                "recall@50": round(float(a[:, 1].mean()), 4), "ndcg@10": round(float(a[:, 2].mean()), 4)}
    return {"label": label or f"latefusion_b{beta}", "kind": kind, "beta": beta,
            "content_only": content_only, "cooccur_only": cooccur_only,
            "leakage_filtered@50": leak, "strata": {k: agg(v) for k, v in strat.items()},
            "eval_seconds": round(time.monotonic() - t0, 1)}
