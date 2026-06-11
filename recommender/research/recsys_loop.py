"""
Recommender improvement harness — research-loop target script.

RESEARCH QUESTION
  Raise the offline ranking quality of the theemeraldexchange recommender
  toward production-grade, by implementing the architecture that best-in-class
  production systems actually run (retrieval -> ranking -> calibrated re-rank),
  grounded in the Zotero "Recommender Systems" corpus. Concretely: maximize
  leave-one-out nDCG@10 and Recall@50 on the household library while keeping the
  rejection-leakage rate ~0.

PRODUCTION-FIRST MANDATE (non-negotiable, mirrors literature-consultation SKILL)
  Every new recipe/architecture section MUST trace to what a real deployed
  system does (YouTube/Meta/Netflix/Spotify/Pinterest/ByteDance/LinkedIn/Kuaishou),
  cited from the Zotero corpus. Not the canon-from-memory, not recency-chasing,
  not "what the current code does." See the inventory at
  ~/Documents/best-analytics/Python/assets/INVENTORY_recsys.md and the Zotero
  "Recommender Systems" collection (43 papers).

FITNESS FUNCTION  (leave-one-out; needs NO explicit feedback)
  The household LIBRARY is the positive signal (titles they chose). For each
  held-out library title t: remove t from the library, run the recommender,
  and measure whether t is recalled/ranked high among candidates.
    - Recall@K  = fraction of held-out titles appearing in top-K
    - nDCG@K    = position-discounted gain of the held-out title (IDCG=1)
    - reject-leakage@K = fraction of in-catalog household rejections that appear
      in top-K of the full-library production call.
        * _filtered  (rejects anti-joined, the production path) -> GUARDRAIL,
          must stay ~0. Proves the hard exclusion is intact in every recipe.
        * _unfiltered (rejects NOT excluded) -> diagnostic of how reject-tempted
          the raw ranker is; informative, not a gate (rejects are model-relevant
          by construction -- the household vetoed titles the model liked).
  Report all three every iteration. nDCG@10 is the headline.

DATA SOURCES (reality as of 2026-06-01 -- sourced in iteration 1, cached)
  - recommender DB (1.9 GB snapshot): 37,738 titles (31,166 movie + 6,572 tv),
    ALL with title_features + title_vec embeddings (MiniLM-L6, 384d). Catalog +
    content features are RICH and present.
  - library_items table is EMPTY (0 rows) -- the Sonarr/Radarr library was never
    synced into the recommender (a real bug in the live sync path). Iteration 1
    sourced it directly from Sonarr /tv/api/v3/series (260 series) + Radarr
    /movies/api/v3/movie (1,182 movie rows -> 796 unique tmdb ids) and cached to
    research/cache/library_{movie,tv}.json. In-catalog w/ embedding: 753 movie,
    235 tv -- the usable leave-one-out positive set.
  - household rejections: 852 total (464 movie + 388 tv) in the backend
    rejections.json; only 10 reached household_rejections in the recommender DB
    (another sync gap). Full set cached to research/cache/rejections.json.
    In-catalog (could actually surface): 363 movie + 286 tv -- the leakage set.

EXECUTION  (decided iteration 1: MODE A -- local snapshot)
  Local snapshot + a lightweight venv (numpy, sqlite-vec, pydantic only -- the
  offline eval needs no torch/sentence-transformers because every library title
  is a catalog title that already has an embedding). Fast iterations, no NAS
  round-trips. Venv: recommender/.venv-eval. Run:
    RECOMMENDER_DB_PATH=~/Documents/eex-recsys-lit/snapshot/exchange.db \
      recommender/.venv-eval/bin/python recommender/research/recsys_loop.py

CONVENTIONS: type hints, no classes where a function does, section headers, no
emojis. Never modify the live recipe behavior without an A/B vs the baseline in
this harness. Commit each iteration (named files only).
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

# --- path wiring: import the real recommender app (retrieval + recipes) -------
RECO_DIR = Path(__file__).resolve().parents[1]  # .../recommender
if str(RECO_DIR) not in sys.path:
    sys.path.insert(0, str(RECO_DIR))

# Resolve DB path: env override, local snapshot, or in-container /data.
DB_PATH = os.environ.get("RECOMMENDER_DB_PATH") or next(
    (p for p in [
        str(Path.home() / "Documents/eex-recsys-lit/snapshot/exchange.db"),
        "/data/exchange.db",
        str(RECO_DIR / "recommender.db"),
    ] if Path(p).exists()),
    "/data/exchange.db",
)
os.environ.setdefault("RECOMMENDER_DB_PATH", DB_PATH)
CACHE = Path(__file__).resolve().parent / "cache"
CACHE.mkdir(exist_ok=True)

KS = (10, 50)
KINDS = ("movie", "tv")


# --- FUNCTION LIBRARY ---------------------------------------------------------

def ndcg_at_k(ranked_ids: list[int], target_id: int, k: int) -> float:
    """Single-target nDCG@k: 1/log2(rank+2) if target in top-k else 0 (IDCG=1)."""
    top = ranked_ids[:k]
    if target_id not in top:
        return 0.0
    return 1.0 / math.log2(top.index(target_id) + 2)


def recall_at_k(ranked_ids: list[int], target_id: int, k: int) -> float:
    return 1.0 if target_id in ranked_ids[:k] else 0.0


def connect():
    """sqlite-vec-loaded read-only connection to the snapshot via app.db."""
    from app import db
    return db.connect(db_path=Path(DB_PATH), readonly=True)


def load_cache_library(kind: str) -> list[dict]:
    path = CACHE / f"library_{kind}.json"
    if not path.exists():
        return []
    return json.loads(path.read_text())


def load_cache_rejections() -> dict:
    path = CACHE / "rejections.json"
    if not path.exists():
        return {"movie": [], "tv": []}
    return json.loads(path.read_text())


def load_embeddings_for(conn, kind: str, ids: list[int]) -> dict[int, np.ndarray]:
    """Bulk-load title_features embeddings for the given ids (one pass)."""
    from app.db import deserialize_f32
    out: dict[int, np.ndarray] = {}
    ordered = sorted(set(ids))
    for i in range(0, len(ordered), 500):
        batch = ordered[i : i + 500]
        q = ",".join("?" for _ in batch)
        for r in conn.execute(
            f"SELECT tmdb_id, embedding, dim FROM title_features "
            f"WHERE kind = ? AND tmdb_id IN ({q})",
            (kind, *batch),
        ).fetchall():
            out[r["tmdb_id"]] = deserialize_f32(r["embedding"], dim=r["dim"])
    return out


def load_titles_for(conn, kind: str, ids: list[int]) -> dict[int, dict]:
    out: dict[int, dict] = {}
    ordered = sorted(set(ids))
    for i in range(0, len(ordered), 500):
        batch = ordered[i : i + 500]
        q = ",".join("?" for _ in batch)
        for r in conn.execute(
            f"SELECT tmdb_id, title, COALESCE(vote_count,0) AS vote_count "
            f"FROM titles WHERE kind = ? AND tmdb_id IN ({q})",
            (kind, *batch),
        ).fetchall():
            out[r["tmdb_id"]] = {"title": r["title"], "vote_count": r["vote_count"]}
    return out


def build_context(
    *,
    kind: str,
    library_ids: set[int],
    emb_map: dict[int, np.ndarray],
    title_key_set: set[str],
    rejected_ids: set[int],
):
    """Construct a UserContext directly (bypassing per-fold DB reload).

    Faithful to load_user_context: positive_centroid() is the mean of the
    library embeddings; retrieval anti-joins library_ids + rejected_ids and
    drops candidates whose title_key collides with title_key_set.
    """
    from app.context import UserContext
    ordered = [i for i in sorted(library_ids) if i in emb_map]
    mat = np.vstack([emb_map[i] for i in ordered]) if ordered else None
    return UserContext(
        sub="loo-eval",
        kind=kind,
        library_ids=set(library_ids),
        library_title_keys=title_key_set,
        library_embeddings=mat,
        library_embedding_ids=ordered,
        library_titles={},
        liked_ids=set(),
        liked_titles={},
        liked_embeddings=None,
        liked_embedding_ids=[],
        disliked_ids=set(),
        disliked_embeddings=None,
        disliked_embedding_ids=[],
        rejected_ids=set(rejected_ids),
        recently_shown_ids=set(),
    )


def rank_ids(recipe_mod, ctx, conn, *, n: int, params: dict) -> list[int]:
    res = recipe_mod.score(ctx, conn, n=n, params=params)
    return [it.tmdb_id for it in res.items]


def evaluate_recipe(
    conn,
    *,
    recipe_name: str,
    params: dict,
    kind: str,
    verbose: bool = True,
) -> dict:
    """Leave-one-out eval of a recipe for one kind. Returns a metrics dict."""
    from app import recipes
    from app.context import title_key_variants

    recipe_mod = recipes.get(recipe_name)
    p = {**recipe_mod.DEFAULTS, **params}
    min_votes = int(p.get("min_vote_count", 0))
    k_max = max(KS)

    lib = load_cache_library(kind)
    lib_ids_all = [x["tmdb_id"] for x in lib]
    rej = load_cache_rejections()
    rej_ids_all = [e["id"] for e in rej.get(kind, [])]

    # Restrict to in-catalog titles that have an embedding (only those can be
    # recalled / used as positives).
    emb_map = load_embeddings_for(conn, kind, lib_ids_all + rej_ids_all)
    title_map = load_titles_for(conn, kind, lib_ids_all)

    positives = [i for i in lib_ids_all if i in emb_map and i in title_map]
    reject_in_catalog = {i for i in rej_ids_all if i in emb_map}

    # Per-title key variants, and a frequency Counter so we can cheaply rebuild
    # the library_title_keys set MINUS the held-out title's keys each fold
    # (leaving t's own keys in would let retrieval dedup-drop t -> false 0).
    key_variants = {i: title_key_variants(title_map[i]["title"]) for i in positives}
    key_freq: Counter = Counter()
    for ks in key_variants.values():
        key_freq.update(ks)
    full_key_set = set(key_freq)

    # Recallable ceiling: positives whose vote_count >= min_vote_count. Titles
    # below the threshold are filtered out of retrieval and can NEVER be
    # recalled, capping the achievable recall.
    recallable = [i for i in positives if title_map[i]["vote_count"] >= min_votes]

    pos_set = set(positives)
    agg = {f"recall@{k}": 0.0 for k in KS}
    agg.update({f"ndcg@{k}": 0.0 for k in KS})
    n_folds = 0
    t0 = time.monotonic()
    for t in positives:
        lib_minus = pos_set - {t}
        # title_key set excluding t's own keys
        tks = key_variants[t]
        key_set = {k for k in full_key_set if (key_freq[k] - (1 if k in tks else 0)) > 0}
        ctx = build_context(
            kind=kind,
            library_ids=lib_minus,
            emb_map=emb_map,
            title_key_set=key_set,
            rejected_ids=reject_in_catalog,
        )
        ranked = rank_ids(recipe_mod, ctx, conn, n=k_max, params=params)
        for k in KS:
            agg[f"recall@{k}"] += recall_at_k(ranked, t, k)
            agg[f"ndcg@{k}"] += ndcg_at_k(ranked, t, k)
        n_folds += 1
    elapsed = time.monotonic() - t0

    metrics = {k: (v / n_folds if n_folds else 0.0) for k, v in agg.items()}

    # --- reject leakage on the full-library production call (one call each) ---
    full_keys = set(full_key_set)
    ctx_filtered = build_context(
        kind=kind, library_ids=pos_set, emb_map=emb_map,
        title_key_set=full_keys, rejected_ids=reject_in_catalog,
    )
    top_filtered = rank_ids(recipe_mod, ctx_filtered, conn, n=max(KS), params=params)
    ctx_unfiltered = build_context(
        kind=kind, library_ids=pos_set, emb_map=emb_map,
        title_key_set=full_keys, rejected_ids=set(),
    )
    top_unfiltered = rank_ids(recipe_mod, ctx_unfiltered, conn, n=max(KS), params=params)

    denom = len(reject_in_catalog) or 1
    leak_filtered = {
        k: len(set(top_filtered[:k]) & reject_in_catalog) for k in KS
    }
    leak_unfiltered = {
        k: len(set(top_unfiltered[:k]) & reject_in_catalog) for k in KS
    }

    out = {
        "recipe": recipe_name,
        "kind": kind,
        "params": {kk: p[kk] for kk in recipe_mod.DEFAULTS},
        "n_positive_folds": n_folds,
        "n_recallable_ceiling": len(recallable),
        "recallable_frac": round(len(recallable) / (len(positives) or 1), 4),
        "n_reject_in_catalog": len(reject_in_catalog),
        "metrics": {k: round(v, 4) for k, v in metrics.items()},
        "leakage_filtered_count": leak_filtered,
        "leakage_unfiltered_count": leak_unfiltered,
        "leakage_filtered_frac@50": round(leak_filtered[50] / denom, 4),
        "leakage_unfiltered_frac@50": round(leak_unfiltered[50] / denom, 4),
        "eval_seconds": round(elapsed, 1),
    }
    if verbose:
        print(json.dumps(out, indent=2))
    return out


# --- SECTION 0: situational readiness -----------------------------------------

def section0_readiness() -> dict:
    info = {"db_path": DB_PATH, "db_exists": Path(DB_PATH).exists()}
    if not info["db_exists"]:
        print(json.dumps(info, indent=2))
        print("\nITER-1 TODO: snapshot the recommender DB or run in-container.")
        return info
    conn = connect()
    for t in ("titles", "title_vec", "title_features", "library_items", "household_rejections"):
        try:
            info[f"n_{t}"] = conn.execute(f"select count(*) from {t}").fetchone()[0]
        except Exception as e:
            info[f"n_{t}"] = f"err:{str(e)[:30]}"
    info["library_cached_movie"] = (CACHE / "library_movie.json").exists()
    info["library_cached_tv"] = (CACHE / "library_tv.json").exists()
    info["rejections_cached"] = (CACHE / "rejections.json").exists()
    # active model_config (the as-deployed config)
    try:
        row = conn.execute(
            "select version, recipe, params_json from model_config where active=1 limit 1"
        ).fetchone()
        info["active_model"] = (
            {"version": row["version"], "recipe": row["recipe"], "params": row["params_json"]}
            if row else None
        )
    except Exception as e:
        info["active_model"] = f"err:{str(e)[:40]}"
    print(json.dumps(info, indent=2))
    return info


# --- SECTION 1: BASELINE -- leave-one-out eval of the production recipes -------
# Baselines the default recipe (mmr_diverse, what production runs) and the
# simpler baseline_cosine for context. This is the scoreboard; every later
# variant is an A/B against these numbers.

def section1_baseline() -> dict:
    conn = connect()
    results: dict[str, dict] = {}
    for recipe_name in ("mmr_diverse", "baseline_cosine"):
        for kind in KINDS:
            key = f"{recipe_name}:{kind}"
            print(f"\n===== BASELINE {key} =====")
            results[key] = evaluate_recipe(
                conn, recipe_name=recipe_name, params={}, kind=kind
            )
    return results


# --- SECTION 2: VARIANT -- item-based kNN (max-sim-to-library) ----------------
# Production lineage: Amazon item-to-item CF (Linden et al. 2003) + EASE
# (Steck 2019). Tests the iteration-1 diagnosis that the single centroid is the
# bottleneck. A/B vs the mmr_diverse baseline. Also sweeps neighbor_topk (max
# vs top-k mean aggregation).

def section2_item_knn() -> dict:
    conn = connect()
    results: dict[str, dict] = {}
    # Confound-controlled sweep (addresses skeptic CRITICAL #1 + popularity
    # ablation). Each entry: (label, params).
    variants = [
        # Retrieval-UNBOUNDED ceiling (full catalog scan): how good item-item
        # SCORING is if retrieval reach were perfect. Not production-deployable
        # as brute force; it is the upper bound the production fix should chase.
        ("item_knn_full_max",      {"candidate_pool": "full", "neighbor_topk": 1}),
        ("item_knn_full_top10",    {"candidate_pool": "full", "neighbor_topk": 10}),
        # Popularity ablation: pop_w=0 isolates pure item-item similarity from
        # the popularity prior (skeptic MAJOR).
        ("item_knn_full_top10_pop0", {"candidate_pool": "full", "neighbor_topk": 10, "popularity_weight": 0.0}),
        # FAIR A/B vs mmr_diverse: SAME centroid-ANN candidate budget (pool 800),
        # only the scoring differs. full - ann = the retrieval contribution;
        # ann - mmr_baseline = the scoring contribution at equal candidate reach.
        ("item_knn_ann_top10",     {"candidate_pool": "ann", "neighbor_topk": 10, "pool_size": 800}),
    ]
    for label, params in variants:
        for kind in KINDS:
            tag = f"{label}:{kind}"
            print(f"\n===== VARIANT {tag} =====")
            results[tag] = evaluate_recipe(
                conn, recipe_name="item_knn", params=params, kind=kind
            )
            results[tag]["label"] = label
    return results


# --- SECTION 3: VARIANT -- multi-feature fused item representation ------------
# Iteration-2 proved the ranker is not the bottleneck; the MiniLM(title+overview)
# representation is. This fuses MiniLM with IDF-weighted genre/keyword/cast/crew
# blocks (ItemSage multi-feature pattern, Baltescu 2022) and re-scores the SAME
# 800-item ANN pool by max fused-sim. Fair A/B vs the iteration-2 minilm ann_max.

def section3_fusion() -> dict:
    import fusion as FUSE
    conn = connect()
    results: dict[str, dict] = {}

    # References (self-contained iteration): production baseline + iter-2 winner.
    for kind in KINDS:
        print(f"\n===== REF mmr_diverse:{kind} =====")
        results[f"mmr_diverse:{kind}"] = evaluate_recipe(
            conn, recipe_name="mmr_diverse", params={}, kind=kind)
        print(f"\n===== REF item_knn_minilm_ann_max:{kind} =====")
        results[f"item_knn_minilm_ann_max:{kind}"] = evaluate_recipe(
            conn, recipe_name="item_knn",
            params={"candidate_pool": "ann", "neighbor_topk": 1, "pool_size": 800}, kind=kind)

    # Fused variants (ann mode = deployable A/B).
    weight_configs = {
        "fused_balanced":   {"text": 1.0, "genre": 0.3, "keyword": 1.0, "cast": 0.7, "crew": 0.5},
        "fused_meta_heavy": {"text": 0.5, "genre": 0.5, "keyword": 1.5, "cast": 1.0, "crew": 0.7},
        "fused_text_kw":    {"text": 1.0, "keyword": 1.0},  # ablation: text + keywords only
    }
    for name, w in weight_configs.items():
        for kind in KINDS:
            tag = f"{name}:{kind}"
            print(f"\n===== VARIANT {tag} =====")
            res = FUSE.evaluate_fused(conn, kind=kind, weights=w, mode="ann", label=name)
            print(json.dumps(res, indent=2))
            results[tag] = res

    # Franchise stratification of the winning config (skeptic franchise-bias +
    # iteration-3 blind-spot probe): is the fused lift creator-affinity-driven?
    win = weight_configs["fused_balanced"]
    for kind in KINDS:
        print(f"\n===== FRANCHISE STRATIFICATION fused_balanced:{kind} =====")
        strat = FUSE.franchise_stratified(conn, kind=kind, weights=win)
        print(json.dumps(strat, indent=2))
        results[f"franchise:{kind}"] = strat
    return results


# --- SECTION 4: ablations -- close the iteration-3 devils-advocate items -------
# (a) stability: re-run fused_balanced (deterministic) to lock it across 2 iters.
# (b) clean feature isolation: which block carries the lift?
# (c) fused mode=full vs ann: is the win retrieval-bound or scoring (ann is the
#     deployable re-rank stage)? Sampled folds for the expensive full scan.

def section4_ablations() -> dict:
    import fusion as FUSE
    conn = connect()
    results: dict[str, dict] = {}

    # (a) stability reference + production baseline
    for kind in KINDS:
        print(f"\n===== REF mmr_diverse:{kind} =====")
        results[f"mmr_diverse:{kind}"] = evaluate_recipe(conn, recipe_name="mmr_diverse", params={}, kind=kind)
    balanced = {"text": 1.0, "genre": 0.3, "keyword": 1.0, "cast": 0.7, "crew": 0.5}
    for kind in KINDS:
        print(f"\n===== STABILITY fused_balanced:{kind} (expect iter-3 numbers) =====")
        r = FUSE.evaluate_fused(conn, kind=kind, weights=balanced, mode="ann", label="fused_balanced")
        print(json.dumps(r, indent=2))
        results[f"stability_fused_balanced:{kind}"] = r

    # (b) clean feature isolation (movie, ann) -- one block at a time over text.
    iso = {
        "text_only":     {"text": 1.0},
        "text_genre":    {"text": 1.0, "genre": 1.0},
        "text_keyword":  {"text": 1.0, "keyword": 1.0},
        "text_cast":     {"text": 1.0, "cast": 1.0},
        "text_crew":     {"text": 1.0, "crew": 1.0},
        "text_castcrew": {"text": 1.0, "cast": 0.7, "crew": 0.5},
    }
    for name, w in iso.items():
        print(f"\n===== ISOLATION {name}:movie =====")
        r = FUSE.evaluate_fused(conn, kind="movie", weights=w, mode="ann", label=name)
        print(json.dumps(r, indent=2))
        results[f"{name}:movie"] = r

    # (c) retrieval-vs-ranking: fused balanced full-catalog scan (sampled folds).
    print("\n===== ABLATION fused_balanced FULL (movie, sampled) =====")
    r = FUSE.evaluate_fused(conn, kind="movie", weights=balanced, mode="full",
                            label="fused_balanced_full", sample=250)
    print(json.dumps(r, indent=2))
    results["fused_balanced_full:movie"] = r
    return results


# --- SYNTHESIS (updated every iteration: current best metric + what changed) --
SYNTHESIS = """
=== SYNTHESIS (iteration 6, CONVERGED) ===
LOCKED BEST CONFIG: co-engagement RETRIEVAL union (top-10 PMI neighbors per
library item) + content fusion scoring (text+cast+crew). Movie leave-one-out:
  nDCG@10  0.0021 (baseline) -> 0.0219  = 10.4x
  recall@50 0.0173 -> 0.1381  = 8.0x ;  recall@10 0.0053 -> 0.0425 = 8.0x
  reject-leakage_filtered@50 = 0.
