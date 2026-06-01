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
    - nDCG@K    = position-discounted gain of the held-out title
    - reject-leakage@K = fraction of the 852 household rejections that appear
      in top-K  (GUARDRAIL — must stay ~0; a model that recalls rejects is bad
      regardless of recall)
  Report all three every iteration. nDCG@10 is the headline.

DATA SOURCES (reality as of 2026-06-01 — verify each iteration)
  - recommender DB (1.9 GB): titles, title_features, title_genres, title_cast,
    title_crew, title_keywords, title_vec (sqlite-vec embeddings, MiniLM-L6 384d).
    Catalog + content features are RICH and present.
  - library_items table is EMPTY (0 rows) — the Sonarr/Radarr library was never
    synced into the recommender. ITERATION 1 MUST source the household library
    (Sonarr /api/v3/series + Radarr /api/v3/movie via the backend, which holds
    the API keys) and cache it as research/cache/library_{movie,tv}.json. This
    sourcing gap is itself a finding to fix in the live sync path.
  - household rejections: 852 total (464 movie + 388 tv) live in the backend's
    rejections.json; only 10 reached household_rejections in the recommender DB
    (another sync gap). Pull the full 852 for the leakage guardrail.

EXECUTION
  Two viable modes (pick in iteration 1, document the choice):
    A) Local: snapshot the DB once, install recommender deps in a venv, import
       app.recipes + app.retrieval, eval locally. Fast iterations.
    B) On-NAS: run inside exchange-recommender (has env+DB+model) via
       `docker exec`. No local 1.9 GB pull, but per-iteration code edits need a
       scratch-mount or rsync of app/.
  Either way: the loop edits recipes in recommender/app/recipes/ and registers
  variants in recommender/app/recipes/__init__.py.

CONVENTIONS: type hints, no classes where a function does, section headers, no
emojis. Never modify the live recipe behavior without an A/B vs the baseline in
this harness. Commit each iteration (named files only).
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
from pathlib import Path

# Resolve DB path: env override, local snapshot, or in-container /data.
DB_PATH = os.environ.get("RECOMMENDER_DB_PATH") or next(
    (p for p in [
        str(Path.home() / "Documents/eex-recsys-lit/snapshot/exchange.db"),
        "/data/exchange.db",
        str(Path(__file__).resolve().parents[1] / "recommender.db"),
    ] if Path(p).exists()),
    "/data/exchange.db",
)
CACHE = Path(__file__).resolve().parent / "cache"
CACHE.mkdir(exist_ok=True)


# --- FUNCTION LIBRARY (add helpers here, before the execution sections) -------

def ndcg_at_k(ranked_ids: list[int], target_id: int, k: int) -> float:
    """Single-target nDCG@k: 1/log2(rank+2) if target in top-k else 0 (IDCG=1)."""
    top = ranked_ids[:k]
    if target_id not in top:
        return 0.0
    return 1.0 / math.log2(top.index(target_id) + 2)


def recall_at_k(ranked_ids: list[int], target_id: int, k: int) -> float:
    return 1.0 if target_id in ranked_ids[:k] else 0.0


def db() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


# --- SECTION 0: situational readiness (the only section that ships) -----------
# The loop replaces/extends everything below. This stub just proves the harness
# runs and reports what's missing so iteration 1 knows where to start.

def section0_readiness() -> dict:
    info = {"db_path": DB_PATH, "db_exists": Path(DB_PATH).exists()}
    if not info["db_exists"]:
        print(json.dumps(info, indent=2))
        print("\nITER-1 TODO: snapshot the recommender DB or run in-container.")
        return info
    c = db()
    present = {r[0] for r in c.execute(
        "select name from sqlite_master where type='table'")}
    for t in ("titles", "title_vec", "library_items", "household_rejections"):
        if t in present:
            try:
                info[f"n_{t}"] = c.execute(f"select count(*) from {t}").fetchone()[0]
            except Exception as e:  # vec vtable needs the extension loaded
                info[f"n_{t}"] = f"err:{str(e)[:30]}"
    lib_cache = CACHE / "library_movie.json"
    info["library_cached"] = lib_cache.exists()
    print(json.dumps(info, indent=2))
    if info.get("n_library_items") == 0 and not info["library_cached"]:
        print("\nITER-1 TODO: source the household library (Sonarr/Radarr via "
              "backend) into research/cache/library_{movie,tv}.json; pull the "
              "852 rejections for the leakage guardrail; then build the "
              "leave-one-out eval and BASELINE the current mmr_diverse recipe.")
    return info


# --- SYNTHESIS (updated every iteration: current best metric + what changed) --
SYNTHESIS = """
Baseline: NOT YET MEASURED. No variant beats baseline yet (none exist).
Headline metric (nDCG@10): pending iteration 1.
"""

if __name__ == "__main__":
    section0_readiness()
    print(SYNTHESIS)
