"""Record ranker and fused goldens from the untouched Python recipes.

The /score golden's synthetic catalog and household (gen_score_goldens.py)
plus synthetic cast, crew, keywords, languages, TMDB collections, TV
last-air dates and a few fresh releases are seeded into one fresh migrated
exchange.db. Each scenario loads the Python UserContext for a /score body and
records the ranker's intermediates (catalog arrays, refs and log-odds, the
training feature matrix, fitted weights / mean / std, the candidate rows and
their features, the slate) and the final items and diag of ranker.score /
fused.score, plus ranker.score_ids for a few ids. The Rust replay
(src/recipes/ranker/tests.rs) matches features and weights within 1e-6
relative (weights 1e-4 under a ridge below 1), model scores within 1e-5, and
ids, rows and item order exactly.

The catalog's "this year" is pinned to 2026 (ranker reads time.gmtime()), so
the fresh flags do not move with the calendar; the replay pins the same year.

    <main checkout>/recommender/.venv/bin/python \
        crates/recommender/tests/fixtures/gen_ranker_goldens.py
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))

from gen_score_goldens import A, B, CATALOG, HOUSEHOLD, base_title, inline  # noqa: E402

THIS_YEAR = 2026
LANGS = ["en", "en", "en", "fr", "ja", "ko"]


def extras(r: dict) -> dict:
    """Synthetic credits, keywords, language, collection, air date, fresh year."""
    kind, i = r["kind"], r["tmdb_id"]
    year = r["year"]
    if kind == "movie" and i % 10 == 3:
        year = THIS_YEAR - 1
    elif i % 25 == 7:
        year = THIS_YEAR
    if kind == "movie":
        if i % 11 == 0:
            raw = None
        elif i % 5 == 0:
            raw = {"belongs_to_collection": {"id": 900 + i % 7}}
        elif i % 7 == 0:
            raw = {"belongs_to_collection": None}
        else:
            raw = {"id": i}
    else:
        if i % 4 == 0:
            last = f"{THIS_YEAR - 1}-10-01"
        elif i % 9 == 0:
            last = ""
        elif i % 13 == 0:
            last = None
        elif i % 6 == 1:
            last = f"{THIS_YEAR}-02-11"
        else:
            last = f"{2000 + i % 20}-05-05"
        raw = {"last_air_date": last}
    cast, seen = [], set()
    for k in range(3 + i % 10):
        person = (i * 31 + k * 17) % 90 + 1
        if person in seen:
            continue
        seen.add(person)
        cast.append([person, None if (i % 15 == 0 and k == 1) else k])
    crew = [[1000 + i % 25, "Director"], [1000 + (i * 7) % 40, "Writer"]]
    if i % 3 == 0:
        crew.append([1100 + i % 10, "Producer"])
    if i % 8 == 0:
        crew.append([1000 + i % 25, "Screenplay"])
    crew = [list(c) for c in dict.fromkeys(tuple(c) for c in crew)]
    keywords = sorted({5000 + (i * 13 + k * 29) % 45 for k in range(i % 6)})
    return {
        "kind": kind, "tmdb_id": i, "year": year,
        "original_language": None if i % 29 == 0 else LANGS[(i * 5) % 6],
        "raw_json": None if raw is None else json.dumps(raw),
        "cast": cast, "crew": crew, "keywords": keywords,
    }


EXTRAS = [extras(r) for r in CATALOG]

LIB_BIG = [{"tmdb_id": i, "title": base_title(i)} for i in range(100, 220, 2)]
FB_BIG = [{"tmdb_id": i, "signal": "dislike"} for i in range(1, 60, 3)]

SCENARIOS = [
    ("ranker_movie", "ranker", inline("movie"), {}),
    ("ranker_movie_kids_cap", "ranker", inline("movie"), {"kids_genre_cap": 0.15}),
    ("ranker_tv", "ranker", inline("tv"), {}),
    ("ranker_tv_kids_cap", "ranker", inline("tv"), {"kids_genre_cap": 0.15}),
    ("ranker_movie_big", "ranker", inline("movie", library=LIB_BIG, feedback=FB_BIG, n=30), {}),
    ("ranker_movie_big_params", "ranker", inline("movie", library=LIB_BIG, feedback=FB_BIG, n=25),
     {"pool_size": 80, "interest_clusters": 3, "ridge": 0.5, "calibration": 0.6, "redundancy": 0.4,
      "fresh_share": 0.5, "personalized_threshold": 0.3, "min_vote_count": 0}),
    ("ranker_no_negatives", "ranker", inline("movie", sub=B, feedback=[], household_rejections=[]), {}),
    ("ranker_stored_tv", "ranker", {"sub": A, "kind": "tv"}, {}),
    ("ranker_cold", "ranker", inline("movie", sub=B, library=[], feedback=[], household_rejections=[]), {}),
    ("fused_movie", "fused", inline("movie"), {}),
    ("fused_movie_kids_cap", "fused", inline("movie"), {"kids_genre_cap": 0.15}),
    ("fused_tv", "fused", inline("tv"), {}),
    ("fused_movie_big", "fused", inline("movie", library=LIB_BIG, feedback=FB_BIG, n=30), {}),
    ("fused_likes_only", "fused", {"sub": B, "kind": "tv", "library": [],
                                   "feedback": [{"tmdb_id": 3, "signal": "like"}, {"tmdb_id": 8, "signal": "like"}]},
     {}),
    ("fused_params", "fused", inline("movie", n=15),
     {"cast_weight": 0.0, "crew_weight": 1.2, "cast_topn": 3, "pool_size": 60, "personalized_threshold": 0.6}),
    ("fused_cast_topn", "fused", inline("tv"), {"cast_topn": 2, "content_weight": 0.5}),
    ("fused_cold", "fused", inline("movie", sub=B, library=[], feedback=[], household_rejections=[]), {}),
]


def seed_extras(conn) -> None:
    for e in EXTRAS:
        conn.execute("UPDATE titles SET year = ?, original_language = ?, raw_json = ? WHERE kind = ? AND tmdb_id = ?",
                     (e["year"], e["original_language"], e["raw_json"], e["kind"], e["tmdb_id"]))
        for person, order_idx in e["cast"]:
            conn.execute("INSERT INTO title_cast VALUES (?, ?, ?, ?, ?)",
                         (e["tmdb_id"], e["kind"], person, f"p{person}", order_idx))
        for person, job in e["crew"]:
            conn.execute("INSERT INTO title_crew VALUES (?, ?, ?, ?, ?)",
                         (e["tmdb_id"], e["kind"], person, f"p{person}", job))
        for kw in e["keywords"]:
            conn.execute("INSERT INTO title_keywords VALUES (?, ?, ?, ?)",
                         (e["tmdb_id"], e["kind"], kw, f"k{kw}"))
    conn.commit()


def fl(v) -> float | None:
    v = float(v)
    return None if math.isnan(v) or math.isinf(v) else v


def vec(a) -> list:
    return [fl(v) for v in a]


def mat(m) -> list:
    return [vec(r) for r in m]


def sparse_rows(m) -> list:
    m = m.tocsr()
    m.sort_indices()
    return [[[int(c), float(w)] for c, w in zip(m.indices[m.indptr[r]:m.indptr[r + 1]],
                                               m.data[m.indptr[r]:m.indptr[r + 1]])]
            for r in range(m.shape[0])]


def json_safe(v):
    if isinstance(v, float):
        return fl(v)
    if isinstance(v, dict):
        return {k: json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [json_safe(x) for x in v]
    return v


def dump_catalog(cat) -> dict:
    return {
        "ids": [int(t) for t in cat.ids],
        "rating": vec(cat.rating), "log_votes": vec(cat.log_votes), "log_vote_rate": vec(cat.log_vote_rate),
        "log_pop": vec(cat.log_pop), "age": vec(cat.age), "fresh": [bool(b) for b in cat.fresh],
        "vote_count": vec(cat.vote_count), "available": [bool(b) for b in cat.available],
        "collection": [int(c) for c in cat.collection], "key": cat.key,
        "genres": [list(g) for g in cat.genres],
        "genre": sparse_rows(cat.genre), "lang": sparse_rows(cat.lang), "decade": sparse_rows(cat.decade),
        "cast": sparse_rows(cat.cast), "crew": sparse_rows(cat.crew), "kw": sparse_rows(cat.kw),
    }


def items(result) -> list:
    return [json_safe(it.model_dump()) for it in result.items]


def main() -> None:
    import numpy as np

    with tempfile.TemporaryDirectory() as tmp:
        os.environ["RECOMMENDER_DB_PATH"] = str(Path(tmp) / "exchange.db")
        for k in ("NODE_ENV", "EEX_REQUIRE_BINDING"):
            os.environ.pop(k, None)
        sys.path.insert(0, str(REPO / "recommender"))
        from app import db as db_module  # noqa: E402
        from app.context import load_user_context  # noqa: E402
        from app.recipes import fused, ranker  # noqa: E402
        from app.schemas import ScoreRequest  # noqa: E402
        from gen_score_goldens import seed  # noqa: E402

        ranker.time = types.SimpleNamespace(gmtime=lambda: types.SimpleNamespace(tm_year=THIS_YEAR), time=time.time)

        db_module.migrate()
        conn = db_module.connect()
        seed(conn)
        seed_extras(conn)

        catalogs = {kind: dump_catalog(ranker._catalog(conn, kind)) for kind in ("movie", "tv")}
        out = []
        for name, recipe, body, params in SCENARIOS:
            ranker._MODELS.clear()
            fused._IDF.clear()
            req = ScoreRequest(**body)
            ctx = load_user_context(conn, req, persist_library=False)
            sc = {"name": name, "recipe": recipe, "body": body, "params": params}
            if recipe == "ranker" and ctx.positive_centroid() is not None:
                p = {**ranker.DEFAULTS, **params}
                cat, refs, model = ranker._prepare(ctx, conn, p)
                train_rows = np.concatenate([refs.pos, refs.neg])
                x_train, _ = ranker._features(cat, refs, train_rows)
                sc["refs"] = {
                    "pos": [int(r) for r in refs.pos], "neg": [int(r) for r in refs.neg],
                    "lo_genre": [vec(v) for v in refs.lo_genre],
                    "lo_lang": [vec(v) for v in refs.lo_lang],
                    "lo_decade": [vec(v) for v in refs.lo_decade],
                }
                sc["model"] = {
                    "x": mat(x_train), "w": vec(model.w), "mean": vec(model.mean), "std": vec(model.std),
                    "train_auc": fl(model.train_auc), "n_pos": model.n_pos, "n_neg": model.n_neg,
                }
                if len(refs.pos):
                    owned = {k for t in ctx.library_ids if (r := cat.row.get(t)) is not None and (k := cat.key[r])}
                    ok = ranker._eligible(ctx, cat, int(p["min_vote_count"]), owned)
                    rows, src = ranker._candidates(cat, refs, model, ok, int(p["pool_size"]),
                                                   int(p["interest_clusters"]))
                    x, affinity = ranker._features(cat, refs, rows)
                    z = model.z(x)
                    sc["candidates"] = {"eligible": int(ok.sum()), "rows": [int(r) for r in rows], "src": src,
                                        "x": mat(x), "z": vec(z)}
                    ids = [int(cat.ids[r]) for r in rows[:12]] + [int(cat.ids[refs.pos[0]]), 99999]
                    sc["score_ids"] = {"ids": ids, "scores": {str(k): fl(v) for k, v in
                                                              ranker.score_ids(ctx, conn, ids, params).items()}}
                result = ranker.score(ctx, conn, n=req.n, params=params)
            else:
                mod = ranker if recipe == "ranker" else fused
                result = mod.score(ctx, conn, n=req.n, params=params)
            diag = json_safe(dict(result.diag))
            diag.pop("model_age_s", None)
            sc["items"] = items(result)
            sc["diag"] = diag
            out.append(sc)
        conn.close()

    golden = {
        "numpy": np.__version__,
        "this_year": THIS_YEAR,
        "catalog": CATALOG,
        "household": HOUSEHOLD,
        "extras": EXTRAS,
        "catalogs": catalogs,
        "scenarios": out,
    }
    path = HERE / "ranker-goldens.json"
    path.write_text(json.dumps(golden, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"wrote {path}: {len(out)} scenarios, sizes " +
          ", ".join(f"{s['name']}={len(s['items'])}" for s in out))


if __name__ == "__main__":
    main()
