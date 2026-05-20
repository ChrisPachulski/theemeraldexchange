You are an autonomous improvement agent iterating on the AI recommendation section of The Emerald Exchange — a self-hosted household media dashboard. Your job: push the section past "technically present, falls back to trending, picks feel generic, refreshes look stuck" into something the household actually relies on.

ARTIFACTS (read these in full before iteration 1; re-read on every change):
- server/routes/suggestions.ts  — the Claude + TMDB orchestration
- server/routes/suggestions.test.ts — the test suite to extend
- src/lib/hooks/useSuggested.ts — React Query wrapper for the route
- src/lib/hooks/useAiSuggestionsEnabled.ts — household toggle
- src/lib/hooks/useUserFeedback.ts — red/green dot mutation
- src/components/search/TrendingRow.tsx — the rendered strip
- src/components/search/AiToggle.tsx — the on/off control
- src/components/tabs/MoviesTab.tsx and src/components/tabs/TvTab.tsx — call sites

REFERENCE CONTEXT:
- PRODUCT.md — product intent, voice, principles. Note the "search is the verb" line: the strip is a sidebar to search, not a substitute. Don't grow the strip past TARGET_COUNT=20.
- DESIGN.md — palette + chrome. The visual contract is locked.
- Git log on suggestions.ts shows what's been tried and what failed (e.g., "trim Claude call for speed" reverted, "cap rejection prompt" undone, "year guard" relaxed for TV).
- Memory feedback_impeccable_conservative.md — the user prefers conservative refinement over rewrites; don't strip implementation choices.
- Memory project_brand_mark_webgl.md — WebGL is allowed in the brand mark; no relevance here.

DOMAIN: Claude-backed library-aware media recommendations for movies + TV. Library + reject list come from Sonarr/Radarr; suggestions render as a Discover strip above search. Cost is metered (BYO Anthropic key, per-refresh tokens). Audience: 1–3 household members per server, not millions.

GOAL: Move every rubric dimension to ≥ 4 with the changes verified, the tests green, and the dev-server output showing real personalized fill.

QUALITY RUBRIC — see `.planning/ai-recommendations-loop/rubric.md` for the full table. Summary of dimensions:
  1. Personalized fill          (target ≥ 4)
  2. Library / reject hygiene   (target ≥ 4)
  3. Personalization signal     (target ≥ 4)
  4. Refresh variety            (target ≥ 4)
  5. Latency                    (target ≥ 4)
  6. Honest degradation         (target ≥ 4)
  7. Trust scaffolding          (target ≥ 4)

INVARIANT: Every iteration must improve at least one rubric dimension by a measurable amount AND not regress any other dimension below its previous score. If you cannot identify a concrete improvement after honest assessment, declare convergence — do NOT pad iterations with cosmetic edits.

VERIFICATION PROTOCOL — mandatory:
1. Before writing code that uses an external library/API, fetch current docs via context7:
   resolve-library-id("anthropic-sdk") | resolve-library-id("@anthropic-ai/sdk")
   resolve-library-id("hono")
   resolve-library-id("@tanstack/react-query")
   query-docs for any specific API you call.
2. Before changing the Claude prompt structure, prompt-caching mechanics, tool-use forced output, or messages stack, re-verify against the Anthropic SDK current docs — the Claude API surface evolves (cache_control, beta headers, model IDs).
3. Before writing non-trivial code, search for a real reference implementation:
   - GitHub: search for the specific pattern in TypeScript projects with stars
   - Anthropic cookbook + claude.ai docs for tool-use validate-and-retry
4. Verification labels — MANDATORY on every change line in the iteration log:
   - VERIFIED        — change ran, output observed, behaves as claimed
   - SYNTAX-CHECKED  — `npm run build` or `tsc --noEmit` parsed clean, no execution
   - WEB-CONFIRMED   — factual claim cited to a dated source ≤ 12 mo
   - CONTEXT7-SOURCED — code shape pulled from current library docs via context7
   - REFERENCE-MATCHED — adapted from a named, working open-source impl
   - INFERRED        — logically sound, not independently verified (DANGER ZONE — skeptic MUST attempt to verify)
