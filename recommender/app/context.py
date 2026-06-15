"""User and candidate context construction.

The /score endpoint hands the active recipe a fully-loaded ``UserContext``
(library, likes, dislikes, rejections, recently-shown) plus access to the
sqlite-vec store. This module is the only place that touches SQLite for
context loading; recipes stay pure-functional over the data we hand them.
"""

from __future__ import annotations

import json
import logging
import math
import re
import sqlite3
from dataclasses import dataclass, field
from itertools import batched
from datetime import datetime, timezone

import numpy as np

from .db import GENRE_AGG_SQL, deserialize_f32, transaction
from .schemas import Kind, ScoreRequest

log = logging.getLogger(__name__)
IN_BATCH_SIZE = 500
RECENTLY_SHOWN_RETENTION_DAYS = 30
# "watched" is implicit feedback: the household actually played >=40% of (or
# completed) a title. It's the strongest positive intent we capture short of an
# explicit like, so it joins the engagement tier and feeds the positive
# centroid via load_user_context.
ENGAGEMENT_FEEDBACK_SIGNALS = {"clicked", "added", "watched"}
POSITIVE_FEEDBACK_SIGNALS = {"like", *ENGAGEMENT_FEEDBACK_SIGNALS}
MODEL_PARAM_BOUNDS: dict[str, tuple[float, float]] = {
    "pool_size": (1, 5000),
    "mmr_input_k": (1, 1000),
    "min_vote_count": (0, 100000),
    "negative_weight": (0.0, 5.0),
    "popularity_weight": (0.0, 5.0),
    "personalized_threshold": (-1.0, 1.0),
    "mmr_lambda": (0.0, 1.0),
}


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
    library_title_keys: set[str]
    library_embeddings: np.ndarray | None  # shape (n_lib, dim) or None
    # tmdb_ids aligned 1:1 with the rows of library_embeddings. Use this
    # for any matrix-vs-id zip — sorting library_ids and zipping
    # produces misalignment whenever some ids lack embeddings (the
    # matrix is shorter than the set in that case).
    library_embedding_ids: list[int]
    library_titles: dict[int, TitleRow]
    liked_ids: set[int]
    liked_titles: dict[int, TitleRow]
    liked_embeddings: np.ndarray | None
    liked_embedding_ids: list[int]
    disliked_ids: set[int]
    disliked_embeddings: np.ndarray | None
    disliked_embedding_ids: list[int]
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


def normalize_title_key(title: str | None) -> str | None:
    if not title:
        return None
    normalized = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
    return re.sub(r"\s+", " ", normalized) or None


def title_key_variants(title: str | None) -> set[str]:
    key = normalize_title_key(title)
    if key is None:
        return set()
    out = {key}
    for sep in (" - ", ": "):
        if sep in title:
            base = normalize_title_key(title.split(sep, 1)[0])
            if base:
                out.add(base)
    return out


def _load_title_rows(conn: sqlite3.Connection, kind: Kind, ids: list[int]) -> dict[int, TitleRow]:
    if not ids:
        return {}
    out: dict[int, TitleRow] = {}
    for batch in batched(sorted(set(ids)), IN_BATCH_SIZE):
        placeholders = ",".join("?" for _ in batch)
        rows = conn.execute(
            f"""SELECT t.tmdb_id, t.kind, t.title, t.year, t.poster_path, t.overview,
                      COALESCE(t.popularity, 0) AS popularity, t.vote_average,
                      {GENRE_AGG_SQL}
               FROM titles t
               WHERE t.kind = ? AND t.tmdb_id IN ({placeholders})""",
            (kind, *batch),
        ).fetchall()
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


def _load_embeddings(
    conn: sqlite3.Connection,
    kind: Kind,
    ids: set[int],
) -> dict[int, np.ndarray]:
    out: dict[int, np.ndarray] = {}
    ordered = sorted(ids)
    for batch in batched(ordered, IN_BATCH_SIZE):
        placeholders = ",".join("?" for _ in batch)
        rows = conn.execute(
            f"""SELECT tmdb_id, embedding, dim
                FROM title_features
                WHERE kind = ? AND tmdb_id IN ({placeholders})""",
            (kind, *batch),
        ).fetchall()
        for row in rows:
            out[row["tmdb_id"]] = deserialize_f32(row["embedding"], dim=row["dim"])
    return out


