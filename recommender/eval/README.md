# Eval holdout

`holdout.jsonl` — **one JSON object per line** (JSONL, not JSON
array). The optimizer evaluates candidate model configs against
these examples before promoting; without a populated file every
optimizer run records its candidate as an inactive proposal and
auto-promotion stays off (see `workers/optimizer.py:load_holdout`).

Each line:

```json
{
  "sub": "plex-user-sub",
  "kind": "movie",
  "library": [603, 27205, 11],
  "positives": [157336, 1726],
  "negatives": [603534]
}
```

* `library` — TMDB ids the household has indexed (household-scoped;
  the model treats them as the positive centroid).
* `positives` — TMDB ids this user later liked / added / clicked.
  Scorer rewards recall against these.
* `negatives` — ids the user later rejected / disliked. Scorer
  penalizes false positives against these.

`holdout.example.jsonl` ships in this directory as a syntactically
valid template (3 rows). It is NOT real user data — don't copy it
into production; use the generator script below to build a real
file from your own database.

This file is gitignored. Build it from a recommender DB snapshot:

```bash
# Inside the recommender container (default DB path /data/exchange.db):
docker exec exchange-recommender sh -c 'python -m eval.build_holdout > /data/holdout.jsonl'

# From the host, against a copied snapshot:
RECOMMENDER_DB_PATH=./snapshot.db \
  python recommender/eval/build_holdout.py > recommender/eval/holdout.jsonl
```

The generator filters to (sub, kind) pairs that have at least one
positive outcome AND a library of at least three titles in the
last 30 days (`HOLDOUT_LOOKBACK_DAYS` env to override). Anything
under those floors is too noisy to score against, so it gets
dropped at build time rather than polluting the eval signal.

**Why not just `sqlite3 -mode json`?** That mode emits a single
JSON array, not JSONL. `workers/optimizer.py` reads line-by-line
(`json.loads(line)` per line) — a JSON-array file silently parses
as zero usable rows and the auto-promotion gate stays off without
any visible error.
