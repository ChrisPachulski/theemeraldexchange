# Quality Rubric — AI Recommendation Section

**Domain.** Claude-backed library-aware media recommendations for a self-hosted household media dashboard (movies + TV). Library + reject list come from Sonarr/Radarr; suggestions render as the Discover strip above search. Cost is metered (BYO Anthropic key, per-refresh tokens).

**Goal.** Move the section from "technically present, frequently fills from trending/discover, picks feel mainstream-generic, refreshes look stuck, household members don't trust it" to **viable** — defined by the rubric below.

**Convergence target.** All 7 dimensions ≥ 4 for 2 consecutive iterations, minimum 75 iterations completed, all `INFERRED` items either verified or explicitly waived, deep skeptic has fired and produced no unresolved concerns.

## Dimensions

| # | Dimension                  | What it measures                                                                                                                                                                                                                            | Current (baseline) | Target |
|---|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------|--------|
| 1 | Personalized fill         | % of refreshes that return ≥ TARGET_COUNT picks where ≥ 80% have **provenance ∈ {personalized, discover}**. Trending fallback is the failure mode; genre-aware discover (`tmdbDiscoverByGenres` seeded by the library's top genres) is a legitimate fill path — it's still using household taste signal, just via TMDB instead of Claude. Originally counted any fill as failure; iter 5's parallel gate (Agent B) surfaced that this miscounts. | 2 — Claude-only routes underfill against large libraries; trending fallback fires often (commits 0572b72, 4be44d7…). | ≥ 4 — modal refresh has ≥ 80% of picks provenanced 'personalized' OR 'discover' (i.e. taste-driven, not 'trending' fallback) |
| 2 | Library / reject hygiene  | Returned picks that are already in the library or on the household NEVER list (0 is the only acceptable number). Counts both id-match and title-match (incl. base-title for library).                                                       | 4 — defense in depth (id + normalized title + base title), validate-and-retry, pre-validate by title. Edge cases still possible at the franchise level. | 5 — zero leaks across a soak run; remaining edge cases documented |
| 3 | Personalization signal     | Picks measurably reflect the household's actual taste (genre distribution mirroring; explicitly-liked titles influence neighborhood; not just TMDB's popular-list under another label). Measured by: (a) genre distribution of returned picks vs library distribution; (b) overlap of returned picks with TMDB top-popular-this-month is sub-threshold; (c) likes nudge the cluster. | 3 — prompt asks for it, no measurement, no eval, no reward signal. Haiku may regress to popular regardless. | ≥ 4 — eval harness with measurable taste-matching score across a synthetic library + a real-household snapshot; picks beat trending baseline on both genre-mirroring and per-like neighborhood |
| 4 | Refresh variety            | Two consecutive refreshes (same user, same library, no feedback events between) return materially different ranked picks — operationalized as Jaccard overlap of top-20 < 0.5 across N=5 refreshes, AND the user-perceived "new face on the strip" rate per refresh ≥ 40%. RECENTLY_SHOWN must actually move the model. | 2 — temperature=0.7 + RECENTLY_SHOWN block exists, but cache-prefix determinism plus a soft preference language means refreshes often look repetitive; no measured rotation rate. | ≥ 4 — measured Jaccard ≤ 0.5 P50, ≤ 0.7 P95 across 5-refresh windows |
| 5 | Latency                    | Time from request to first byte rendered. P50 ≤ 2.5s, P95 ≤ 6s. Includes Claude call, TMDB lookups, validation, fill. Server-Timing breakdown shows no single phase > 70% of total.                                                          | 2 — initial call ≈ 5–15s (Haiku + 30-pick overfetch + serial validate + retry path frequently fires). Loading hint says "takes a few seconds…" but UX still feels slow.  | ≥ 4 — P50 ≤ 2.5s, P95 ≤ 6s on realistic data, retry path takes p99 ≤ 3s on top of initial |
| 6 | Honest degradation         | Every failure mode surfaces an actionable, accurate explanation in the UI. Source mismatch is never silent. Cost waste is never silent. Empty strips never render with no hint. Diag payload is consumed end-to-end.                          | 3 — `describeEmptySource` / `describeError` exist, source-hint surfaces some cases. Cost spent on rejected picks is silent. Genre-mirroring failures are silent. | ≥ 4 — every failure path has a tested UI surface; cost-of-waste is visible to the user when present |
| 7 | Trust scaffolding          | The user can tell, for any given pick, WHY it's there (genre kinship, like-neighbor, novelty). Right now picks render as anonymous cards — no taste-link, no provenance. Plus: per-pick reasoning is captured for later review even if not always visible. | 1 — `SUBMIT_TOOL.description` explicitly says "no reasoning", no `reason` field, no per-pick provenance. The user has no way to differentiate a personalized pick from a trending fill. | ≥ 4 — picks carry source ('personalized' \| 'discover' \| 'trending') + optional one-line "because you liked X" / "neighbor of Y in your library" caption surfaced on hover/tap |

## Verification surfaces available

- `npm test` — vitest suite (151 tests, 17 on the suggestions route). Add tests for every new behavior.
- `npm run dev` — concurrent vite + server. Hit `GET /api/suggestions/movie` and `/tv` with a real session cookie + key for live behavior.
- `npm run build` — TS strict for both client and server.
- Real Sonarr/Radarr libraries are reachable in this environment; the loop should soak real data, not just mocks.
- The `_diag` field is the loop's primary observability signal — every iteration should leave it more useful, not less.

## Out of scope

- Switching media providers (TMDB stays). Switching auth model (BYO Anthropic key stays).
- The UX principle "Search is the verb" — the strip is a sidebar to search, not a replacement for it. Don't grow the strip past TARGET_COUNT=20.
- Background pre-warming, push-based updates, or persistent recommendation jobs (V2).
