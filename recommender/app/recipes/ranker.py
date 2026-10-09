"""Two-stage ranker learned from the household's own judgments.

WHY
  ``fused`` ranks ~800 centroid-ANN neighbours by max similarity to any owned
  title. Replayed against the household's real judgments
  (research/household_eval.py, state frozen at 2026-07-01, scored on what was
  added vs red-dotted afterwards) that ordering was a coin flip -- judgment AUC
  0.54 movie / 0.43 tv -- and its slates were low-rated filler; the household
  red-dotted ~1,900 picks against ~120 adds. Similarity to the library is not
  what separates a want from a veto, so this recipe learns what does.

PIPELINE
  1. Candidates, from an in-memory catalog matrix (no sqlite-vec k cap):
       * multi-interest: spherical k-means over the positives, a quota of the
         nearest titles per interest (Pinterest PinnerSage, Pal 2020), so one
         dense cluster can no longer own the whole pool;
       * learned-cheap: every eligible title scored by the cheap half of the
         household model (taste log-odds, rating, vote volume and velocity);
       * fresh: the best recent releases by that same cheap score.
  2. Features per candidate against positives P (library + likes + adds /
     clicks / watches) and negatives N (dislikes + household vetoes): content
     cosine to P (max, top-k mean) and how far it is closer to N than to P
     (a hinge, so a title far from everything isn't rewarded for being far from
     the vetoes), IDF cast / crew / keyword overlap with
     P and N, genre / language / decade log-odds of P vs N, Bayesian rating,
     vote volume and votes-per-year, popularity, age.
  3. Score = logistic regression fit per household on P vs N with
     leave-self-out features, ridge-shrunk toward PRIOR so a household with few
     judgments still gets sane weights. Cached per (sub, kind); refit when the
     judgment counts move.
  4. Slate: calibrated greedy selection (Netflix, Steck 2018) so the strip's
     genre mix tracks the household's, a near-duplicate penalty, one title per
     TMDB collection, a running floor of recent releases and the running
     kids-genre cap.

TESTED AND LEFT OUT: collaborative counts from TMDB's per-title
"recommendations" lists (fetched for every owned/judged title) moved judgment
AUC and future-add recall by less than their noise at both eval cutoffs, so
they don't earn an ingest pipeline. Recency-weighting the training positives
was likewise flat.
"""

from __future__ import annotations

import logging
import math
import sqlite3
import threading
import time
from dataclasses import dataclass

import numpy as np
from scipy import sparse

from ..context import Candidate, UserContext, _load_title_rows, normalize_title_key
from ..db import GENRE_AGG_SQL, deserialize_f32, table_generation
from ..reasons import discover_reason, personalized_reason
from ..retrieval import AVAILABLE_TITLE_PREDICATE
from ..schemas import ScoredItem
from . import EMBED_EPS, RecipeResult, cold_start_result
from .fused import KEY_CREW_JOBS, KIDS_GENRE_IDS

log = logging.getLogger(__name__)

DEFAULTS: dict[str, float | int | str] = {
    "pool_size": 600,                # candidates scored by the full model
    "interest_clusters": 12,         # max k-means interests over the positives
    "min_vote_count": 50,
    "ridge": 10.0,                   # pull toward PRIOR (units: one balanced sample)
    "calibration": 0.3,              # slate genre mix vs relevance (Steck 2018 lambda)
    "redundancy": 0.1,               # penalty on content similarity to already-picked titles
    "fresh_share": 0.25,             # running floor of titles released (tv: aired) this year or last
    "kids_genre_cap": 0.35,
    "personalized_threshold": 0.55,  # neighbour similarity that earns "personalized"
}

FEATURES = (
    "sim_pos_max", "sim_pos_topk", "neg_excess_max", "neg_excess_topk",
    "cast_pos", "cast_neg", "crew_pos", "crew_neg", "kw_pos", "kw_neg",
    "genre_lo", "lang_lo", "decade_lo",
    "rating", "log_votes", "log_vote_rate", "log_pop", "age",
)
# Features computable for the whole catalog without per-title SQL; they drive
# the learned-cheap candidate source.
CHEAP = ("genre_lo", "lang_lo", "decade_lo", "rating", "log_votes", "log_vote_rate", "log_pop", "age")
_F = {name: i for i, name in enumerate(FEATURES)}
_CHEAP_IDX = np.array([_F[c] for c in CHEAP])

