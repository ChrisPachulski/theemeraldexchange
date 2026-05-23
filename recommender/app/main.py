"""FastAPI entry point.

The Hono backend hits these endpoints; the public-facing tunnel is not
configured for this service. All requests are inside the Docker network.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException

from .config import CONFIG
from .context import get_active_model_config, load_user_context
from .db import connect, migrate
from . import recipes
from .schemas import (
    FeedbackEventRequest,
    HealthResponse,
    ScoreRequest,
    ScoreResponse,
)

log = logging.getLogger("recommender")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("recommender starting; db=%s", CONFIG.db_path)
    applied = migrate()
    if applied:
        log.info("applied migrations: %s", applied)
    yield


app = FastAPI(title="exchange-recommender", lifespan=lifespan)


def get_db() -> Iterator[sqlite3.Connection]:
    """Per-request SQLite connection.

    FastAPI runs sync handlers in a worker threadpool, so a single shared
    connection across concurrent requests would race on cursor state and
    implicit transactions. SQLite open is cheap (microseconds) and WAL
    mode lets multiple readers + one writer overlap, so a fresh
    connection per request is the simplest correct shape here.
    """
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


@app.get("/health", response_model=HealthResponse)
def health(conn: sqlite3.Connection = Depends(get_db)) -> HealthResponse:
    titles = conn.execute("SELECT COUNT(*) AS c FROM titles").fetchone()["c"]
    vecs = conn.execute("SELECT COUNT(*) AS c FROM title_vec").fetchone()["c"]
    cfg_row = conn.execute(
        "SELECT version FROM model_config WHERE active = 1 LIMIT 1"
    ).fetchone()
    return HealthResponse(
        ok=True,
        db_path=str(CONFIG.db_path),
        titles=titles,
        title_vectors=vecs,
        active_model_version=cfg_row["version"] if cfg_row else None,
    )


@app.post("/score", response_model=ScoreResponse)
def score(
    req: ScoreRequest,
    conn: sqlite3.Connection = Depends(get_db),
) -> ScoreResponse:
    t0 = time.perf_counter()
    ctx = load_user_context(conn, req)

    # Cold-start orchestration: choose the cold_start_trending recipe when the
    # library is too small for a meaningful taste signal. Independent of which
    # recipe is "active" — the optimizer can't override common sense here.
    if len(ctx.library_ids) < CONFIG.cold_start_threshold and not ctx.liked_ids:
        recipe_name = "cold_start_trending"
        params: dict = {}
        model_version = "cold-start"
    else:
        model_version, recipe_name, params = get_active_model_config(conn)

    try:
        recipe = recipes.get(recipe_name)
    except KeyError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    result = recipe.score(ctx, conn, n=req.n, params=params)
    items = result.items[: req.n]

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if items:
        conn.executemany(
            """INSERT INTO rec_log(sub, kind, tmdb_id, rank, score, provenance, model_version, ts)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    req.sub,
                    req.kind,
                    it.tmdb_id,
                    rank,
                    it.score,
                    it.provenance,
                    model_version,
                    now,
                )
                for rank, it in enumerate(items)
            ],
        )
        conn.executemany(
            """INSERT INTO recently_shown(sub, kind, tmdb_id, ts)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(sub, kind, tmdb_id) DO UPDATE SET ts = excluded.ts""",
            [(req.sub, req.kind, it.tmdb_id, now) for it in items],
        )

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    diag = {
        "elapsed_ms": round(elapsed_ms, 1),
        "user": ctx.diag,
        **result.diag,
    }
    return ScoreResponse(
        items=items,
        model_version=model_version,
        recipe=recipe_name,
        diag=diag,
    )


@app.post("/events/feedback")
def post_feedback(
    ev: FeedbackEventRequest,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, bool]:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.execute(
        """INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(sub, kind, tmdb_id, signal) DO UPDATE SET ts = excluded.ts""",
        (ev.sub, ev.kind, ev.tmdb_id, ev.signal, now),
    )
    # Outcome attribution: tie this event back to the most recent rec_log row
    # for the same (sub, kind, tmdb_id) so the optimizer can learn from it.
    # Map present-tense signals to past-tense outcomes (the rec_outcomes
    # constraint enforces past tense).
    signal_to_outcome = {
        "like": "liked",
        "dislike": "disliked",
        "reject": "rejected",
        "clicked": "clicked",
        "added": "added",
    }
    if ev.signal in signal_to_outcome:
        rec = conn.execute(
            """SELECT id FROM rec_log
               WHERE sub = ? AND kind = ? AND tmdb_id = ?
               ORDER BY ts DESC LIMIT 1""",
            (ev.sub, ev.kind, ev.tmdb_id),
        ).fetchone()
        if rec is not None:
            conn.execute(
                """INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES (?, ?, ?)
                   ON CONFLICT(rec_id, outcome) DO UPDATE SET ts = excluded.ts""",
                (rec["id"], signal_to_outcome[ev.signal], now),
            )
    return {"ok": True}


@app.post("/events/library/sync")
def post_library_sync(
    payload: dict,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, int]:
    """Bulk-replace the library snapshot for one kind.

    Hono is the source of truth via Sonarr/Radarr. We mirror it here for
    recipes that only get a ``sub`` (e.g. the optimizer's offline replays).
    """
    kind = payload.get("kind")
    items = payload.get("items") or []
    if kind not in ("movie", "tv"):
        raise HTTPException(status_code=400, detail="invalid kind")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.execute("DELETE FROM library_items WHERE kind = ?", (kind,))
    conn.executemany(
        """INSERT INTO library_items(kind, tmdb_id, source, added_at)
           VALUES (?, ?, ?, ?)""",
        [(kind, int(it["tmdb_id"]), it.get("source"), now) for it in items if it.get("tmdb_id")],
    )
    return {"count": len(items)}


@app.post("/events/rejection")
def post_rejection(
    payload: dict,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, bool]:
    kind = payload.get("kind")
    tmdb_id = payload.get("tmdb_id")
    if kind not in ("movie", "tv") or not isinstance(tmdb_id, int):
        raise HTTPException(status_code=400, detail="invalid payload")
    conn.execute(
        """INSERT INTO household_rejections(kind, tmdb_id, ts) VALUES (?, ?, datetime('now'))
           ON CONFLICT(kind, tmdb_id) DO NOTHING""",
        (kind, tmdb_id),
    )
    return {"ok": True}
