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


# --- SYNTHESIS (updated every iteration: current best metric + what changed) --
SYNTHESIS = """
=== SYNTHESIS (iteration 1) ===
Scoreboard EXISTS. Baseline measured: leave-one-out over the real household
library (753 movie + 235 tv positives), reject-leakage over the in-catalog
rejection set (363 movie + 286 tv), via the production retrieval+recipe path.

Headline metric: leave-one-out nDCG@10 of mmr_diverse (the deployed default).
See iter_1_output.txt for the numbers; logged to iteration_log.md.

GUARDRAIL: leakage_filtered@50 must be 0 (hard exclusion intact). The
unfiltered leakage is a diagnostic only.

No production-grounded variant implemented yet -- iteration 2 onward. The
variant ladder (each must trace to a deployed system + Zotero paper):
  EASE (Steck2019, item-item closed form; strong on sparse single-household)
  -> two-stage retrieval->learned re-rank (YouTube/Pinterest/Spotify)
  -> calibrated re-rank (Steck2018; Netflix+Spotify; likely beats MMR)
  -> sequential model (SASRec/PinnerFormer) if simpler stages plateau.

TENSIONS: none yet (single approach).
"""

if __name__ == "__main__":
    info = section0_readiness()
    if info.get("db_exists"):
        section1_baseline()
    print(SYNTHESIS)
