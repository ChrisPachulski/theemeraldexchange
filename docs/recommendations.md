# Recommendation Pipeline

**Route**: `GET /api/suggestions/:type` (type = `movie` | `tv`), defined in
`server/routes/suggestions.ts` (a thin dispatcher: parse + auth, snapshot the
household, build the safety filters, then hand off to a path runner).

There are **two** pipelines behind that route, selected by one env flag:

| Pipeline | File | When it runs |
|----------|------|--------------|
| **Local recommender** (primary; what production runs) | `server/services/suggestionsRecommenderPath.ts` | `USE_LOCAL_RECOMMENDER=1` |
| **Claude BYO-key** (fallback/legacy) | `server/services/suggestionsClaudePath.ts` | `USE_LOCAL_RECOMMENDER` unset/0 |

Production on the NAS sets `USE_LOCAL_RECOMMENDER=1` (see
`docker-compose.yml`), so the Python recommender sidecar is the system of
record for personalization. The Claude pipeline is retained for deployments
without the sidecar; it is not what members see in prod.

## Shared prologue (both pipelines)

```
Request arrives (Origin-gated even though it's a GET — in local-recommender
mode the refresh writes rotation state via the sidecar, so a hostile
credentialed GET could poison it; see requireTrustedOrigin in the route)
│
├─ Parallel snapshot: library (Sonarr/Radarr, 30s cache) +
│  rejections (permanent veto list) + per-user feedback (likes/dislikes)
├─ Library fetch failure → 502 library_unavailable (never silently
│  treats a missing library as "user owns nothing")
├─ force=trending (explicit Recommended ⇄ Trending toggle) → TMDB
│  trending, household-filtered — honored in EVERY mode
│
└─ Dispatch: USE_LOCAL_RECOMMENDER=1 → recommender path, else Claude path
```

## Primary path: the local recommender sidecar

`recommender/` is a FastAPI + sqlite-vec sidecar in the same compose stack
(service `recommender`, reachable only inside the Docker network). Hono calls
`POST /score` with the household snapshot:

- `library` — items with `tmdb_id` **only when > 0** (Sonarr series often
  carry `tmdbId: 0`; the schema is `tmdb_id > 0`-or-omitted, and one bad id
  422s the whole batch — see `project_recommender_tmdb_id_positive`)
- `feedback` — per-user like/dislike signals (ids > 0)
- `household_rejections` — the permanent veto list, by TMDB id

Inside the sidecar (`recommender/app/`):

1. **Retrieval** (`retrieval.py`): sqlite-vec ANN around the household's
   positive embedding centroid, anti-joined against
   `library ∪ rejections ∪ recently-shown ∪ dislikes` *before* ranking.
2. **Recipe** (`app/recipes/`): the active recipe + weights live in the
   `model_config` table. Production runs `fused` — content-embedding cosine
   fused with IDF-weighted cast/crew overlap, scored as max-similarity to any
   single library item (not the averaged centroid). `baseline_cosine`,
   `mmr_diverse`, `item_knn`, and `cold_start_trending` are also registered.
3. **Cold start**: handled inside the sidecar
   (`RECOMMENDER_COLD_START_THRESHOLD`, default 10) via the
   `cold_start_trending` recipe — the server does not pre-empt it.
4. **Learning loop**: a nightly optimizer (`workers/optimizer.py`) proposes
   weight changes (±20% drift cap) and only auto-promotes when the candidate
   beats baseline on the eval holdout (see `recommender/eval/README.md`).

Back in Hono (`suggestionsRecommenderPath.ts`):

- Picks are re-filtered by `filterRecommenderSafe` — **id + full normalized
  title only**. The base-form franchise matching used elsewhere is
  deliberately excluded here: it collapsed "Batman: Bad Blood" to "batman"
  and blanket-banned whole franchises (the strip-capped-at-~7 bug).
- Empty/failed score → TMDB trending fallback (full `filterHouseholdSafe`),
  mirrored back to the sidecar via `/events/shown` so rotation still works.
  A sidecar outage is reported to Glitchtip, never hidden.
- **No trending tail-padding.** A short personalized strip renders short;
  only a genuinely empty result falls back to trending.
- Rendered picks are reported back as impressions (`/events/impressions`)
  so the funnel metrics and recently-shown rotation stay truthful.
- `_diag` carries `modelVersion`, `recipe`, the sidecar's own diag block,
  and `costCents: 0` (no tokens are spent on this path).

### The household veto contract

Red-dot rejections are **permanent** — never FIFO-evicted, never capped at
the persistence layer (`feedback_never_suggest_is_permanent`). They are
enforced twice: by id inside the sidecar's retrieval anti-join, and again in
Hono's `filterRecommenderSafe` (id + exact normalized title, so a
TMDB-duplicate id of a vetoed title is still suppressed).

