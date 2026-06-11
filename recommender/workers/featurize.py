"""Build per-title feature vectors.

The vector is a concatenation of:
  * the overview text embedded by sentence-transformers (384d for MiniLM)
  * a multi-hot genre fingerprint (small dim, weighted)
  * a hashed-keyword bag (small dim, weighted)

For now we keep dim aligned with the embed model's native size and rely on
the text embedding to carry most of the signal; the multi-hot pieces are
added as a small additive perturbation so two same-overview titles in
different genres still separate slightly.

The result lands in two places:
  * ``title_features`` keeps the raw vector + the JSON feature blob so we
    can re-quantize or change the encoding later without re-running
    ingest.
  * ``title_vec`` (sqlite-vec) is the searchable index used by /score.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sqlite3
from datetime import datetime, timezone

import numpy as np

from app.config import CONFIG
from app.db import connect, encode_vec_rowid, serialize_f32, transaction

log = logging.getLogger("featurize")

GENRE_WEIGHT = 0.30
KEYWORD_WEIGHT = 0.15
COMMIT_CHUNK_SIZE = 256


def _normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def _genre_perturbation(dim: int, genre_ids: list[int]) -> np.ndarray:
    """Deterministic small vector in {-1,0,1}^dim hashed from each genre id."""
    out = np.zeros(dim, dtype=np.float32)
    for gid in genre_ids:
        h = hashlib.blake2s(f"g:{gid}".encode(), digest_size=4).digest()
        seed = int.from_bytes(h, "big") % (2**32)
        rng = np.random.default_rng(seed)
        idx = rng.integers(0, dim, size=min(8, dim))
        signs = rng.choice([-1.0, 1.0], size=idx.shape)
        out[idx] += signs
    return out


def _keyword_perturbation(dim: int, keyword_ids: list[int]) -> np.ndarray:
    out = np.zeros(dim, dtype=np.float32)
    for kid in keyword_ids[:30]:
        h = hashlib.blake2s(f"k:{kid}".encode(), digest_size=4).digest()
        seed = int.from_bytes(h, "big") % (2**32)
        rng = np.random.default_rng(seed)
        idx = rng.integers(0, dim, size=min(4, dim))
        signs = rng.choice([-1.0, 1.0], size=idx.shape)
        out[idx] += signs
    return out


def _load_pending(conn: sqlite3.Connection, limit: int | None) -> list[sqlite3.Row]:
    # Pick rows in two states:
    #   1. Never featurized: f.tmdb_id IS NULL — initial bootstrap path.
    #   2. STALE: f.computed_at < t.fetched_at — the row exists, but the
    #      titles record was re-fetched (typically by tmdb_ingest --mode
    #      changes overwriting via ON CONFLICT DO UPDATE) more recently
    #      than the features were computed. Without the stale check, the
    #      nightly /changes job updates plot/genres/keywords on the
    #      titles row but the embedding stays anchored to the OLD
    #      overview text — retrieval keeps recommending against pre-
    #      revision content and learning loops can't see the new signal.
    #
    # The titles.fetched_at < title_features.computed_at case is
    # implicit-OK: features are newer than the source row, so no rework.
    q = """
        SELECT t.tmdb_id, t.kind, t.title, t.overview,
               (SELECT GROUP_CONCAT(g.genre_id ORDER BY g.genre_id) FROM title_genres g
                WHERE g.kind = t.kind AND g.tmdb_id = t.tmdb_id) AS genres,
               (SELECT GROUP_CONCAT(k.keyword_id ORDER BY k.keyword_id) FROM title_keywords k
                WHERE k.kind = t.kind AND k.tmdb_id = t.tmdb_id) AS keywords
        FROM titles t
        LEFT JOIN title_features f ON f.kind = t.kind AND f.tmdb_id = t.tmdb_id
        WHERE f.tmdb_id IS NULL
           OR f.computed_at < t.fetched_at
        ORDER BY t.fetched_at ASC, t.kind, t.tmdb_id
    """
    if limit:
        q += f" LIMIT {int(limit)}"
    return conn.execute(q).fetchall()


def _ids_csv(s: str | None) -> list[int]:
    if not s:
        return []
    return [int(x) for x in s.split(",") if x.strip()]


def run(*, limit: int | None = None) -> int:
    from sentence_transformers import SentenceTransformer

    conn = connect()
    model = SentenceTransformer(CONFIG.embed_model)
    dim = CONFIG.embed_dim

    pending = _load_pending(conn, limit)
    if not pending:
        log.info("nothing to featurize")
        return 0
    log.info("featurizing %d titles with %s (dim=%d)", len(pending), CONFIG.embed_model, dim)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    total = 0
    for offset in range(0, len(pending), COMMIT_CHUNK_SIZE):
        chunk = pending[offset : offset + COMMIT_CHUNK_SIZE]
        texts = [
            " — ".join(
                x for x in (r["title"], r["overview"] or "") if x
            )
            for r in chunk
        ]
        text_embs = model.encode(
            texts,
            batch_size=64,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=True,
        ).astype(np.float32)

        feature_rows: list[tuple] = []
        vec_rows: list[tuple] = []
        for row, txt_emb in zip(chunk, text_embs, strict=True):
            genre_ids = _ids_csv(row["genres"])
            keyword_ids = _ids_csv(row["keywords"])
            g_pert = GENRE_WEIGHT * _genre_perturbation(dim, genre_ids)
            k_pert = KEYWORD_WEIGHT * _keyword_perturbation(dim, keyword_ids)
            vec = _normalize(txt_emb + g_pert + k_pert)
            feature_json = json.dumps({
                "genres": genre_ids,
                "keywords": keyword_ids,
                "text_norm": float(np.linalg.norm(txt_emb)),
            })
            blob = serialize_f32(vec)
            feature_rows.append((row["tmdb_id"], row["kind"], feature_json, blob, dim, now))
            # vec0's rowid is globally unique despite the PARTITION KEY, so
            # encode kind into the rowid to avoid movie/TV id collisions
            # (TMDB ids are not unique across namespaces).
            vec_rows.append((encode_vec_rowid(row["kind"], int(row["tmdb_id"])), row["kind"], blob))

        with transaction(conn):
            conn.executemany(
                """INSERT INTO title_features(tmdb_id, kind, feature_json, embedding, dim, computed_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(tmdb_id, kind) DO UPDATE SET
                     feature_json=excluded.feature_json,
                     embedding=excluded.embedding,
                     dim=excluded.dim,
                     computed_at=excluded.computed_at""",
                feature_rows,
            )
            # vec0 doesn't honor INSERT OR REPLACE cleanly with a partition key;
            # do DELETE-then-INSERT in a single transaction instead. rowid is
            # already kind-encoded so the DELETE matches at most one row.
            conn.executemany(
                "DELETE FROM title_vec WHERE rowid = ? AND kind = ?",
                [(rowid, kind) for rowid, kind, _ in vec_rows],
            )
            conn.executemany(
                "INSERT INTO title_vec(rowid, kind, embedding) VALUES (?, ?, ?)",
                vec_rows,
            )
        total += len(feature_rows)
        log.info("featurized %d/%d titles", total, len(pending))

    return total


def _cli() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run(limit=args.limit)


if __name__ == "__main__":
    _cli()
