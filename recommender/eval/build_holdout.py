"""Build eval/holdout.jsonl from a recommender DB snapshot.

The optimizer (workers/optimizer.py) reads JSONL — one object per
line, shape: { sub, kind, library[], positives[], negatives[] }.
The previous docs suggested SQLite's `.mode json`, which emits a
single JSON array, not JSONL — feeding that file into the optimizer
would either crash (json.JSONDecodeError per line) or silently
fall through to the "no holdout" path and disable auto-promotion.

Usage (inside the container, or with RECOMMENDER_DB_PATH set):

    python -m eval.build_holdout > /data/holdout.jsonl

Or, from the host, against a snapshot copy:

    RECOMMENDER_DB_PATH=./snapshot.db python recommender/eval/build_holdout.py \\
        > recommender/eval/holdout.jsonl

The query joins rec_log → rec_outcomes for one row per (sub, kind)
in the last 30 days, then unions in the household library at write
time so library size matches the model's view of the user. A user
must have at least one positive AND at least three library items
to make it into the holdout — otherwise the eval signal is too
noisy to be worth scoring against.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

DB_PATH = os.environ.get("RECOMMENDER_DB_PATH", "/data/recommender.db")
LOOKBACK_DAYS = int(os.environ.get("HOLDOUT_LOOKBACK_DAYS", "30"))
MIN_LIBRARY = 3
MIN_POSITIVES = 1


def main() -> int:
    p = Path(DB_PATH)
    if not p.exists():
        print(f"db not found: {p}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row

    library_by_kind: dict[str, list[int]] = {"movie": [], "tv": []}
    for row in conn.execute("SELECT kind, tmdb_id FROM library_items ORDER BY tmdb_id"):
        library_by_kind.setdefault(row["kind"], []).append(row["tmdb_id"])

    rows = conn.execute(
        f"""
        SELECT
          r.sub,
          r.kind,
          r.tmdb_id,
          o.outcome
        FROM rec_log r
        JOIN rec_outcomes o ON o.rec_id = r.id
        WHERE r.ts >= datetime('now', '-{LOOKBACK_DAYS} days')
        """
    )

    by_user: dict[tuple[str, str], dict[str, set[int]]] = {}
    for r in rows:
        key = (r["sub"], r["kind"])
        bucket = by_user.setdefault(key, {"positives": set(), "negatives": set()})
        if r["outcome"] in ("liked", "added", "clicked"):
            bucket["positives"].add(r["tmdb_id"])
        elif r["outcome"] in ("rejected", "disliked"):
            bucket["negatives"].add(r["tmdb_id"])

    emitted = 0
    for (sub, kind), bucket in sorted(by_user.items()):
        library = library_by_kind.get(kind, [])
        if len(library) < MIN_LIBRARY or len(bucket["positives"]) < MIN_POSITIVES:
            continue
        entry = {
            "sub": sub,
            "kind": kind,
            "library": library,
            "positives": sorted(bucket["positives"]),
            "negatives": sorted(bucket["negatives"]),
        }
        print(json.dumps(entry))
        emitted += 1

    print(f"wrote {emitted} holdout rows from {p}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
