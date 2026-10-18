"""Record TMDB ingest goldens from the untouched Python worker.

Each scenario seeds a fresh exchange.db, starts the Rust fake TMDB
(examples/fake_tmdb.rs, fixtures only, never api.themoviedb.org), points
workers.tmdb_client at it and runs workers.tmdb_ingest._run with the
scenario's flags. It records the resulting rows (the DUMP queries: titles
minus fetched_at, the child tables, title_vec rowids, ingest_queue
status/attempts/last_error, ingest_state cursors) and the fake's request log
(path, query with the key redacted, auth header). The Rust test replays every
scenario against the same fake and compares.

Pinned: today = TODAY (date.today() and the year buckets) and a rate limit
the fake never trips; tenacity's real backoff runs (about 17 s in all).

    cargo build -p recommender --example fake_tmdb
    <main checkout>/recommender/.venv/bin/python \\
        crates/recommender/tests/fixtures/gen_ingest_goldens.py
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import functools
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
FAKE = REPO / "target" / "debug" / "examples" / "fake_tmdb"
CREDENTIAL = "fixture-credential-0001"  # fake_tmdb.rs FIXTURE_CREDENTIAL
TODAY = dt.date(2026, 3, 10)

DUMP = {
    "titles": "SELECT json_array(tmdb_id, kind, title, original_title, year, release_date, overview,"
              " poster_path, vote_average, vote_count, popularity, runtime, status, original_language,"
              " adult, last_changed_at, json(raw_json)) FROM titles ORDER BY kind, tmdb_id",
    "title_genres": "SELECT json_array(tmdb_id, kind, genre_id) FROM title_genres"
                    " ORDER BY kind, tmdb_id, genre_id",
    "title_keywords": "SELECT json_array(tmdb_id, kind, keyword_id, keyword) FROM title_keywords"
                      " ORDER BY kind, tmdb_id, keyword_id",
    "title_cast": "SELECT json_array(tmdb_id, kind, person_id, name, order_idx) FROM title_cast"
                  " ORDER BY kind, tmdb_id, person_id",
    "title_crew": "SELECT json_array(tmdb_id, kind, person_id, name, job) FROM title_crew"
                  " ORDER BY kind, tmdb_id, person_id, job",
    "title_features": "SELECT json_array(tmdb_id, kind) FROM title_features ORDER BY kind, tmdb_id",
    "title_vec": "SELECT json_array(rowid, kind) FROM title_vec ORDER BY rowid",
    "ingest_queue": "SELECT json_array(tmdb_id, kind, status, attempts, last_error) FROM ingest_queue"
                    " ORDER BY kind, tmdb_id",
    "ingest_state": "SELECT json_array(key, value) FROM ingest_state ORDER BY key",
}


def ok(body: dict) -> dict:
    return {"status": 200, "body": body}


def fail(status: int) -> dict:
    return {"status": status, "body": {"status_code": 0, "status_message": "fixture"}}


def route(path: str, *responses: dict, **query: str) -> dict:
    return {"path": path, "query": {k.replace("__", "."): v for k, v in query.items()},
            "responses": list(responses)}


def empty_page(path: str) -> dict:
    return route(path, ok({"page": 1, "results": [], "total_pages": 0}))


def seed_title(kind: str, tmdb_id: int) -> list[str]:
    """A title present in all six tables and title_vec."""
    rowid = tmdb_id | (1 << 32) if kind == "tv" else tmdb_id
    t = f"{tmdb_id}, '{kind}'"
    return [
        f"INSERT INTO titles(tmdb_id, kind, title, vote_count, fetched_at) VALUES ({t}, 'Old', 99, '2026-01-01')",
        f"INSERT INTO title_genres(tmdb_id, kind, genre_id) VALUES ({t}, 18)",
        f"INSERT INTO title_keywords(tmdb_id, kind, keyword_id, keyword) VALUES ({t}, 1, 'old')",
        f"INSERT INTO title_cast(tmdb_id, kind, person_id, name, order_idx) VALUES ({t}, 5, 'Old Cast', 0)",
        f"INSERT INTO title_crew(tmdb_id, kind, person_id, name, job) VALUES ({t}, 6, 'Old Crew', 'Director')",
        f"INSERT INTO title_features(tmdb_id, kind, feature_json, embedding, dim, computed_at)"
        f" VALUES ({t}, '{{}}', zeroblob(1536), 384, '2026-01-01')",
        f"INSERT INTO title_vec(rowid, kind, embedding) VALUES ({rowid}, '{kind}', zeroblob(1536))",
    ]


def queue(tmdb_id: int, kind: str, status: str, attempts: int, last_error: str | None = None) -> str:
    err = "NULL" if last_error is None else f"'{last_error}'"
    return (f"INSERT INTO ingest_queue(tmdb_id, kind, status, attempts, last_error, updated_at)"
            f" VALUES ({tmdb_id}, '{kind}', '{status}', {attempts}, {err}, '2026-01-01')")


AMELIE = {
    "id": 10, "title": "Amélie", "original_title": "Le Fabuleux Destin d'Amélie Poulain",
    "release_date": "2001-04-25", "overview": "A shy waitress decides to change the lives of others.",
    "poster_path": "/a.jpg", "vote_average": 7.9, "vote_count": 12000, "popularity": 45.123,
    "runtime": 122, "status": "Released", "original_language": "fr", "adult": False,
    "genres": [{"id": 35, "name": "Comedy"}, {"id": 10749, "name": "Romance"}, {"name": "no id"}],
    "keywords": {"keywords": [{"id": 100, "name": "paris"}, {"id": 101, "name": "café"},
                              {"id": None, "name": "dropped"}]},
    "credits": {
        "cast": [{"id": None if i == 3 else 1000 + i, "name": f"Actor {i}", "order": i} for i in range(22)],
        "crew": [
            {"id": 2000, "name": "Director A", "job": "Director"},
            {"id": 2000, "name": "Director A", "job": "Writer"},
            {"id": 2001, "name": "No Job", "job": ""},
            {"name": "No Id", "job": "Producer"},
            {"id": 2002, "name": "Composer", "job": "Original Music Composer"},
        ],
    },
}


def movie(tmdb_id: int, **extra) -> dict:
    return {"id": tmdb_id, "title": f"Movie {tmdb_id}", "release_date": "2010-06-01",
            "vote_count": 200, "vote_average": 6.5, "popularity": 3.25, "runtime": 95, **extra}


SCENARIOS = [
    {
        "name": "bootstrap",
        "auth": "query",
        "opts": {"mode": "bootstrap", "concurrency": 8, "limit": None, "skip_enumerate": False,
                 "retry_errors": False, "max_attempts": 8},
        "seed": [queue(99, "movie", "done", 1, "x"), queue(15, "movie", "error", 2, "old")]
                + seed_title("movie", 12) + seed_title("tv", 12),
        "fake": {"routes": [
            route("/3/discover/movie", ok({"page": 1, "total_pages": 2, "results": [
                {"id": 10}, {"id": 11, "adult": True}, {"id": 0}, {"id": 12}, {"title": "no id"}]}),
                primary_release_date__gte="2020-01-01", page="1"),
            route("/3/discover/movie", ok({"page": 2, "total_pages": 2, "results": [{"id": 13}, {"id": 10}]}),
                  primary_release_date__gte="2020-01-01", page="2"),
            route("/3/discover/movie", fail(500), primary_release_date__gte="2025-01-01"),
            route("/3/discover/movie", fail(429), ok({"results": [{"id": 14}], "total_pages": 1}),
                  primary_release_date__gte="1990-01-01"),
            empty_page("/3/discover/movie"),
            route("/3/discover/tv", ok({"results": [{"id": 20}, {"id": 21}], "total_pages": 1}),
                  first_air_date__gte="2015-01-01"),
            empty_page("/3/discover/tv"),
            route("/3/movie/10", ok(AMELIE)),
            route("/3/movie/12", ok({"id": 12, "title": "Adult", "adult": True, "vote_count": 500})),
            route("/3/movie/13", ok(movie(13, vote_count=10))),
            route("/3/tv/20", ok({
                "id": 20, "name": "Show Twenty", "original_name": "", "first_air_date": "2019-09-01",
                "episode_run_time": [42, 45], "vote_count": "300", "vote_average": 8, "popularity": 12,
                "status": "Ended", "keywords": {"results": [{"id": 300, "name": "heist"}]},
                "credits": {"cast": [{"id": 3000, "name": "Lead", "order": 0}], "crew": []}})),
            route("/3/tv/21", fail(503), ok({
                "id": 21, "name": "Show 21", "vote_count": 51, "episode_run_time": [],
                "release_date": None, "first_air_date": ""})),
        ]},
    },
    {
        "name": "changes",
        "auth": "query",
        "opts": {"mode": "changes", "concurrency": 4, "limit": None, "skip_enumerate": False,
                 "retry_errors": False, "max_attempts": 8},
        "seed": [
            "INSERT INTO ingest_state(key, value, ts) VALUES ('changes_movie_cursor', '2026-02-10', 'x')",
            "INSERT INTO ingest_state(key, value, ts) VALUES ('changes_tv_cursor', 'not-a-date', 'x')",
            "INSERT INTO ingest_state(key, value, ts) VALUES ('embed_model', 'm@r', 'x')",
            queue(30, "movie", "done", 3), queue(31, "movie", "error", 5, "old"),
        ] + seed_title("movie", 32),
        "fake": {"routes": [
            route("/3/movie/changes", ok({"page": 1, "total_pages": 2, "results": [
                {"id": 30}, {"id": "abc"}, {"id": None}, {"adult": False}, {"id": "31"}]}),
                start_date="2026-02-10", page="1"),
            route("/3/movie/changes", ok({"page": 2, "total_pages": 2, "results": [{"id": 31}]}),
                  start_date="2026-02-10", page="2"),
            route("/3/movie/changes", ok({"results": [{"id": 32, "adult": False}]}), start_date="2026-02-23"),
            route("/3/movie/changes", ok({"results": [], "total_pages": 1})),
            route("/3/tv/changes", ok({"results": [{"id": 40}, {"id": 41}], "total_pages": 1}),
                  start_date="2026-03-08", end_date="2026-03-10"),
            route("/3/movie/30", ok(movie(30, genres=[{"id": 28}]))),
            route("/3/movie/31", ok(movie(31, title="", name="Fallback Name"))),
            route("/3/movie/32", ok(movie(32, vote_count=49))),
            route("/3/tv/40", ok({"id": 40, "name": "Dup Crew", "vote_count": 60, "credits": {"crew": [
                {"id": 7, "name": "Same", "job": "Producer"}, {"id": 7, "name": "Same", "job": "Producer"}]}})),
            route("/3/tv/41", ok({"id": 41, "name": "Forty One", "vote_count": 50})),
        ]},
    },
    {
        "name": "retry-errors",
        "auth": "bearer",
        "opts": {"mode": "retry-errors", "concurrency": 2, "limit": None, "skip_enumerate": False,
                 "retry_errors": False, "max_attempts": 3},
        "seed": [queue(50, "movie", "error", 1, "boom"), queue(51, "movie", "error", 3, "boom"),
                 queue(52, "tv", "error", 2, "boom"), queue(53, "movie", "pending", 0),
                 queue(54, "movie", "done", 1)],
        "fake": {"routes": [
            route("/3/movie/50", ok(movie(50))),
            route("/3/tv/52", ok({"id": 52, "name": "Tv 52", "vote_count": 70, "first_air_date": "1999"})),
            route("/3/movie/53", ok(movie(53, adult=True))),
        ]},
    },
    {
        "name": "retry-unbounded",
        "auth": "query",
        "opts": {"mode": "retry-errors", "concurrency": 1, "limit": None, "skip_enumerate": False,
                 "retry_errors": False, "max_attempts": 0},
        "seed": [queue(51, "movie", "error", 9, "boom")],
        "fake": {"routes": [route("/3/movie/51", fail(500))]},
    },
    {
        "name": "bootstrap-limited",
        "auth": "query",
        "opts": {"mode": "bootstrap", "concurrency": 1, "limit": 2, "skip_enumerate": True,
                 "retry_errors": True, "max_attempts": 8},
        "seed": [queue(60, "movie", "pending", 0), queue(61, "movie", "pending", 0),
                 queue(62, "movie", "pending", 0), queue(63, "movie", "error", 1, "old"),
                 queue(64, "movie", "error", 8, "old")],
        "fake": {"routes": [
            route("/3/movie/61", ok(movie(61))),
            route("/3/movie/62", ok(movie(62))),
            route("/3/movie/63", ok(movie(63))),
        ]},
    },
    {
        "name": "changes-fails",
        "auth": "query",
        "opts": {"mode": "changes", "concurrency": 8, "limit": None, "skip_enumerate": False,
                 "retry_errors": True, "max_attempts": 8},
        "seed": [queue(70, "movie", "error", 1, "old")],
        "fake": {"routes": [route("/3/movie/changes", ok({"results": [], "total_pages": 1}))]},
    },
]


def main() -> None:
    if not FAKE.exists():
        sys.exit(f"build the fake first: cargo build -p recommender --example fake_tmdb ({FAKE})")
    sys.path.insert(0, str(REPO / "recommender"))
    for k in ("NODE_ENV", "TMDB_API_KEY", "TMDB_READ_ACCESS_TOKEN"):
        os.environ.pop(k, None)
    from app import db as db_module  # noqa: E402
    from workers import tmdb_client, tmdb_ingest  # noqa: E402

    class FixedDate(dt.date):
        @classmethod
        def today(cls):  # noqa: D102
            return cls(TODAY.year, TODAY.month, TODAY.day)

    tmdb_ingest.date = FixedDate
    tmdb_ingest.CURRENT_YEAR = TODAY.year
    tmdb_ingest.YEAR_BUCKETS = [(s, min(s + 4, TODAY.year + 2)) for s in range(1900, TODAY.year + 3, 5)]
    tmdb_client.TmdbClient.__init__.__kwdefaults__["rate_capacity"] = 100_000

    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for sc in SCENARIOS:
            path = Path(tmp) / f"{sc['name']}.db"
            db_module.migrate(db_path=path)
            conn = db_module.connect(db_path=path)
            for stmt in sc["seed"]:
                conn.execute(stmt)
            conn.close()
            tmdb_ingest.connect = functools.partial(db_module.connect, db_path=path)

            scenario_file = Path(tmp) / f"{sc['name']}.json"
            scenario_file.write_text(json.dumps(sc["fake"]))
            fake = subprocess.Popen([str(FAKE), str(scenario_file)], stdout=subprocess.PIPE, text=True)
            try:
                base = fake.stdout.readline().strip()
                tmdb_client.TMDB_BASE = f"{base}/3"
                for k in ("TMDB_API_KEY", "TMDB_READ_ACCESS_TOKEN"):
                    os.environ.pop(k, None)
                os.environ["TMDB_READ_ACCESS_TOKEN" if sc["auth"] == "bearer" else "TMDB_API_KEY"] = CREDENTIAL
                o = sc["opts"]
                ns = argparse.Namespace(mode=o["mode"], concurrency=o["concurrency"], limit=o["limit"],
                                        skip_enumerate=o["skip_enumerate"], retry_errors=o["retry_errors"],
                                        max_attempts=o["max_attempts"])
                error = None
                try:
                    asyncio.run(tmdb_ingest._run(ns))
                except Exception as e:  # noqa: BLE001
                    error = str(e).replace(base, "<base>")
                with urllib.request.urlopen(f"{base}/__log") as r:
                    requests = json.load(r)
            finally:
                fake.kill()
                fake.wait()
            conn = db_module.connect(db_path=path)
            tables = {name: [json.loads(row[0].replace(base, "<base>")) for row in conn.execute(sql)]
                      for name, sql in DUMP.items()}
            conn.close()
            out.append({**sc, "expect": {"error": error, "tables": tables, "requests": requests}})
            print(f"{sc['name']}: {len(requests)} requests, error={error}", file=sys.stderr)

    golden = {"today": TODAY.isoformat(), "dump": DUMP, "scenarios": out}
    (HERE / "ingest-goldens.json").write_text(json.dumps(golden, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
