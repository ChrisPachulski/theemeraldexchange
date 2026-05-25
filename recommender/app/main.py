"""FastAPI entry point.

The Hono backend hits these endpoints; the public-facing tunnel is not
configured for this service. All requests are inside the Docker network.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import sqlite3
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, Header, HTTPException

from .config import CONFIG
from .context import load_user_context, select_model_config_for_context
from .db import connect, migrate, transaction
from . import recipes
from .schemas import (
    ClearFeedbackRequest,
    FeedbackEventRequest,
    HealthResponse,
    ImpressionEventRequest,
    LibrarySyncRequest,
    RejectionEventRequest,
    ScoreRequest,
    ScoreResponse,
    ShownEventRequest,
)
from workers.iptv_ingest import main as iptv_ingest_main

log = logging.getLogger("recommender")
RECENTLY_SHOWN_RETENTION_DAYS = 30
FEEDBACK_ATTRIBUTION_MINUTES = 10
RETENTION_SWEEP_INTERVAL_SECONDS = 3600


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def sweep_retention_once() -> None:
    conn = connect()
    try:
        with transaction(conn):
            conn.execute(
                """DELETE FROM rec_log
                   WHERE datetime(ts) < datetime('now', ?)
                     AND id NOT IN (SELECT rec_id FROM rec_outcomes)""",
                (f"-{CONFIG.rec_log_retention_days} days",),
            )
            conn.execute(
                "DELETE FROM recently_shown WHERE datetime(ts) < datetime('now', ?)",
                (f"-{RECENTLY_SHOWN_RETENTION_DAYS} days",),
            )
    finally:
        conn.close()


async def retention_sweeper() -> None:
    while True:
        try:
            await asyncio.to_thread(sweep_retention_once)
        except Exception:
            log.exception("retention sweep failed")
        await asyncio.sleep(RETENTION_SWEEP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("recommender starting; db=%s", CONFIG.db_path)
    applied = migrate()
    if applied:
        log.info("applied migrations: %s", applied)
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        iptv_ingest_main,
        trigger="cron",
        hour=3,
        minute=30,
        id="iptv_ingest",
        replace_existing=True,
    )
    scheduler.start()
    sweep_task = asyncio.create_task(retention_sweeper())
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)
        sweep_task.cancel()
        with suppress(asyncio.CancelledError):
            await sweep_task


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


def require_event_secret(
    x_recommender_secret: str | None = Header(default=None),
) -> None:
    expected = CONFIG.event_secret
    if not expected:
        raise HTTPException(status_code=503, detail="event secret is not configured")
    if x_recommender_secret is None or not hmac.compare_digest(x_recommender_secret, expected):
        raise HTTPException(status_code=401, detail="invalid event secret")


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
    _auth: None = Depends(require_event_secret),
    conn: sqlite3.Connection = Depends(get_db),
) -> ScoreResponse:
    t0 = time.perf_counter()
    ctx = load_user_context(conn, req, persist_library=False)

    model_version, recipe_name, params = select_model_config_for_context(conn, ctx)

    try:
        recipe = recipes.get(recipe_name)
    except KeyError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    result = recipe.score(ctx, conn, n=req.n, params=params)
    items = result.items[: req.n]

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
    _auth: None = Depends(require_event_secret),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, bool]:
    now = _utc_now_iso()
    with transaction(conn):
        if ev.signal in {"like", "clicked", "added"}:
            conn.execute(
                """DELETE FROM user_feedback
                   WHERE sub=? AND kind=? AND tmdb_id=?
                     AND signal IN ('dislike', 'reject')""",
                (ev.sub, ev.kind, ev.tmdb_id),
            )
        elif ev.signal == "dislike":
            conn.execute(
                """DELETE FROM user_feedback
                   WHERE sub=? AND kind=? AND tmdb_id=?
                     AND signal IN ('like', 'clicked', 'added')""",
                (ev.sub, ev.kind, ev.tmdb_id),
            )
        elif ev.signal == "reject":
            conn.execute(
                """DELETE FROM user_feedback
                   WHERE sub=? AND kind=? AND tmdb_id=?
                     AND signal IN ('like', 'dislike', 'shown', 'clicked', 'added')""",
                (ev.sub, ev.kind, ev.tmdb_id),
            )
        elif ev.signal == "shown":
            conn.execute(
                "DELETE FROM user_feedback WHERE sub=? AND kind=? AND tmdb_id=? AND signal='shown'",
                (ev.sub, ev.kind, ev.tmdb_id),
            )
            conn.execute(
                """INSERT INTO recently_shown(sub, kind, tmdb_id, ts)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(sub, kind, tmdb_id) DO UPDATE SET ts = excluded.ts""",
                (ev.sub, ev.kind, ev.tmdb_id, now),
            )
            conn.execute(
                "DELETE FROM recently_shown WHERE datetime(ts) < datetime('now', ?)",
                (f"-{RECENTLY_SHOWN_RETENTION_DAYS} days",),
            )
            return {"ok": True}
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
                     AND datetime(ts) >= datetime('now', ?)
                   ORDER BY datetime(ts) DESC, id DESC LIMIT 1""",
                (ev.sub, ev.kind, ev.tmdb_id, f"-{FEEDBACK_ATTRIBUTION_MINUTES} minutes"),
            ).fetchone()
            if rec is not None:
                if ev.signal in {"like", "dislike", "reject"}:
                    conn.execute(
                        """DELETE FROM rec_outcomes
                           WHERE outcome IN ('liked', 'disliked', 'rejected')
                             AND rec_id IN (
                               SELECT id FROM rec_log WHERE sub=? AND kind=? AND tmdb_id=?
                             )""",
                        (ev.sub, ev.kind, ev.tmdb_id),
                    )
                conn.execute(
                    """INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES (?, ?, ?)
                       ON CONFLICT(rec_id, outcome) DO UPDATE SET ts = excluded.ts""",
                    (rec["id"], signal_to_outcome[ev.signal], now),
                )
            else:
                log.warning(
                    "feedback attribution skipped: no in-session rec_log row sub=%r kind=%s tmdb_id=%s signal=%s window=%dm",
                    ev.sub,
                    ev.kind,
                    ev.tmdb_id,
                    ev.signal,
                    FEEDBACK_ATTRIBUTION_MINUTES,
                )
    return {"ok": True}


