"""Behavioral tests for the core scoring path against a real (tmp) sqlite-vec DB.

Covers the layers that historically broke in production:
  * retrieval.retrieve_candidates — anti-join (library / household veto /
    dislikes / recently-shown), distance ordering across the IN(...) re-fetch,
    vote-count + availability gates, franchise title-key collision, pool_size.
  * context.load_user_context — inline-vs-stored feedback precedence (inline
    is authoritative; stored engagement merges in unless explicitly negated),
    watched-signal merge, inline household_rejections precedence, per-user
    reject union.
  * recipes — fused (veto NEVER surfaces, IDF weighting direction, cast-weight
    fusion direction, cold-start fallback), mmr_diverse (diversification vs
    pure relevance), baseline_cosine (similarity ordering), item_knn (max-sim
    scoring + exclusions), cold_start_trending.

The fixture builds a small synthetic catalog with controlled embedding
geometry (axis-aligned clusters in the real 384-dim space) so every expected
ordering is a property of the math, not of luck.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pytest

from app.config import CONFIG
from app.context import (
    load_user_context,
    select_model_config_for_context,
    title_key_variants,
)
from app.db import VEC_TABLE_DDL, connect, encode_vec_rowid, serialize_f32
from app.recipes import baseline_cosine, cold_start_trending, fused, item_knn, mmr_diverse
from app.recipes.mmr_diverse import _mmr
from app.retrieval import cold_start_pool, retrieve_candidates
from app.schemas import ScoreRequest

SUB = "plex:494190801"
DIM = CONFIG.embed_dim

# Catalog ids — grouped so the assertions below read naturally.
LIB_A1 = 101          # "Emerald Heist", action cluster, in library (rare+common cast)
LIB_A2 = 102          # action cluster, in library
CAND_NEAR = 201       # action cluster — should rank high
CAND_NEAR2 = 202      # action cluster, slightly farther
CAND_FAR = 301        # comedy cluster — should rank low
VETOED = 401          # household_rejections — must NEVER surface (it is the closest match)
DISLIKED = 402        # user dislike — excluded from retrieval
SHOWN = 403           # recently_shown — excluded from retrieval
FRANCHISE = 404       # "Emerald Heist: Part Two" — title-key collision with LIB_A1
LOW_VOTE = 405        # below min_vote_count
UNRELEASED = 406      # future release_date — availability gate
CAST_RARE = 601       # shares a RARE actor with LIB_A1
CAST_COMMON = 602     # shares a COMMON actor with LIB_A1
RARE_PERSON = 9001
COMMON_PERSON = 9002


def axis_vec(weights: dict[int, float]) -> np.ndarray:
    v = np.zeros(DIM, dtype=np.float32)
    for idx, val in weights.items():
        v[idx] = val
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


ACTION = axis_vec({0: 1.0})
COMEDY = axis_vec({1: 1.0})


def add_title(
    conn: sqlite3.Connection,
    tmdb_id: int,
    *,
    title: str,
    vec: np.ndarray,
    kind: str = "movie",
    popularity: float = 10.0,
    vote_count: int = 500,
    genres: tuple[int, ...] = (28,),
    cast: tuple[int, ...] = (),
    crew: tuple[tuple[int, str], ...] = (),
    release_date: str = "2020-01-01",
    status: str = "Released",
) -> None:
    conn.execute(
        """INSERT INTO titles(tmdb_id, kind, title, year, release_date, overview, poster_path,
                              vote_average, vote_count, popularity, status, adult, fetched_at)
           VALUES (?, ?, ?, 2020, ?, 'synthetic', NULL, 7.0, ?, ?, ?, 0, datetime('now'))""",
        (tmdb_id, kind, title, release_date, vote_count, popularity, status),
    )
    for g in genres:
        conn.execute("INSERT INTO title_genres VALUES (?, ?, ?)", (tmdb_id, kind, g))
    for order_idx, person_id in enumerate(cast):
        conn.execute(
            "INSERT INTO title_cast VALUES (?, ?, ?, ?, ?)",
            (tmdb_id, kind, person_id, f"person-{person_id}", order_idx),
        )
    for person_id, job in crew:
        conn.execute(
            "INSERT INTO title_crew VALUES (?, ?, ?, ?, ?)",
            (tmdb_id, kind, person_id, f"person-{person_id}", job),
        )
    blob = serialize_f32(vec)
    conn.execute(
        "INSERT INTO title_features VALUES (?, ?, '{}', ?, ?, datetime('now'))",
        (tmdb_id, kind, blob, DIM),
    )
    conn.execute(
        "INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, ?, ?)",
        (encode_vec_rowid(kind, tmdb_id), kind, blob),
    )


@pytest.fixture(autouse=True)
def _clear_module_caches():
    fused._IDF.clear()
    item_knn._CATALOG.clear()
    yield
    fused._IDF.clear()
    item_knn._CATALOG.clear()


@pytest.fixture()
def conn(tmp_path):
    db_path = tmp_path / "exchange.db"
    c = connect(db_path=db_path)
    # Apply the repo migrations' SQL directly: migration 0005 contains an
    # unannotated DROP TABLE that the migrator's destructive gate refuses on a
    # fresh DB, and the migrator itself is covered by test_db_migrator. What
    # matters here is the REAL final schema.
    c.execute(VEC_TABLE_DDL.format(dim=DIM))  # 0005 references title_vec
    for f in sorted((Path(__file__).resolve().parents[1] / "migrations").glob("*.sql")):
        c.executescript(f.read_text(encoding="utf-8"))

    add_title(c, LIB_A1, title="Emerald Heist", vec=ACTION,
              cast=(RARE_PERSON, COMMON_PERSON), crew=((7001, "Director"),))
    add_title(c, LIB_A2, title="Steel Vengeance", vec=axis_vec({0: 0.95, 2: 0.05}))
    add_title(c, CAND_NEAR, title="Crimson Strike", vec=axis_vec({0: 0.95, 3: 0.05}),
              cast=(COMMON_PERSON,))
    add_title(c, CAND_NEAR2, title="Night Convoy", vec=axis_vec({0: 0.85, 3: 0.15}),
              cast=(COMMON_PERSON,))
    add_title(c, CAND_FAR, title="Giggle Factory", vec=COMEDY, genres=(35,),
              cast=(COMMON_PERSON,))
    add_title(c, VETOED, title="Forbidden Sequel", vec=ACTION)
    add_title(c, DISLIKED, title="Hated One", vec=ACTION)
    add_title(c, SHOWN, title="Seen It", vec=ACTION, cast=(COMMON_PERSON,))
    add_title(c, FRANCHISE, title="Emerald Heist: Part Two", vec=ACTION)
    add_title(c, LOW_VOTE, title="Obscure Gem", vec=ACTION, vote_count=5,
              cast=(COMMON_PERSON,))
    add_title(c, UNRELEASED, title="Coming Soon", vec=ACTION,
              release_date="2030-01-01", status="In Production",
              cast=(COMMON_PERSON,))
    # Equal mid-similarity content for the IDF pair: only the shared person differs.
    cast_pair_vec = axis_vec({0: 0.6, 4: 0.4})
    add_title(c, CAST_RARE, title="Quiet Partner", vec=cast_pair_vec, cast=(RARE_PERSON,))
    add_title(c, CAST_COMMON, title="Familiar Face", vec=cast_pair_vec, cast=(COMMON_PERSON,))

    c.executemany(
        "INSERT INTO library_items(kind, tmdb_id, source, added_at) VALUES ('movie', ?, 'radarr', datetime('now'))",
        [(LIB_A1,), (LIB_A2,)],
    )
    c.execute(
        "INSERT INTO household_rejections VALUES ('movie', ?, datetime('now'))", (VETOED,)
    )
    c.executemany(
        "INSERT INTO user_feedback VALUES (?, 'movie', ?, ?, datetime('now'))",
        [(SUB, DISLIKED, "dislike")],
    )
    c.execute(
        "INSERT INTO recently_shown VALUES (?, 'movie', ?, datetime('now'))", (SUB, SHOWN)
    )
    yield c
    c.close()


def _ctx(conn, **overrides):
    req = ScoreRequest(sub=SUB, kind="movie", **overrides)
    return load_user_context(conn, req)


# =========================================================================
# retrieval.retrieve_candidates
# =========================================================================


def _retrieved_ids(conn, ctx, *, pool_size=50, min_votes=50):
    batch = retrieve_candidates(
        conn, kind="movie", query_vec=ctx.positive_centroid(), user=ctx,
        pool_size=pool_size, min_vote_count=min_votes,
    )
    return [c.title.tmdb_id for c in batch.candidates], batch


def test_retrieval_anti_join_excludes_all_signal_classes(conn) -> None:
    ids, _ = _retrieved_ids(conn, _ctx(conn))
    assert LIB_A1 not in ids and LIB_A2 not in ids, "library items must not be re-suggested"
    assert VETOED not in ids, "household veto is permanent — it must never be retrieved"
    assert DISLIKED not in ids
    assert SHOWN not in ids
    assert CAND_NEAR in ids and CAND_FAR in ids


def test_retrieval_gates_vote_count_and_availability(conn) -> None:
    ids, _ = _retrieved_ids(conn, _ctx(conn))
    assert LOW_VOTE not in ids, "below min_vote_count"
    assert UNRELEASED not in ids, "future release_date must not be recommended"
    ids_lenient, _ = _retrieved_ids(conn, _ctx(conn), min_votes=0)
    assert LOW_VOTE in ids_lenient


def test_retrieval_drops_franchise_title_key_collision(conn) -> None:
    # "Emerald Heist: Part Two" shares the base key with library title
    # "Emerald Heist" — the retrieval-level dedupe treats it as already owned.
    assert title_key_variants("Emerald Heist: Part Two") & title_key_variants("Emerald Heist")
    ids, _ = _retrieved_ids(conn, _ctx(conn))
    assert FRANCHISE not in ids


def test_retrieval_preserves_distance_order_and_pool_size(conn) -> None:
    ctx = _ctx(conn)
    ids, batch = _retrieved_ids(conn, ctx)
    assert batch.distances == sorted(batch.distances), (
        "the IN(...) re-fetch must not scramble KNN distance order"
    )
    # Action-cluster candidate must be closer to the action library than comedy.
    assert ids.index(CAND_NEAR) < ids.index(CAND_FAR)

    ids_small, _ = _retrieved_ids(conn, ctx, pool_size=2)
    assert len(ids_small) == 2
    assert ids_small == ids[:2], "pool_size truncation must keep the closest candidates"


def test_retrieval_clamps_knn_k_to_sqlite_vec_limit(conn) -> None:
    # sqlite-vec hard-caps a KNN query's k at 4096; retrieve_candidates over-
    # fetches by ~(pool_size + len(excluded)), and the household's excluded set
    # (library + permanent rejections + recently-shown + dislikes) grows without
    # bound. Once it crossed 4096, sqlite-vec raised "k value in knn query too
    # large" and EVERY /score 500'd. A large excluded set must clamp k and still
    # return real candidates — never throw.
    ctx = _ctx(conn)
    ctx.rejected_ids.update(range(500_000, 504_200))  # > 4096 exclusions, in place
    assert len(ctx.rejected_ids) > 4096
    ids, _ = _retrieved_ids(conn, ctx)  # must not raise sqlite3.OperationalError
    assert CAND_NEAR in ids, "real candidates still returned after k is clamped"


def test_bounded_exclusions_trims_soft_recently_shown_to_fit_knn() -> None:
    # Regression for the "recommender catching its breath" empty strip: a heavy
    # household's recently_shown grew past the point where library + dislikes +
    # rejects + recently_shown exceeded the sqlite-vec KNN cap, so the anti-join
    # left nothing. recently_shown is SOFT and must be trimmed; the must-not-show
    # HARD set (library / disliked / rejected) is always preserved.
    from types import SimpleNamespace
    from app.retrieval import bounded_exclusions, VEC_KNN_MAX_K

    hard_lib = set(range(0, 858))
    hard_dis = set(range(10_000, 10_751))
    hard_rej = set(range(20_000, 20_050))
    shown_order = list(range(100_000, 103_768))  # ts-DESC: most-recent first
    user = SimpleNamespace(
        library_ids=hard_lib,
        disliked_ids=hard_dis,
        rejected_ids=hard_rej,
        recently_shown_ids=set(shown_order),  # 3768 soft, the bloat
        recently_shown_order=shown_order,
    )
    pool_size = 500
    excluded = bounded_exclusions(user, pool_size)
    hard = hard_lib | hard_dis | hard_rej

    assert hard <= excluded, "hard exclusions (owned/disliked/rejected) must never be dropped"
    # Bounded so the clamped KNN (<= VEC_KNN_MAX_K) keeps pool_size headroom.
    assert len(excluded) <= VEC_KNN_MAX_K - max(pool_size, 200)
    # The soft set WAS trimmed (not all 3768 recently-shown survived).
    assert len(excluded) < len(hard) + len(user.recently_shown_ids)
    # ...but far more than the old pool_size*3 reserve allowed: a heavy household
    # must retain enough recent exclusions to actually rotate off repeats.
    kept_soft = len(excluded) - len(hard)
    assert kept_soft > 1000, "heavy household kept too few soft exclusions to rotate"
    # Recency-aware: the titles kept are the MOST-RECENTLY shown (front of the
    # ts-DESC order), never an arbitrary slice that could re-show recent repeats.
    assert set(shown_order[:kept_soft]) <= excluded


def test_bounded_exclusions_keeps_most_recent_soft_when_trimming() -> None:
    # When the soft set must be trimmed, the survivors are the most-recently
    # shown (front of recently_shown_order), so a just-seen title is suppressed
    # while an ancient one may recur — the "recommender only repeats itself" fix.
    from types import SimpleNamespace
    from app.retrieval import bounded_exclusions, VEC_KNN_MAX_K

    # reserve == max(pool_size, 200) == 200, so keep_soft == 4096 - 200 - len(hard);
    # size hard to leave exactly 5 soft slots.
    hard = set(range(0, VEC_KNN_MAX_K - 200 - 5))  # leaves keep_soft == 5
    recent = [900_001, 900_002, 900_003, 900_004, 900_005]
    old = list(range(800_000, 800_050))
    order = recent + old  # most-recent first
    user = SimpleNamespace(
        library_ids=hard,
        disliked_ids=set(),
        rejected_ids=set(),
        recently_shown_ids=set(order),
        recently_shown_order=order,
    )
    excluded = bounded_exclusions(user, pool_size=1)
    kept = excluded - hard
    assert kept == set(recent), "must keep the 5 most-recently-shown, drop the old"


def test_bounded_exclusions_keeps_everything_when_it_already_fits() -> None:
    # Light household: nothing is trimmed — recently_shown still suppresses repeats.
    from types import SimpleNamespace
    from app.retrieval import bounded_exclusions

    user = SimpleNamespace(
        library_ids={1, 2, 3},
        disliked_ids={4},
        rejected_ids={5},
        recently_shown_ids={6, 7, 8},
    )
    assert bounded_exclusions(user, pool_size=50) == {1, 2, 3, 4, 5, 6, 7, 8}


def test_cold_start_pool_orders_by_popularity_and_excludes(conn) -> None:
    conn.execute("UPDATE titles SET popularity = 99 WHERE tmdb_id = ?", (CAND_FAR,))
    ctx = _ctx(conn)
    rows = cold_start_pool(conn, kind="movie", user=ctx, pool_size=10, min_vote_count=50)
    ids = [r.tmdb_id for r in rows]
    assert ids[0] == CAND_FAR, "cold-start pool is popularity-ordered"
    assert VETOED not in ids and LIB_A1 not in ids and DISLIKED not in ids


# =========================================================================
# context.load_user_context — precedence matrix
# =========================================================================


def test_stored_feedback_used_when_no_inline(conn) -> None:
    conn.execute(
        "INSERT INTO user_feedback VALUES (?, 'movie', ?, 'like', datetime('now'))",
        (SUB, CAND_NEAR2),
    )
    ctx = _ctx(conn)  # feedback omitted -> stored rows are the source
    assert CAND_NEAR2 in ctx.liked_ids
    assert DISLIKED in ctx.disliked_ids


def test_inline_feedback_is_authoritative_over_stored_dots(conn) -> None:
    # Stored mirror still carries a dislike + a like; the inline empty list
    # says "all dots cleared" — stale mirrored rows must not resurrect them.
    conn.execute(
        "INSERT INTO user_feedback VALUES (?, 'movie', ?, 'like', datetime('now'))",
        (SUB, CAND_NEAR2),
    )
    ctx = _ctx(conn, feedback=[])
    assert ctx.disliked_ids == set(), "inline [] must clear the stored dislike"
    assert CAND_NEAR2 not in ctx.liked_ids, "stored 'like' dot must not survive inline []"


def test_stored_engagement_merges_into_inline_positives(conn) -> None:
    # Engagement signals live only in this sidecar, so they merge into the
    # inline branch — unless the inline payload explicitly negates the title.
    conn.execute(
        "INSERT INTO user_feedback VALUES (?, 'movie', ?, 'watched', datetime('now'))",
        (SUB, CAND_NEAR),
    )
    ctx = _ctx(conn, feedback=[])
    assert CAND_NEAR in ctx.liked_ids, "stored watched signal must merge in"

    ctx2 = _ctx(conn, feedback=[{"tmdb_id": CAND_NEAR, "signal": "dislike"}])
    assert CAND_NEAR in ctx2.disliked_ids
    assert CAND_NEAR not in ctx2.liked_ids, "explicit inline dislike beats stored engagement"


def test_inline_household_rejections_are_authoritative(conn) -> None:
    # Stored veto on VETOED; inline list replaces it entirely.
    ctx = _ctx(conn, household_rejections=[CAND_FAR])
    assert CAND_FAR in ctx.rejected_ids
    assert VETOED not in ctx.rejected_ids, "inline rejections replace stored ones"
    # Per-user reject feedback still unions in on top of the inline list.
    ctx2 = _ctx(
        conn,
        household_rejections=[CAND_FAR],
        feedback=[{"tmdb_id": CAND_NEAR2, "signal": "reject"}],
    )
    assert {CAND_FAR, CAND_NEAR2} <= ctx2.rejected_ids


def test_inline_library_overrides_stored(conn) -> None:
    ctx = _ctx(conn, library=[{"tmdb_id": CAND_FAR, "title": "Giggle Factory"}])
    assert ctx.library_ids == {CAND_FAR}
    assert ctx.library_embedding_ids == [CAND_FAR]
    # Stored path: both library_items rows.
    assert _ctx(conn).library_ids == {LIB_A1, LIB_A2}


def test_cold_start_routing_below_threshold(conn) -> None:
    ctx = _ctx(conn, library=[], feedback=[], household_rejections=[])
    version, recipe, params = select_model_config_for_context(conn, ctx)
    assert (version, recipe, params) == ("cold-start", "cold_start_trending", {})


# =========================================================================
# recipes/fused
# =========================================================================


def test_fused_veto_never_surfaces_even_as_best_match(conn) -> None:
    # VETOED is geometrically the single closest title to the library centroid
    # — if the veto plumbing breaks anywhere, it ranks #1. It must not appear.
    ctx = _ctx(conn)
    result = fused.score(ctx, conn, n=10, params={})
    ids = [it.tmdb_id for it in result.items]
    assert ids, "fused must return items for a warm library"
    assert VETOED not in ids
    assert DISLIKED not in ids and SHOWN not in ids and LIB_A1 not in ids


def test_fused_prefers_similar_cluster(conn) -> None:
    ctx = _ctx(conn)
    result = fused.score(ctx, conn, n=10, params={})
    ids = [it.tmdb_id for it in result.items]
    assert ids.index(CAND_NEAR) < ids.index(CAND_FAR)


def test_fused_idf_direction_rare_person_outranks_common(conn) -> None:
    # CAST_RARE and CAST_COMMON have IDENTICAL content embeddings and equal
    # popularity; they differ only in which LIB_A1 cast member they share.
    # IDF must weight the rare co-star above the ubiquitous one.
    ctx = _ctx(conn)
    result = fused.score(ctx, conn, n=13, params={})
    ids = [it.tmdb_id for it in result.items]
    assert CAST_RARE in ids and CAST_COMMON in ids
    assert ids.index(CAST_RARE) < ids.index(CAST_COMMON)
    scores = {it.tmdb_id: it.score for it in result.items}
    assert scores[CAST_RARE] > scores[CAST_COMMON]


def test_fused_cast_weight_direction(conn) -> None:
    # With the cast block disabled the IDF pair ties on content; enabling it
    # must strictly raise the cast-sharing pair's scores. Guards against the
    # historical fusion-weight-inversion failure mode.
    ctx = _ctx(conn)
    no_cast = {it.tmdb_id: it.score for it in
               fused.score(ctx, conn, n=13, params={"cast_weight": 0.0, "crew_weight": 0.0}).items}
    with_cast = {it.tmdb_id: it.score for it in
                 fused.score(ctx, conn, n=13, params={"cast_weight": 0.7, "crew_weight": 0.0}).items}
    assert no_cast[CAST_RARE] == pytest.approx(no_cast[CAST_COMMON]), (
        "content-only scores must tie for identical embeddings"
    )
    assert with_cast[CAST_RARE] > no_cast[CAST_RARE], "cast weight must ADD signal, not subtract"


def test_fused_cast_topn_param_is_wired(conn) -> None:
    # cast_topn is an optimizer-tunable param: score() must read it from
    # params, not from the module DEFAULTS. LIB_A1 carries COMMON_PERSON at
    # order_idx=1, so with cast_topn=1 (only order_idx < 1 counts) the library
    # side of the COMMON overlap disappears and CAST_COMMON loses its cast
    # bonus, while CAST_RARE (RARE_PERSON at order_idx=0 on both sides) keeps
    # its boost. With the default cast_topn=10 both pairs overlap.
    ctx = _ctx(conn)
    default = {it.tmdb_id: it.score for it in
               fused.score(ctx, conn, n=13, params={}).items}
    topn1 = {it.tmdb_id: it.score for it in
             fused.score(ctx, conn, n=13, params={"cast_topn": 1}).items}
    assert topn1[CAST_COMMON] < default[CAST_COMMON], (
        "cast_topn=1 must drop the order_idx=1 library cast overlap; "
        "if this ties, score() is still reading DEFAULTS instead of params"
    )
    # CAST_RARE keeps its overlap (order_idx=0 on both sides); with the library
    # cast vector shrunk to just the rare person its normalized weight can only
    # grow, so the rare/common gap must widen.
    assert topn1[CAST_RARE] >= default[CAST_RARE]
    assert (topn1[CAST_RARE] - topn1[CAST_COMMON]) > (
        default[CAST_RARE] - default[CAST_COMMON]
    )
    # The IDF cache must key on cast_topn — otherwise the second call would
    # silently reuse df counts computed for a different cutoff.
    assert ("movie", "cast", 1) in fused._IDF and ("movie", "cast", 10) in fused._IDF


def test_fused_cold_start_fallback(conn) -> None:
    ctx = _ctx(conn, library=[], feedback=[], household_rejections=[])
    result = fused.score(ctx, conn, n=5, params={})
    assert result.diag["path"] == "cold_start"
    assert result.items, "cold start must still produce a strip"
    assert all(it.provenance == "trending" for it in result.items)
    pops = [it.score for it in result.items]
    assert pops == sorted(pops, reverse=True), "cold start is popularity-ordered"


# =========================================================================
# recipes/mmr_diverse
# =========================================================================


def _cand(vec: np.ndarray):
    from app.context import Candidate, TitleRow

    return Candidate(
        title=TitleRow(tmdb_id=0, kind="movie", title="x", year=None, poster_path=None,
                       overview=None, popularity=0.0, vote_average=None, genre_ids=()),
        embedding=vec,
    )


def test_mmr_selection_diversifies_vs_pure_relevance() -> None:
    near_dupes = [axis_vec({0: 1.0}), axis_vec({0: 0.999, 3: 0.001}), axis_vec({0: 0.998, 3: 0.002})]
    different = axis_vec({1: 1.0})
    cands = [_cand(v) for v in [*near_dupes, different]]
    relevance = [0.99, 0.98, 0.97, 0.60]

    pure = _mmr(cands, relevance, lam=1.0, n=3)
    assert pure == [0, 1, 2], "lambda=1.0 must reduce to pure relevance order"

    diverse = _mmr(cands, relevance, lam=0.5, n=3)
    assert 3 in diverse, "MMR must pull in the different item over the third near-duplicate"
    assert diverse[0] == 0, "the most relevant item is always selected first"


def test_mmr_recipe_end_to_end_diversity_and_exclusions(conn) -> None:
    ctx = _ctx(conn)
    result = mmr_diverse.score(ctx, conn, n=3, params={"mmr_lambda": 0.5, "min_vote_count": 50})
    ids = [it.tmdb_id for it in result.items]
    assert VETOED not in ids and DISLIKED not in ids and SHOWN not in ids
    # Action library + many action candidates: a 0.5 lambda must surface the
    # comedy outlier within the top 3 instead of three action near-duplicates.
    assert CAND_FAR in ids


# =========================================================================
# recipes/baseline_cosine
# =========================================================================


def test_baseline_cosine_orders_by_similarity_and_excludes(conn) -> None:
    ctx = _ctx(conn)
    result = baseline_cosine.score(ctx, conn, n=10, params={})
    ids = [it.tmdb_id for it in result.items]
    assert VETOED not in ids and DISLIKED not in ids
    assert ids.index(CAND_NEAR) < ids.index(CAND_FAR)
    scores = [it.score for it in result.items]
    assert scores == sorted(scores, reverse=True)


def test_baseline_cosine_negative_centroid_pushes_disliked_cluster_away(conn) -> None:
    # Disliking the comedy title must lower the comedy candidate's score
    # relative to a context with no dislikes (the negative-weight subtraction).
    ctx_neutral = _ctx(conn, feedback=[])
    ctx_anti_comedy = _ctx(conn, feedback=[{"tmdb_id": CAND_FAR, "signal": "dislike"}])
    # Score a fresh comedy probe (CAND_FAR itself is excluded once disliked).
    add_title(conn, 777, title="Chuckle Town", vec=axis_vec({1: 0.98, 5: 0.02}), genres=(35,))
    neutral = {it.tmdb_id: it.score for it in baseline_cosine.score(ctx_neutral, conn, n=13, params={}).items}
    anti = {it.tmdb_id: it.score for it in baseline_cosine.score(ctx_anti_comedy, conn, n=13, params={}).items}
    assert 777 in neutral and 777 in anti
    assert anti[777] < neutral[777]


# =========================================================================
# recipes/item_knn
# =========================================================================


def test_item_knn_full_mode_max_sim_and_exclusions(conn) -> None:
    ctx = _ctx(conn)
    result = item_knn.score(ctx, conn, n=10, params={})
    ids = [it.tmdb_id for it in result.items]
    assert result.diag["path"] == "item_knn_full"
    assert VETOED not in ids and DISLIKED not in ids and SHOWN not in ids
    assert LIB_A1 not in ids and LIB_A2 not in ids
    assert FRANCHISE not in ids, "library title-key collision must be filtered"
    assert ids.index(CAND_NEAR) < ids.index(CAND_FAR)


def test_item_knn_ann_mode_matches_exclusion_contract(conn) -> None:
    ctx = _ctx(conn)
    result = item_knn.score(ctx, conn, n=10, params={"candidate_pool": "ann", "pool_size": 50})
    ids = [it.tmdb_id for it in result.items]
    assert result.diag["path"] == "item_knn_ann"
    assert VETOED not in ids and LIB_A1 not in ids


# =========================================================================
# recipes/cold_start_trending
# =========================================================================


def test_cold_start_trending_recipe(conn) -> None:
    ctx = _ctx(conn, library=[], feedback=[], household_rejections=[])
    result = cold_start_trending.score(ctx, conn, n=5, params={})
    ids = [it.tmdb_id for it in result.items]
    assert ids, "trending fallback must not be empty"
    assert all(it.provenance == "trending" for it in result.items)
    # Inline empty rejections are authoritative: the stored veto does not apply
    # here, but the cold-start pool still honors the context's exclusions.
    ctx_with_veto = _ctx(conn, library=[], feedback=[])
    ids2 = [it.tmdb_id for it in cold_start_trending.score(ctx_with_veto, conn, n=20, params={"min_vote_count": 0}).items]
    assert VETOED not in ids2
