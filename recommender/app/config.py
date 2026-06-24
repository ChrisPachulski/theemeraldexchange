from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


EVENT_SECRET_MIN_LEN = 32
EVENT_SECRET_PLACEHOLDERS = {
    "changeme",
    "change-me",
    "change_me",
    "placeholder",
    "secret",
    "password",
    "test",
    "test-secret",
    "replaceme",
    "replace-me",
    "replace_me",
    "your-secret-here",
    "session-secret",
}


INTERNAL_PRINCIPAL_MODES = {"off", "log", "enforce"}


@dataclass(frozen=True)
class Config:
    db_path: Path
    migrations_dir: Path
    host: str
    port: int

    tmdb_api_key: str | None
    anthropic_api_key: str | None
    event_secret: str | None

    # Internal-principal verification per contract §4. Hono attaches a
    # JWE on every outbound call; this service verifies it via the PyO3
    # binding. Mode defaults to "enforce" in production (secure by default;
    # load() fail-fasts if the secret is missing) and "off" outside
    # production so dev/CI keeps working. Operators can pin "log" during
    # rollout, or explicitly set "off" in production to opt out.
    internal_principal_secret: str | None
    internal_principal_mode: str

    embed_model: str
    embed_dim: int

    cold_start_threshold: int
    default_recipe: str

    optimizer_max_drift_pct: float
    optimizer_max_tokens: int
    rec_log_retention_days: int


def _path(env_name: str, default: str) -> Path:
    return Path(os.environ.get(env_name, default)).resolve()


def _validate_secret(env_name: str) -> str | None:
    raw = os.environ.get(env_name)
    if raw is None or raw.strip() == "":
        return None
    if os.environ.get("NODE_ENV") != "production":
        return raw
    if raw.lower() in EVENT_SECRET_PLACEHOLDERS:
        raise ValueError(f"{env_name} looks like a placeholder value")
    if len(raw) < EVENT_SECRET_MIN_LEN:
        raise ValueError(
            f"{env_name} must be at least {EVENT_SECRET_MIN_LEN} characters"
        )
    return raw


def _event_secret() -> str | None:
    return _validate_secret("RECOMMENDER_EVENT_SECRET")


def _internal_principal_secret() -> str | None:
    return _validate_secret("INTERNAL_PRINCIPAL_SECRET")


def _internal_principal_mode() -> str:
    # Secure-by-default in production: when the operator hasn't pinned a mode,
    # production verifies caller identity ("enforce") rather than silently
    # ignoring the inbound JWE ("off"). Outside production the default stays
    # "off" so dev/CI keeps working without provisioning the secret. An
    # operator can still explicitly opt out in production with
    # RECOMMENDER_INTERNAL_PRINCIPAL_MODE=off.
    env_raw = os.environ.get("RECOMMENDER_INTERNAL_PRINCIPAL_MODE")
    if env_raw is None or env_raw.strip() == "":
        return "enforce" if os.environ.get("NODE_ENV") == "production" else "off"
    raw = env_raw.strip().lower()
    if raw not in INTERNAL_PRINCIPAL_MODES:
        raise ValueError(
            f"RECOMMENDER_INTERNAL_PRINCIPAL_MODE={raw!r} must be one of "
            f"{sorted(INTERNAL_PRINCIPAL_MODES)}"
        )
    return raw


def load() -> Config:
    internal_principal_secret = _internal_principal_secret()
    internal_principal_mode = _internal_principal_mode()
    # In production, a verifying mode (log/enforce) is useless without a secret:
    # internal_principal_dep() fail-closes with a 503 on every request. Fail
    # fast at startup instead, so the misconfiguration is loud rather than a
    # silent per-request outage. Operators who genuinely want no caller-identity
    # verification must set RECOMMENDER_INTERNAL_PRINCIPAL_MODE=off explicitly.
    if (
        os.environ.get("NODE_ENV") == "production"
        and internal_principal_mode in {"log", "enforce"}
        and internal_principal_secret is None
    ):
        raise ValueError(
            "INTERNAL_PRINCIPAL_SECRET must be set when "
            f"RECOMMENDER_INTERNAL_PRINCIPAL_MODE is {internal_principal_mode!r} "
            "(the production default). Provision the secret, or set "
            "RECOMMENDER_INTERNAL_PRINCIPAL_MODE=off to explicitly opt out."
        )
    # /score AND every /events/* endpoint depend on the event secret
    # (require_event_secret 503s without it), so in production an unset secret
    # makes the whole recommender inert — and the backend then silently degrades
    # every user to trending. Fail fast at startup so the misconfiguration is a
    # loud boot crash, not a silent per-request outage. (The compose default
    # leaves RECOMMENDER_EVENT_SECRET empty, so this is a real first-deploy trap.)
    event_secret = _event_secret()
    if os.environ.get("NODE_ENV") == "production" and event_secret is None:
        raise ValueError(
            "RECOMMENDER_EVENT_SECRET must be set in production: /score and all "
            "/events/* endpoints 503 without it, so the recommender is inert. "
            "Provision the secret (shared with the Hono backend)."
        )
    return Config(
        db_path=_path("RECOMMENDER_DB_PATH", "./data/exchange.db"),
        migrations_dir=_path("RECOMMENDER_MIGRATIONS_DIR", str(Path(__file__).resolve().parent.parent / "migrations")),
        host=os.environ.get("RECOMMENDER_HOST", "127.0.0.1"),
        port=int(os.environ.get("RECOMMENDER_PORT", "8000")),
        tmdb_api_key=os.environ.get("TMDB_API_KEY") or None,
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        event_secret=event_secret,
        internal_principal_secret=internal_principal_secret,
        internal_principal_mode=internal_principal_mode,
        embed_model=os.environ.get("RECOMMENDER_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
        embed_dim=int(os.environ.get("RECOMMENDER_EMBED_DIM", "384")),
        cold_start_threshold=int(os.environ.get("RECOMMENDER_COLD_START_THRESHOLD", "10")),
        default_recipe=os.environ.get("RECOMMENDER_DEFAULT_RECIPE", "mmr_diverse"),
        optimizer_max_drift_pct=float(os.environ.get("RECOMMENDER_OPTIMIZER_MAX_DRIFT_PCT", "0.20")),
        optimizer_max_tokens=int(os.environ.get("RECOMMENDER_OPTIMIZER_MAX_TOKENS", "8000")),
        rec_log_retention_days=int(os.environ.get("RECOMMENDER_REC_LOG_RETENTION_DAYS", "90")),
    )


CONFIG = load()