Pipeline: candidates = MiniLM-ANN-800 pool UNION top-10-PMI co-engagement
neighbors of the library (MovieLens-derived, PMI-debiased); score by max
similarity over a per-block-normalized fused item vector (MiniLM + IDF cast +
IDF crew). Deterministic; the architecture is stable across iters 5-6 and the
neighbor_cap gain is a smooth plateau (caps 5-10 ~0.022, >=15 ~0.0173).

WHAT MOVED THE HEADLINE, IN ORDER (each traced to a deployed system + paper):
  1. Item-based scoring > single centroid (Amazon item-to-item; iter 2) -- the
     centroid collapses a diverse library.
  2. Multi-feature item representation: cast+crew >> title text (ItemSage;
     iter 3) -- 5x. The win is creator-affinity; genre is noise.
  3. Co-engagement as a RETRIEVAL source, not a re-rank score (Spotify
     co-listening / YouTube candidate-gen; iters 4-5) -- another ~2x by getting
     the right candidates into the pool the MiniLM centroid never surfaced.
  4. Top-k co-engagement neighbor cap (precision; Abdollahpouri-adjacent; iter 6)
     -- +27% nDCG@10 and a smaller, cheaper candidate set.

HONEST BOUNDARIES (documented, not failures of the headline result):
  - Cross-creator / NOVEL stratum (no shared cast/crew) stays 0 recall under
    every config. Content + an imported movie co-engagement graph cannot recall
    a title with no creator AND no co-engagement bridge to the library. Breaking
    it needs household IMPLICIT FEEDBACK + EXPLORATION (Variant A: BaRT/YouTube)
    -- requires behavioral data this single household has not yet generated.
  - TV unsolved: MovieLens is movies-only; TV needs a TV-inclusive co-engagement
    source (series share audiences, not casts).
  - Popularity penalty HURTS this metric (household taste is mainstream-ish).

