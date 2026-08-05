"""`neighbors_for` must never cite the same title twice.

`load_user_context` folds watched/clicked/added into ``liked_ids`` while the
same tmdb_id is usually already in ``library_ids``, so a watched-and-liked
title lands in BOTH embedding-aligned id lists. `neighbors_for` builds one
flat pool from both, so without a dedupe guard both rows of that one title
can win the top-k argsort and the UI pill renders "matches Severance,
Severance" instead of two distinct neighbors.
"""

from __future__ import annotations

import numpy as np

from app.context import Candidate, TitleRow, UserContext
from app.reasons import neighbors_for, personalized_reason


def _title(tmdb_id: int, title: str) -> TitleRow:
    return TitleRow(
        tmdb_id=tmdb_id,
        kind="tv",
        title=title,
        year=2022,
        poster_path=None,
        overview=None,
        popularity=1.0,
        vote_average=8.0,
        genre_ids=(18,),
    )


def _ctx(
    *,
    library: list[tuple[TitleRow, list[float]]],
    liked: list[tuple[TitleRow, list[float]]],
) -> UserContext:
    """Minimal UserContext carrying only what `neighbors_for` reads."""

    def split(rows):
        if not rows:
            return {}, [], None
        titles = {t.tmdb_id: t for t, _ in rows}
        ids = [t.tmdb_id for t, _ in rows]
        embs = np.vstack([np.array(v, dtype=np.float32) for _, v in rows])
        return titles, ids, embs

    lib_titles, lib_ids, lib_embs = split(library)
    liked_titles, liked_ids, liked_embs = split(liked)
    return UserContext(
        sub="u1",
        kind="tv",
        library_ids=set(lib_ids),
        library_title_keys=set(),
        library_embeddings=lib_embs,
        library_embedding_ids=lib_ids,
        library_titles=lib_titles,
        liked_ids=set(liked_ids),
        liked_titles=liked_titles,
        liked_embeddings=liked_embs,
        liked_embedding_ids=liked_ids,
        disliked_ids=set(),
        disliked_embeddings=None,
        disliked_embedding_ids=[],
        rejected_ids=set(),
        recently_shown_ids=set(),
    )


def _candidate() -> Candidate:
    return Candidate(
        title=_title(999, "Candidate Show"),
        embedding=np.array([1.0, 0.0, 0.0], dtype=np.float32),
    )


def test_watched_and_liked_title_is_cited_once() -> None:
    """A title in BOTH pools must not occupy two top-k slots."""
    severance = _title(100, "Severance")
    andor = _title(200, "Andor")
    ctx = _ctx(
        # Both near-duplicate rows of Severance out-score Andor, so a pool
        # without dedupe returns [100, 100] and starves the real runner-up.
        library=[(severance, [1.0, 0.02, 0.0]), (andor, [0.9, 0.3, 0.0])],
        liked=[(severance, [1.0, 0.01, 0.0])],
    )

    result = neighbors_for(_candidate(), ctx, k=2)

    assert len({t.tmdb_id for t in result}) == len(result)
    assert [t.tmdb_id for t in result] == [100, 200]


def test_personalized_reason_cites_two_distinct_titles() -> None:
    """The rendered pill is the user-visible symptom — no 'X, X'."""
    ctx = _ctx(
        library=[
            (_title(100, "Severance"), [1.0, 0.02, 0.0]),
            (_title(200, "Andor"), [0.9, 0.3, 0.0]),
        ],
        liked=[(_title(100, "Severance"), [1.0, 0.01, 0.0])],
    )

    cand = _candidate()
    reason = personalized_reason(cand, neighbors_for(cand, ctx, k=2))

    parts = reason.removeprefix("matches ").split(", ")
    assert len(parts) == 2
    assert parts[0] != parts[1]
    assert reason == "matches Severance, Andor"


def test_liked_only_title_is_still_eligible() -> None:
    """The dedupe guard must skip repeats, not drop the liked-only pool."""
    ctx = _ctx(
        library=[(_title(100, "Severance"), [1.0, 0.02, 0.0])],
        liked=[
            (_title(100, "Severance"), [1.0, 0.01, 0.0]),
            (_title(300, "Silo"), [0.95, 0.2, 0.0]),
        ],
    )

    result = neighbors_for(_candidate(), ctx, k=2)

    assert [t.tmdb_id for t in result] == [100, 300]
