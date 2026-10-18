"""Record /score goldens from the untouched FastAPI recommender.

A synthetic catalog (no household data: made-up titles, genres, votes,
dates, and embeddings drawn from a splitmix64 stream the Rust replay
regenerates bit for bit) plus a synthetic household is seeded into one fresh
migrated exchange.db. Each scenario then replaces the model_config rows, sets
cold_start_threshold / default_recipe, and posts one /score body through
TestClient. The response is recorded verbatim; the Rust replay
(src/http/tests.rs, score_goldens) matches ids and order exactly, scores
within 1e-5, reasons and diag keys.

Run like gen_http_goldens.py (the PyO3 binding validates subs):

    PYTHONPATH=<dir holding emerald_contracts.abi3.so> \
        <main checkout>/recommender/.venv/bin/python \
        crates/recommender/tests/fixtures/gen_score_goldens.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

EVENT_SECRET = "e" * 36
A = "local:01HABCDEFGHJKMNPQRSTVWXYZ0"
B = "google:12345"
DIM = 384
MASK = (1 << 64) - 1


def splitmix(state: int):
    while True:
        state = (state + 0x9E3779B97F4A7C15) & MASK
        z = state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
        yield z ^ (z >> 31)


def embedding(kind: str, tmdb_id: int, cluster: int) -> list[float]:
    """Cluster centre plus per-title noise; every value is k/256, exact in f32."""
    c = splitmix(1000 + cluster)
    r = splitmix(tmdb_id * 2 + (kind == "tv"))
    return [((next(c) >> 56) - 128 + 2 * ((next(r) >> 58) - 32)) / 256 for _ in range(DIM)]


WORDS = ["Emerald", "Crimson", "Silent", "Iron", "Golden", "Hidden",
         "Broken", "Electric", "Midnight", "Paper", "Velvet", "Northern"]
NOUNS = ["Heist", "Harbor", "Signal", "Garden", "Frontier", "Archive", "Empire", "Orbit", "Ledger", "Echo"]
GENRES = {
    "movie": [[28, 12, 53], [35, 10751], [18, 80], [878, 14], [16, 10751, 10762], [99]],
    "tv": [[10759, 18], [35], [10765], [80, 9648], [10762, 16], [10764]],
}


def base_title(i: int) -> str:
    return f"{WORDS[i % 12]} {NOUNS[(i // 12) % 10]} {i}"


def catalog_row(kind: str, i: int) -> dict:
    cluster = (i * 7) % 6
    title = base_title(i)
    if i % 30 == 0:
        title = f"{base_title(i - 1)}: Part Two"   # collides with an owned i - 1
    elif i % 60 == 45:
        title = f"{base_title(i - 1)} - The Return"
    year = None if i % 23 == 0 else (0 if i == 47 else 1985 + (i * 3) % 40)
    if year is None:
        release = None
    elif i % 19 == 0:
        release = "2099-06-01"
    elif i % 31 == 0:
        release = ""
    elif i % 37 == 0:
        release = None
    else:
        release = f"{max(year, 1985)}-{(i % 12) + 1:02d}-15"
    if i % 41 == 0:
        status = "Rumored"
    elif i % 43 == 0:
        status = None
    elif i % 53 == 0:
        status = "In Production"
    elif kind == "tv":
        status = ["Returning Series", "Ended", "Canceled"][i % 3]
    else:
        status = "Released"
    genres = GENRES[kind][cluster][: 1 + i % 3]
    if i % 17 == 0:
        genres = [1, *genres]   # an unnamed genre sorts first; the label skips it
    if i % 59 == 0:
        genres = []
    return {
        "tmdb_id": i,
        "kind": kind,
        "title": title,
        "year": year,
        "release_date": release,
        "status": status,
        "vote_count": None if i % 47 == 0 else (i * 37) % 700,
        "popularity": None if i == 83 else ((i * 7919) % 1000) / 10 + i / 1000 + (0.0005 if kind == "tv" else 0),
        "vote_average": 5 + (i % 50) / 10,
        "overview": None if i % 13 == 0 else f"Synthetic overview {i}",
        "poster_path": None if i % 11 == 0 else f"/{kind}/{i}.jpg",
        "genres": genres,
        "cluster": cluster,
        # 67s are in the KNN index but have no features (join miss); 71s are
        # nowhere in the vector store.
        "features": i % 67 != 0 and i % 71 != 0,
        "vec": i % 71 != 0,
    }


CATALOG = [catalog_row("movie", i) for i in range(1, 241)] + [catalog_row("tv", i) for i in range(1, 121)]

# (table, row, minutes ago for ts)
HOUSEHOLD = {
    "library_items": [("movie", i) for i in (29, 59, 5, 12, 18, 33, 40)] + [("tv", i) for i in (4, 10, 16, 22, 28, 70)],
    "user_feedback": [
        (A, "movie", 7, "like"), (A, "movie", 13, "like"), (A, "movie", 8, "dislike"),
        (A, "movie", 9, "dislike"), (A, "movie", 14, "reject"), (A, "movie", 15, "clicked"),
        (A, "movie", 21, "added"), (A, "movie", 26, "watched"), (A, "movie", 8, "watched"),
        (A, "tv", 3, "like"), (A, "tv", 9, "dislike"), (A, "tv", 11, "watched"), (A, "tv", 15, "clicked"),
        (B, "movie", 100, "like"),
    ],
    "household_rejections": [("movie", 20), ("movie", 34), ("tv", 5)],
    "recently_shown": [
        (A, "movie", 6, 5), (A, "movie", 11, 10), (A, "movie", 17, 2 * 1440),
        (A, "movie", 23, 40 * 1440), (A, "movie", 24, 1440),
        (A, "tv", 7, 3), (A, "tv", 13, 60 * 1440), (B, "movie", 50, 5),
    ],
}

LIB_MOVIE = [{"tmdb_id": i, "title": base_title(i), "source": "radarr"} for i in (29, 59, 5, 12, 18, 33, 40, 66, 67, 71)] + [
    {"tmdb_id": 90001, "title": "Not In Catalog"},
    {"tmdb_id": None, "title": base_title(101)},   # owned by title only
    {"title": None},
]
LIB_TV = [{"tmdb_id": i, "title": base_title(i)} for i in (4, 10, 16, 22, 28, 70)] + [{"tmdb_id": 44}]
FB_MOVIE = [{"tmdb_id": 7, "signal": "like"}, {"tmdb_id": 13, "signal": "like"}, {"tmdb_id": 8, "signal": "dislike"},
            {"tmdb_id": 14, "signal": "reject"}, {"tmdb_id": 26, "signal": "dislike"}, {"tmdb_id": 35, "signal": "watched"}]
FB_TV = [{"tmdb_id": 3, "signal": "like"}, {"tmdb_id": 9, "signal": "dislike"}, {"tmdb_id": 12, "signal": "reject"}]


def inline(kind: str, **kw) -> dict:
    body = {
        "sub": A,
        "kind": kind,
        "n": 20,
        "library": LIB_MOVIE if kind == "movie" else LIB_TV,
        "feedback": FB_MOVIE if kind == "movie" else FB_TV,
        "household_rejections": [20, 34, 36] if kind == "movie" else [5],
    }
    body.update(kw)
    return body


def active(recipe: str, params: str = "{}") -> list:
    return [["v-old", "baseline_cosine", "{}", 0], ["v-golden", recipe, params, 1]]


def sc(name, body, model_config=(), config=None, raw=None, secret=EVENT_SECRET):
    return {"name": name, "model_config": list(model_config), "config": config or {},
            "body": body, "raw": raw, "secret": secret}


NO_EMB_LIB = [{"tmdb_id": 90001 + i} for i in range(12)]

SCENARIOS = [
    sc("mmr_default_movie", inline("movie")),
    sc("mmr_default_tv", inline("tv")),
    sc("baseline_movie", inline("movie"), active("baseline_cosine")),
    sc("baseline_tv", inline("tv"), active("baseline_cosine")),
    sc("baseline_stored_only", {"sub": A, "kind": "movie"}, active("baseline_cosine")),
    sc("mmr_stored_only_tv", {"sub": A, "kind": "tv"}, active("mmr_diverse")),
    sc("baseline_keep_recent", inline("movie", exclude_recently_shown=False), active("baseline_cosine")),
    sc("baseline_params", inline("movie", n=30), active("baseline_cosine",
       '{"pool_size": 40, "negative_weight": 1.5, "popularity_weight": 2.0, '
       '"personalized_threshold": 0.9, "min_vote_count": 0}')),
    sc("mmr_params", inline("movie", n=12), active("mmr_diverse",
       '{"mmr_lambda": 0.3, "mmr_input_k": 30, "pool_size": 120}')),
    sc("mmr_lambda_one", inline("tv"), active("mmr_diverse", '{"mmr_lambda": 1.0}')),
    sc("mmr_sanitized", inline("movie"), active("mmr_diverse",
       '{"pool_size": "big", "mmr_lambda": 7, "mmr_input_k": 3.5, "negative_weight": true, '
       '"min_vote_count": -5, "unknown": 1, "personalized_threshold": -2}')),
    sc("baseline_half_even_pool", inline("movie"), active("baseline_cosine", '{"pool_size": 2.5}')),
    sc("baseline_half_even_pool_up", inline("movie"), active("baseline_cosine", '{"pool_size": 3.5}')),
    sc("params_not_json", inline("movie"), active("baseline_cosine", "not json")),
    sc("params_not_object", inline("movie"), active("baseline_cosine", "[1, 2]")),
    sc("unknown_recipe", inline("movie"), active("nope")),
    sc("unknown_recipe_custom_default", inline("tv"), active("nope"), {"default_recipe": "baseline_cosine"}),
    sc("unknown_default_recipe", inline("movie"), (), {"default_recipe": "nope"}),
    # A's stored clicked/added/watched rows merge into any inline feedback, so
    # a cold start needs B (no engagement rows).
    sc("cold_start_movie", inline("movie", sub=B, library=[], feedback=[], household_rejections=[])),
    sc("cold_start_tv_stored_signals", {"sub": B, "kind": "tv", "library": []}),
    sc("engagement_is_taste", inline("movie", library=[], feedback=[], household_rejections=[])),
    sc("cold_start_b_threshold", inline("movie", sub=B, feedback=[]), (), {"cold_start_threshold": 100}),
    sc("engagement_beats_threshold", inline("movie", feedback=[]), (), {"cold_start_threshold": 100}),
    sc("no_embeddings_not_cold", inline("movie", sub=B, library=NO_EMB_LIB, feedback=[])),
    sc("cold_start_trending_active", inline("movie"), active("cold_start_trending", '{"min_vote_count": 0}')),
    sc("empty_pool", inline("movie"), active("baseline_cosine", '{"min_vote_count": 100000}')),
    sc("n_1", inline("tv", n=1), active("mmr_diverse")),
    sc("n_50", inline("movie", n=50), active("baseline_cosine", '{"min_vote_count": 0}')),
    sc("likes_only_tv", {"sub": B, "kind": "tv", "library": [], "feedback": [{"tmdb_id": 3, "signal": "like"}]},
       active("baseline_cosine")),
    sc("n_string_bool_words", inline("movie", n="7", exclude_recently_shown="NO")),
    # 422s, 401
    sc("missing_body", None),
    sc("bad_n_low", inline("movie", n=0)),
    sc("bad_n_high", inline("movie", n=51)),
    sc("bad_n_float", inline("movie", n=2.5)),
    sc("bad_bool", inline("movie", exclude_recently_shown="maybe")),
    sc("bad_bool_num", inline("movie", exclude_recently_shown=2)),
    sc("bad_library", inline("movie", library="x")),
    sc("bad_library_items", inline("movie", library=["x", {"tmdb_id": 0, "title": 5, "source": 7}, None])),
    sc("bad_feedback", inline("movie", feedback=[{"tmdb_id": 1, "signal": "shown"}, {"signal": "like"}])),
    sc("bad_rejections", inline("movie", household_rejections=[0, "1", True, 2])),
    sc("bad_sub_kind", {**inline("movie", sub="garbage"), "kind": "show"}),
    sc("bad_everything", {"sub": 5, "kind": None, "n": None, "exclude_recently_shown": None,
                          "library": 5, "feedback": {}, "household_rejections": "x"}),
    sc("unparsable", None, raw='{"sub": '),
    sc("wrong_secret", inline("movie"), secret="wrong"),
]


def seed(conn) -> None:
    from app.db import encode_vec_rowid, serialize_f32

    import numpy as np

    for r in CATALOG:
        conn.execute(
            """INSERT INTO titles(tmdb_id, kind, title, year, release_date, overview, poster_path,
                                  vote_average, vote_count, popularity, status, adult, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '2026-01-01')""",
            (r["tmdb_id"], r["kind"], r["title"], r["year"], r["release_date"], r["overview"],
             r["poster_path"], r["vote_average"], r["vote_count"], r["popularity"], r["status"]),
        )
        for g in r["genres"]:
            conn.execute("INSERT INTO title_genres VALUES (?, ?, ?)", (r["tmdb_id"], r["kind"], g))
        blob = serialize_f32(np.array(embedding(r["kind"], r["tmdb_id"], r["cluster"]), dtype=np.float32))
        if r["features"]:
            conn.execute("INSERT INTO title_features VALUES (?, ?, '{}', ?, ?, '2026-01-01')",
                         (r["tmdb_id"], r["kind"], blob, DIM))
        if r["vec"]:
            conn.execute("INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, ?, ?)",
                         (encode_vec_rowid(r["kind"], r["tmdb_id"]), r["kind"], blob))
    for kind, tid in HOUSEHOLD["library_items"]:
        conn.execute("INSERT INTO library_items VALUES (?, ?, 'radarr', '2026-01-01')", (kind, tid))
    for sub, kind, tid, signal in HOUSEHOLD["user_feedback"]:
        conn.execute("INSERT INTO user_feedback VALUES (?, ?, ?, ?, '2026-01-01')", (sub, kind, tid, signal))
    for kind, tid in HOUSEHOLD["household_rejections"]:
        conn.execute("INSERT INTO household_rejections VALUES (?, ?, '2026-01-01')", (kind, tid))
    for sub, kind, tid, minutes in HOUSEHOLD["recently_shown"]:
        conn.execute(
            "INSERT INTO recently_shown VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', ?))",
            (sub, kind, tid, f"-{minutes} minutes"),
        )
    conn.commit()


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["RECOMMENDER_DB_PATH"] = str(Path(tmp) / "exchange.db")
        os.environ["EEX_REQUIRE_BINDING"] = "1"
        for k in ("NODE_ENV", "RECOMMENDER_EVENT_SECRET", "INTERNAL_PRINCIPAL_SECRET",
                  "RECOMMENDER_INTERNAL_PRINCIPAL_MODE", "RECOMMENDER_COLD_START_THRESHOLD",
                  "RECOMMENDER_DEFAULT_RECIPE"):
            os.environ.pop(k, None)
        sys.path.insert(0, str(REPO / "recommender"))
        from fastapi.testclient import TestClient  # noqa: E402

        from app import config as config_module  # noqa: E402
        from app import db as db_module  # noqa: E402
        from app import internal_principal as ip_module  # noqa: E402
        from app import main as main_module  # noqa: E402

        base = config_module.CONFIG
        assert base.cold_start_threshold == 10 and base.default_recipe == "mmr_diverse"
        db_module.migrate()
        conn = db_module.connect()
        seed(conn)
        conn.close()
        client = TestClient(main_module.app, raise_server_exceptions=False)
        for s in SCENARIOS:
            conn = db_module.connect()
            conn.execute("DELETE FROM model_config")
            conn.executemany(
                "INSERT INTO model_config(version, recipe, params_json, active, created_at) "
                "VALUES (?, ?, ?, ?, '2026-01-01')",
                s["model_config"],
            )
            conn.commit()
            conn.close()
            cfg = replace(base, event_secret=EVENT_SECRET, internal_principal_mode="off", **s["config"])
            for m in (config_module, main_module, ip_module, db_module):
                m.CONFIG = cfg
            raw = s["raw"] if s["raw"] is not None else (None if s["body"] is None else json.dumps(s["body"]))
            headers = {"x-recommender-secret": s["secret"]}
            if raw is not None:
                headers["content-type"] = "application/json"
            r = client.post("/score", headers=headers, content=raw.encode() if raw is not None else None)
            s["raw"] = raw
            s["expect"] = {"status": r.status_code, "body": r.json()}
            del s["body"]
        for m in (config_module, main_module, ip_module, db_module):
            m.CONFIG = base

    golden = {
        "event_secret": EVENT_SECRET,
        "dim": DIM,
        "catalog": CATALOG,
        "household": HOUSEHOLD,
        "scenarios": SCENARIOS,
    }
    path = HERE / "score-goldens.json"
    path.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + "\n")
    ok = sum(1 for s in SCENARIOS if s["expect"]["status"] == 200)
    print(f"wrote {path}: {len(SCENARIOS)} scenarios, {ok} scored")


if __name__ == "__main__":
    main()