# Standardized-feature weights a household starts from before it has judged
# anything; the ridge pulls the fit toward these.
PRIOR = np.array([
    0.3, 0.5, -0.3, -0.5,
    0.2, -0.2, 0.2, -0.2, 0.2, -0.2,
    0.5, 0.3, 0.2,
    0.3, 0.2, 0.2, 0.1, 0.0,
], dtype=np.float64)

TOPK = 10                 # neighbours averaged by the *_topk similarity features
LOGODDS_PRIOR = 0.1       # category-rate prior, as a fraction of each class's size
LOGODDS_EVIDENCE = 20.0   # judgments in a category before its log-odds count fully
CAST_TOPN = 10            # top-billed cast only, matching fused
RATING_PRIOR_VOTES = 200  # Bayesian-average pseudo-votes
MAX_TRAIN_PER_CLASS = 1500
MODEL_TTL_S = 12 * 3600
SLATE_INPUT = 150         # top-scored candidates the slate step chooses from
FRESH_INPUT = 40          # plus the top fresh ones, so the fresh floor can be met
CALIBRATION_SMOOTHING = 0.01


# --- catalog -------------------------------------------------------------------


@dataclass
class _Catalog:
    ids: np.ndarray            # tmdb_id per row
    row: dict[int, int]        # tmdb_id -> row
    emb: np.ndarray            # (n, dim) unit rows
    genre: sparse.csr_matrix   # (n, n_genres) multi-hot
    lang: sparse.csr_matrix    # (n, n_langs) one-hot
    decade: sparse.csr_matrix  # (n, n_decades) one-hot
    genres: list[tuple[int, ...]]
    rating: np.ndarray         # Bayesian average, centred
    log_votes: np.ndarray
    log_vote_rate: np.ndarray  # votes per year out: lifetime votes structurally bury new releases
    log_pop: np.ndarray
    age: np.ndarray            # decades since release
    fresh: np.ndarray          # bool: released (tv: last aired) this year or last
    vote_count: np.ndarray
    available: np.ndarray      # bool: released + not cancelled-before-air
    collection: np.ndarray     # TMDB collection id, 0 = none
    key: list[str | None]      # full normalized title
    cast: sparse.csr_matrix    # IDF-weighted, L2-normalized top-billed cast
    crew: sparse.csr_matrix    # same, key crew (director / writer / ...)
    kw: sparse.csr_matrix      # same, TMDB keywords


_CATALOG: dict[str, tuple[tuple, _Catalog]] = {}
_CATALOG_LOCK = threading.Lock()


def _onehot(codes: list, n_rows: int) -> sparse.csr_matrix:
    vocab: dict = {}
    rows, cols = [], []
    for r, cs in enumerate(codes):
        for c in cs:
            rows.append(r)
            cols.append(vocab.setdefault(c, len(vocab)))
    return sparse.csr_matrix(
        (np.ones(len(rows), np.float32), (rows, cols)), shape=(n_rows, max(len(vocab), 1))
    )


def _creators(conn: sqlite3.Connection, kind: str, row: dict[int, int], which: str) -> sparse.csr_matrix:
    """Catalog-aligned (n_titles, vocab) rows of IDF-weighted, L2-normalized
    people or keywords, so request-time overlap is a sparse product, not SQL."""
    if which == "cast":
        sql, args = "SELECT tmdb_id, person_id FROM title_cast WHERE kind = ? AND order_idx < ?", (kind, CAST_TOPN)
    elif which == "crew":
        jobs = ",".join("?" for _ in KEY_CREW_JOBS)
        sql = f"SELECT DISTINCT tmdb_id, person_id FROM title_crew WHERE kind = ? AND job IN ({jobs})"
        args = (kind, *KEY_CREW_JOBS)
    else:
        sql, args = "SELECT tmdb_id, keyword_id FROM title_keywords WHERE kind = ?", (kind,)
    vocab: dict[int, int] = {}
    rows, cols = [], []
    for tid, key in conn.execute(sql, args):
        r = row.get(tid)
        if r is not None:
            rows.append(r)
            cols.append(vocab.setdefault(key, len(vocab)))
    n = len(row)
    m = sparse.csr_matrix((np.ones(len(rows), np.float32), (rows, cols)), shape=(n, max(len(vocab), 1)))
    m.sum_duplicates()
    m.data[:] = 1.0
    df = np.bincount(m.indices, minlength=m.shape[1])
    m = m.multiply((np.log((1.0 + n) / (1.0 + df)) + 1.0).astype(np.float32)).tocsr()
    norms = np.sqrt(np.asarray(m.multiply(m).sum(axis=1)).ravel())
    norms[norms == 0] = 1.0
    return sparse.diags((1.0 / norms).astype(np.float32)).dot(m).tocsr()