@app.post("/events/library/sync")
def post_library_sync(
    payload: LibrarySyncRequest,
    _auth: None = Depends(require_event_secret),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, int]:
    """Bulk-replace the library snapshot for one kind.

    Hono is the source of truth via Sonarr/Radarr. We mirror it here for
    recipes that only get a ``sub`` (e.g. the optimizer's offline replays).
    """
    if not payload.items:
        if not (payload.force and payload.confirm_purge):
            raise HTTPException(
                status_code=400,
                detail="empty library sync requires force and confirm_purge",
            )
        log.warning("empty library sync with force+confirm_purge for kind=%s", payload.kind)

    now = _utc_now_iso()
    by_tmdb_id = {it.tmdb_id: it.source for it in payload.items}
    rows = [(payload.kind, tmdb_id, source, now) for tmdb_id, source in by_tmdb_id.items()]

    with transaction(conn):
        conn.execute("DELETE FROM library_items WHERE kind = ?", (payload.kind,))
        if rows:
            conn.executemany(
                """INSERT INTO library_items(kind, tmdb_id, source, added_at)
                   VALUES (?, ?, ?, ?)""",
                rows,
            )
    return {"count": len(rows)}


@app.post("/events/shown")
def post_shown(
    payload: ShownEventRequest,
    _auth: None = Depends(require_event_secret),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, int]:
    """Bulk-record items as 'recently shown' for a user.

    The /events/impressions endpoint records recommender-picked items
    after Hono has applied final filtering. Hono's suggestions route can
    also append trending-fill items when the recommender returns fewer
    than TARGET_COUNT (see server/routes/suggestions.ts). Those fill
    items are visible to the user but are not recommender impressions, so
    callers post the fill tmdb_ids here to keep rotation in sync.

    Only recently_shown is written. Fill items aren't recommendations
    (no model produced them), so they intentionally don't appear in
    rec_log — attributing a click to a "recommendation" that was
    really a fallback would poison the optimizer's training signal.
    """
    if len(payload.tmdb_ids) > 200:
        raise HTTPException(status_code=413, detail="shown event batch too large")
    if not payload.tmdb_ids:
        return {"count": 0}
    now = _utc_now_iso()
    with transaction(conn):
        conn.executemany(
            """INSERT INTO recently_shown(sub, kind, tmdb_id, ts)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(sub, kind, tmdb_id) DO UPDATE SET ts = excluded.ts""",
            [(payload.sub, payload.kind, tid, now) for tid in payload.tmdb_ids],
        )
        conn.execute(
            "DELETE FROM recently_shown WHERE datetime(ts) < datetime('now', ?)",
            (f"-{RECENTLY_SHOWN_RETENTION_DAYS} days",),
        )
    return {"count": len(payload.tmdb_ids)}


