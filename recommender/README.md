# Emerald Exchange — Recommender

Local recommendation service. Owns its own SQLite DB (`/data/exchange.db`) with the
TMDB catalog, household library, per-user feedback, recommendation log, and the
active model config. Hono calls `POST /score` on every `/api/suggestions/:type`
refresh; Claude is *not* on the request path.

## Layout

```
recommender/
  app/
    main.py             FastAPI app: /health, /score, /events/feedback, /events/shown
    db.py               sqlite-vec connection helper + migrations runner
    config.py           env loader (DB path, ANTHROPIC_API_KEY, TMDB key, etc.)
    schemas.py          pydantic models for /score request/response
    recipes/
      __init__.py       recipe registry
      baseline_cosine.py
      mmr_diverse.py
      cold_start_trending.py
  workers/
    tmdb_ingest.py      bootstrap (Phase A) + nightly changes (Phase B)
    featurize.py        compute title_features vectors
    optimizer.py        nightly Claude-driven model_config tuning + auto-promote
  migrations/
    0001_initial.sql
  eval/
    holdout.jsonl       frozen sample of past sessions for the optimizer's eval gate
  Dockerfile
  pyproject.toml
  Makefile
```

## Local quickstart

```bash
make install
make migrate                 # creates ./data/exchange.db
TMDB_API_KEY=... make ingest-bootstrap
make featurize
make serve
```

Then `curl -XPOST localhost:8000/score -d '{"sub":"u1","kind":"tv","n":20}'`.

## Production

Runs as a sibling container in the project's `docker-compose.yml` (service name
`recommender`). Only reachable inside the Docker network — Hono is the public
surface via Cloudflare Tunnel.

## Model recipes

Each recipe in `app/recipes/` exposes a single `score(user_ctx, candidates) -> [Pick]`.
Adding a new recipe is just dropping a file in that folder and registering it.
The active recipe + its weights live in the `model_config` table — the optimizer
edits this nightly with a ±20% weight-drift cap.
