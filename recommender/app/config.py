from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    db_path: Path
    migrations_dir: Path
    host: str
    port: int

    tmdb_api_key: str | None
    anthropic_api_key: str | None

    embed_model: str
    embed_dim: int

    cold_start_threshold: int
    default_recipe: str

    optimizer_max_drift_pct: float
    optimizer_max_tokens: int


def _path(env_name: str, default: str) -> Path:
    return Path(os.environ.get(env_name, default)).resolve()


def load() -> Config:
    return Config(
        db_path=_path("RECOMMENDER_DB_PATH", "./data/exchange.db"),
        migrations_dir=_path("RECOMMENDER_MIGRATIONS_DIR", str(Path(__file__).resolve().parent.parent / "migrations")),
        host=os.environ.get("RECOMMENDER_HOST", "127.0.0.1"),
        port=int(os.environ.get("RECOMMENDER_PORT", "8000")),
        tmdb_api_key=os.environ.get("TMDB_API_KEY") or None,
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        embed_model=os.environ.get("RECOMMENDER_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
        embed_dim=int(os.environ.get("RECOMMENDER_EMBED_DIM", "384")),
        cold_start_threshold=int(os.environ.get("RECOMMENDER_COLD_START_THRESHOLD", "10")),
        default_recipe=os.environ.get("RECOMMENDER_DEFAULT_RECIPE", "mmr_diverse"),
        optimizer_max_drift_pct=float(os.environ.get("RECOMMENDER_OPTIMIZER_MAX_DRIFT_PCT", "0.20")),
        optimizer_max_tokens=int(os.environ.get("RECOMMENDER_OPTIMIZER_MAX_TOKENS", "8000")),
    )


CONFIG = load()
