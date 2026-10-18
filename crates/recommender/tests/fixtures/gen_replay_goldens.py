"""Record replay-eval goldens from the untouched research/household_eval.py.

A synthetic snapshot dir (no household data) is built in a temp dir: an
exchange.db with the ranker golden's catalog (gen_score_goldens.seed plus
gen_ranker_goldens.seed_extras) and a synthetic owner's user_feedback and
rec_log / rec_outcomes history spread around the cutoffs, plus library.json
(Radarr/Sonarr-shaped, with `added`), user-feedback.json and rejections.json.
household_eval.evaluate then runs for ranker (prod params) and fused, movie
and tv, at both gate cutoffs; its result dicts are the golden (NaN written as
null). The Rust replay (src/replay_eval/tests.rs) rebuilds the same snapshot
and must match every value to 4 decimals.

The catalog's "this year" is pinned to 2026 as in gen_ranker_goldens.py.

    <main checkout>/recommender/.venv/bin/python \
        crates/recommender/tests/fixtures/gen_replay_goldens.py
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import time
import types
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(HERE))

from gen_score_goldens import base_title  # noqa: E402

THIS_YEAR = 2026
OWNER = "local:replay-owner"
CUTOFFS = ["2026-06-15", "2026-07-01"]
CASES = [("ranker", {"kids_genre_cap": 0.15}), ("fused", {})]


def day(i: int) -> str:
    return (date(2026, 5, 1) + timedelta(days=(i * 37) % 120)).isoformat()


def snapshot() -> dict:
    fb_rows, rec_rows = [], []
    for kind, top in (("movie", 240), ("tv", 120)):
        for i in range(1, top + 1):
            sig = ("dislike" if i % 7 == 1 else "added" if i % 11 == 2 else "clicked" if i % 13 == 3
                   else "watched" if i % 17 == 4 else "like" if i % 19 == 5 else None)
            if sig:
                fb_rows.append([OWNER, kind, i, sig, f"{day(i)}T12:00:00.000000+00:00"])
            if i % 9 == 0 and i % 7 != 1:
                fb_rows.append([OWNER, kind, i, "dislike", f"{day(i + 3)}T08:00:00.000000+00:00"])
            if i % 5 == 0:
                outcome = ["clicked", "added", "disliked", "ignored", None, "disliked"][(i // 5) % 6]
                rec_rows.append([OWNER, kind, i, f"{day(i + 1)}T09:30:00.000000+00:00", outcome])
        fb_rows.append(["local:someone-else", kind, 3, "added", "2026-06-01T00:00:00.000000+00:00"])
        rec_rows.append(["local:someone-else", kind, 4, "2026-07-02T00:00:00.000000+00:00", "added"])

    library = {}
    for kind, top in (("movie", 240), ("tv", 120)):
        items = []
        for i in range(2, top + 1, 4):
            items.append({"tmdbId": i, "title": base_title(i), "added": f"{day(i * 3)}T10:00:00Z"})
        items += [
            {"tmdbId": None, "title": "No Id", "added": "2026-05-02T00:00:00Z"},
            {"tmdbId": 0, "title": "Zero Id", "added": "2026-05-02T00:00:00Z"},
            {"tmdbId": 90001, "title": "Not In Catalog", "added": "2026-07-20T00:00:00Z"},
            {"tmdbId": 90002, "title": "Not In Catalog Early", "added": "2026-05-20T00:00:00Z"},
        ]
        library[kind] = items
    feedback_json = {
        OWNER: {
            "movie": {"liked": [{"id": i} for i in (3, 23, 43, 63)], "disliked": [{"id": i} for i in (8, 28, 48, 0)]},
            "tv": {"liked": [{"id": i} for i in (3, 33)], "disliked": [{"id": i} for i in (8, 38)]},
        },
        "local:someone-else": {"movie": {"liked": [{"id": 5}]}},
    }
    rejections = {"movie": [{"id": i} for i in (14, 34, 54, 74)], "tv": [{"id": i} for i in (14, 44)]}
    return {"owner": OWNER, "user_feedback": fb_rows, "rec_log": rec_rows, "library": library,
            "user_feedback_json": feedback_json, "rejections": rejections}


def json_safe(v):
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else v
    if isinstance(v, dict):
        return {k: json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [json_safe(x) for x in v]
    return v


def main() -> None:
    snap = snapshot()
    with tempfile.TemporaryDirectory() as tmp:
        sd = Path(tmp)
        os.environ.update({"EEX_SNAP": str(sd), "EEX_OWNER_SUB": OWNER, "RECOMMENDER_DB_PATH": str(sd / "exchange.db")})
        for k in ("NODE_ENV", "EEX_REQUIRE_BINDING", "RECOMMENDER_COLD_START_THRESHOLD", "RECOMMENDER_DEFAULT_RECIPE"):
            os.environ.pop(k, None)
        sys.path.insert(0, str(REPO / "recommender"))
        sys.path.insert(0, str(REPO / "recommender" / "research"))
        from app import db as db_module  # noqa: E402
        from app.recipes import fused, ranker  # noqa: E402
        from gen_ranker_goldens import seed_extras  # noqa: E402
        from gen_score_goldens import seed  # noqa: E402

        ranker.time = types.SimpleNamespace(gmtime=lambda: types.SimpleNamespace(tm_year=THIS_YEAR), time=time.time)

        db_module.migrate()
        conn = db_module.connect()
        seed(conn)
        seed_extras(conn)
        for row in snap["user_feedback"]:
            conn.execute("INSERT INTO user_feedback(sub, kind, tmdb_id, signal, ts) VALUES (?, ?, ?, ?, ?)", row)
        for n, (sub, kind, tid, ts, outcome) in enumerate(snap["rec_log"]):
            cur = conn.execute(
                "INSERT INTO rec_log(sub, kind, tmdb_id, rank, score, provenance, model_version, ts) "
                "VALUES (?, ?, ?, ?, 0.5, 'discover', 'v', ?)", (sub, kind, tid, n % 20, ts))
            if outcome:
                conn.execute("INSERT INTO rec_outcomes(rec_id, outcome, ts) VALUES (?, ?, ?)", (cur.lastrowid, outcome, ts))
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()
        (sd / "library.json").write_text(json.dumps(snap["library"]))
        (sd / "user-feedback.json").write_text(json.dumps(snap["user_feedback_json"]))
        (sd / "rejections.json").write_text(json.dumps(snap["rejections"]))

        import household_eval  # noqa: E402

        assert household_eval.OWNER == OWNER and household_eval.SNAP == sd
        cases = []
        for recipe, params in CASES:
            for kind in ("movie", "tv"):
                for cutoff in CUTOFFS:
                    ranker._MODELS.clear()
                    fused._IDF.clear()
                    out = household_eval.evaluate(recipe, kind, cutoff, params)
                    cases.append({"recipe": recipe, "kind": kind, "cutoff": cutoff, "params": params,
                                  "out": json_safe(out)})
                    print(json.dumps(out))

    path = HERE / "replay-goldens.json"
    path.write_text(json.dumps({"this_year": THIS_YEAR, "snapshot": snap, "cases": cases}, indent=1) + "\n")
    print(f"wrote {path}: {len(cases)} cases")


if __name__ == "__main__":
    main()
