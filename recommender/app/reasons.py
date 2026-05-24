"""Templated 'why this' string generation. No LLM.

Recipes give us a Candidate + the top-K nearest items from the user's
positive set (library + likes). This module turns that into a short string
that fits the existing UI pill (≤ ~80 chars).
"""

from __future__ import annotations

from .context import Candidate, TitleRow, UserContext

_TMDB_GENRES = {
    # Movies + TV — overlap is fine; lookups are by id.
    28: "action", 12: "adventure", 16: "animation", 35: "comedy", 80: "crime",
    99: "documentary", 18: "drama", 10751: "family", 14: "fantasy", 36: "history",
    27: "horror", 10402: "music", 9648: "mystery", 10749: "romance",
    878: "sci-fi", 10770: "tv movie", 53: "thriller", 10752: "war", 37: "western",
    10759: "action & adventure", 10762: "kids", 10763: "news",
    10764: "reality", 10765: "sci-fi & fantasy", 10766: "soap",
    10767: "talk", 10768: "war & politics",
}


def _genre_label(genre_ids: tuple[int, ...]) -> str | None:
    for gid in genre_ids:
        name = _TMDB_GENRES.get(gid)
        if name:
            return name
    return None


def personalized_reason(cand: Candidate, neighbors: list[TitleRow]) -> str:
    """`matches Severance, Andor` — drop year, cap at two neighbors."""
    if not neighbors:
        g = _genre_label(cand.title.genre_ids)
        return f"new {g} pick" if g else "based on your taste"
    parts = [n.title for n in neighbors[:2]]
    return f"matches {', '.join(parts)}"


def discover_reason(cand: Candidate) -> str:
    g = _genre_label(cand.title.genre_ids)
    if g and cand.title.year:
        return f"{cand.title.year} {g} you haven't seen"
    if g:
        return f"{g} you might've missed"
    return "outside your usual lane"


def trending_reason(title: TitleRow) -> str:
    g = _genre_label(title.genre_ids)
    if g:
        return f"trending in {g}"
    return "trending now"


def neighbors_for(cand: Candidate, ctx: UserContext, k: int = 2) -> list[TitleRow]:
    """Find the k library/like titles whose embeddings are closest to cand."""
    import numpy as np

    pool_ids: list[int] = []
    pool_embs: list[np.ndarray] = []

    # Use the embedding-aligned id lists, NOT sorted(ids). The matrix
    # skips ids without an embedding; sorting the raw id set and zipping
    # would mis-align every row after the first missing one and cite
    # the wrong neighbor in the "matches X, Y" pill.
    if ctx.library_embeddings is not None:
        for tid, emb in zip(ctx.library_embedding_ids, ctx.library_embeddings, strict=True):
            pool_ids.append(tid)
            pool_embs.append(emb)
    if ctx.liked_embeddings is not None:
        for tid, emb in zip(ctx.liked_embedding_ids, ctx.liked_embeddings, strict=True):
            pool_ids.append(tid)
            pool_embs.append(emb)

    if not pool_embs:
        return []

    pool = np.vstack(pool_embs)
    cand_norm = cand.embedding / max(np.linalg.norm(cand.embedding), 1e-9)
    pool_norm = pool / np.linalg.norm(pool, axis=1, keepdims=True).clip(min=1e-9)
    sims = pool_norm @ cand_norm
    top = sims.argsort()[::-1][:k]
    out: list[TitleRow] = []
    for idx in top:
        tid = pool_ids[idx]
        tr = ctx.library_titles.get(tid) or ctx.liked_titles.get(tid)
        if tr is not None:
            out.append(tr)
    return out