5. Every iteration runs the test suite (`npm test`) AND the typecheck (`npm run build`). A red bar closes the iteration with a `regression` entry — fix before opening the next iteration.
6. When changing live behavior, also exercise the route via `npm run dev` + a real authenticated request. Capture the `_diag` payload and Server-Timing header in the iteration log as evidence.
7. Source freshness: any web citation > 12 months old is STALE — find a newer one or flag the claim INFERRED.

SOURCE ATTRIBUTION:
Every factual claim must cite:
- [WEB] URL + access date + publication date
- [CONTEXT7] library-name + version + doc section
- [TRAINING] from training data (lowest confidence — must be flagged for verification)

PER-ITERATION CYCLE:

1. ASSESS — Score every rubric dimension (1–5) based on the CURRENT state. Compare to the previous iteration's scores. Be honest. Padding is its own regression.

2. IDENTIFY — Pick the SINGLE lowest-scoring dimension. If tied, pick the one with highest household impact (the user-perceived ones — personalized fill, personalization signal, refresh variety, trust scaffolding — break ties over the engineering-internal ones).

3. RESEARCH — Targeted web + context7 search aimed at the specific weakness. Examples of useful queries:
   - "Anthropic prompt caching tool use Claude 4 best practices 2026"
   - "claude-sonnet-4-6 vs claude-haiku-4-5 recommendation accuracy"
   - "tmdb api genre discover recommendation seed best practices"
   - "movie recommendation system genre distribution mirroring eval"
   - "react query refetch invalidation cache mutation patterns 2026"
   - "anthropic SDK streaming tool_use partial response 2026"
   Source every claim. Log every URL with access date.

4. IMPROVE — One dimension, one iteration. Small, surgical change. Examples (NOT prescriptive — pick what the assessment surfaces):
   - Add a per-pick `reason` field to the tool input_schema, surface it as hover text on cards
   - Switch the model to claude-sonnet-4-6 behind a feature flag with cost guardrails
   - Add an offline eval harness that scores genre-mirroring + like-neighbor + trending-divergence on a fixed library snapshot
   - Stream the Claude tool_use so the UI starts rendering when the first 3 picks arrive instead of waiting for 30
   - Add a per-pick provenance label (`personalized` / `discover` / `trending`) on the SuggestionItem so the UI can render it differently
   - Pre-shape the TMDB lookup as a parallel race with a hint-bearing fallback so lookup nulls degrade gracefully
   - Introduce a "warm" cache of the household library block so the cached prefix actually hits the cache instead of being rebuilt on every fingerprint shift
5. CHALLENGE (skeptic) — adversarial review of THIS iteration's changes:
   a. Did the change improve the target dimension? Re-score it; if delta ≤ 0, the iteration FAILED and rolls back.
   b. Did any other dimension regress? Score them all.
   c. Are any items still INFERRED? Verify them now or document why verification is blocked.
   d. Spot-check one citation — does the source actually say what was claimed?
   e. Did `npm test` and `npm run build` stay green? If not, the iteration FAILED.
   SKEPTIC SCHEDULE:
   - Every iteration: standard skeptic.
   - Iterations 3, 6, 9, 12, 18, 27, 36, 45, 54, 63, 72: VARIANT skeptic — argue the OPPOSITE of the current direction. ("Are we sure switching models is worth the cost? Argue Haiku is enough.")
   - Iterations 5, 25, 50: PARALLEL GATE — spawn 3 agents:
     Agent A: "What alternative approach would more aggressively improve {weakest_dimension}?"
     Agent B: "What's the strongest case the artifact is already good enough on this dimension?"
     Agent C: "What domain knowledge are we missing that an expert recommendation-system engineer would know?"
   - Whenever all dimensions ≥ 4: DEEP SKEPTIC — full iteration-log audit for dropped concerns, INFERRED leaks, anchoring bias.

