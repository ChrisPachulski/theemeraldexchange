"""IPTV export ingest worker.

Pulls the Hono `/api/iptv/export/recommender` catalog snapshot and upserts
TMDB-linked VOD/series rows into the recommender `titles` table under the
IPTV-specific kinds added by migration 0005.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
import sqlite3
from collections.abc import Iterable
from typing import Any, TypedDict

import httpx

try:
    from app.db import connect
except ModuleNotFoundError:  # pragma: no cover - root-level pytest import path
    from recommender.app.db import connect  # type: ignore[no-redef]


class IptvExportPayload(TypedDict):
    vod: list[dict[str, Any]]
    series: list[dict[str, Any]]


@dataclass(frozen=True)
class IptvVod:
    id: int
    title: str
    year: int | None
    overview: str | None
    director: str | None
    cast: str | None
    tmdb_id: int | None
    rating: float | None
    poster_path: str | None


@dataclass(frozen=True)
class IptvSeries:
    id: int
    title: str
    overview: str | None
    poster_path: str | None
    tmdb_id: int | None
    rating: float | None


UPSERT_SQL = """
INSERT INTO titles (
  tmdb_id, kind, title, original_title, year, release_date, overview,
  poster_path, vote_average, vote_count, popularity, runtime, status,
  original_language, adult, last_changed_at, fetched_at, raw_json
) VALUES (
  ?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?
)
ON CONFLICT(tmdb_id, kind) DO UPDATE SET
  title = excluded.title,
  year = excluded.year,
  overview = excluded.overview,
  poster_path = excluded.poster_path,
  vote_average = excluded.vote_average,
  fetched_at = excluded.fetched_at,
  raw_json = excluded.raw_json
"""


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value != "" else None


def _vod_from_row(row: dict[str, Any]) -> IptvVod:
    return IptvVod(
        id=int(row["id"]),
        title=str(row["title"]),
        year=_optional_int(row.get("year")),
        overview=_optional_str(row.get("overview")),
        director=_optional_str(row.get("director")),
        cast=_optional_str(row.get("cast")),
        tmdb_id=_optional_int(row.get("tmdb_id")),
        rating=_optional_float(row.get("rating")),
        poster_path=_optional_str(row.get("poster_path")),
    )


def _series_from_row(row: dict[str, Any]) -> IptvSeries:
    return IptvSeries(
        id=int(row["id"]),
        title=str(row["title"]),
        overview=_optional_str(row.get("overview")),
        poster_path=_optional_str(row.get("poster_path")),
        tmdb_id=_optional_int(row.get("tmdb_id")),
        rating=_optional_float(row.get("rating")),
    )


def upsert_iptv_titles(
    db: sqlite3.Connection,
    vods: Iterable[IptvVod],
    series: Iterable[IptvSeries],
) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with db:
        for vod in vods:
            if vod.tmdb_id is None:
                continue
            db.execute(
                UPSERT_SQL,
                (
                    vod.tmdb_id,
                    "iptv_vod",
                    vod.title,
                    vod.year,
                    vod.overview,
                    vod.poster_path,
                    vod.rating,
                    now,
                    json.dumps(
                        {
                            "iptv_id": vod.id,
                            "iptv_kind": "vod",
                            "director": vod.director,
                            "cast": vod.cast,
                        },
                        sort_keys=True,
                    ),
                ),
            )

        for item in series:
            if item.tmdb_id is None:
                continue
            db.execute(
                UPSERT_SQL,
                (
                    item.tmdb_id,
                    "iptv_series",
                    item.title,
                    None,
                    item.overview,
                    item.poster_path,
                    item.rating,
                    now,
                    json.dumps(
                        {
                            "iptv_id": item.id,
                            "iptv_kind": "series",
                        },
                        sort_keys=True,
                    ),
                ),
            )


def fetch_iptv_export(host: str, secret: str) -> IptvExportPayload:
    url = f"{host.rstrip('/')}/api/iptv/export/recommender"
    response = httpx.get(
        url,
        headers={"x-iptv-export-secret": secret},
        timeout=60.0,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("iptv export response is not an object")
    vod = payload.get("vod", [])
    series = payload.get("series", [])
    if not isinstance(vod, list) or not isinstance(series, list):
        raise ValueError("iptv export response must contain vod and series arrays")
    return {"vod": vod, "series": series}


def main() -> None:
    host = os.environ.get("HONO_HOST", "").strip()
    secret = os.environ.get("IPTV_RECOMMENDER_EXPORT_SECRET", "").strip()
    if not host or not secret:
        print(
            "[iptv-ingest] skipped; "
            "HONO_HOST or IPTV_RECOMMENDER_EXPORT_SECRET not configured"
        )
        return

    payload = fetch_iptv_export(host, secret)
    vods = [_vod_from_row(row) for row in payload["vod"]]
    series = [_series_from_row(row) for row in payload["series"]]

    db = connect()
    try:
        upsert_iptv_titles(db, vods, series)
    finally:
        db.close()

    print(f"[iptv-ingest] upserted vods={len(vods)} series={len(series)}")


if __name__ == "__main__":
    main()
