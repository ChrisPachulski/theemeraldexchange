"""Module-level _IDF / _CATALOG caches invalidate when the catalog mutates.

The nightly ingest rehydrates title_cast/title_crew via DELETE+INSERT and
upserts titles/title_features in place. Before generation fingerprinting these
caches lived for the life of the process, so a long-running server scored
against frozen IDF weights and a frozen catalog matrix.
"""

from __future__ import annotations

import sqlite3

import numpy as np
import pytest

from app.db import serialize_f32, table_generation
from app.recipes import fused, item_knn


@pytest.fixture(autouse=True)
def _clear_caches():
    fused._IDF.clear()
    item_knn._CATALOG.clear()
    yield
    fused._IDF.clear()
    item_knn._CATALOG.clear()


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript(
        """
        CREATE TABLE titles (
          tmdb_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
          year INTEGER, release_date TEXT, overview TEXT, poster_path TEXT,
          vote_average REAL, vote_count INTEGER, popularity REAL, status TEXT,
          fetched_at TEXT NOT NULL, PRIMARY KEY (tmdb_id, kind)
        );
        CREATE TABLE title_genres (
          tmdb_id INTEGER NOT NULL, kind TEXT NOT NULL, genre_id INTEGER NOT NULL,
          PRIMARY KEY (tmdb_id, kind, genre_id)
        );
        CREATE TABLE title_cast (
          tmdb_id INTEGER NOT NULL, kind TEXT NOT NULL, person_id INTEGER NOT NULL,
          name TEXT, order_idx INTEGER, PRIMARY KEY (tmdb_id, kind, person_id)
        );
        CREATE TABLE title_crew (
          tmdb_id INTEGER NOT NULL, kind TEXT NOT NULL, person_id INTEGER NOT NULL,
          name TEXT, job TEXT NOT NULL, PRIMARY KEY (tmdb_id, kind, person_id, job)
        );
        CREATE TABLE title_features (
          tmdb_id INTEGER NOT NULL, kind TEXT NOT NULL, feature_json TEXT NOT NULL,
          embedding BLOB NOT NULL, dim INTEGER NOT NULL, computed_at TEXT NOT NULL,
          PRIMARY KEY (tmdb_id, kind)
        );
        """
    )
    yield c
    c.close()


def _seed_title(conn: sqlite3.Connection, tmdb_id: int, *, fetched_at: str = "t0") -> None:
    conn.execute(
        "INSERT INTO titles(tmdb_id, kind, title, vote_count, popularity, status, fetched_at) "
        "VALUES (?, 'movie', ?, 100, 1.0, 'Released', ?)",
        (tmdb_id, f"Title {tmdb_id}", fetched_at),
    )


def _seed_feature(conn: sqlite3.Connection, tmdb_id: int, vec, *, computed_at: str = "t0") -> None:
    arr = np.asarray(vec, dtype=np.float32)
    conn.execute(
        "INSERT INTO title_features(tmdb_id, kind, feature_json, embedding, dim, computed_at) "
        "VALUES (?, 'movie', '{}', ?, ?, ?) "
        "ON CONFLICT(tmdb_id, kind) DO UPDATE SET "
        "embedding=excluded.embedding, computed_at=excluded.computed_at",
        (tmdb_id, serialize_f32(arr), arr.size, computed_at),
    )


# ---------------------------------------------------------------------------
# table_generation primitive
# ---------------------------------------------------------------------------


def test_table_generation_moves_on_insert_and_timestamp(conn) -> None:
    g0 = table_generation(conn, ("titles", "fetched_at"), "title_cast")
    _seed_title(conn, 1)
    g1 = table_generation(conn, ("titles", "fetched_at"), "title_cast")
    assert g1 != g0
    # In-place upsert keeps count/rowid but stamps the timestamp column.
    conn.execute("UPDATE titles SET fetched_at='t1' WHERE tmdb_id=1")
    g2 = table_generation(conn, ("titles", "fetched_at"), "title_cast")
    assert g2 != g1
    # No mutation -> stable.
    assert table_generation(conn, ("titles", "fetched_at"), "title_cast") == g2