DEPLOYMENT PATH (research -> production): precompute, per library, the top-10
PMI co-engagement neighbor lists + the fused (MiniLM+cast+crew) item vectors;
at score time, retrieve MiniLM-ANN pool UNION those neighbors and rank by fused
similarity. ~2,600-candidate scoring (cheaper than the uncapped 5,362). The PMI
graph is a periodic offline batch job over the imported co-rating source.

CONVERGENCE: all five criteria hold -- see iteration_log.md CONVERGENCE ARGUMENT.
"""

_SYNTHESIS_ITER5 = """
=== SYNTHESIS (iteration 5, capstone) ===
BEST CONFIG: co-engagement RETRIEVAL UNION + content scoring. Candidates =
MiniLM-ANN-800 pool UNION the PMI co-engagement neighbors of the library
(MovieLens-derived), scored by content fusion (text+cast+crew). Movie:
  nDCG@10  0.0081 -> 0.0173 (2.1x) vs content-only on the SAME harness;
  recall@50 0.0452 -> 0.1328 (2.9x); ~8x nDCG@10 / ~7.7x recall@50 vs the
  original mmr_diverse baseline. leakage_filtered@50 = 0.
This CONFIRMS the iteration-4 diagnosis: co-engagement helps as RETRIEVAL (a
candidate source), not as a re-rank score. union_content ~= union_fused (the
co-engagement SCORE term adds nothing; z-score-clean) -> the win is the
candidate SET. (Production item-to-item is an ANN candidate source: Covington
p3; the edges carry the lift: LightGCN p1-2, Spotify edges-only p7-8.)

