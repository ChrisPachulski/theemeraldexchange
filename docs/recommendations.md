# AI Recommendation Pipeline

**File**: `server/routes/suggestions.ts`  
**Route**: `GET /api/suggestions/:type` (type = `movie` | `tv`)  
**Model**: `claude-haiku-4-5` (BYO key — household supplies `X-Anthropic-Api-Key` header)

## High-level flow

```
Request arrives
│
├─ force=trending → TMDB trending (no Claude call, AI toggle off)
├─ library < COLD_START_THRESHOLD (10) → TMDB trending + cold-start hint
├─ no Anthropic key → 402
│
└─ Normal path:
   1. Fetch library (Sonarr/Radarr, 30s cache)
   2. Fetch rejections + user likes (parallel with library)
   3. Start candidate pool fetch (TMDB /discover, parallel with backfill)
   4. Build system prompt:
      a. SYSTEM_PROMPT (static, shared across all households)
      b. Library block (cached via cache_control: ephemeral, 5 min TTL)
      c. Priority taste block (top-30 genre-typical titles, volatile)
      d. User likes block (recency-ordered, volatile)
      e. Recently-shown block (per-user buffer, volatile, capped at 80% pool size)
      f. Candidate pool block (60 pre-vetted titles, volatile)
   5. Call Claude (forced tool_use, max_tokens=4096, temperature=0.7, per-request salt)
   6. Validate picks:
      a. Pool fast-path: pool title match → accept without TMDB /search
      b. Non-pool picks: TMDB /search lookup (with year hint, retries without year)
      c. Year-proximity guard (movies only, ±5 years)
      d. Library + rejection dedup (id + normalized title + base title)
   7. If picks < TARGET_COUNT (20) and rejections > 0:
      → Retry with Claude (tool_result feedback, recentlyShown dropped)
   8. If still short:
      → Fill from TMDB /discover (genre-seeded, quality-sorted)
      → Fall back to TMDB trending if discover also falls short
   9. Record shown items (per-user recently-shown buffer)
   10. Return response with provenance per item + _diag payload
```

## Candidate pool architecture

The pool is pre-fetched from TMDB `/discover` seeded by the household's top-5 genres:
- **Quality lane** (3 pages): `sort_by=vote_average.desc, vote_count.gte=100` — acclaimed niche titles
- **Novelty lane** (1 page): `sort_by=primary_release_date.desc, vote_count.gte=30` — recent releases

Pool items are deduplicated by TMDB id and shuffled per-request (Fisher-Yates) so Claude sees a different numbered list on each refresh.

**Why this matters**: Claude's task is to *rank* the pool, not *generate* from its popularity prior. This reduces the "mainstream blockbuster" regression and reduces TMDB /search lookups (pool hits bypass the search round-trip entirely).

## Provenance

Every returned item carries a `provenance` field:

| Value | Meaning |
|-------|---------|
| `personalized` | Claude picked it + validator accepted it |
| `discover` | TMDB /discover fill (genre-seeded, taste-aware) |
| `trending` | TMDB trending fallback (no taste signal) |

The UI renders a pip (dot) on the card for `personalized` (emerald) and `discover` (cool-white). Trending cards have no pip.

## _diag payload (dev-only observability)

Every response includes `_diag` with:

| Field | What it tells you |
|-------|-------------------|
| `libraryCount` | Items in household library |
| `rejectionCount` | Items on the NEVER list |
| `libraryGenres` | Top-5 genre distribution Claude was told to mirror |
| `poolSize` | Items in the filtered+shuffled candidate pool |
| `poolHits` | Claude picks that matched a pool item (no /search round-trip) |
| `poolHitRate` | `poolHits / accepted` — 1.0 is ideal, 0.0 means pool didn't help |
| `accepted` | Claude picks that passed validation |
| `retryAttempted` | Whether a validate-and-retry loop fired |
| `fillSource` | `discover` / `trending` / `discover+trending` (when filling short) |
| `droppedPicks` | Total picks dropped by validation (library + reject + dedup + lookup) |
| `costCents` | Estimated Anthropic spend for this refresh (Haiku 4.5 rates) |
| `claudeTruncated` | `true` when Claude's output was cut by max_tokens |
| `lastCounters` | Breakdown of dropped picks by reason |

## Caching strategy

| Layer | TTL | Purpose |
|-------|-----|---------|
| Library cache (Sonarr/Radarr) | 30s | Avoids fetching hundreds of items on every refresh |
| Library block cache | In-memory (8 entries LRU) | Avoids rebuilding the prompt block when library unchanged |
| TMDB discover/pool cache | 5 min | Pool + fill share this cache (one /discover call per TTL window) |
| TMDB trending cache | 5 min | Cached per kind (movie/tv) |
| Anthropic prompt cache | 5 min (ephemeral) | `cache_control: ephemeral` on the library block; cache hits are ~10x cheaper |

## Error handling

| Condition | Behavior |
|-----------|----------|
| TMDB HTTP 429 | `tmdbFetchWithRetry` waits `Retry-After` seconds (cap 10s) then retries once |
| Anthropic 529/503 | `withAnthropicRetry` waits 3s then retries once |
| Claude returns no tool_use block | Treated as 0 picks → fill path fires |
| Claude output truncated (max_tokens) | `claudeTruncated: true` in `_diag`, strip hint rendered |
| Malformed picks (null/non-string title) | Filtered out in `readToolUse`, warn logged |
| Claude throws (network/auth/rate) | Falls back to TMDB trending, `source: trending_fallback` |

## Cold-start path

When `library.length < COLD_START_THRESHOLD (10)`:
- Returns TMDB trending with `source: trending`
- `_diag.reason: 'library_below_threshold'`
- `_diag.hint: 'Add at least N more title(s) to get personalized recommendations'`
- Hint surfaces in the strip header on the UI (both when items=0 and items>0)

## Debugging a bad refresh

1. Open DevTools → Network → find the `/api/suggestions/movie` request
2. Check `Response.body._diag`:
   - `poolHitRate < 0.3` → pool isn't matching Claude's picks; check genre coverage
   - `droppedPicks > 10` → validation is noisy; check `lastCounters` breakdown
   - `claudeTruncated: true` → max_tokens fired; this should not happen with 4096
   - `fillSource: trending` → Claude picks exhausted; library may be too large/narrow
3. Check `Server-Timing` header for per-phase latency breakdown:
   - `candidatePool` — TMDB /discover time
   - `claudeInitial` — Claude call time  
   - `validate1` — validation time
   - `fill` — fill time (only present when filling)

## Running the eval harness

```bash
# Mocked eval (no real keys needed):
npm run eval:recs

# Live eval (requires real keys):
RECS_EVAL_LIVE=1 ANTHROPIC_API_KEY=sk-ant-... TMDB_API_KEY=... npm run eval:recs
```

Eval reports are written to `.planning/ai-recommendations-loop/eval-runs/`.
