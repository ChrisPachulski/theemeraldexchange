"""Stronger + richer content embeddings (post-convergence follow-up).

WHY: the converged result's win was creator-affinity (cast/crew) -- a content-
IRRELEVANT proxy. The novel stratum (no shared cast/crew) scored 0, and so did
PURE content item-retrieval over the deployed MiniLM-L6 embedding of the short
TMDB overview. Diagnosis: the content signal exists (novel titles have a ~0.55
overview-twin) but the representation is NOT DISCRIMINATIVE -- a 2019 MiniLM-L6
over a two-line overview puts thousands of films at ~0.5-0.6, burying the right
one. This tests the real lever (a content-representation problem, NOT missing
behavioral data): richer text (title + overview + theme keywords, all already in
the DB) embedded by a modern model (BGE), then content item-retrieval on the
novel stratum. No watch logs.

Production lineage: Spotify audiobook cold-start uses Sentence-BERT over text
metadata as the content signal (DeNadai 2024); the model + text quality is the
documented lever for content discrimination.

RESEARCH infra (needs torch + sentence-transformers; gitignored venv .venv-embed).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

RECO_DIR = Path(__file__).resolve().parents[1]
if str(RECO_DIR) not in sys.path:
    sys.path.insert(0, str(RECO_DIR))
CACHE = Path(__file__).resolve().parent / "cache"
CACHE.mkdir(exist_ok=True)

DEFAULT_MODEL = "BAAI/bge-base-en-v1.5"
KW_PER_TITLE = 30


def build_texts(conn, kind: str, ids: list[int]) -> dict[int, str]:
    """Enriched per-title text: title (year). overview Themes: kw1, kw2, ...
    Uses title + overview + up to KW_PER_TITLE theme keywords -- all in the DB,
    no re-fetch."""
    out: dict[int, str] = {}
    base: dict[int, tuple] = {}
    for i in range(0, len(ids), 500):
        b = ids[i:i + 500]
        q = ",".join("?" for _ in b)
        for r in conn.execute(
            f"SELECT tmdb_id, title, year, COALESCE(overview,'') AS overview "
            f"FROM titles WHERE kind=? AND tmdb_id IN ({q})", (kind, *b)):
            base[r["tmdb_id"]] = (r["title"], r["year"], r["overview"])
    kws: dict[int, list[str]] = {}
    for i in range(0, len(ids), 500):
        b = ids[i:i + 500]
        q = ",".join("?" for _ in b)
        for r in conn.execute(
            f"SELECT tmdb_id, keyword FROM title_keywords WHERE kind=? AND tmdb_id IN ({q})",
            (kind, *b)):
            kws.setdefault(r["tmdb_id"], []).append(r["keyword"])
    for tid, (title, year, ov) in base.items():
        kw = ", ".join(kws.get(tid, [])[:KW_PER_TITLE])
        parts = [f"{title}" + (f" ({year})" if year else "") + "."]
        if ov:
            parts.append(ov)
        if kw:
            parts.append(f"Themes: {kw}.")
        out[tid] = " ".join(parts)
    return out


def embed_catalog(conn, kind: str, ids: list[int], *, model_name: str = DEFAULT_MODEL,
                  device: str | None = None) -> tuple[list[int], np.ndarray]:
    """Embed enriched text for `ids`; cache to npz. Returns (ids, L2-normed mat)."""
    tag = model_name.replace("/", "_")
    npz = CACHE / f"content_emb_{tag}_{kind}_{len(ids)}.npz"
    if npz.exists():
        d = np.load(npz, allow_pickle=True)
        return list(d["ids"]), d["mat"]

    import torch
    from sentence_transformers import SentenceTransformer
    if device is None:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = SentenceTransformer(model_name, device=device)

    texts_map = build_texts(conn, kind, ids)
    ordered = [i for i in ids if i in texts_map]
    texts = [texts_map[i] for i in ordered]
    mat = model.encode(texts, batch_size=128, show_progress_bar=True,
                        normalize_embeddings=True, convert_to_numpy=True)
    mat = mat.astype(np.float32)
    np.savez(npz, ids=np.array(ordered), mat=mat)
    return ordered, mat


def content_itemknn_recall(M_ids: list[int], M: np.ndarray, lib_ids: list[int],
                           targets: list[int], ks=(10, 50)) -> dict:
    """Leave-one-out content item-knn (max-sim to any library item, full catalog)
    over the given embedding matrix, for the target subset."""
    import math
    idx = {t: i for i, t in enumerate(M_ids)}
    lib = [i for i in lib_ids if i in idx]
    lib_rows = np.array([idx[i] for i in lib])
    lib_set = set(lib)
    agg = {f"recall@{k}": 0.0 for k in ks}
    agg.update({f"ndcg@{k}": 0.0 for k in ks})
    n = 0
    for t in targets:
        if t not in idx:
            continue
        keep = lib_rows[lib_rows != idx[t]]
        sims = M @ M[keep].T
        score = sims.max(axis=1)
        for i in lib_set:
            if i != t:
                score[idx[i]] = -9.0
        top = np.argpartition(-score, max(ks))[:max(ks)]
        top = top[np.argsort(-score[top])]
        ranked = [M_ids[j] for j in top]
        for k in ks:
            if t in ranked[:k]:
                agg[f"recall@{k}"] += 1.0
        if t in ranked[:max(ks)]:
            pos = ranked.index(t)
            for k in ks:
                if pos < k:
                    agg[f"ndcg@{k}"] += 1.0 / math.log2(pos + 2)
        n += 1
    return {"n": n, **{k: round(v / n, 4) if n else 0.0 for k, v in agg.items()}}