HONEST LIMIT (the stated cross-creator goal was NOT achieved): the NOVEL stratum
(no shared cast/crew) STAYS 0 recall. The 2.9x lift is creator-twin recall
amplification (creator_twin recall@50 0.0508 -> 0.1495; the 89% majority). Truly
content-AND-creator-novel titles have co-engagement edges too weak to rank among
~5,362 candidates. Cross-creator recall needs household IMPLICIT FEEDBACK +
EXPLORATION (Variant A: BaRT/YouTube), not content + an imported graph.

CEILING: held_out_in_universe_frac = 0.64 (36% of held-out titles are not
candidates at all -> auto-0). recall@50 (0.13) << 0.64, so SCORING is the
binding constraint, not pool size (rebuts the big-pool-artifact concern).

DEPLOYABILITY: precompute the per-library co-engagement neighbor lists; scoring
a ~5,362-candidate union is ~6.7x the 800-pool cost but bounded and cacheable.
The fusion vectors must also be precomputed into the index (research uses scipy).

TV: still unsolved (MovieLens is movies-only; needs a TV-inclusive co-engagement
source).

LADDER AHEAD (iteration 6 = convergence iteration):
  -> confirm union stability (deterministic; re-run) + lock the leaner config;
  -> precision refinements: popularity-cap / per-item neighbor cap on the union
     (Abdollahpouri) to lift nDCG@10 without losing recall;
  -> write the CONVERGENCE ARGUMENT.
  -> (future milestone, not this loop) Variant A implicit-feedback+exploration
     for the novel stratum; TV co-engagement source.

