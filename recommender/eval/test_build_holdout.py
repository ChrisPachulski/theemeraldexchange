from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from eval import build_holdout


def test_explicit_negative_removes_prior_engagement_positive(
    tmp_path: Path,
    capsys,
) -> None:
    db_path = tmp_path / "exchange.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE library_items(kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL);
            CREATE TABLE rec_log(
              id INTEGER PRIMARY KEY,
              sub TEXT NOT NULL,
              kind TEXT NOT NULL,
              tmdb_id INTEGER NOT NULL,
              ts TEXT NOT NULL
            );
            CREATE TABLE rec_outcomes(
              rec_id INTEGER NOT NULL,
              outcome TEXT NOT NULL
            );
            """
        )
        conn.executemany(
            "INSERT INTO library_items(kind, tmdb_id) VALUES ('movie', ?)",
            [(10,), (11,), (12,)],
        )
        conn.executemany(
            """INSERT INTO rec_log(id, sub, kind, tmdb_id, ts)
               VALUES (?, 'user-1', 'movie', ?, datetime('now'))""",
            [(1, 42), (2, 99)],
        )
        conn.executemany(
            "INSERT INTO rec_outcomes(rec_id, outcome) VALUES (?, ?)",
            [(1, "clicked"), (2, "clicked"), (2, "disliked")],
        )
        conn.commit()
    finally:
        conn.close()

    old_db_path = build_holdout.DB_PATH
    try:
        build_holdout.DB_PATH = str(db_path)
        assert build_holdout.main() == 0
    finally:
        build_holdout.DB_PATH = old_db_path

    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1
    row = json.loads(out[0])
    assert row["positives"] == [42]
    assert row["negatives"] == [99]