def _catalog(conn: sqlite3.Connection, kind: str, *, refresh: bool = False) -> _Catalog:
    """The cached catalog. Requests never revalidate it -- the fingerprint is
    full-table scans over a multi-GB DB, seconds on the NAS -- so a nightly
    ingest reaches the ranker when ``warm`` (startup + hourly) rebuilds it."""
    hit = _CATALOG.get(kind)
    if hit is not None and not refresh:
        return hit[1]
    gen = table_generation(conn, ("titles", "fetched_at"), ("title_features", "computed_at"))
    if hit is not None and hit[0] == gen:
        return hit[1]
    with _CATALOG_LOCK:
        hit = _CATALOG.get(kind)
        if hit is not None and hit[0] == gen:
            return hit[1]
        collection_sql = (
            "json_extract(t.raw_json, '$.belongs_to_collection.id')" if kind == "movie" else "NULL"
        )
        # A returning show with a new season is as topical as a premiere.
        last_air_sql = "NULL" if kind == "movie" else "substr(json_extract(t.raw_json, '$.last_air_date'), 1, 4)"
        rows = conn.execute(
            f"""SELECT t.tmdb_id, t.title, t.year, t.vote_average,
                       COALESCE(t.vote_count, 0) AS vote_count,
                       COALESCE(t.popularity, 0) AS popularity, t.original_language,
                       CASE WHEN {AVAILABLE_TITLE_PREDICATE} THEN 1 ELSE 0 END AS available,
                       {collection_sql} AS collection, {last_air_sql} AS last_air_year,
                       {GENRE_AGG_SQL},
                       f.embedding AS embedding, f.dim AS dim
                FROM titles t
                JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
                WHERE t.kind = ?""",
            (kind,),
        ).fetchall()
        n = len(rows)
        ids = np.array([r["tmdb_id"] for r in rows], dtype=np.int64)
        emb = (
            np.vstack([deserialize_f32(r["embedding"], dim=r["dim"]) for r in rows]).astype(np.float32)
            if rows else np.zeros((0, 1), np.float32)
        )
        emb /= np.clip(np.linalg.norm(emb, axis=1, keepdims=True), EMBED_EPS, None)
        genres = [tuple(int(g) for g in r["genres"].split(",")) if r["genres"] else () for r in rows]
        votes = np.array([r["vote_count"] for r in rows], dtype=np.float64)
        avg = np.array([r["vote_average"] or 0.0 for r in rows], dtype=np.float64)
        mean_rating = float((avg * votes).sum() / max(votes.sum(), 1.0))
        rating = (votes * avg + RATING_PRIOR_VOTES * mean_rating) / (votes + RATING_PRIOR_VOTES) - mean_rating
        year = np.array([r["year"] or np.nan for r in rows], dtype=np.float64)
        this_year = time.gmtime().tm_year
        age = np.clip((this_year - np.nan_to_num(year, nan=this_year)) / 10.0, 0.0, 12.0)
        recent = np.fmax(year, np.array(
            [float(r["last_air_year"]) if (r["last_air_year"] or "").isdigit() else np.nan for r in rows]
        ))
        row = {int(t): i for i, t in enumerate(ids)}
        cat = _Catalog(
            ids=ids,
            row=row,
            emb=emb,
            genre=_onehot(genres, n),
            lang=_onehot([(r["original_language"] or "?",) for r in rows], n),
            decade=_onehot([(int(y // 10) if not math.isnan(y) else -1,) for y in year], n),
            genres=genres,
            rating=rating,
            log_votes=np.log10(1.0 + votes),
            log_vote_rate=np.log10(1.0 + votes / (age * 10.0 + 0.5)),
            log_pop=np.log10(1.0 + np.array([r["popularity"] for r in rows], dtype=np.float64)),
            age=age,
            fresh=np.nan_to_num(recent, nan=0.0) >= this_year - 1,
            vote_count=votes,
            available=np.array([bool(r["available"]) for r in rows]),
            collection=np.array([int(r["collection"] or 0) for r in rows], dtype=np.int64),
            key=[normalize_title_key(r["title"]) for r in rows],
            cast=_creators(conn, kind, row, "cast"),
            crew=_creators(conn, kind, row, "crew"),
            kw=_creators(conn, kind, row, "kw"),
        )
        _CATALOG[kind] = (gen, cat)
        log.info("ranker catalog loaded: kind=%s titles=%d", kind, n)
        return cat


# --- household reference sets + features ---------------------------------------------


@dataclass
class _Refs:
    pos: np.ndarray            # catalog rows of positives
    neg: np.ndarray            # catalog rows of negatives
    pos_col: dict[int, int]    # catalog row -> column in pos
    neg_col: dict[int, int]
    lo_genre: tuple[np.ndarray, np.ndarray, np.ndarray]  # plain, minus-self-in-P, minus-self-in-N
    lo_lang: tuple[np.ndarray, np.ndarray, np.ndarray]
    lo_decade: tuple[np.ndarray, np.ndarray, np.ndarray]


def _logodds(m: sparse.csr_matrix, pos: np.ndarray, neg: np.ndarray) -> tuple[np.ndarray, ...]:
    """Per-category log P(cat | positive) - log P(cat | negative), plus the
    leave-self-out variants for a member of P or of N.

    Each class's rate is smoothed toward the category's catalog share with a
    prior sized to that class, so a category nobody judged scores exactly 0
    (Laplace smoothing with unequal class sizes scored it ~+0.9 for whichever
    class was smaller), and the result is shrunk by the category's evidence so
    one owned news show doesn't make "news" a strong taste.
    """
    share = np.asarray(m.sum(axis=0)).ravel() / max(m.shape[0], 1)
    cp = np.asarray(m[pos].sum(axis=0)).ravel()
    cn = np.asarray(m[neg].sum(axis=0)).ravel()
    n_p, n_n = float(len(pos)), float(len(neg))

    def lo(cp_, n_p_, cn_, n_n_):
        rate_p = (cp_ + LOGODDS_PRIOR * n_p_ * share) / ((1 + LOGODDS_PRIOR) * max(n_p_, 1.0))
        rate_n = (cn_ + LOGODDS_PRIOR * n_n_ * share) / ((1 + LOGODDS_PRIOR) * max(n_n_, 1.0))
        evidence = cp_ + cn_
        with np.errstate(divide="ignore", invalid="ignore"):
            raw = np.log(rate_p / rate_n)
        return np.where(evidence > 0, np.nan_to_num(raw), 0.0) * evidence / (evidence + LOGODDS_EVIDENCE)

    # Clamped: the -1 variants only apply to a member's own categories (count >= 1);
    # elsewhere they're never selected but must stay finite.
    return (lo(cp, n_p, cn, n_n), lo(np.maximum(cp - 1, 0), max(n_p - 1, 0), cn, n_n),
            lo(cp, n_p, np.maximum(cn - 1, 0), max(n_n - 1, 0)))


def _refs(cat: _Catalog, pos_ids: set[int], neg_ids: set[int]) -> _Refs:
    pos = np.array(sorted(cat.row[t] for t in pos_ids if t in cat.row), dtype=np.int64)
    neg = np.array(sorted(cat.row[t] for t in neg_ids - pos_ids if t in cat.row), dtype=np.int64)
    return _Refs(
        pos=pos, neg=neg,
        pos_col={int(r): j for j, r in enumerate(pos)}, neg_col={int(r): j for j, r in enumerate(neg)},
        lo_genre=_logodds(cat.genre, pos, neg),
        lo_lang=_logodds(cat.lang, pos, neg),
        lo_decade=_logodds(cat.decade, pos, neg),
    )


def _mean_logodds(m: sparse.csr_matrix, rows: np.ndarray, lo: tuple, in_p: np.ndarray, in_n: np.ndarray) -> np.ndarray:
    sub = m[rows]
    per = np.where(in_p, sub @ lo[1], np.where(in_n, sub @ lo[2], sub @ lo[0]))
    count = np.asarray(sub.sum(axis=1)).ravel()
    return per / np.maximum(count, 1.0)


def _cheap(cat: _Catalog, refs: _Refs, rows: np.ndarray, in_p: np.ndarray, in_n: np.ndarray) -> np.ndarray:
    return np.column_stack([
        _mean_logodds(cat.genre, rows, refs.lo_genre, in_p, in_n),
        _mean_logodds(cat.lang, rows, refs.lo_lang, in_p, in_n),
        _mean_logodds(cat.decade, rows, refs.lo_decade, in_p, in_n),
        cat.rating[rows], cat.log_votes[rows], cat.log_vote_rate[rows], cat.log_pop[rows], cat.age[rows],
    ])


def _sim_stats(sim: np.ndarray, rows: np.ndarray, col: dict[int, int], fill: float) -> tuple[np.ndarray, np.ndarray]:
    """Row max and top-k mean of ``sim`` with each row's own column masked out."""
    if sim.shape[1] == 0:
        z = np.zeros(len(rows))
        return z, z
    sim = sim.copy()
    self_r = [i for i, r in enumerate(rows) if int(r) in col]
    if self_r:
        sim[self_r, [col[int(rows[i])] for i in self_r]] = fill
    k = min(TOPK, sim.shape[1])
    top = np.partition(sim, -k, axis=1)[:, -k:]
    return sim.max(axis=1), top.mean(axis=1)


def _features(cat: _Catalog, refs: _Refs, rows: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(len(rows), len(FEATURES)) matrix, plus the per-row positive-neighbour
    affinity matrix (content + creators + themes) used for "because you have"."""
    in_p = np.isin(rows, refs.pos)
    in_n = np.isin(rows, refs.neg)
    x = np.zeros((len(rows), len(FEATURES)))
    e = cat.emb[rows]
    s_pos = e @ cat.emb[refs.pos].T
    s_neg = e @ cat.emb[refs.neg].T
    pos_max, pos_topk = _sim_stats(s_pos, rows, refs.pos_col, -1.0)
    neg_max, neg_topk = _sim_stats(s_neg, rows, refs.neg_col, -1.0)
    x[:, 0], x[:, 1] = pos_max, pos_topk
    x[:, 2] = np.maximum(neg_max - pos_max, 0.0) if len(refs.neg) else 0.0
    x[:, 3] = np.maximum(neg_topk - pos_topk, 0.0) if len(refs.neg) else 0.0

    affinity = s_pos.copy()
    for m, fp, fn in ((cat.cast, 4, 5), (cat.crew, 6, 7), (cat.kw, 8, 9)):
        mx = m[rows]
        ov_pos = (mx @ m[refs.pos].T).toarray()
        ov_neg = (mx @ m[refs.neg].T).toarray()
        x[:, fp] = _sim_stats(ov_pos, rows, refs.pos_col, 0.0)[0]
        x[:, fn] = _sim_stats(ov_neg, rows, refs.neg_col, 0.0)[0]
        affinity += 0.5 * ov_pos
    x[:, _CHEAP_IDX] = _cheap(cat, refs, rows, in_p, in_n)
    self_r = [i for i, r in enumerate(rows) if int(r) in refs.pos_col]
    if self_r:
        affinity[self_r, [refs.pos_col[int(rows[i])] for i in self_r]] = -np.inf
    return x, affinity


# --- per-household model ---------------------------------------------------------------


@dataclass
class _Model:
    w: np.ndarray        # standardized weights, bias last
    mean: np.ndarray
    std: np.ndarray
    n_pos: int
    n_neg: int
    train_auc: float
    fitted_at: float
    ridge: float

    def z(self, x: np.ndarray, cols: np.ndarray | None = None) -> np.ndarray:
        if cols is None:
            return ((x - self.mean) / self.std) @ self.w[:-1] + self.w[-1]
        return ((x - self.mean[cols]) / self.std[cols]) @ self.w[cols]


_MODELS: dict[tuple[str, str], _Model] = {}
_MODELS_LOCK = threading.Lock()


def _fit_logistic(x: np.ndarray, y: np.ndarray, prior: np.ndarray, ridge: float) -> np.ndarray:
    """Class-balanced logistic regression, L2-shrunk toward ``prior`` (bias
    unshrunk), by Newton's method."""
    n, f = x.shape
    xb = np.hstack([x, np.ones((n, 1))])
    pos = y.sum()
    sw = np.where(y == 1, n / (2.0 * max(pos, 1.0)), n / (2.0 * max(n - pos, 1.0)))
    target = np.append(prior, 0.0)
    reg = np.full(f + 1, ridge)
    reg[-1] = 1e-6
    w = target.copy()
    for _ in range(50):
        p = 1.0 / (1.0 + np.exp(-np.clip(xb @ w, -30, 30)))
        grad = xb.T @ (sw * (p - y)) + reg * (w - target)
        hess = (xb * (sw * p * (1 - p))[:, None]).T @ xb + np.diag(reg)
        step = np.linalg.solve(hess, grad)
        w -= step
        if np.abs(step).max() < 1e-7:
            break
    return w


def _auc(s: np.ndarray, y: np.ndarray) -> float:
    r = s.argsort().argsort() + 1.0
    n1 = y.sum()
    n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)) if n1 and n0 else float("nan")


def _model(ctx: UserContext, cat: _Catalog, refs: _Refs, ridge: float) -> _Model:
    """The household's fitted weights. Reused across catalog reloads (they hold
    no catalog rows); refit on TTL, a ridge change, or judgment-count drift."""
    key = (ctx.sub, ctx.kind)
    n_pos, n_neg = len(refs.pos), len(refs.neg)
    m = _MODELS.get(key)
    drift = 0 if m is None else abs(m.n_pos - n_pos) + abs(m.n_neg - n_neg)
    if (
        m is not None and m.ridge == ridge and time.time() - m.fitted_at < MODEL_TTL_S
        and drift < max(10, 0.02 * (n_pos + n_neg))
    ):
        return m
    with _MODELS_LOCK:
        rng = np.random.default_rng(len(ctx.sub) * 7919 + n_pos * 31 + n_neg)
        pos = refs.pos if n_pos <= MAX_TRAIN_PER_CLASS else rng.choice(refs.pos, MAX_TRAIN_PER_CLASS, replace=False)
        neg = refs.neg if n_neg <= MAX_TRAIN_PER_CLASS else rng.choice(refs.neg, MAX_TRAIN_PER_CLASS, replace=False)
        rows = np.concatenate([pos, neg])
        y = np.concatenate([np.ones(len(pos)), np.zeros(len(neg))])
        x, _ = _features(cat, refs, rows)
        mean = x.mean(axis=0)
        std = x.std(axis=0)
        std[std < 1e-9] = 1.0
        xs = (x - mean) / std
        if len(pos) and len(neg):
            w = _fit_logistic(xs, y, PRIOR, ridge)
        else:
            w = np.append(PRIOR, 0.0)
        train_auc = _auc(xs @ w[:-1], y) if len(pos) and len(neg) else float("nan")
        m = _Model(w=w, mean=mean, std=std, n_pos=n_pos, n_neg=n_neg,
                   train_auc=train_auc, fitted_at=time.time(), ridge=ridge)
        _MODELS[key] = m
        log.info("ranker model fit: sub=%s kind=%s pos=%d neg=%d train_auc=%.3f",
                 ctx.sub, ctx.kind, n_pos, n_neg, train_auc)
        return m


# --- candidates -------------------------------------------------------------------------


def _interests(e: np.ndarray, k: int, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Spherical k-means: (k, dim) unit centroids and cluster sizes."""
    k = max(1, min(k, len(e)))
    rng = np.random.default_rng(seed)
    cent = e[rng.choice(len(e), k, replace=False)].copy()
    assign = np.zeros(len(e), dtype=np.int64)
    for _ in range(15):
        assign = (e @ cent.T).argmax(axis=1)
        for c in range(k):
            members = e[assign == c]
            if len(members):
                v = members.sum(axis=0)
                cent[c] = v / max(np.linalg.norm(v), EMBED_EPS)
    return cent, np.bincount(assign, minlength=k)


def _eligible(ctx: UserContext, cat: _Catalog, min_votes: int, owned_keys: set[str]) -> np.ndarray:
    ok = cat.available & (cat.vote_count >= min_votes)
    blocked = ctx.library_ids | ctx.rejected_ids | ctx.disliked_ids | ctx.recently_shown_ids | ctx.liked_ids
    for t in blocked:
        r = cat.row.get(t)
        if r is not None:
            ok[r] = False
    if owned_keys:
        ok &= np.array([k not in owned_keys for k in cat.key])
    return ok


def _candidates(
    cat: _Catalog, refs: _Refs, model: _Model, ok: np.ndarray, pool: int, k_max: int,
) -> tuple[np.ndarray, dict[str, int]]:
    elig = np.flatnonzero(ok)
    if len(elig) == 0:
        return elig, {}
    picked: list[np.ndarray] = []
    # learned-cheap: the household model's cheap half over every eligible title
    cheap = _cheap(cat, refs, elig, np.zeros(len(elig), bool), np.zeros(len(elig), bool))
    cheap_score = model.z(cheap, _CHEAP_IDX)
    n_cheap = min(len(elig), pool // 2)
    picked.append(elig[np.argpartition(-cheap_score, n_cheap - 1)[:n_cheap]])
    # multi-interest content neighbours, quota ~ sqrt(interest size)
    k = min(k_max, max(1, len(refs.pos) // 25))
    cent, sizes = _interests(cat.emb[refs.pos], k)
    sims = cat.emb[elig] @ cent.T
    share = np.sqrt(sizes) / max(np.sqrt(sizes).sum(), EMBED_EPS)
    for c in range(len(cent)):
        q = min(len(elig), max(1, int(round(share[c] * (pool - n_cheap)))))
        picked.append(elig[np.argpartition(-sims[:, c], q - 1)[:q]])
    # fresh: the best recent releases by the cheap model, so the slate's fresh floor has stock
    fresh = np.flatnonzero(cat.fresh[elig])
    n_fresh = min(len(fresh), pool // 8)
    if n_fresh:
        picked.append(elig[fresh[np.argpartition(-cheap_score[fresh], n_fresh - 1)[:n_fresh]]])
    rows = np.unique(np.concatenate(picked))
    return rows, {"cheap": n_cheap, "interests": len(cent), "fresh": n_fresh, "pool": len(rows)}


# --- slate -----------------------------------------------------------------------------


def _genre_dist(genre: sparse.csr_matrix) -> np.ndarray:
    """Dense rows spreading each title's weight evenly over its genres."""
    g = genre.toarray().astype(np.float64)
    return g / np.maximum(g.sum(axis=1, keepdims=True), 1.0)


def _slate(
    z: np.ndarray, emb: np.ndarray, gdist: np.ndarray, target: np.ndarray, collection: np.ndarray,
    kids: np.ndarray, fresh: np.ndarray, n: int, p: dict,
) -> list[int]:
    """Greedy slate over the inputs (returns their indices, best first).

    Each pick maximizes (1 - lam) * relevance - lam * KL(target || slate genre
    mix) - redundancy * max content similarity to what's already picked --
    Netflix's calibrated recommendations (Steck, RecSys 2018) plus an MMR-style
    near-duplicate penalty. Running constraints, each relaxed only when nothing
    else is left: one title per TMDB collection, kids-genre share <= cap at every
    prefix, fresh share >= floor at every prefix (floor rounds down, so the
    first card is never forced).
    """
    lam, mu = float(p["calibration"]), float(p["redundancy"])
    kids_cap, fresh_floor = float(p["kids_genre_cap"]), float(p["fresh_share"])
    rel = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))  # predicted P(want), as in Steck
    sim = emb @ emb.T
    has_target = target > 0
    qsum = np.zeros_like(target)
    best_sim = np.zeros(len(z))
    left = np.ones(len(z), dtype=bool)
    seen_coll: set[int] = set()
    chosen: list[int] = []
    n_kids = n_fresh = 0
    while len(chosen) < n and left.any():
        m = len(chosen) + 1
        allowed = left.copy()
        repeat = np.array([c != 0 and c in seen_coll for c in collection])
        if (allowed & ~repeat).any():
            allowed &= ~repeat
        if n_kids + 1 > kids_cap * m and (allowed & ~kids).any():
            allowed &= ~kids
        if n_fresh < int(fresh_floor * m) and (allowed & fresh).any():
            allowed &= fresh
        q = (1 - CALIBRATION_SMOOTHING) * (qsum + gdist) / m + CALIBRATION_SMOOTHING * target
        kl = (target[has_target] * np.log(target[has_target] / q[:, has_target])).sum(axis=1)
        obj = np.where(allowed, (1 - lam) * rel - lam * kl - mu * best_sim, -np.inf)
        i = int(obj.argmax())
        chosen.append(i)
        left[i] = False
        qsum += gdist[i]
        best_sim = np.maximum(best_sim, sim[i])
        n_kids += bool(kids[i])
        n_fresh += bool(fresh[i])
        if collection[i]:
            seen_coll.add(int(collection[i]))
    return chosen


# --- recipe entry points ------------------------------------------------------------------


def _prepare(ctx: UserContext, conn: sqlite3.Connection, p: dict):
    cat = _catalog(conn, ctx.kind)
    pos_ids = ctx.library_ids | ctx.liked_ids
    neg_ids = (ctx.disliked_ids | ctx.rejected_ids) - pos_ids
    refs = _refs(cat, pos_ids, neg_ids)
    model = _model(ctx, cat, refs, float(p["ridge"]))
    return cat, refs, model


def warm(conn: sqlite3.Connection) -> None:
    """(Re)build the catalogs off the request path if the catalog tables moved.
    A cold build is slow (it parses every title's raw TMDB JSON and scans the
    credits/keyword tables), which no strip request should wait on."""
    for kind in ("movie", "tv"):
        _catalog(conn, kind, refresh=True)


def score_ids(ctx: UserContext, conn: sqlite3.Connection, ids: list[int], params: dict) -> dict[int, float]:
    """Model score for explicit tmdb ids (the offline eval's hook)."""
    p = {**DEFAULTS, **params}
    cat, refs, model = _prepare(ctx, conn, p)
    rows = np.array([cat.row[t] for t in ids if t in cat.row], dtype=np.int64)
    if len(rows) == 0 or len(refs.pos) == 0:
        return {}
    x, _ = _features(cat, refs, rows)
    return {int(cat.ids[r]): float(s) for r, s in zip(rows, model.z(x))}


def score(ctx: UserContext, conn: sqlite3.Connection, *, n: int, params: dict) -> RecipeResult:
    p = {**DEFAULTS, **params}
    min_votes = int(p["min_vote_count"])
    if ctx.positive_centroid() is None:
        return cold_start_result(conn, ctx, n=n, min_vote_count=min_votes)

    cat, refs, model = _prepare(ctx, conn, p)
    if len(refs.pos) == 0:
        return cold_start_result(conn, ctx, n=n, min_vote_count=min_votes)
    owned_keys = {k for t in ctx.library_ids if (r := cat.row.get(t)) is not None and (k := cat.key[r])}
    ok = _eligible(ctx, cat, min_votes, owned_keys)
    rows, src = _candidates(cat, refs, model, ok, int(p["pool_size"]), int(p["interest_clusters"]))
    if len(rows) == 0:
        return RecipeResult(items=[], diag={"path": "empty_pool"})

    x, affinity = _features(cat, refs, rows)
    z = model.z(x)
    by_score = np.argsort(-z)
    fresh_rows = [i for i in by_score if cat.fresh[rows[i]]][:FRESH_INPUT]
    top = np.array(list(dict.fromkeys([*by_score[:SLATE_INPUT].tolist(), *fresh_rows])), dtype=np.int64)
    cr = rows[top]
    kids = np.array([bool(KIDS_GENRE_IDS.intersection(cat.genres[r])) for r in cr])
    target = _genre_dist(cat.genre[refs.pos]).mean(axis=0)
    picks = _slate(z[top], cat.emb[cr], _genre_dist(cat.genre[cr]), target, cat.collection[cr],
                   kids, cat.fresh[cr], n, p)
    chosen = [int(top[k]) for k in picks]

    title_rows = _load_title_rows(conn, ctx.kind, [int(cat.ids[rows[i]]) for i in chosen])
    chosen = [i for i in chosen if int(cat.ids[rows[i]]) in title_rows]
    pos_titles = _load_title_rows(
        conn, ctx.kind,
        [int(cat.ids[refs.pos[j]]) for i in chosen for j in np.argsort(-affinity[i])[:2]],
    )
    tau = float(p["personalized_threshold"])
    items: list[ScoredItem] = []
    for i in chosen:
        nb = np.argsort(-affinity[i])[:2]
        neighbours = [pos_titles[t] for j in nb if (t := int(cat.ids[refs.pos[j]])) in pos_titles
                      and affinity[i, j] >= tau]
        personal = bool(neighbours)
        cand = Candidate(title=title_rows[int(cat.ids[rows[i]])], embedding=cat.emb[rows[i]])
        items.append(ScoredItem(
            tmdb_id=cand.title.tmdb_id, title=cand.title.title, year=cand.title.year,
            poster_path=cand.title.poster_path, overview=cand.title.overview,
            score=float(1.0 / (1.0 + math.exp(-max(min(z[i], 30.0), -30.0)))),
            provenance="personalized" if personal else "discover",
            reason=personalized_reason(cand, neighbours) if personal else discover_reason(cand),
        ))
    return RecipeResult(items=items, diag={
        "path": "ranker", **src, "pos": len(refs.pos), "neg": len(refs.neg),
        "train_auc": round(model.train_auc, 4), "model_age_s": round(time.time() - model.fitted_at),
        "weights": {f: round(float(w), 3) for f, w in zip(FEATURES, model.w)},
        "kids_returned": sum(bool(KIDS_GENRE_IDS.intersection(cat.genres[rows[i]])) for i in chosen),
        "fresh_returned": int(sum(cat.fresh[rows[i]] for i in chosen)), "returned": len(items),
    })
