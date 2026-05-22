"""Candidate retrieval via sqlite-vec KNN.

Given a query vector (the user's positive centroid, optionally with a
negative-centroid penalty applied), pull the top-N nearest titles of the
requested kind, anti-joined against library / rejections / recently-shown.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

import numpy as np

from .context import Candidate, TitleRow, UserContext
from .db import deserialize_f32, serialize_f32
from .schemas import Kind


@dataclass
class CandidateBatch:
    candidates: list[Candidate]
    distances: list[float]
    diag: dict[str, object]


def retrieve_candidates(
    conn: sqlite3.Connection,
    *,
    kind: Kind,
    query_vec: np.ndarray,
    user: UserContext,
    pool_size: int,
    min_vote_count: int,
) -> CandidateBatch:
    """Return the top-N nearest titles after applying household-safe filters.

    sqlite-vec's MATCH operator needs a ``k`` parameter — we over-fetch by
    ~3x the requested pool size to leave room for the anti-join drops.
    """
    excluded = user.library_ids | user.rejected_ids | user.recently_shown_ids | user.disliked_ids
    overfetch = max(pool_size * 3, pool_size + len(excluded), 200)

    rows = conn.execute(
        """SELECT v.rowid AS tmdb_id, v.distance AS distance
           FROM title_vec v
           WHERE v.kind = ? AND v.embedding MATCH ? AND k = ?
           ORDER BY v.distance""",
        (kind, serialize_f32(query_vec), overfetch),
    ).fetchall()

    if not rows:
        return CandidateBatch(candidates=[], distances=[], diag={"raw": 0, "kept": 0})

    keep_ids = [r["tmdb_id"] for r in rows if r["tmdb_id"] not in excluded]
    keep_distances = {r["tmdb_id"]: r["distance"] for r in rows}

    if not keep_ids:
        return CandidateBatch(candidates=[], distances=[], diag={"raw": len(rows), "kept": 0})

    placeholders = ",".join("?" for _ in keep_ids)
    title_rows = conn.execute(
        f"""SELECT t.tmdb_id, t.kind, t.title, t.year, t.poster_path, t.overview,
                  COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                  COALESCE(t.vote_count, 0) AS vote_count,
                  (SELECT GROUP_CONCAT(g.genre_id) FROM title_genres g
                   WHERE g.kind = t.kind AND g.tmdb_id = t.tmdb_id) AS genres,
                  f.embedding AS embedding, f.dim AS dim
           FROM titles t
           JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
           WHERE t.kind = ?
             AND t.tmdb_id IN ({placeholders})
             AND COALESCE(t.vote_count, 0) >= ?""",
        (kind, *keep_ids, min_vote_count),
    ).fetchall()

    candidates: list[Candidate] = []
    distances: list[float] = []
    for r in title_rows:
        gids = tuple(int(g) for g in r["genres"].split(",")) if r["genres"] else ()
        title = TitleRow(
            tmdb_id=r["tmdb_id"],
            kind=kind,
            title=r["title"],
            year=r["year"],
            poster_path=r["poster_path"],
            overview=r["overview"],
            popularity=r["popularity"] or 0.0,
            vote_average=r["vote_average"],
            genre_ids=gids,
        )
        emb = deserialize_f32(r["embedding"], dim=r["dim"])
        candidates.append(Candidate(title=title, embedding=emb))
        distances.append(float(keep_distances[r["tmdb_id"]]))
        if len(candidates) >= pool_size:
            break

    return CandidateBatch(
        candidates=candidates,
        distances=distances,
        diag={"raw": len(rows), "kept": len(candidates), "excluded": len(excluded)},
    )


def cold_start_pool(
    conn: sqlite3.Connection,
    *,
    kind: Kind,
    user: UserContext,
    pool_size: int,
    min_vote_count: int,
) -> list[TitleRow]:
    """Popularity-ordered pool when we have no taste signal yet."""
    excluded = user.library_ids | user.rejected_ids | user.recently_shown_ids | user.disliked_ids
    rows = conn.execute(
        """SELECT t.tmdb_id, t.title, t.year, t.poster_path, t.overview,
                  COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                  (SELECT GROUP_CONCAT(g.genre_id) FROM title_genres g
                   WHERE g.kind = t.kind AND g.tmdb_id = t.tmdb_id) AS genres
           FROM titles t
           WHERE t.kind = ? AND COALESCE(t.vote_count, 0) >= ?
           ORDER BY popularity DESC
           LIMIT ?""",
        (kind, min_vote_count, pool_size * 3),
    ).fetchall()

    out: list[TitleRow] = []
    for r in rows:
        if r["tmdb_id"] in excluded:
            continue
        gids = tuple(int(g) for g in r["genres"].split(",")) if r["genres"] else ()
        out.append(
            TitleRow(
                tmdb_id=r["tmdb_id"],
                kind=kind,
                title=r["title"],
                year=r["year"],
                poster_path=r["poster_path"],
                overview=r["overview"],
                popularity=r["popularity"] or 0.0,
                vote_average=r["vote_average"],
                genre_ids=gids,
            )
        )
        if len(out) >= pool_size:
            break
    return out
