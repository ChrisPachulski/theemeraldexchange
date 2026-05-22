"""User and candidate context construction.

The /score endpoint hands the active recipe a fully-loaded ``UserContext``
(library, likes, dislikes, rejections, recently-shown) plus access to the
sqlite-vec store. This module is the only place that touches SQLite for
context loading; recipes stay pure-functional over the data we hand them.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np

from .db import deserialize_f32
from .schemas import Kind, ScoreRequest

log = logging.getLogger(__name__)


@dataclass
class TitleRow:
    tmdb_id: int
    kind: Kind
    title: str
    year: int | None
    poster_path: str | None
    overview: str | None
    popularity: float
    vote_average: float | None
    genre_ids: tuple[int, ...]


@dataclass
class Candidate:
    title: TitleRow
    embedding: np.ndarray


@dataclass
class UserContext:
    sub: str
    kind: Kind
    library_ids: set[int]
    library_embeddings: np.ndarray | None  # shape (n_lib, dim) or None
    library_titles: dict[int, TitleRow]
    liked_ids: set[int]
    liked_embeddings: np.ndarray | None
    disliked_ids: set[int]
    disliked_embeddings: np.ndarray | None
    rejected_ids: set[int]
    recently_shown_ids: set[int]
    diag: dict[str, object] = field(default_factory=dict)

    @property
    def has_taste_signal(self) -> bool:
        return self.library_embeddings is not None or self.liked_embeddings is not None

    def positive_centroid(self) -> np.ndarray | None:
        """Mean of library + likes embeddings. None if neither present."""
        chunks = [c for c in (self.library_embeddings, self.liked_embeddings) if c is not None]
        if not chunks:
            return None
        stacked = np.concatenate(chunks, axis=0)
        centroid = stacked.mean(axis=0)
        norm = np.linalg.norm(centroid)
        return centroid / norm if norm > 0 else centroid

    def negative_centroid(self) -> np.ndarray | None:
        if self.disliked_embeddings is None:
            return None
        centroid = self.disliked_embeddings.mean(axis=0)
        norm = np.linalg.norm(centroid)
        return centroid / norm if norm > 0 else centroid


def _embedding_for(conn: sqlite3.Connection, kind: Kind, tmdb_id: int) -> np.ndarray | None:
    row = conn.execute(
        "SELECT embedding, dim FROM title_features WHERE kind = ? AND tmdb_id = ?",
        (kind, tmdb_id),
    ).fetchone()
    if row is None:
        return None
    return deserialize_f32(row["embedding"], dim=row["dim"])


def _load_title_rows(conn: sqlite3.Connection, kind: Kind, ids: list[int]) -> dict[int, TitleRow]:
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""SELECT t.tmdb_id, t.kind, t.title, t.year, t.poster_path, t.overview,
                  COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                  (SELECT GROUP_CONCAT(g.genre_id) FROM title_genres g
                   WHERE g.kind = t.kind AND g.tmdb_id = t.tmdb_id) AS genres
           FROM titles t
           WHERE t.kind = ? AND t.tmdb_id IN ({placeholders})""",
        (kind, *ids),
    ).fetchall()
    out: dict[int, TitleRow] = {}
    for r in rows:
        gids = (
            tuple(int(g) for g in r["genres"].split(",")) if r["genres"] else ()
        )
        out[r["tmdb_id"]] = TitleRow(
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
    return out


def _stack_embeddings(conn: sqlite3.Connection, kind: Kind, ids: set[int]) -> np.ndarray | None:
    vecs = []
    for tid in ids:
        v = _embedding_for(conn, kind, tid)
        if v is not None:
            vecs.append(v)
    if not vecs:
        return None
    return np.vstack(vecs)


def load_user_context(conn: sqlite3.Connection, req: ScoreRequest) -> UserContext:
    """Build a UserContext for this scoring request.

    Source-of-truth rules:
      * library + household_rejections: prefer the request body when provided
        (Hono is the canonical owner of Sonarr/Radarr state). Fall back to
        the recommender's library_items / household_rejections tables.
      * per-user feedback + recently_shown: always from the recommender DB,
        since the recommender owns those tables.
    """
    kind = req.kind

    # ----- library
    if req.library is not None:
        library_ids = {item.tmdb_id for item in req.library}
        # Optionally upsert into library_items so the recommender's DB stays
        # warm even if the next call comes without an explicit library payload.
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for item in req.library:
            conn.execute(
                """INSERT INTO library_items(kind, tmdb_id, source, added_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(kind, tmdb_id) DO UPDATE SET
                     source = excluded.source""",
                (kind, item.tmdb_id, item.source, now),
            )
    else:
        library_ids = {
            r["tmdb_id"]
            for r in conn.execute(
                "SELECT tmdb_id FROM library_items WHERE kind = ?", (kind,)
            ).fetchall()
        }

    library_titles = _load_title_rows(conn, kind, list(library_ids))
    library_embeddings = _stack_embeddings(conn, kind, library_ids)

    # ----- per-user signals
    fb_rows = conn.execute(
        """SELECT tmdb_id, signal FROM user_feedback
           WHERE sub = ? AND kind = ?""",
        (req.sub, kind),
    ).fetchall()

    inline_likes: set[int] = set()
    inline_dislikes: set[int] = set()
    inline_rejects: set[int] = set()
    if req.feedback is not None:
        for fb in req.feedback:
            (inline_likes if fb.signal == "like" else inline_dislikes if fb.signal == "dislike" else inline_rejects).add(
                fb.tmdb_id
            )

    liked_ids = inline_likes | {r["tmdb_id"] for r in fb_rows if r["signal"] == "like"}
    disliked_ids = inline_dislikes | {r["tmdb_id"] for r in fb_rows if r["signal"] == "dislike"}

    # ----- household rejections
    rejected_ids = (
        set(req.household_rejections)
        if req.household_rejections is not None
        else {r["tmdb_id"] for r in conn.execute(
            "SELECT tmdb_id FROM household_rejections WHERE kind = ?", (kind,)
        ).fetchall()}
    )
    rejected_ids |= inline_rejects
    rejected_ids |= {r["tmdb_id"] for r in fb_rows if r["signal"] == "reject"}

    liked_embeddings = _stack_embeddings(conn, kind, liked_ids)
    disliked_embeddings = _stack_embeddings(conn, kind, disliked_ids)

    # ----- recently shown
    recently_shown_ids: set[int] = set()
    if req.exclude_recently_shown:
        recently_shown_ids = {
            r["tmdb_id"]
            for r in conn.execute(
                """SELECT tmdb_id FROM recently_shown
                   WHERE sub = ? AND kind = ?
                   ORDER BY ts DESC LIMIT 200""",
                (req.sub, kind),
            ).fetchall()
        }

    return UserContext(
        sub=req.sub,
        kind=kind,
        library_ids=library_ids,
        library_embeddings=library_embeddings,
        library_titles=library_titles,
        liked_ids=liked_ids,
        liked_embeddings=liked_embeddings,
        disliked_ids=disliked_ids,
        disliked_embeddings=disliked_embeddings,
        rejected_ids=rejected_ids,
        recently_shown_ids=recently_shown_ids,
        diag={
            "library_count": len(library_ids),
            "liked_count": len(liked_ids),
            "disliked_count": len(disliked_ids),
            "rejected_count": len(rejected_ids),
            "recently_shown_count": len(recently_shown_ids),
        },
    )


def get_active_model_config(conn: sqlite3.Connection) -> tuple[str, str, dict]:
    row = conn.execute(
        "SELECT version, recipe, params_json FROM model_config WHERE active = 1 LIMIT 1"
    ).fetchone()
    if row is None:
        # Implicit default — keeps the service usable before the first
        # optimizer run writes a row.
        from .config import CONFIG

        return ("v0", CONFIG.default_recipe, {})
    return (row["version"], row["recipe"], json.loads(row["params_json"]))
