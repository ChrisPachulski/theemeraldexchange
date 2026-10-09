"""Temporal household-judgment eval for the recommender.

WHY THIS AND NOT LEAVE-ONE-OUT
  The earlier research loop scored library reconstruction (hold out an owned
  title, see if it comes back). That rewards predicting franchise siblings and
  says nothing about the ~1,900 red dots the household has put on served picks.
  This harness replays the household as it stood at a cutoff T and scores the
  recipe against what happened AFTER T:

    * judgment AUC   -- P(score(pos) > score(neg)) over titles the household
                        judged after T. pos = added / clicked / watched / added to
                        the library; neg = disliked. "imp" = served picks only.
    * future recall  -- recall@20/50 of titles added to the library after T
                        (the full recipe: retrieval + ranking + filters).
    * slate stats    -- what the top-20 at T actually looks like.

  Nothing after T leaks into the context: the library is cut by the Radarr/
  Sonarr `added` date, engagement by its ts, and every test-labelled id is
  stripped from the context negatives (the backend dislike list has no ts).

INPUTS (outside the repo; household data never gets committed)
  $EEX_SNAP (default ~/eex-recsys-snap): exchange.db (recommender DB copy),
  library.json (Radarr/Sonarr export with `added`), user-feedback.json and
  rejections.json (backend data dir).

  recommender/.venv/bin/python recommender/research/household_eval.py \
      [--cutoff 2026-07-01] [--recipe fused] [--kind movie] [--show 20]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

RECO_DIR = Path(__file__).resolve().parents[1]
if str(RECO_DIR) not in sys.path:
    sys.path.insert(0, str(RECO_DIR))

SNAP = Path(os.environ.get("EEX_SNAP", Path.home() / "eex-recsys-snap"))
os.environ.setdefault("RECOMMENDER_DB_PATH", str(SNAP / "exchange.db"))
OWNER = os.environ.get("EEX_OWNER_SUB", "plex:494190801")
POS_SIGNALS = ("added", "clicked", "watched")
POS_OUTCOMES = ("added", "clicked")


# --- data -------------------------------------------------------------------

def connect():
    from app import db
    return db.connect(db_path=SNAP / "exchange.db", readonly=True)


@dataclass
class Household:
    kind: str
    cutoff: str
    library: list[tuple[int, str]]          # owned before T
    engaged: set[int]                       # added/clicked/watched before T
    liked: set[int]
    disliked: set[int]                      # before T (or unknown ts)
    rejected: set[int]
    test_pos: set[int] = field(default_factory=set)
    test_neg: set[int] = field(default_factory=set)
    test_imp: set[int] = field(default_factory=set)  # served after T
    future_adds: set[int] = field(default_factory=set)
    train_pos: set[int] = field(default_factory=set)  # judged before T
    train_neg: set[int] = field(default_factory=set)


def household(conn, kind: str, cutoff: str) -> Household:
    lib_raw = json.loads((SNAP / "library.json").read_text())[kind]
    fb = json.loads((SNAP / "user-feedback.json").read_text()).get(OWNER, {}).get(kind, {})
    rej = json.loads((SNAP / "rejections.json").read_text()).get(kind, [])

    before = [(x["tmdbId"], x["title"]) for x in lib_raw if x.get("tmdbId") and x["added"] < cutoff]
    after = {x["tmdbId"] for x in lib_raw if x.get("tmdbId") and x["added"] >= cutoff}

    rows = conn.execute(
        "SELECT tmdb_id, signal, ts FROM user_feedback WHERE sub = ? AND kind = ?", (OWNER, kind)
    ).fetchall()
    eng_before = {r["tmdb_id"] for r in rows if r["signal"] in POS_SIGNALS and r["ts"] < cutoff}
    pos_after = {r["tmdb_id"] for r in rows if r["signal"] in POS_SIGNALS and r["ts"] >= cutoff}
    neg_after = {r["tmdb_id"] for r in rows if r["signal"] == "dislike" and r["ts"] >= cutoff}
    neg_before = {r["tmdb_id"] for r in rows if r["signal"] == "dislike" and r["ts"] < cutoff}

    out = conn.execute(
        """SELECT l.tmdb_id, l.ts AS shown, o.outcome FROM rec_log l
           LEFT JOIN rec_outcomes o ON o.rec_id = l.id
           WHERE l.sub = ? AND l.kind = ?""",
        (OWNER, kind),
    ).fetchall()
    imp_after = {r["tmdb_id"] for r in out if r["shown"] >= cutoff}
    pos_after |= {r["tmdb_id"] for r in out if r["shown"] >= cutoff and r["outcome"] in POS_OUTCOMES}
    neg_after |= {r["tmdb_id"] for r in out if r["shown"] >= cutoff and r["outcome"] == "disliked"}
    pos_before = eng_before | {r["tmdb_id"] for r in out if r["shown"] < cutoff and r["outcome"] in POS_OUTCOMES}
    neg_before |= {r["tmdb_id"] for r in out if r["shown"] < cutoff and r["outcome"] == "disliked"}

    owned_before = {i for i, _ in before}
    pos_after |= after
    conflict = pos_after & neg_after
    test_pos = pos_after - conflict - owned_before
    test_neg = neg_after - conflict - owned_before
    test_ids = test_pos | test_neg

    # Backend lists carry no ts: anything not judged after T is treated as known at T.
    disliked = ({e["id"] for e in fb.get("disliked", [])} | neg_before) - test_ids
    rejected = {e["id"] for e in rej} - test_ids
    liked = {e["id"] for e in fb.get("liked", [])} - test_ids
    return Household(
        kind=kind, cutoff=cutoff, library=before, engaged=eng_before - test_ids, liked=liked,
        disliked=disliked, rejected=rejected, test_pos=test_pos, test_neg=test_neg,
        test_imp=imp_after, future_adds=after - neg_after,
        train_pos=(pos_before - neg_before) | owned_before, train_neg=neg_before - pos_before,
    )


def context(conn, hh: Household):
    from app.context import load_user_context
    from app.schemas import FeedbackEntry, LibraryItem, ScoreRequest

    fb = [FeedbackEntry(tmdb_id=i, signal="like") for i in sorted(hh.liked) if i > 0]
    fb += [FeedbackEntry(tmdb_id=i, signal="added") for i in sorted(hh.engaged) if i > 0]
    fb += [FeedbackEntry(tmdb_id=i, signal="dislike") for i in sorted(hh.disliked) if i > 0]
    req = ScoreRequest.model_construct(
        sub="eval:replay", kind=hh.kind, n=50, exclude_recently_shown=False,
        library=[LibraryItem(tmdb_id=i, title=t) for i, t in hh.library],
        feedback=fb, household_rejections=sorted(i for i in hh.rejected if i > 0),
    )
    return load_user_context(conn, req)


# --- scoring helpers ----------------------------------------------------------

def candidate_batch(conn, kind: str, ids: list[int]):
    """A CandidateBatch for exactly these ids (no exclusions, no filters)."""
    from app.context import Candidate, title_row_from
    from app.db import GENRE_AGG_SQL, deserialize_f32
    from app.retrieval import CandidateBatch

    by_id = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        ph = ",".join("?" for _ in chunk)
        for r in conn.execute(
            f"""SELECT t.tmdb_id, t.kind, t.title, t.year, t.poster_path, t.overview,
                       COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                       COALESCE(t.vote_count, 0) AS vote_count, {GENRE_AGG_SQL},
                       f.embedding AS embedding, f.dim AS dim
                FROM titles t JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
                WHERE t.kind = ? AND t.tmdb_id IN ({ph})""",
            (kind, *chunk),
        ).fetchall():
            by_id[r["tmdb_id"]] = Candidate(
                title=title_row_from(r, kind), embedding=deserialize_f32(r["embedding"], dim=r["dim"])
            )
    cands = [by_id[i] for i in ids if i in by_id]
    return CandidateBatch(candidates=cands, distances=[0.0] * len(cands), diag={})


def score_ids(recipe_mod, ctx, conn, ids: list[int], params: dict) -> dict[int, float]:
    """Score arbitrary ids with a recipe by pinning its candidate pool to them."""
    if hasattr(recipe_mod, "score_ids"):
        return recipe_mod.score_ids(ctx, conn, ids, params)
    batch = candidate_batch(conn, ctx.kind, ids)
    orig = recipe_mod.retrieve_candidates
    recipe_mod.retrieve_candidates = lambda *a, **k: batch
    try:
        res = recipe_mod.score(ctx, conn, n=len(batch.candidates), params={**params, "kids_genre_cap": 1.0})
    finally:
        recipe_mod.retrieve_candidates = orig
    return {it.tmdb_id: it.score for it in res.items}


def auc(scores: dict[int, float], pos: set[int], neg: set[int]) -> tuple[float, int, int]:
    p = [scores[i] for i in pos if i in scores]
    n = [scores[i] for i in neg if i in scores]
    if not p or not n:
        return float("nan"), len(p), len(n)
    allv = np.array(p + n)
    ranks = allv.argsort().argsort() + 1.0
    # average ranks for ties
    _, inv, counts = np.unique(allv, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts))
    np.add.at(sums, inv, ranks)
    ranks = (sums / counts)[inv]
    u = ranks[: len(p)].sum() - len(p) * (len(p) + 1) / 2
    return float(u / (len(p) * len(n))), len(p), len(n)


def auc_se(a: float, n_p: int, n_n: int) -> float:
    """Hanley-McNeil standard error."""
    if math.isnan(a) or not n_p or not n_n:
        return float("nan")
    q1, q2 = a / (2 - a), 2 * a * a / (1 + a)
    return math.sqrt((a * (1 - a) + (n_p - 1) * (q1 - a * a) + (n_n - 1) * (q2 - a * a)) / (n_p * n_n))


# --- report ------------------------------------------------------------------

KIDS = {16, 10751, 10762}


def evaluate(recipe_name: str, kind: str, cutoff: str, params: dict, show: int = 0) -> dict:
    from app import recipes

    conn = connect()
    hh = household(conn, kind, cutoff)
    ctx = context(conn, hh)
    mod = recipes.get(recipe_name)
    p = {**mod.DEFAULTS, **params}

    judged = sorted(hh.test_pos | hh.test_neg)
    scores = score_ids(mod, ctx, conn, judged, p)
    a_all, np_all, nn_all = auc(scores, hh.test_pos, hh.test_neg)
    a_imp, np_imp, nn_imp = auc(scores, hh.test_pos & hh.test_imp, hh.test_neg & hh.test_imp)

    res = mod.score(ctx, conn, n=50, params=p)
    ranked = [it.tmdb_id for it in res.items]
    targets = {i for i in hh.future_adds if i not in ctx.library_ids}
    in_cat = {r[0] for r in conn.execute(
        f"SELECT tmdb_id FROM title_features WHERE kind = ? AND tmdb_id IN ({','.join('?' * len(targets))})",
        (kind, *targets),
    ).fetchall()} if targets else set()
    rec20 = len(set(ranked[:20]) & in_cat) / max(len(in_cat), 1)
    rec50 = len(set(ranked[:50]) & in_cat) / max(len(in_cat), 1)

    top = res.items[:20]
    meta = {r["tmdb_id"]: r for r in conn.execute(
        f"""SELECT t.tmdb_id, t.title, t.year, t.vote_average, t.vote_count, t.original_language,
                   (SELECT GROUP_CONCAT(genre_id) FROM title_genres g WHERE g.kind=t.kind AND g.tmdb_id=t.tmdb_id) AS genres
            FROM titles t WHERE t.kind = ? AND t.tmdb_id IN ({','.join('?' * len(top))})""",
        (kind, *[it.tmdb_id for it in top]),
    ).fetchall()} if top else {}
    kids = sum(1 for it in top if KIDS & {int(g) for g in (meta[it.tmdb_id]["genres"] or "").split(",") if g})
    emb = candidate_batch(conn, kind, [it.tmdb_id for it in top]).candidates
    e = np.vstack([c.embedding / np.linalg.norm(c.embedding) for c in emb]) if emb else np.zeros((0, 1))
    ils = float((e @ e.T)[np.triu_indices(len(e), 1)].mean()) if len(e) > 1 else 0.0
    gsets = [set((meta[it.tmdb_id]["genres"] or "").split(",")) - {""} for it in top]
    top_share = max((sum(g in gs for gs in gsets) for g in set().union(*gsets)), default=0) / max(len(gsets), 1)
    judged50 = [it.tmdb_id for it in res.items[:50] if it.tmdb_id in hh.test_pos | hh.test_neg]
    va = [meta[it.tmdb_id]["vote_average"] or 0 for it in top]
    judged_top = [it.tmdb_id for it in top if it.tmdb_id in hh.test_pos | hh.test_neg]

    out = {
        "recipe": recipe_name, "kind": kind, "cutoff": cutoff,
        "ctx": {"lib": len(hh.library), "eng": len(hh.engaged), "dis": len(hh.disliked), "rej": len(hh.rejected)},
        "auc_all": (round(a_all, 4), round(auc_se(a_all, np_all, nn_all), 4), np_all, nn_all),
        "auc_imp": (round(a_imp, 4), round(auc_se(a_imp, np_imp, nn_imp), 4), np_imp, nn_imp),
        "future_recall@20": round(rec20, 4), "future_recall@50": round(rec50, 4), "future_n": len(in_cat),
        "slate_kids@20": kids, "slate_vote_avg@20": round(float(np.mean(va)) if va else 0, 2),
        "slate_judged_pos/neg": (sum(i in hh.test_pos for i in judged_top), sum(i in hh.test_neg for i in judged_top)),
        "judged@50_pos/neg": (sum(i in hh.test_pos for i in judged50), sum(i in hh.test_neg for i in judged50)),
        "slate_ils@20": round(ils, 3), "slate_top_genre_share@20": round(top_share, 2),
        "diag": {k: v for k, v in res.diag.items() if k in ("path", "raw", "kept", "returned", "kids_returned", "pool", "train_auc")},
        "weights": res.diag.get("weights"),
    }
    if show:
        for it in res.items[:show]:
            m = meta.get(it.tmdb_id)
            tag = "+" if it.tmdb_id in hh.test_pos else "-" if it.tmdb_id in hh.test_neg else " "
            print(f"  {tag} {it.score:7.3f} {it.title} ({it.year}) va={m['vote_average'] if m else '?'} "
                  f"g={m['genres'] if m else '?'} | {it.reason}")
    conn.close()
    return out


def _cli() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cutoff", default="2026-07-01")
    ap.add_argument("--recipe", default="fused")
    ap.add_argument("--kind", default="both")
    ap.add_argument("--params", default="{}")
    ap.add_argument("--show", type=int, default=0)
    a = ap.parse_args()
    for kind in (("movie", "tv") if a.kind == "both" else (a.kind,)):
        print(json.dumps(evaluate(a.recipe, kind, a.cutoff, json.loads(a.params), a.show)))


if __name__ == "__main__":
    _cli()
