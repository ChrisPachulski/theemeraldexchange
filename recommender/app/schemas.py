from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StrictInt, field_validator

from .sub_validation import validate_sub

Kind = Literal["movie", "tv"]
Provenance = Literal["personalized", "discover", "trending"]
PositiveStrictInt = Annotated[int, Field(strict=True, gt=0)]


def _check_sub(v: str) -> str:
    """Pydantic field validator — proxies to `validate_sub` so every
    inbound `sub` runs through the canonical regex per §8 of the
    cross-service contract."""
    return validate_sub(v)


class LibraryItem(BaseModel):
    tmdb_id: PositiveStrictInt | None = None
    title: str | None = None
    source: str | None = None


class FeedbackEntry(BaseModel):
    tmdb_id: PositiveStrictInt
    signal: Literal["like", "dislike", "reject", "clicked", "added"]


class ScoreRequest(BaseModel):
    sub: str = Field(..., description="Plex user id; the per-user feedback partition key")
    kind: Kind

    _validate_sub = field_validator("sub")(_check_sub)
    n: int = Field(20, ge=1, le=50)
    exclude_recently_shown: bool = True
    # Allow callers to push the source-of-truth library + feedback in-line so
    # we don't have to keep two stores in sync. When absent, we use what the
    # recommender already has in its tables.
    library: list[LibraryItem] | None = Field(default=None, max_length=5000)
    feedback: list[FeedbackEntry] | None = Field(
        default=None,
        max_length=5000,
        description="Omit to use stored feedback; pass a list, including [], as authoritative.",
    )
    household_rejections: list[PositiveStrictInt] | None = Field(
        default=None,
        max_length=5000,
        description="Omit to use stored rejections; pass a list, including [], as authoritative.",
    )


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

    _validate_sub = field_validator("sub")(_check_sub)


class ClearFeedbackRequest(BaseModel):
    sub: str
    kind: Kind
    tmdb_id: StrictInt
    signal: Literal["like", "dislike", "reject"] | None = None

    _validate_sub = field_validator("sub")(_check_sub)


class LibrarySyncItem(BaseModel):
    tmdb_id: StrictInt
    source: str | None = None


class LibrarySyncRequest(BaseModel):
    kind: Kind
    items: list[LibrarySyncItem] = Field(default_factory=list, max_length=5000)
    force: bool = False
    confirm_purge: bool = False


class ShownEventRequest(BaseModel):
    sub: str
    kind: Kind
    tmdb_ids: list[StrictInt] = Field(default_factory=list, max_length=200)

    _validate_sub = field_validator("sub")(_check_sub)


class ImpressionItem(BaseModel):
    tmdb_id: StrictInt
    rank: int = Field(..., ge=0)
    score: float
    provenance: Provenance
    model_version: str


class ImpressionEventRequest(BaseModel):
    sub: str
    kind: Kind
    items: list[ImpressionItem] = Field(default_factory=list, max_length=200)

    _validate_sub = field_validator("sub")(_check_sub)


class RejectionEventRequest(BaseModel):
    kind: Kind
    tmdb_id: StrictInt


class HealthResponse(BaseModel):
    ok: bool
    db_path: str
    titles: int
    title_vectors: int
    active_model_version: str | None
    # Caller-identity enforcement mode (off/log/enforce) so operators can detect
    # an identity-unauthenticated deployment. Optional for back-compat.
    internal_principal_mode: str | None = None
    # Optimizer holdout health: {"mode": "active"|"record-only"|"unknown", ...}.
    optimizer: dict[str, Any] | None = None
