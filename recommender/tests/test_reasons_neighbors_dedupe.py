"""Regression: a watched-and-liked title must not be cited twice.

`neighbors_for` builds one flat pool from library_embedding_ids THEN
liked_embedding_ids. A title present in both (watched AND explicitly liked
— the common case) used to occupy two pool rows with near-identical
embeddings, so both could win the top-k argsort and `personalized_reason`
rendered "matches Severance, Severance" instead of two distinct neighbors.
"""

from __future__ import annotations

import numpy as np

from app.context import Candidate, TitleRow, UserContext
from app.reasons import neighbors_for, personalized_reason

DIM = 8
BOTH_POOLS_ID = 101  # in library AND likes — the duplicate source
OTHER_ID = 202


def _vec(*, axis: int, tilt: float = 0.0) -> np.ndarray:
    v = np.zeros(DIM, dtype=np.float32)
    v[axis] = 1.0
    v[(axis + 1) % DIM] = tilt
    return v


def _title(tmdb_id: int, name: str) -> TitleRow:
    return TitleRow(
        tmdb_id=tmdb_id,
        kind="tv",
        title=name,
        year=2022,
        poster_path=None,
        overview=None,
        popularity=1.0,
        vote_average=8.0,
        genre_ids=(18,),
    )


def _ctx() -> UserContext:
    # Same id in both pools; the liked copy is a near-identical (re-embedded)
    # vector, exactly as production re-featurization produces.
    dup_lib = _vec(axis=0)
    dup_liked = _vec(axis=0, tilt=0.001)
    # A genuinely distinct neighbor, similar to the candidate but slightly
    # less so than the duplicate — so a buggy pool ranks dup, dup, other.
    other = _vec(axis=0, tilt=0.35)
    titles = {
        BOTH_POOLS_ID: _title(BOTH_POOLS_ID, "Severance"),
        OTHER_ID: _title(OTHER_ID, "Andor"),
    }
    return UserContext(
        sub="dedupe-test",
        kind="tv",
        library_ids={BOTH_POOLS_ID, OTHER_ID},
        library_title_keys=set(),
        library_embeddings=np.vstack([dup_lib, other]),
        library_embedding_ids=[BOTH_POOLS_ID, OTHER_ID],
        library_titles=dict(titles),
        liked_ids={BOTH_POOLS_ID},
        liked_titles={BOTH_POOLS_ID: titles[BOTH_POOLS_ID]},
        liked_embeddings=np.vstack([dup_liked]),
        liked_embedding_ids=[BOTH_POOLS_ID],
        disliked_ids=set(),
        disliked_embeddings=None,
        disliked_embedding_ids=[],
        rejected_ids=set(),
        recently_shown_ids=set(),
    )


def _cand() -> Candidate:
    return Candidate(title=_title(303, "Silo"), embedding=_vec(axis=0))


def test_neighbors_for_dedupes_title_in_both_pools() -> None:
    result = neighbors_for(_cand(), _ctx(), k=2)

    assert len(result) == 2
    assert len({t.tmdb_id for t in result}) == len(result)
    assert {t.tmdb_id for t in result} == {BOTH_POOLS_ID, OTHER_ID}


def test_personalized_reason_cites_two_distinct_titles() -> None:
    ctx = _ctx()
    cand = _cand()

    reason = personalized_reason(cand, neighbors_for(cand, ctx, k=2))

    assert reason.startswith("matches ")
    parts = [p.strip() for p in reason.removeprefix("matches ").split(",")]
    assert len(parts) == 2
    assert parts[0] != parts[1]


def test_dedupe_keeps_the_library_embedding() -> None:
    """Library loop runs first, so its vector is the one that survives."""
    ctx = _ctx()
    # Candidate aligned with the *liked* tilt: if the liked row had won the
    # dedupe the pool would contain the tilted copy. Ordering must still be
    # driven by the library row, and the id must appear exactly once.
    cand = Candidate(title=_title(303, "Silo"), embedding=_vec(axis=0, tilt=0.001))

    result = neighbors_for(cand, ctx, k=3)

    assert [t.tmdb_id for t in result] == [BOTH_POOLS_ID, OTHER_ID]


def test_no_duplicates_when_k_exceeds_distinct_titles() -> None:
    """k larger than the distinct pool must not pad with repeats."""
    result = neighbors_for(_cand(), _ctx(), k=5)

    assert len({t.tmdb_id for t in result}) == len(result) == 2