TENSIONS: retrieval vs scoring (a better score can't recall an un-retrieved
candidate -- the whole iter-5 win is retrieval); overall-recall vs novel-stratum
(co-engagement amplifies the creator-twin majority, not cross-creator discovery).
RESOLVED: z-score asymmetry (monotonic, no ranking effect); big-pool artifact
(in-universe ceiling); LOO-leakage (foreign graph, zero household signal).
"""

_SYNTHESIS_ITER4 = """
=== SYNTHESIS (iteration 4) ===
BEST CONFIG UNCHANGED + NOW LOCKED: fused_balanced (== text+cast+crew) movie
nDCG@10 0.0106, reproduced EXACTLY this iteration (deterministic) -> stable
across iters 3-4. recall@10 0.0279 (21/753), leakage_filtered@50 0.

ABLATIONS (closed the iteration-3 devils-advocate items):
  - Feature isolation: the lift is CAST+CREW. text_only nDCG@10 0.0009; +cast
    0.0076; +crew 0.0077; +cast+crew 0.0107 ~= balanced 0.0106. GENRE HURTS
    (0.0), keyword minor (0.0036). Creator-affinity confirmed at the feature
    level; a leaner text+cast+crew equals balanced -> drop genre.
  - Retrieval vs ranking: full-catalog fused recall@50 ~0.08 vs ann 0.0398 (~2x)
    but worse nDCG@10 -> the MiniLM-centroid 800-pool CAPS deep recall (full
    finds more) while crowding the top. Retrieval reach is itself a lever.