## Fallback path: Claude BYO-key pipeline

Only reachable when `USE_LOCAL_RECOMMENDER` is off. Model:
`claude-haiku-4-5` (`MODEL` in `server/services/suggestionsPrompt.ts`).

### Key resolution (changed 2026-06-11)

The Anthropic key is the *user's own* (BYO). Resolution order in
`suggestionsClaudePath.ts`:

1. `X-Anthropic-Api-Key` request header — back-compat for pre-migration
   SPAs and scripted callers; header wins when present.
2. The user's **server-stored key**: `PUT /api/settings/anthropic-key`
   (`server/routes/settings.ts`) stores it encrypted at rest per sub —
   AES-256-GCM with an HKDF-derived data key and the sub bound as AAD
   (`server/services/userApiKeys.ts`). The SPA never holds the key after
   save; the UI sees only a set-flag + masked last-4
   (`src/lib/hooks/useUserApiKey.ts`, which also migrates any legacy
   localStorage key to the server on first authenticated mount).
3. Neither present → `402 api_key_required`.

### Flow

```
1. Cold start: library < 10 → TMDB trending + hint
2. Fetch candidate pool (TMDB /discover seeded by top-5 library genres:
   3 quality pages + 1 novelty page, deduped, shuffled per request)
3. Build prompt: cached library block (cache_control: ephemeral) +
   priority-taste + user-likes + recently-shown (capped at 80% of pool
   size) + numbered candidate pool
4. Claude call (forced tool_use, per-request salt for refresh variety)
5. Validate picks: pool fast-path (no /search), TMDB lookup for the rest,
   year-proximity guard (movies), library/rejection/dedup drops
6. Short of 20 with actionable feedback → one retry with tool_result
   feedback
7. Still short → fill from genre-seeded /discover, then trending
8. Record shown; respond with per-item provenance + _diag
```

Claude's job is to *rank* the pre-vetted pool, not generate from its
popularity prior — that is what keeps the picks off the mainstream-blockbuster
attractor and keeps TMDB /search traffic low.

## Provenance (both pipelines)

| Value | Meaning |
|-------|---------|
| `personalized` | recommender pick above its personalized threshold / accepted Claude pick |
| `discover` | TMDB /discover fill (genre-seeded) |
| `trending` | TMDB trending (cold start, explicit toggle, or fallback) |

The UI renders a pip on the card for `personalized` (emerald) and `discover`
(cool-white); trending cards have no pip.

## _diag payload (observability)

Every response includes `_diag`. Shared fields: `libraryCount`,
`rejectionCount`, `libraryGenres`, `librarySnapshotAgeHours`.

Recommender path adds: `modelVersion`, `recipe`, `rec` (the sidecar's diag:
elapsed ms, retrieval counts, recipe internals), `recommenderReturned`,
`fillCount` (always 0 since tail-padding was removed; kept for back-compat),
`path` markers on the fallback branches.

Claude path adds: `poolSize`, `poolHits`, `poolHitRate`, `accepted`,
`retryAttempted`, `fillSource`, `droppedPicks`, `lastCounters`, `costCents`,
`cacheHitRate`, `claudeTruncated`.

## Caching (Claude path; the recommender owns its own state)

| Layer | TTL | Purpose |
|-------|-----|---------|
| Library cache (Sonarr/Radarr) | 30s | shared by both pipelines |
| Library prompt-block cache | in-memory LRU | avoid rebuilding when library unchanged |
| TMDB discover/pool + trending | 5 min | pool + fill share one /discover call |
| Anthropic prompt cache | 5 min (ephemeral) | cached library block ~10x cheaper |

## Error handling

| Condition | Behavior |
|-----------|----------|
| Recommender /score throws | TMDB trending fallback + Glitchtip warning |
| Library unavailable | 502 `library_unavailable` (no silent trending) |
| TMDB 429 | retry once after `Retry-After` (cap 10s) |
| Anthropic 529/503 | retry once after 3s |
| Claude throws / no tool_use | trending fallback, `source: trending_fallback` |
| No BYO key (Claude path) | 402 `api_key_required` |

## Running the eval harness

```bash
# Mocked eval (no real keys needed):
npm run eval:recs

# Live eval (requires real keys):
RECS_EVAL_LIVE=1 ANTHROPIC_API_KEY=sk-ant-... TMDB_API_KEY=... npm run eval:recs
```

Eval reports are written to `.planning/ai-recommendations-loop/eval-runs/`.
The recommender's own offline eval (holdout-gated optimizer) is documented in
`recommender/eval/README.md`.
