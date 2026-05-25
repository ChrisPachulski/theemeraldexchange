from pathlib import Path
import sqlite3

try:
    from recommender.workers.iptv_ingest import (
        IptvSeries,
        IptvVod,
        upsert_iptv_titles,
    )
except ModuleNotFoundError:  # pragma: no cover - recommender-project pytest root
    from workers.iptv_ingest import IptvSeries, IptvVod, upsert_iptv_titles


ROOT = Path(__file__).resolve().parents[1]


def make_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.executescript((ROOT / "migrations" / "0001_initial.sql").read_text())
    db.executescript((ROOT / "migrations" / "0005_iptv_kinds.sql").read_text())
    return db


def test_upsert_iptv_titles_inserts_under_new_kinds() -> None:
    db = make_db()

    upsert_iptv_titles(
        db,
        [
            IptvVod(
                id=20,
                title="The Matrix",
                year=1999,
                overview="Neo follows the rabbit.",
                director="Lana Wachowski, Lilly Wachowski",
                cast="Keanu Reeves, Carrie-Anne Moss",
                tmdb_id=603,
                rating=8.7,
                poster_path="/matrix.jpg",
            ),
        ],
        [
            IptvSeries(
                id=30,
                title="Game of Thrones",
                overview="Westeros.",
                poster_path="/got.jpg",
                tmdb_id=1399,
                rating=9.0,
            ),
        ],
    )

    rows = db.execute(
        "SELECT tmdb_id, kind, title, year, vote_average FROM titles ORDER BY kind"
    ).fetchall()
    assert (1399, "iptv_series", "Game of Thrones", None, 9.0) in rows
    assert (603, "iptv_vod", "The Matrix", 1999, 8.7) in rows


def test_upsert_iptv_titles_updates_existing_rows() -> None:
    db = make_db()

    upsert_iptv_titles(
        db,
        [
            IptvVod(
                id=20,
                title="Old Title",
                year=1999,
                overview=None,
                director=None,
                cast=None,
                tmdb_id=603,
                rating=7.0,
                poster_path=None,
            ),
            IptvVod(
                id=21,
                title="Unlinked IPTV Movie",
                year=None,
                overview=None,
                director=None,
                cast=None,
                tmdb_id=None,
                rating=None,
                poster_path=None,
            ),
        ],
        [],
    )
    upsert_iptv_titles(
        db,
        [
            IptvVod(
                id=20,
                title="Updated Title",
                year=2000,
                overview="Updated",
                director=None,
                cast=None,
                tmdb_id=603,
                rating=8.0,
                poster_path="/updated.jpg",
            ),
        ],
        [],
    )

    rows = db.execute("SELECT tmdb_id, kind, title, year, vote_average FROM titles").fetchall()
    assert rows == [(603, "iptv_vod", "Updated Title", 2000, 8.0)]