VARIANT B (co-engagement, MovieLens 25M PMI item-item graph): a NEGATIVE-but-
decisive result. Sourced + built the graph (162k users, 11k nodes w/ neighbors,
PMI-debiased). Coverage good: 80% of library / 40% of the content-NOVEL stratum
have a co-engagement edge. BUT co-engagement as a RE-SCORER does NOT help
(cooccur_only weak; late-fusion nDCG@10 0.0077-0.0078 <= content 0.0081; novel
recall stays 0). ROOT CAUSE (proven): of the 34 novel-stratum titles WITH a
co-engagement edge, only 1 (3%) is in its MiniLM-centroid ANN pool -- 33/34 are
invisible to any re-scorer. => Co-engagement must drive RETRIEVAL (candidate
union), NOT re-ranking. This is the iteration-5 lever (Spotify/YouTube serve
item-to-item as an ANN candidate source, not a re-rank -- Covington p3).

TV: still unsolved. MovieLens is movies-only; the TV co-engagement source +
the retrieval-union lever are the open path.

LADDER AHEAD:
  -> ITER 5: co-engagement RETRIEVAL union -- candidates = MiniLM-ANN pool UNION
     PMI co-engagement neighbors of the library, then fused scoring. Measure
     novel-stratum + overall recall lift. (The 3% -> ? test.)
  -> TV co-engagement source (TV-inclusive co-rating/co-watch) for the TV gap.
  -> calibrated re-rank (Steck 2018) once recall is lifted.