6. SCORE — Re-score every dimension. Log deltas. Update Current State.

7. REPORT — Append to iteration_log.md:
   ## Iteration N
   **Target dimension**: X
   **Hypothesis**: what we expect the change to do
   **Research consulted**: bulleted sources with [WEB|CONTEXT7|REFERENCE] + URL + date
   **Changes made**: file paths + line ranges + verification labels
   **Verification results**: `npm test`, `npm run build`, dev-server request output (curl + Server-Timing)
   **Skeptic response**: questions and answers
   **Rubric scores**: full vector with deltas vs previous iteration
   **Next action**: what iteration N+1 should target

CONVERGENCE CRITERIA — all must hold:
1. All 7 dimensions ≥ 4 for 2 consecutive iterations.
2. No OPEN skeptic concerns from the last 2 iterations.
3. No INFERRED items without attempted verification.
4. Deep skeptic has fired at least once after convergence threshold met.
5. Minimum 75 iterations completed (hard floor — the user set this explicitly).
6. `npm test` and `npm run build` both green on the convergence iteration.
7. A live dev-server request to /api/suggestions/movie AND /api/suggestions/tv returned source='personalized' with ≥ 16 items, captured in the log.

When converged, output `CONVERGED` as the last line of the iteration log entry.

PACING:
- Iterations 1–5: cover all 7 dimensions at least once. Establish measurement infrastructure (an eval harness; structured logging of `_diag` to disk) so subsequent iterations can compare. The eval harness IS the iteration loop's reward signal — without it, scores are guesses.
- Iterations 6–20: target the lowest-scoring dimensions. Expect 60–70% of the loop to be on Personalization signal + Refresh variety + Personalized fill — those are the hardest and the most user-perceptible.
- Iterations 21–50: harden, soak, edge-case. Add tests for every behavior change. Eval scores should be moving upward visibly.
- Iterations 51–75: polish, trust scaffolding, honest degradation paths, final regressions. Deep skeptic. Convergence checks every iteration from 70 onward.

ANTI-ANCHORING:
- At iteration 5, snapshot the rubric scores AND the current architecture (model choice, prompt structure, validate-retry, fill chain). This snapshot is append-only.
- Whenever an iteration produces no score delta, log the attempted approach in the DEAD ENDS table — do not silently re-try it later.
- The git log already contains a graveyard of attempted approaches. Read it before any large rewrite.

ITERATION LOG — `.planning/ai-recommendations-loop/iteration_log.md`. Seed exists. Append-only. Update the "Current State" header in place each iteration; iteration entries are append-only.

ROLLBACK POLICY:
- Each iteration commits as its own change in a working branch. If an iteration's skeptic finds the change regressed a dimension or broke a test, `git reset --hard HEAD~1` and log the rollback in DEAD ENDS. Do NOT pile broken changes on each other.
- If three consecutive iterations on the same dimension fail to move it, switch dimensions and log "stuck — needs reframing or external input."

FINAL REPORT on convergence:
Produce `.planning/ai-recommendations-loop/improvement_report.md`:
- Starting and final rubric scores with deltas
- Bulleted list of key improvements with verification labels
- All resolved skeptic concerns
- Any concerns marked WONTFIX with explicit justification
- Citations: every source consulted across the run with dates
- A handoff note for the next loop: what to target if/when more work is needed

GUARDRAILS (do not violate these):
- Do NOT commit secrets, .env, or rotated keys.
- Do NOT bump the Anthropic SDK major version mid-loop without an explicit iteration dedicated to the migration.
- Do NOT change the TARGET_COUNT (20) — that's a product contract.
- Do NOT remove the BYO-key model — that's a privacy/cost contract.
- Do NOT add Co-Authored-By or any AI attribution to commits (per global CLAUDE.md).
- Do NOT add backwards-compat shims for removed code — delete it cleanly.
- Do NOT silently widen the API surface — every new field is a public contract.
