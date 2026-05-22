from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Kind = Literal["movie", "tv"]
Provenance = Literal["personalized", "discover", "trending"]


class LibraryItem(BaseModel):
    tmdb_id: int
    title: str | None = None
    source: str | None = None


class FeedbackEntry(BaseModel):
    tmdb_id: int
    signal: Literal["like", "dislike", "reject"]


class ScoreRequest(BaseModel):
    sub: str = Field(..., description="Plex user id; the per-user feedback partition key")
    kind: Kind
    n: int = Field(20, ge=1, le=50)
    exclude_recently_shown: bool = True
    # Allow callers to push the source-of-truth library + feedback in-line so
    # we don't have to keep two stores in sync. When absent, we use what the
    # recommender already has in its tables.
    library: list[LibraryItem] | None = None
    feedback: list[FeedbackEntry] | None = None
    household_rejections: list[int] | None = None


class ScoredItem(BaseModel):
    tmdb_id: int
    title: str | None = None
    year: int | None = None
    poster_path: str | None = None
    overview: str | None = None
    score: float
    provenance: Provenance
    reason: str | None = None


class ScoreResponse(BaseModel):
    items: list[ScoredItem]
    model_version: str
    recipe: str
    diag: dict[str, object] = Field(default_factory=dict)


class FeedbackEventRequest(BaseModel):
    sub: str
    kind: Kind
    tmdb_id: int
    signal: Literal["like", "dislike", "reject", "shown", "clicked", "added"]


class HealthResponse(BaseModel):
    ok: bool
    db_path: str
    titles: int
    title_vectors: int
    active_model_version: str | None