TENSIONS:
  - re-scoring vs retrieval: a better SCORE cannot recall a candidate the
    RETRIEVAL never surfaced. The novel-stratum + deep-recall gains both live
    behind retrieval, not scoring.
RESOLVED this iter: fused-full ablation (retrieval caps deep recall); cast/crew
isolation (the win is cast+crew, genre is noise); fusion stability (deterministic
reproduce). Prior: franchise=creator-affinity; popularity; candidate-set.
"""

_SYNTHESIS_ITER3 = """
=== SYNTHESIS (iteration 3) ===
BEST CONFIG (movie headline): fused_balanced -- MiniLM fused with IDF-weighted
genre/keyword/cast/crew, re-scoring the 800-item MiniLM-ANN pool by max fused-sim.
FIRST config to beat the baseline on the headline nDCG@10:
  movie nDCG@10 0.0021 -> 0.0106 (5.0x); recall@10 4 -> 21 titles (+17, 5.3x);
  recall@50 13 -> 30 (+17, 2.3x); leakage_filtered@50 = 0.
fused_meta_heavy ties within sampling error. Lineage: ItemSage multi-feature
fusion (Baltescu 2022); Spotify content cold-start (DeNadai 2024).

HONEST SCOPE (devils-advocate-tightened):
  - Real but absolutely small: +17 of 753 at recall@10. "5x" is over a basement;
    always pair with the count.
  - Deployable as a RE-RANK STAGE over the existing MiniLM-ANN pool (no retrieval
    change). NOT a shipped recipe yet (research/, scipy); full deploy = precompute
    fused vectors into the index.
  - The lift is ENTIRELY creator-affinity. Stratified: movie creator_twin
    (n=669) recall@10 0.0105; novel stratum (n=84, no shared cast/crew)
    recall@10 = 0.0. Legitimate but NARROW -- zero cross-creator generalization.