def _stack_embeddings(
    conn: sqlite3.Connection, kind: Kind, ids: set[int]
) -> tuple[np.ndarray, list[int]] | None:
    """Stack embeddings + return the id list aligned 1:1 to matrix rows.

    Iterates ``sorted(ids)`` for deterministic order, skipping ids
    without an embedding. The id list is the source of truth for which
    matrix row represents which title — callers MUST NOT independently
    sort ``ids`` and zip against the matrix, because skipped ids would
    misalign the zip from that point on (`reasons.neighbors_for` used
    to do exactly this and would cite the wrong neighbor).
    """
    vecs = []
    out_ids: list[int] = []
    embeddings = _load_embeddings(conn, kind, ids)
    for tid in sorted(ids):
        v = embeddings.get(tid)
        if v is not None:
            vecs.append(v)
            out_ids.append(tid)
    if not vecs:
        return None
    return np.vstack(vecs), out_ids


def load_user_context(
    conn: sqlite3.Connection,
    req: ScoreRequest,
    *,
    persist_library: bool = False,
) -> UserContext:
    """Build a UserContext for this scoring request.

    Source-of-truth rules:
      * library + household_rejections: prefer the request body when provided
        (Hono is the canonical owner of Sonarr/Radarr state). Fall back to
        the recommender's library_items / household_rejections tables.
      * per-user feedback + recently_shown: always from the recommender DB,
        since the recommender owns those tables.

    ``persist_library`` (default False): when True and a request library is
    supplied, the library is upserted into ``library_items`` so the DB
    stays warm for any later call that lands without an explicit library.
    Production score calls keep this False; /events/library/sync is the
    authoritative persistence path.
    """
    kind = req.kind

    # ----- library
    if req.library is not None:
        library_ids = {item.tmdb_id for item in req.library if item.tmdb_id is not None}
        library_title_keys = set().union(*(title_key_variants(item.title) for item in req.library))
        if persist_library:
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            with transaction(conn):
                conn.executemany(
                    """INSERT INTO library_items(kind, tmdb_id, source, added_at)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(kind, tmdb_id) DO UPDATE SET
                         source = COALESCE(excluded.source, library_items.source),
                         added_at = excluded.added_at""",
                    [
                        (kind, item.tmdb_id, item.source, now)
                        for item in req.library
                        if item.tmdb_id is not None
                    ],
                )
    else:
        library_ids = {
            r["tmdb_id"]
            for r in conn.execute(
                "SELECT tmdb_id FROM library_items WHERE kind = ?", (kind,)
            ).fetchall()
        }
        library_title_keys = set()

    library_titles = _load_title_rows(conn, kind, list(library_ids))
    for title in library_titles.values():
        library_title_keys.update(title_key_variants(title.title))
    lib_pair = _stack_embeddings(conn, kind, library_ids)
    library_embeddings, library_embedding_ids = (
        (lib_pair[0], lib_pair[1]) if lib_pair is not None else (None, [])
    )

    # ----- per-user signals
    # Hono is the source of truth for dot feedback. When req.feedback is
    # present, treat like/dislike/reject as authoritative so stale mirrored
    # rows cannot resurrect cleared dots. Engagement signals (clicked/added)
    # are recorded only in this sidecar, so merge those stored positives
    # into the inline branch without overriding explicit negative feedback.
    if req.feedback is not None:
        inline_likes: set[int] = set()
        inline_dislikes: set[int] = set()
        inline_rejects: set[int] = set()
        for fb in req.feedback:
            target = (
                inline_likes
                if fb.signal in POSITIVE_FEEDBACK_SIGNALS
                else inline_dislikes
                if fb.signal == "dislike"
                else inline_rejects
            )
            target.add(fb.tmdb_id)
        fb_rows = conn.execute(
            """SELECT tmdb_id, signal FROM user_feedback
               WHERE sub = ? AND kind = ?""",
            (req.sub, kind),
        ).fetchall()
        explicit_negatives = inline_dislikes | inline_rejects
        engagement_likes = {
            r["tmdb_id"]
            for r in fb_rows
            if r["signal"] in ENGAGEMENT_FEEDBACK_SIGNALS
            and r["tmdb_id"] not in explicit_negatives
        }
        liked_ids = inline_likes | engagement_likes
        disliked_ids = inline_dislikes
        reject_from_feedback = inline_rejects
    else:
        fb_rows = conn.execute(
            """SELECT tmdb_id, signal FROM user_feedback
               WHERE sub = ? AND kind = ?""",
            (req.sub, kind),
        ).fetchall()
        liked_ids = {
            r["tmdb_id"]
            for r in fb_rows
            if r["signal"] in POSITIVE_FEEDBACK_SIGNALS
        }
        disliked_ids = {r["tmdb_id"] for r in fb_rows if r["signal"] == "dislike"}
        reject_from_feedback = {r["tmdb_id"] for r in fb_rows if r["signal"] == "reject"}

    # ----- household rejections
    # Same precedence rule: if Hono passed household_rejections inline,
    # that's the truth — don't union with stored rows. The
    # reject-signal entries from the feedback block always apply
    # (they're per-user "hide this from me forever" signals).
    if req.household_rejections is not None:
        rejected_ids = set(req.household_rejections)
    else:
        rejected_ids = {
            r["tmdb_id"]
            for r in conn.execute(
                "SELECT tmdb_id FROM household_rejections WHERE kind = ?", (kind,)
            ).fetchall()
        }
    rejected_ids |= reject_from_feedback

    liked_pair = _stack_embeddings(conn, kind, liked_ids)
    liked_embeddings, liked_embedding_ids = (
        (liked_pair[0], liked_pair[1]) if liked_pair is not None else (None, [])
    )
    liked_titles = _load_title_rows(conn, kind, list(liked_ids))
    disliked_pair = _stack_embeddings(conn, kind, disliked_ids)
    disliked_embeddings, disliked_embedding_ids = (
        (disliked_pair[0], disliked_pair[1]) if disliked_pair is not None else (None, [])
    )

    # ----- recently shown
    recently_shown_ids: set[int] = set()
    if req.exclude_recently_shown:
        recently_shown_ids = {
            r["tmdb_id"]
            for r in conn.execute(
                """SELECT tmdb_id FROM recently_shown
                   WHERE sub = ? AND kind = ?
                     AND datetime(ts) >= datetime('now', ?)
                   ORDER BY ts DESC""",
                (req.sub, kind, f"-{RECENTLY_SHOWN_RETENTION_DAYS} days"),
            ).fetchall()
        }

    return UserContext(
        sub=req.sub,
        kind=kind,
        library_ids=library_ids,
        library_title_keys=library_title_keys,
        library_embeddings=library_embeddings,
        library_embedding_ids=library_embedding_ids,
        library_titles=library_titles,
        liked_ids=liked_ids,
        liked_titles=liked_titles,
        liked_embeddings=liked_embeddings,
        liked_embedding_ids=liked_embedding_ids,
        disliked_ids=disliked_ids,
        disliked_embeddings=disliked_embeddings,
        disliked_embedding_ids=disliked_embedding_ids,
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
    from . import recipes
    from .config import CONFIG

    try:
        recipe_mod = recipes.get(row["recipe"])
    except KeyError:
        log.error(
            "active model_config %s has unknown recipe %r; using default recipe",
            row["version"],
            row["recipe"],
        )
        return ("v0", CONFIG.default_recipe, {})
    try:
        params = json.loads(row["params_json"])
    except json.JSONDecodeError:
        log.error(
            "active model_config %s has invalid params_json; using default recipe",
            row["version"],
        )
        return ("v0", CONFIG.default_recipe, {})
    if not isinstance(params, dict):
        log.error(
            "active model_config %s params_json is %s; using default recipe",
            row["version"],
            type(params).__name__,
        )
        return ("v0", CONFIG.default_recipe, {})
    if not isinstance(recipe_mod.DEFAULTS, dict):
        log.error(
            "active model_config %s recipe defaults are invalid; using default recipe",
            row["version"],
        )
        return ("v0", CONFIG.default_recipe, {})
    return (row["version"], row["recipe"], sanitize_model_params(row["recipe"], params, version=row["version"]))


def sanitize_model_params(recipe_name: str, params: dict, *, version: str) -> dict[str, int | float | str]:
    from . import recipes

    recipe_mod = recipes.get(recipe_name)
    defaults = recipe_mod.DEFAULTS
    if not isinstance(params, dict):
        log.error(
            "active model_config %s params_json is %s; ignoring params",
            version,
            type(params).__name__,
        )
        return {}
    clean_params: dict[str, int | float | str] = {}
    for key, default in defaults.items():
        if key not in params:
            continue
        value = params[key]
        if isinstance(default, bool) or isinstance(value, bool):
            continue
        if isinstance(default, int):
            if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                log.error(
                    "active model_config %s has invalid param %r; ignoring",
                    version,
                    key,
                )
                continue
            lo, hi = MODEL_PARAM_BOUNDS.get(key, (1, 100000))
            clean_params[key] = int(max(lo, min(hi, round(float(value)))))
        elif isinstance(default, float):
            if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                log.error(
                    "active model_config %s has invalid param %r; ignoring",
                    version,
                    key,
                )
                continue
            lo, hi = MODEL_PARAM_BOUNDS.get(key, (-1.0e6, 1.0e6))
            clean_params[key] = max(lo, min(hi, float(value)))
        elif isinstance(default, str) and isinstance(value, str):
            clean_params[key] = value
    return clean_params


def select_model_config_for_context(
    conn: sqlite3.Connection,
    ctx: UserContext,
    *,
    model_config: tuple[str, str, dict] | None = None,
) -> tuple[str, str, dict]:
    from .config import CONFIG

    if len(ctx.library_ids) < CONFIG.cold_start_threshold and not ctx.liked_ids:
        return ("cold-start", "cold_start_trending", {})
    return model_config if model_config is not None else get_active_model_config(conn)
