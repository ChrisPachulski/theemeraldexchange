"""Record featurize goldens from the untouched Python worker.

perturbations: _genre_perturbation / _keyword_perturbation for a spread of
single ids, a few multi-id lists (the keyword list runs past the 30-id cap),
and ids whose 8 / 4 draws repeat an index (numpy's `out[idx] += signs` writes a
repeated index once). Stored sparse as [index, value] pairs; the Rust test
compares them exactly.

stages: a tiny fixture DB featurized by workers.featurize.run with the pinned
MiniLM (HF cache, offline) through first run, rerun, stale rows, a model
identity change and a limited run. Each stage records the pending rows (after
the identity reconcile), the processed count and the identity row; the first
and last stages also record every title_features row. The Rust tests replay
the stages without the model (pending, identity) and with it (vectors within
1e-4, feature JSON).

    HF_HUB_OFFLINE=1 <main checkout>/recommender/.venv/bin/python \\
        crates/recommender/tests/fixtures/gen_featurize_goldens.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

LONG = " ".join(
    f"Chapter {i}: the crew of the drifting station argues about rationing, sabotage and home."
    for i in range(40)
)

# (tmdb_id, kind, title, overview, fetched_at, genres, keywords)
TITLES = [
    (1, "movie", "Alpha", "A veteran astronaut leads a rescue mission.", "2026-01-01T00:00:00+00:00",
     [28, 12], [818, 9715]),
    (1, "tv", "Alpha Show", "Astronauts cross the solar system.", "2026-01-01T00:00:00+00:00",
     [10759], []),
    (2, "movie", "Beta", None, "2026-01-02T00:00:00+00:00", [], [180547]),
    (3, "movie", "", "Only an overview, no title.", "2025-12-31T00:00:00+00:00", [18], []),
    (4, "tv", "Gamma", LONG, "2026-01-03T00:00:00+00:00", [18, 10765],
     [5000 + 37 * k for k in range(35)]),
    (5, "movie", "Delta", "  A chef opens a café — with her brother.  ", "2026-01-03T00:00:00+00:00",
     [35, 10751, 16], [4565]),
]


def sparse(v) -> list:
    return [[int(i), float(v[i])] for i in range(len(v)) if v[i] != 0]


def main() -> None:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["RECOMMENDER_DB_PATH"] = str(Path(tmp) / "exchange.db")
        for k in ("NODE_ENV", "RECOMMENDER_EMBED_MODEL", "RECOMMENDER_EMBED_MODEL_REVISION",
                  "RECOMMENDER_EMBED_DIM"):
            os.environ.pop(k, None)
        sys.path.insert(0, str(REPO / "recommender"))
        import numpy as np  # noqa: E402

        from app import db as db_module  # noqa: E402
        from app.config import CONFIG  # noqa: E402
        from workers import featurize  # noqa: E402

        dim = CONFIG.embed_dim
        identity = f"{CONFIG.embed_model}@{CONFIG.embed_revision}"

        def dup_ids(prefix: str, picks: int, fn) -> list[int]:
            import hashlib
            found = []
            for i in range(1, 100000):
                h = hashlib.blake2s(f"{prefix}:{i}".encode(), digest_size=4).digest()
                rng = np.random.default_rng(int.from_bytes(h, "big"))
                idx = rng.integers(0, dim, size=picks)
                if len(set(idx.tolist())) < picks:
                    found.append(i)
                    if len(found) == 3:
                        return found
            raise SystemExit("no duplicate-index id found")

        genre_cases = [[g] for g in (0, 1, 12, 16, 18, 27, 28, 35, 53, 99, 878, 9648, 10402, 10749,
                                     10751, 10752, 10759, 10765, 10770, 2**31, 2**40)]
        genre_cases += [[g] for g in dup_ids("g", 8, featurize._genre_perturbation)]
        genre_cases += [[28, 12, 16, 35], [18, 18], []]
        keyword_cases = [[k] for k in (1, 818, 4565, 9715, 10084, 180547, 210024, 999999999)]
        keyword_cases += [[k] for k in dup_ids("k", 4, featurize._keyword_perturbation)]
        keyword_cases += [[5000 + 37 * k for k in range(35)], [818, 9715, 818], []]
        perturbations = {
            "genre": [{"ids": c, "out": sparse(featurize._genre_perturbation(dim, c))}
                      for c in genre_cases],
            "keyword": [{"ids": c, "out": sparse(featurize._keyword_perturbation(dim, c))}
                        for c in keyword_cases],
        }

        db_module.migrate()
        conn = db_module.connect()
        for tid, kind, title, overview, fetched, genres, keywords in TITLES:
            conn.execute(
                "INSERT INTO titles(tmdb_id, kind, title, overview, fetched_at) VALUES (?, ?, ?, ?, ?)",
                (tid, kind, title, overview, fetched),
            )
            conn.executemany(
                "INSERT INTO title_genres(tmdb_id, kind, genre_id) VALUES (?, ?, ?)",
                [(tid, kind, g) for g in genres],
            )
            conn.executemany(
                "INSERT INTO title_keywords(tmdb_id, kind, keyword_id) VALUES (?, ?, ?)",
                [(tid, kind, k) for k in keywords],
            )
        conn.commit()

        def dump(conn) -> list:
            rows = conn.execute(
                "SELECT tmdb_id, kind, feature_json, embedding, dim FROM title_features "
                "ORDER BY kind, tmdb_id"
            ).fetchall()
            return [
                {"tmdb_id": r["tmdb_id"], "kind": r["kind"], "feature_json": r["feature_json"],
                 "dim": r["dim"],
                 "embedding": [float(f"{x:.9g}") for x in
                               db_module.deserialize_f32(r["embedding"], r["dim"]).tolist()]}
                for r in rows
            ]

        stages = []

        def stage(name: str, sql: list[str], limit: int | None = None, keep_rows: bool = False):
            conn = db_module.connect()
            for s in sql:
                conn.execute(s)
            conn.commit()
            featurize._reconcile_model_identity(conn, identity)
            pending = [[r["kind"], r["tmdb_id"]] for r in featurize._load_pending(conn, limit)]
            conn.close()
            processed = featurize.run(limit=limit)
            conn = db_module.connect()
            ident = conn.execute(
                "SELECT value FROM ingest_state WHERE key = 'embed_model'"
            ).fetchone()["value"]
            vec_rows = conn.execute("SELECT COUNT(*) FROM title_vec").fetchone()[0]
            out = {"name": name, "sql": sql, "limit": limit, "pending": pending,
                   "processed": processed, "identity": ident, "title_vec_rows": vec_rows}
            if keep_rows:
                out["rows"] = dump(conn)
            conn.close()
            stages.append(out)

        stage("first", [], keep_rows=True)
        stage("rerun", [])
        stage("stale", [
            "UPDATE titles SET overview = 'Rewritten plot about a heist.', "
            "fetched_at = '2026-06-01T00:00:00+00:00' WHERE tmdb_id = 2 AND kind = 'movie'",
            "UPDATE title_features SET computed_at = '2026-05-01T00:00:00+00:00' "
            "WHERE tmdb_id = 2 AND kind = 'movie'",
            "INSERT INTO titles(tmdb_id, kind, title, overview, fetched_at) VALUES "
            "(6, 'movie', 'Epsilon', 'A new arrival.', '2026-02-01T00:00:00+00:00')",
        ])
        stage("model_changed", ["UPDATE ingest_state SET value = 'old/model@deadbeef'"])
        stage("limited", ["UPDATE ingest_state SET value = 'old/model@deadbeef'"], limit=2)
        stage("limited_rest", [], keep_rows=True)

    golden = {"dim": dim, "identity": identity, "titles": TITLES,
              "perturbations": perturbations, "stages": stages}
    (HERE / "featurize-goldens.json").write_text(json.dumps(golden, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
