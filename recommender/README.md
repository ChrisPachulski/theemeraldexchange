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
      fused.py          production recipe: content + cast/crew fused re-rank
      item_knn.py
  workers/
    tmdb_ingest.py      bootstrap (Phase A) + nightly changes (Phase B)
    featurize.py        compute title_features vectors
    optimizer.py        nightly Claude-driven model_config tuning + auto-promote
  migrations/
    0001_initial.sql … 0008_user_feedback_watched.sql
  eval/
    README.md           holdout format + how to provision a real one
    build_holdout.py    generator: recommender DB snapshot -> holdout JSONL
    holdout.example.jsonl  syntactic template (3 fake rows, NOT real data)
    holdout.seed.jsonl  committed vetted seed so the optimizer isn't record-only
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
RECOMMENDER_EVENT_SECRET=local-dev-secret make serve
```

Then:

```bash
curl -XPOST localhost:8000/score \
  -H 'content-type: application/json' \
  -H 'x-recommender-secret: local-dev-secret' \
  -d '{"sub":"u1","kind":"tv","n":20}'
```

## Production

Runs as a sibling container in the project's `docker-compose.yml` (service name
`recommender`). Only reachable inside the Docker network — Hono is the public
surface via Cloudflare Tunnel.

## Model recipes

Each recipe in `app/recipes/` exposes a single `score(user_ctx, candidates) -> [Pick]`.
Adding a new recipe is just dropping a file in that folder and registering it.
The active recipe + its weights live in the `model_config` table — the optimizer
edits this nightly with a ±20% weight-drift cap.

## Eval holdout

The optimizer's promotion gate evaluates candidates against a holdout of real
past sessions. That file (`eval/holdout.jsonl`) **deliberately does not ship in
the tree** — it is operator-curated household history, so it is gitignored
(`recommender/.gitignore`) and excluded from the deploy rsync
(`scripts/deploy-nas.sh`). The `eval/` directory itself IS copied into the
image (the generator must be runnable via `docker exec`); what ships in it:
`build_holdout.py`, `eval/holdout.example.jsonl` (a 3-row syntactic template,
not real data) and `eval/holdout.seed.jsonl` (a committed, vetted seed baked
into the image so a fresh deployment isn't stuck record-only).

Provisioning a real holdout (full detail in `eval/README.md`):

```bash
# Inside the recommender container (default DB path /data/exchange.db):
docker exec exchange-recommender sh -c 'python -m eval.build_holdout > /data/holdout.jsonl'

# From the host, against a copied snapshot:
RECOMMENDER_DB_PATH=./snapshot.db \
  python recommender/eval/build_holdout.py > recommender/eval/holdout.jsonl
```

At runtime the optimizer resolves the holdout path in order:
`RECOMMENDER_HOLDOUT_PATH` env (point it at the generated file on the
persistent `/data` volume) → repo-relative `eval/holdout.jsonl` (local dev) →
the baked-in `eval/holdout.seed.jsonl`. Without a usable holdout the optimizer
records candidates as inactive proposals and never auto-promotes.