@app.post("/events/impressions")
def post_impressions(
    payload: ImpressionEventRequest,
    _auth: None = Depends(require_event_secret),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, int]:
    if len(payload.items) > 200:
        raise HTTPException(status_code=413, detail="impression event batch too large")
    if not payload.items:
        return {"count": 0}
    now = _utc_now_iso()
    with transaction(conn):
        conn.executemany(
            """INSERT INTO rec_log(sub, kind, tmdb_id, rank, score, provenance, model_version, ts)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    payload.sub,
                    payload.kind,
                    it.tmdb_id,
                    it.rank,
                    it.score,
                    it.provenance,
                    it.model_version,
                    now,
                )
                for it in payload.items
            ],
        )
        conn.executemany(
            """INSERT INTO recently_shown(sub, kind, tmdb_id, ts)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(sub, kind, tmdb_id) DO UPDATE SET ts = excluded.ts""",
            [(payload.sub, payload.kind, it.tmdb_id, now) for it in payload.items],
        )
        conn.execute(
            "DELETE FROM recently_shown WHERE datetime(ts) < datetime('now', ?)",
            (f"-{RECENTLY_SHOWN_RETENTION_DAYS} days",),
        )
    return {"count": len(payload.items)}


@app.post("/events/rejection")
def post_rejection(
    payload: RejectionEventRequest,
    _auth: None = Depends(require_event_secret),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, bool]:
    with transaction(conn):
        conn.execute(
            """INSERT INTO household_rejections(kind, tmdb_id, ts) VALUES (?, ?, datetime('now'))
               ON CONFLICT(kind, tmdb_id) DO NOTHING""",
            (payload.kind, payload.tmdb_id),
        )
    return {"ok": True}


@app.post("/events/feedback/clear")
def clear_feedback(
    payload: ClearFeedbackRequest,
    _auth: None = Depends(require_event_secret),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, bool]:
    signal_to_outcome = {
        "like": "liked",
        "dislike": "disliked",
        "reject": "rejected",
    }
    signals = [payload.signal] if payload.signal else ["like", "dislike", "reject"]
    outcomes = [signal_to_outcome[s] for s in signals]
    signal_placeholders = ",".join("?" for _ in signals)
    outcome_placeholders = ",".join("?" for _ in outcomes)
    with transaction(conn):
        conn.execute(
            f"""DELETE FROM user_feedback
                WHERE sub=? AND kind=? AND tmdb_id=? AND signal IN ({signal_placeholders})""",
            (payload.sub, payload.kind, payload.tmdb_id, *signals),
        )
        conn.execute(
            f"""DELETE FROM rec_outcomes
               WHERE outcome IN ({outcome_placeholders})
                 AND rec_id IN (
                   SELECT id FROM rec_log WHERE sub=? AND kind=? AND tmdb_id=?
                 )""",
            (*outcomes, payload.sub, payload.kind, payload.tmdb_id),
        )
    return {"ok": True}


@app.post("/events/rejection/clear")
def clear_rejection(
    payload: RejectionEventRequest,
    _auth: None = Depends(require_event_secret),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, bool]:
    # Mirror of /events/rejection but removing instead of inserting.
    # Hono only calls this after confirming no other household member
    # still dislikes the title, so a household_rejections row here
    # genuinely shouldn't survive.
    with transaction(conn):
        conn.execute(
            "DELETE FROM household_rejections WHERE kind=? AND tmdb_id=?",
            (payload.kind, payload.tmdb_id),
        )
    return {"ok": True}