def test_table_generation_rejects_bad_identifier(conn) -> None:
    with pytest.raises(ValueError):
        table_generation(conn, "titles; DROP TABLE titles")


# ---------------------------------------------------------------------------
# fused._idf_map
# ---------------------------------------------------------------------------


def test_idf_cache_hit_when_tables_unchanged(conn) -> None:
    _seed_title(conn, 1)
    conn.execute("INSERT INTO title_cast VALUES (1, 'movie', 900, 'Lead', 0)")
    first = fused._idf_map(conn, "movie", "cast")
    second = fused._idf_map(conn, "movie", "cast")
    assert second is first  # served from cache, not recomputed


def test_idf_cache_invalidates_on_ingest_style_mutation(conn) -> None:
    _seed_title(conn, 1)
    _seed_title(conn, 2)
    conn.execute("INSERT INTO title_cast VALUES (1, 'movie', 900, 'Lead', 0)")
    idf_before = fused._idf_map(conn, "movie", "cast")
    assert 900 in idf_before

    # Ingest rehydrates a title: DELETE+INSERT its cast rows, adding a person.
    conn.execute("DELETE FROM title_cast WHERE tmdb_id=2 AND kind='movie'")
    conn.execute("INSERT INTO title_cast VALUES (2, 'movie', 900, 'Lead', 0)")
    conn.execute("INSERT INTO title_cast VALUES (2, 'movie', 901, 'New', 1)")

    idf_after = fused._idf_map(conn, "movie", "cast")
    assert idf_after is not idf_before
    assert 901 in idf_after
    # Person 900's df went 1 -> 2, so their IDF must drop (more common = less weight).
    assert idf_after[900] < idf_before[900]


def test_idf_crew_cache_invalidates_on_crew_mutation(conn) -> None:
    _seed_title(conn, 1)
    conn.execute("INSERT INTO title_crew VALUES (1, 'movie', 700, 'Dir', 'Director')")
    before = fused._idf_map(conn, "movie", "crew")
    conn.execute("INSERT INTO title_crew VALUES (1, 'movie', 701, 'Wri', 'Writer')")
    after = fused._idf_map(conn, "movie", "crew")
    assert after is not before
    assert 701 in after


# ---------------------------------------------------------------------------
# item_knn._load_catalog
# ---------------------------------------------------------------------------


def test_catalog_cache_hit_when_tables_unchanged(conn) -> None:
    _seed_title(conn, 1)
    _seed_feature(conn, 1, [1.0, 0.0])
    first = item_knn._load_catalog(conn, "movie", 0)
    second = item_knn._load_catalog(conn, "movie", 0)
    assert second is first


def test_catalog_cache_invalidates_on_new_title(conn) -> None:
    _seed_title(conn, 1)
    _seed_feature(conn, 1, [1.0, 0.0])
    cat = item_knn._load_catalog(conn, "movie", 0)
    assert cat["ids"] == [1]

    _seed_title(conn, 2)
    _seed_feature(conn, 2, [0.0, 1.0])
    cat2 = item_knn._load_catalog(conn, "movie", 0)
    assert sorted(cat2["ids"]) == [1, 2]


def test_catalog_cache_invalidates_on_in_place_refeaturize(conn) -> None:
    _seed_title(conn, 1)
    _seed_feature(conn, 1, [1.0, 0.0], computed_at="t0")
    cat = item_knn._load_catalog(conn, "movie", 0)
    # Upsert keeps the rowid and count; only computed_at + embedding move.
    _seed_feature(conn, 1, [0.0, 1.0], computed_at="t1")
    cat2 = item_knn._load_catalog(conn, "movie", 0)
    assert cat2 is not cat
    np.testing.assert_allclose(cat2["mat"][0], [0.0, 1.0])
