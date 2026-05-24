"""TMDB ingest worker.

Two modes:

  * ``bootstrap`` — enumerate all titles meeting ``vote_count >= 50`` and
    ``adult = false`` via paginated /discover sliced by year buckets,
    enqueue them in ``ingest_queue``, then hydrate each one through
    /movie/{id} or /tv/{id} with ``append_to_response=keywords,credits``.
    Resumable: re-running picks up wherever the queue left off.

  * ``changes`` — call /movie/changes and /tv/changes since the last
    cursor stored in ``ingest_state``, then refetch the affected IDs.

Run from the Makefile (``make ingest-bootstrap`` / ``make ingest-changes``)
or from the Hono backend when Sonarr/Radarr adds a new title (single-id
fetch is exposed via :func:`hydrate_one`).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sqlite3
from datetime import date, datetime, timedelta, timezone

from app.db import connect

from .tmdb_client import TmdbClient, from_env

log = logging.getLogger("tmdb_ingest")

CURRENT_YEAR = date.today().year
YEAR_BUCKETS = [
    (start, min(start + 4, CURRENT_YEAR + 2))
    for start in range(1900, CURRENT_YEAR + 3, 5)
]
MIN_VOTE_COUNT = 50
TMDB_MAX_PAGES = 500
CONCURRENCY = 8


# =========================================================================
# Enumeration: paginate /discover by year bucket
# =========================================================================


async def enumerate_kind(client: TmdbClient, conn: sqlite3.Connection, kind: str) -> int:
    """Walk year buckets and persist every (tmdb_id, kind) into ingest_queue."""
    total = 0
    for year_gte, year_lte in YEAR_BUCKETS:
        page = 1
        while page <= TMDB_MAX_PAGES:
            try:
                data = await client.discover(
                    kind,
                    page=page,
                    vote_count_gte=MIN_VOTE_COUNT,
                    year_gte=year_gte,
                    year_lte=year_lte,
                )
            except Exception as e:
                log.warning("discover %s [%d-%d] p=%d failed: %s", kind, year_gte, year_lte, page, e)
                break

            results = data.get("results") or []
            if not results:
                break

            rows = [
                (int(r["id"]), kind, "pending", 0, datetime.now(timezone.utc).isoformat(timespec="seconds"))
                for r in results
                if r.get("id") and not r.get("adult", False)
            ]
            with conn:
                conn.executemany(
                    """INSERT INTO ingest_queue(tmdb_id, kind, status, attempts, updated_at)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(tmdb_id, kind) DO NOTHING""",
                    rows,
                )
            total += len(rows)

            total_pages = int(data.get("total_pages") or 0)
            if page >= total_pages:
                break
            page += 1
        log.info("enumerated %s %d-%d: %d cumulative", kind, year_gte, year_lte, total)
    return total


# =========================================================================
# Hydration: pull one detail record + persist
# =========================================================================


def _flatten_year(release_date: str | None) -> int | None:
    if not release_date or len(release_date) < 4:
        return None
    try:
        return int(release_date[:4])
    except ValueError:
        return None


def _persist_detail(conn: sqlite3.Connection, kind: str, payload: dict) -> bool:
    """Write payload into titles + related tables. Returns False if filtered out."""
    if payload.get("adult", False):
        return False
    vote_count = int(payload.get("vote_count") or 0)
    if vote_count < MIN_VOTE_COUNT:
        return False

    tmdb_id = int(payload["id"])
    title = payload.get("title") or payload.get("name") or "?"
    original_title = payload.get("original_title") or payload.get("original_name")
    release = payload.get("release_date") or payload.get("first_air_date")
    year = _flatten_year(release)

    # Runtime: movies have an int; TV shows have episode_run_time list.
    if kind == "movie":
        runtime = payload.get("runtime")
    else:
        ert = payload.get("episode_run_time") or []
        runtime = int(sum(ert) / len(ert)) if ert else None

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with conn:
        conn.execute(
            """INSERT INTO titles(
                tmdb_id, kind, title, original_title, year, release_date, overview,
                poster_path, vote_average, vote_count, popularity, runtime, status,
                original_language, adult, last_changed_at, fetched_at, raw_json)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(tmdb_id, kind) DO UPDATE SET
                title = excluded.title,
                original_title = excluded.original_title,
                year = excluded.year,
                release_date = excluded.release_date,
                overview = excluded.overview,
                poster_path = excluded.poster_path,
                vote_average = excluded.vote_average,
                vote_count = excluded.vote_count,
                popularity = excluded.popularity,
                runtime = excluded.runtime,
                status = excluded.status,
                original_language = excluded.original_language,
                adult = excluded.adult,
                last_changed_at = excluded.last_changed_at,
                fetched_at = excluded.fetched_at,
                raw_json = excluded.raw_json""",
            (
                tmdb_id, kind, title, original_title, year, release, payload.get("overview"),
                payload.get("poster_path"), payload.get("vote_average"), vote_count,
                payload.get("popularity"), runtime, payload.get("status"),
                payload.get("original_language"), 0, None, now, json.dumps(payload),
            ),
        )

        # Genres
        conn.execute("DELETE FROM title_genres WHERE kind = ? AND tmdb_id = ?", (kind, tmdb_id))
        genres = payload.get("genres") or []
        conn.executemany(
            "INSERT INTO title_genres(tmdb_id, kind, genre_id) VALUES (?,?,?)",
            [(tmdb_id, kind, int(g["id"])) for g in genres if g.get("id") is not None],
        )

        # Keywords
        kw_block = payload.get("keywords") or {}
        kws = kw_block.get("keywords") or kw_block.get("results") or []
        conn.execute("DELETE FROM title_keywords WHERE kind = ? AND tmdb_id = ?", (kind, tmdb_id))
        conn.executemany(
            "INSERT INTO title_keywords(tmdb_id, kind, keyword_id, keyword) VALUES (?,?,?,?)",
            [(tmdb_id, kind, int(k["id"]), k.get("name")) for k in kws if k.get("id") is not None],
        )

        # Cast / crew (top 20 cast, all crew with non-empty job)
        credits = payload.get("credits") or {}
        cast = (credits.get("cast") or [])[:20]
        crew = credits.get("crew") or []
        conn.execute("DELETE FROM title_cast WHERE kind = ? AND tmdb_id = ?", (kind, tmdb_id))
        conn.executemany(
            "INSERT INTO title_cast(tmdb_id, kind, person_id, name, order_idx) VALUES (?,?,?,?,?)",
            [(tmdb_id, kind, int(c["id"]), c.get("name"), c.get("order")) for c in cast if c.get("id") is not None],
        )
        conn.execute("DELETE FROM title_crew WHERE kind = ? AND tmdb_id = ?", (kind, tmdb_id))
        conn.executemany(
            "INSERT INTO title_crew(tmdb_id, kind, person_id, name, job) VALUES (?,?,?,?,?)",
            [
                (tmdb_id, kind, int(c["id"]), c.get("name"), c.get("job") or "")
                for c in crew
                if c.get("id") is not None and c.get("job")
            ],
        )

    return True


async def _hydrate_loop(
    client: TmdbClient,
    conn: sqlite3.Connection,
    *,
    concurrency: int,
    limit: int | None = None,
) -> tuple[int, int]:
    """Drain ingest_queue (status='pending') with N concurrent workers."""
    sem = asyncio.Semaphore(concurrency)
    done = 0
    skipped = 0

    async def worker(tmdb_id: int, kind: str) -> None:
        nonlocal done, skipped
        async with sem:
            try:
                detail = await client.detail(kind, tmdb_id)
            except Exception as e:
                with conn:
                    conn.execute(
                        """UPDATE ingest_queue SET status='error', attempts=attempts+1,
                           last_error=?, updated_at=datetime('now')
                           WHERE tmdb_id=? AND kind=?""",
                        (str(e)[:300], tmdb_id, kind),
                    )
                return
            kept = _persist_detail(conn, kind, detail)
            with conn:
                conn.execute(
                    """UPDATE ingest_queue SET status=?, attempts=attempts+1,
                       last_error=NULL, updated_at=datetime('now')
                       WHERE tmdb_id=? AND kind=?""",
                    ("done" if kept else "skipped", tmdb_id, kind),
                )
            if kept:
                done += 1
            else:
                skipped += 1

    batch_size = max(concurrency * 4, 64)
    while True:
        rows = conn.execute(
            """SELECT tmdb_id, kind FROM ingest_queue
               WHERE status='pending'
               ORDER BY attempts ASC, kind, tmdb_id
               LIMIT ?""",
            (batch_size,),
        ).fetchall()
        if not rows:
            break
        await asyncio.gather(*(worker(r["tmdb_id"], r["kind"]) for r in rows))
        if limit is not None and (done + skipped) >= limit:
            break
        log.info("hydrate progress: done=%d skipped=%d", done, skipped)
    return done, skipped


async def hydrate_one(tmdb_id: int, kind: str) -> bool:
    """One-off hydration used by the Hono backend when Sonarr/Radarr adds an item."""
    client = from_env()
    conn = connect()
    try:
        detail = await client.detail(kind, tmdb_id)
        return _persist_detail(conn, kind, detail)
    finally:
        await client.aclose()
        conn.close()


# =========================================================================
# Changes mode (Phase B)
# =========================================================================


async def changes_since(client: TmdbClient, conn: sqlite3.Connection, kind: str) -> int:
    cursor = conn.execute(
        "SELECT value FROM ingest_state WHERE key = ?", (f"changes_{kind}_cursor",)
    ).fetchone()
    start = (date.today() - timedelta(days=2)).isoformat() if cursor is None else cursor["value"]
    end = date.today().isoformat()

    enqueued = 0
    page = 1
    while True:
        data = await client.changes(kind, start_date=start, end_date=end, page=page)
        for row in data.get("results") or []:
            tid = int(row.get("id"))
            with conn:
                conn.execute(
                    """INSERT INTO ingest_queue(tmdb_id, kind, status, attempts, updated_at)
                       VALUES (?, ?, 'pending', 0, datetime('now'))
                       ON CONFLICT(tmdb_id, kind) DO UPDATE SET status='pending',
                         attempts=0, updated_at=datetime('now')""",
                    (tid, kind),
                )
            enqueued += 1
        if page >= int(data.get("total_pages") or 1):
            break
        page += 1

    with conn:
        conn.execute(
            """INSERT INTO ingest_state(key, value, ts) VALUES (?, ?, datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts""",
            (f"changes_{kind}_cursor", end),
        )
    return enqueued


# =========================================================================
# CLI
# =========================================================================


def _requeue_errors(conn: sqlite3.Connection, max_attempts: int | None) -> int:
    """Reset error rows to pending so they get another hydration pass.

    Without this, transient TMDB failures (5xx, rate-limit, network
    blip) strand rows at status='error' permanently — the drain loop's
    SELECT only picks status='pending', and re-running bootstrap
    enqueues new rows via ON CONFLICT DO NOTHING, which is a no-op for
    existing error rows. Operators previously needed manual SQL to
    recover.

    `max_attempts` caps how many times a single row can be retried so
    a row that's stuck on a permanent failure (e.g. removed from TMDB)
    doesn't churn the queue forever. None = unbounded.
    """
    if max_attempts is None:
        with conn:
            n = conn.execute(
                "UPDATE ingest_queue SET status='pending', last_error=NULL, "
                "updated_at=datetime('now') WHERE status='error'"
            ).rowcount
    else:
        with conn:
            n = conn.execute(
                "UPDATE ingest_queue SET status='pending', last_error=NULL, "
                "updated_at=datetime('now') WHERE status='error' AND attempts < ?",
                (max_attempts,),
            ).rowcount
    return n


async def _run(args: argparse.Namespace) -> None:
    client = from_env()
    conn = connect()
    try:
        if args.mode == "bootstrap":
            if not args.skip_enumerate:
                for kind in ("movie", "tv"):
                    n = await enumerate_kind(client, conn, kind)
                    log.info("enumerate %s: %d added/seen", kind, n)
            if args.retry_errors:
                n = _requeue_errors(conn, args.max_attempts)
                log.info("retry-errors: requeued %d error rows", n)
            done, skipped = await _hydrate_loop(client, conn, concurrency=args.concurrency, limit=args.limit)
            log.info("bootstrap done: done=%d skipped=%d", done, skipped)
        elif args.mode == "changes":
            for kind in ("movie", "tv"):
                n = await changes_since(client, conn, kind)
                log.info("changes enqueued %s: %d", kind, n)
            if args.retry_errors:
                n = _requeue_errors(conn, args.max_attempts)
                log.info("retry-errors: requeued %d error rows", n)
            done, skipped = await _hydrate_loop(client, conn, concurrency=args.concurrency, limit=args.limit)
            log.info("changes hydrate: done=%d skipped=%d", done, skipped)
        elif args.mode == "retry-errors":
            n = _requeue_errors(conn, args.max_attempts)
            log.info("retry-errors: requeued %d error rows", n)
            done, skipped = await _hydrate_loop(client, conn, concurrency=args.concurrency, limit=args.limit)
            log.info("retry-errors done: done=%d skipped=%d", done, skipped)
        else:
            raise SystemExit(f"unknown mode: {args.mode}")
    finally:
        await client.aclose()
        conn.close()


def _cli() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["bootstrap", "changes", "retry-errors"], required=True)
    ap.add_argument("--concurrency", type=int, default=CONCURRENCY)
    ap.add_argument("--limit", type=int, default=None, help="stop after N hydrations (debug)")
    ap.add_argument("--skip-enumerate", action="store_true", help="bootstrap: hydrate-only, skip /discover")
    ap.add_argument(
        "--retry-errors",
        action="store_true",
        help="bootstrap/changes: also requeue status='error' rows before the hydrate pass",
    )
    ap.add_argument(
        "--max-attempts",
        type=int,
        default=None,
        help="cap retries per row so a permanently-broken row doesn't churn the queue (default: unbounded)",
    )
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(_run(args))


if __name__ == "__main__":
    _cli()