TV: no win (nDCG@10 0.0015 < baseline 0.0030). EXPLAINED: only 10% of TV titles
are creator-twins (89% for movies); series rarely share cast/crew, so the
mechanism that powers movies has nothing to work with on TV.

THE NEXT CEILING (literature Q2, grounded): content/creator similarity has a
documented production recall ceiling (Spotify content-only HR@10 0.164 plateau;
co-engagement-graph GNN +36-57% HR, long-tail +118% -- DeNadai 2024). Single
household = no co-occurrence. Levers: (A) EXPLORATION + implicit-feedback harvest
(BaRT McInerney 2018; YouTube Top-K REINFORCE Chen 2019); (B) IMPORT an exogenous
item-item co-engagement graph + GNN propagation (also the documented TV fix:
series share audiences, not casts). Pure collaborative (LightGCN) non-viable solo.

LADDER AHEAD:
  -> ITER 4: confirm fusion stability; fused mode=full ablation (retrieval vs
     ranking) + clean cast-vs-crew isolation; BEGIN Variant B (exogenous
     co-engagement graph) -- the cross-creator + TV lever.
  -> calibrated re-rank (Steck 2018), sequential models later.

TENSIONS:
  - movie vs tv: fusion's creator-affinity mechanism is movie-only by data
    structure; TV needs co-engagement, not content.
  - relative vs absolute: 5x headline is real but +17 titles; do not oversell.
RESOLVED: franchise bias (it IS creator-affinity, stratified + documented as
legitimate-but-narrow); popularity confound (iter 2, zero effect); candidate-set
confound (iter 2, survives at equal budget).
"""

if __name__ == "__main__":
    info = section0_readiness()
    if info.get("db_exists"):
        # Prior iterations' numbers live in their iter_N_output.txt. The active
        # iteration's section runs here; flip as the loop advances.
        #   section1_baseline(); section2_item_knn(); section3_fusion()
        section4_ablations()
    print(SYNTHESIS)
