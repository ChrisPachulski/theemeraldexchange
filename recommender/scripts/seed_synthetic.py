"""Smoke-test seed: insert a handful of synthetic titles + fake embeddings.

Lets us exercise /score without standing up the full TMDB ingest. Each
title gets a deterministic random embedding so MMR + cosine sim produce
stable, debuggable rankings.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import CONFIG  # noqa: E402
from app.db import connect, serialize_f32  # noqa: E402

# Lightweight catalog: each title belongs to one of three "neighborhoods"
# (gritty crime, sci-fi adventure, family animation). The smoke test asks
# for picks given a library full of crime titles — we expect the top
# results to be the other crime titles, not the animations.
TITLES = [
    # gritty crime
    (101, "Heat", 1995, 7.7, [80, 18, 53], "neighborhood:crime"),
    (102, "Sicario", 2015, 7.6, [80, 28, 53], "neighborhood:crime"),
    (103, "Prisoners", 2013, 8.1, [80, 18, 9648], "neighborhood:crime"),
    (104, "Wind River", 2017, 7.7, [80, 18, 9648], "neighborhood:crime"),
    (105, "Hell or High Water", 2016, 7.6, [80, 18, 28], "neighborhood:crime"),
    (106, "The Town", 2010, 7.5, [80, 18, 53], "neighborhood:crime"),
    (107, "Gone Baby Gone", 2007, 7.7, [80, 18, 9648], "neighborhood:crime"),
    # sci-fi adventure
    (201, "Arrival", 2016, 7.9, [878, 18], "neighborhood:scifi"),
    (202, "Annihilation", 2018, 6.8, [878, 18, 27], "neighborhood:scifi"),
    (203, "Ex Machina", 2014, 7.7, [878, 18, 53], "neighborhood:scifi"),
    (204, "Interstellar", 2014, 8.6, [878, 12, 18], "neighborhood:scifi"),
    (205, "Edge of Tomorrow", 2014, 7.9, [878, 28, 12], "neighborhood:scifi"),
    # family animation
    (301, "Up", 2009, 8.2, [16, 10751, 12], "neighborhood:animation"),
    (302, "Inside Out", 2015, 8.1, [16, 10751, 35], "neighborhood:animation"),
    (303, "WALL·E", 2008, 8.4, [16, 10751, 878], "neighborhood:animation"),
    (304, "Coco", 2017, 8.4, [16, 10751, 14], "neighborhood:animation"),
]


def _embedding_for(slug: str, dim: int) -> np.ndarray:
    seed = int.from_bytes(hashlib.blake2s(slug.encode(), digest_size=4).digest(), "big")
    rng = np.random.default_rng(seed)
    v = rng.normal(0, 1, size=dim).astype(np.float32)
    # All titles within a neighborhood share a strong base direction so
    # their cosine sim is high, then a small individual perturbation.
    # Use everything except the trailing ":<tmdb_id>" as the shared key,
    # so all crime titles share `neighborhood:crime` and not `neighborhood`.
    base_key = slug.rsplit(":", 1)[0] if ":" in slug else slug
    base = hashlib.blake2s(base_key.encode(), digest_size=4).digest()
    base_seed = int.from_bytes(base, "big")
    base_v = np.random.default_rng(base_seed).normal(0, 1, size=dim).astype(np.float32)
    v = 0.85 * base_v + 0.15 * v
    return v / max(np.linalg.norm(v), 1e-9)


def main() -> int:
    conn = connect()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    dim = CONFIG.embed_dim

    for tmdb_id, title, year, vote_avg, genres, neighborhood in TITLES:
        kind = "movie"
        conn.execute(
            """INSERT INTO titles(tmdb_id, kind, title, year, release_date, overview,
                                  poster_path, vote_average, vote_count, popularity,
                                  runtime, status, original_language, adult,
                                  fetched_at, raw_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(tmdb_id, kind) DO UPDATE SET
                 title=excluded.title, year=excluded.year, vote_average=excluded.vote_average""",
            (tmdb_id, kind, title, year, f"{year}-01-01", f"{title} is a film about something.",
             None, vote_avg, 1000, 30.0, 120, "Released", "en", 0, now, "{}"),
        )
        conn.execute("DELETE FROM title_genres WHERE kind=? AND tmdb_id=?", (kind, tmdb_id))
        for gid in genres:
            conn.execute("INSERT INTO title_genres(tmdb_id, kind, genre_id) VALUES (?,?,?)", (tmdb_id, kind, gid))

        emb = _embedding_for(neighborhood + f":{tmdb_id}", dim)
        conn.execute(
            """INSERT INTO title_features(tmdb_id, kind, feature_json, embedding, dim, computed_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(tmdb_id, kind) DO UPDATE SET
                 embedding=excluded.embedding, dim=excluded.dim""",
            (tmdb_id, kind, json.dumps({"neighborhood": neighborhood}), serialize_f32(emb), dim, now),
        )
        conn.execute("DELETE FROM title_vec WHERE rowid = ? AND kind = ?", (tmdb_id, kind))
        conn.execute(
            "INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, ?, ?)",
            (tmdb_id, kind, serialize_f32(emb)),
        )

    print(f"seeded {len(TITLES)} titles into {CONFIG.db_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
