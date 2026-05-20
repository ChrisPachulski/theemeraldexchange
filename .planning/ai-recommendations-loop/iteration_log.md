# AI Recommendation Section — Improvement Iteration Log

## Current State (updated each iteration)

**Target artifacts**
- server/routes/suggestions.ts
- server/routes/suggestions.test.ts
- src/lib/hooks/useSuggested.ts
- src/lib/hooks/useAiSuggestionsEnabled.ts
- src/lib/hooks/useUserFeedback.ts
- src/components/search/TrendingRow.tsx
- src/components/search/AiToggle.tsx
- src/components/tabs/MoviesTab.tsx
- src/components/tabs/TvTab.tsx

**Rubric scores (current)**
| # | Dimension              | Baseline | After iter 1 |
|---|------------------------|----------|--------------|
| 1 | Personalized fill      | 2        | 2 (real) / 5 (mocked eval — mock-Claude too lenient) |
| 2 | Library/reject hygiene | 4        | 4 (real) / 5 (mocked eval — covered) |
| 3 | Personalization signal | 3        | 3 (real) / 5 (mocked eval — mock returns non-trending only) |
| 4 | Refresh variety        | 2        | 2 (real) / 3 (mocked — rotation window too small) |
| 5 | Latency                | 2        | 2 (real) / 5 (mocked — no real network) |
| 6 | Honest degradation     | 3        | 3 (real) / 5 (mocked — covered) |
| 7 | Trust scaffolding      | 1        | 1 (no schema change yet) |

**Active skeptic concerns**
- C1 (iter 1): The mocked eval is too friendly to Claude — synthetic Claude picks avoid library/rejects by construction except in the explicit `leaky` scenario, and synthetic TMDB ids never overlap with trending/discover surfaces. Mock-derived scores inflate everything except trust scaffolding. The eval IS reproducible and measurable, but its absolute numbers are not comparable to production. Status: OPEN — iteration 2 must harden the eval (more adversarial mock Claude, optional LIVE mode using real Anthropic when env var set, real TMDB trending ids in the mock so personalization signal can actually be tested).

**Verification gaps**
- V1 (iter 1): The latency score in the harness is meaningless (no real network). Needs a LIVE mode using real Anthropic + real TMDB to produce a comparable number, or remove from the harness scores and replace with a separate live-soak step.
- V2 (iter 1): No assertion that the eval scores actually improve as the real system improves. The harness needs at least one scenario whose mocked score TRACKS the real system's behavior — i.e., changes to the route's prompt/model/temperature should visibly shift at least one mocked score. Iteration 2 should add a "calibration" assertion.

**Test suite status**: 151 passed (16 files) + eval-harness 4 passed (1 file) — `npm test` and `npm run eval:recs` both green as of iter 1.
**Build status**: green — `npm run build` produces dist/ cleanly.
**Live dev-server probe**: not yet run. Deferred to iteration that needs it.

## Skeptic Tracking Table

| Iter | Type | Concern | Status |
|------|------|---------|--------|
| 1 | C1 | Mocked eval too lenient (synthetic Claude avoids library by construction, synthetic TMDB ids never overlap trending) — absolute scores inflated | OPEN — addressed in iter 2 |
| 1 | V1 | Latency score from mock is meaningless | OPEN — needs LIVE mode |
| 1 | V2 | Eval needs calibration: at least one mock-scored dimension must visibly track real system behavior | OPEN |

## Dead Ends (append-only — do not retry these unless the context changed)

| Iter | What was tried | Why it failed |
|------|----------------|---------------|

## Snapshot (frozen at iteration 5)

(populated at iteration 5 to detect anchoring)

---

## Iteration 0 — Baseline (seed, not a real iteration)

**Date**: 2026-05-20
**Target dimension**: n/a — measurement only
**Hypothesis**: n/a
**Research consulted**: PRODUCT.md, DESIGN.md, full read of server/routes/suggestions.ts, git log on the file, all hook + UI files.
**Changes made**: none — read-only baseline.
**Verification results**:
- `npm test` — 151 passed, 16 files, 848ms.
- `npm run build` — not run yet.
- Live dev-server probe — not run yet.
**Skeptic response**: deferred to iteration 1.
**Rubric scores**: 2 / 4 / 3 / 2 / 2 / 3 / 1 (see table above).
**Observations**:
- Model is `claude-haiku-4-5`. For nuanced taste-matching on a curated household library, this is likely under-spec — every "personalized_filled" warning in the log is a paid Claude call that produced sub-target.
- The `SUBMIT_TOOL` explicitly says "no reasoning" — this is the root of the Trust scaffolding zero. There's no per-pick provenance and no way for the user to differentiate a Claude pick from a discover/trending fill.
- `RECENTLY_SHOWN_CAP=150` with soft-preference language relies entirely on temperature + a non-cached suffix block to break repetition. Refresh variety is unmeasured.
- The validate-and-retry path runs at most once and drops the recently-shown block on retry — by design, but it means a single bad Claude pass produces a partially-filled strip from non-personalized fill.
- No offline eval harness exists. Every quality claim in the system is anecdotal. This is the bottleneck for the loop's reward signal — building one is iteration 1's almost-certain target.
- The dev server uses real Sonarr/Radarr; iterations that need live behavior must wire a session cookie + a sandbox key.

**Next action (iteration 1)**: Build the offline eval harness — a script that loads a fixed library snapshot + a fixed reject set + a fixed user-likes set, exercises the suggestions route end-to-end against a mocked Anthropic that records the prompt + replays a known-good response, and emits structured scores per dimension. Without this, every later "score went up" claim is a guess.

---

## Iteration 1 — Build the offline eval harness

**Date**: 2026-05-20
**Target dimension**: meta — measurement infrastructure (prerequisite for every later iteration). No rubric dimension targeted directly; this is enabling work.
**Hypothesis**: An offline, reproducible eval that scores all 7 rubric dimensions will let later iterations make verifiable progress claims instead of guessing.

**Research consulted**:
- Existing test infrastructure at `server/routes/suggestions.test.ts` (read in full) — already mocks Anthropic via `vi.mock` at module level and exposes `_setRejectionsPathForTests`, `_setUserFeedbackPathForTests`, `_setUsageLogPathForTests`, `_setTmdbApiKeyForTests` for harness control. [SOURCE: file read 2026-05-20]
- Vitest separate-config pattern for runs that should NOT execute under default `npm test` — verified by reading `vitest.config.ts` and confirming `include:` is exact-match against test files. [SOURCE: file read 2026-05-20]
- `node:performance.now()` for elapsed timing on mocked code paths — standard Node API. [TRAINING — universally stable]

**Changes made**:
- `scripts/fixtures/library-tv.json` (CREATED) — realistic 20-title curated TV library mixing prestige drama / crime / sci-fi-fantasy with full genre tags. [VERIFIED — loaded by harness]
- `scripts/fixtures/library-movies.json` (CREATED) — 20-title curated movie library, prestige crime/thriller/sci-fi clusters. [VERIFIED]
- `scripts/fixtures/likes.json` (CREATED) — per-kind liked titles for "user with taste signal" scenario. [VERIFIED]
- `scripts/fixtures/rejections.json` (CREATED) — per-kind household rejections. [VERIFIED]
- `server/routes/suggestions.eval.test.ts` (CREATED, ~410 lines) — vitest-runnable eval harness with: mocked Anthropic returning programmable picks, mocked fetch covering Sonarr/Radarr/TMDB-search/TMDB-trending/TMDB-discover, 3 scenarios (movie-normal-5x, tv-normal-5x, movie-leaky-3x), 7 scoring functions matching the rubric, JSON report writer at `.planning/ai-recommendations-loop/eval-runs/<timestamp>.json`. [VERIFIED — all 4 tests pass, report written, scores printed]
- `vitest.eval.config.ts` (CREATED) — isolated config for the eval suite. [SYNTAX-CHECKED — used by `npm run eval:recs`]
- `vitest.config.ts` (UPDATED) — added `exclude: ['server/routes/suggestions.eval.test.ts']` so the eval doesn't run under `npm test`. [VERIFIED — 151 still pass under default config]
- `package.json` (UPDATED) — added `"eval:recs": "vitest run --config vitest.eval.config.ts"`. [VERIFIED — `npm run eval:recs` works]

**Verification results**:
- `npm test` → 151 passed (16 files), 848ms. Same number as baseline. No regression. [VERIFIED]
- `npm run build` → 158 modules transformed, dist/ written, server tsc clean. [VERIFIED]
- `npm run eval:recs` → 4 passed (1 file), report written to `.planning/ai-recommendations-loop/eval-runs/2026-05-20T07-59-22-692Z.json`. Sample stdout (overall mean): `{"personalizedFill":5,"hygiene":5,"personalizationSignal":5,"refreshVariety":3,"latency":5,"honestDegradation":5,"trustScaffolding":1}` [VERIFIED]

**Skeptic response**:
- a. Did the change improve the target dimension? Target was infrastructure; the harness exists, runs, scores. ✓
- b. Did any other dimension regress? No code-path changes to the route itself. ✓
- c. INFERRED items? Two: V1 (mocked latency meaningless), V2 (need calibration that mock scores track real behavior) — both logged as OPEN. The skeptic also raised C1: "your mock Claude is too friendly; the high scores aren't telling you anything." All three concerns logged. The skeptic accepts the harness IS the measurement framework; later iterations must harden it.
- d. Citation spot-check: existing test file structure and vitest config — both directly read, no claim made beyond what's in the files.
- e. Both `npm test` and `npm run eval:recs` green; `npm run build` green. ✓

**Rubric scores after iter 1**: same as baseline (real-world) — 2/4/3/2/2/3/1 — because the route itself was not modified. The harness gives us mocked numbers that are inflated; the iteration log carries both columns to keep this honest.

**Next action (iteration 2)**: Harden the eval harness — (a) seed the mock Claude with adversarial picks that include library matches by id AND title, year mismatches, dedupe collisions, and lookup nulls; (b) align the mocked TMDB trending block so personalization signal scoring can stress real overlap; (c) make trust scaffolding score check the response item schema for `provenance` and `reason` fields so future schema work raises the score automatically.

---

## Iteration 2 — Harden the eval adversary

**Date**: 2026-05-20
**Target dimension**: meta — addressing skeptic concerns C1, V1, V2 from iter 1. Closes the "scores are inflated" gap.
**Hypothesis**: A more adversarial mock Claude + trending overlap + schema-based trust score will produce numbers that move when the system changes, instead of plateauing at 5 for free.

**Research consulted**:
- Reread of `server/routes/suggestions.ts` — confirmed the year-proximity guard at line 1340 is movies-only (TV drops it intentionally), and confirmed validate-and-retry happens once with rejected picks fed back. [SOURCE: file read 2026-05-20]
- Commit history on suggestions.ts — git log shows "Personalized picks short of target — filling" warnings are tied to real production runs (commit `b3963b2`, `486208c` etc. all tweak the prompt to reduce fall-through). [SOURCE: `git log` 2026-05-20]

**Changes made**:
- `server/routes/suggestions.eval.test.ts`:
  - Added `'realistic'` mode to `seedClaudePicks` — injects 1 library hit at pos 0, 1 reject at pos 3, a 15-year drift at pos 5 (movies only), a near-duplicate at pos 6. Uses stride=3 across refreshes (was 7) to mimic cache-anchored repetition. [VERIFIED via run]
  - TMDB trending shim now overlaps the pick universe by 6 titles (shares synthetic ids via `syntheticIdFor`). Personalization signal scoring now can't get a free 5. [VERIFIED]
  - `scoreTrustScaffolding` rewritten to inspect each item's `provenance` and `reason` fields. Today: response items don't carry these → score=1 (matches the real-world score). When iter 3 adds the schema, this score will move. [VERIFIED — score still 1 because nothing changed in the route]
  - `RefreshResult.rawItems` added so the scorer can inspect the full per-item payload, not just ids/titles.
  - Renamed scenarios: `normal-5x` → `realistic-5x` (since the realistic mode is the default adversary now).
- Removed the now-unused `'rotated'` mode parameter.

**Verification results**:
- `npm run eval:recs` — 4 passed (1 file), 250ms. New report at `2026-05-20T08-02-35-323Z.json`. Overall scores: `personalizedFill:5, hygiene:5, personalizationSignal:4, refreshVariety:2.33, latency:5, honestDegradation:5, trustScaffolding:1`. [VERIFIED]
- `npm test` — 151 passed (16 files), 880ms. No regression. [VERIFIED]
- Refresh variety dropped from 3 → 2.33 (matches reality better — stride=3 means refreshes share most of the universe window).
- Personalization signal dropped from 5 → 4 (trending overlap now penalizes mainstream picks).

**Skeptic response**:
- Standard skeptic (iter 2):
  - a. Did the change improve the target? Yes — eval is no longer trivially saturated; scores now have room to move.
  - b. Regression? No (main suite + eval suite both green).
  - c. INFERRED items? `realistic` mode's stressor positions (pos 0/3/5/6) are not derived from any external research — they're plausible but assumed. Logged as INFERRED.
  - d. Citation spot-check: commits cited (b3963b2 etc.) — verified via local git log; all real commits.
  - e. Tests green: ✓
- VARIANT skeptic note (iter 2 prep for iter 3): "Argue the eval doesn't need to be this harsh — maybe real Claude is already cleaner than the mock." Counter-evidence: commits explicitly fight library matches in the retry path. Production traces in the commit messages reference this failure mode. Variant rejected — keep the hardening.

**Rubric scores after iter 2** (real-world | mocked):
| # | Dim | Baseline (real) | Iter 1 (real) | Iter 2 (real) | Iter 2 (mocked) |
|---|-----|-----------------|---------------|---------------|-----------------|
| 1 | Personalized fill | 2 | 2 | 2 | 5 |
| 2 | Hygiene | 4 | 4 | 4 | 5 |
| 3 | Personalization signal | 3 | 3 | 3 | 4 |
| 4 | Refresh variety | 2 | 2 | 2 | 2.33 |
| 5 | Latency | 2 | 2 | 2 | 5 |
| 6 | Honest degradation | 3 | 3 | 3 | 5 |
| 7 | Trust scaffolding | 1 | 1 | 1 | 1 |

**Next action (iteration 3)**: Trust scaffolding (rubric dim 7, lowest score, real=1). Extend `SuggestionItem` to carry a `provenance` field (`'personalized' | 'discover' | 'trending' | 'fallback'`) emitted by every return path, and an optional `reason` field populated from Claude's per-pick rationale (extend the SUBMIT_TOOL input_schema). Update TrendingRow to surface the reason on hover/tap. Tests + eval should both move trustScaffolding off 1.

---

## Iteration 3 — Per-pick provenance + reason end-to-end (VARIANT skeptic)

**Date**: 2026-05-20
**Target dimension**: Trust scaffolding (7) — real=1, lowest dim.
**Hypothesis**: Adding `provenance` ('personalized' | 'discover' | 'trending') to every returned item, opening `reason` in the Claude tool schema, and surfacing both in the UI moves the dimension from 1 → 4 (target ≥4). The mocked eval will show 3 (provenance covered, reasons absent from mock); real-world will rise as Claude fills in reasons.

**Research consulted**:
- Anthropic tool_use input_schema patterns — verified `additionalProperties: false` + optional fields are supported via existing `SUBMIT_TOOL` shape. No web fetch needed; the file's own existing schema is the source. [SOURCE: file read]
- PRODUCT.md voice — "short, confident, no jargon" — informs the reason field's ≤90-char guidance in the tool description. [SOURCE: file read 2026-05-20]
- DESIGN.md — palette tokens used in CSS (`--text-faint`, `--text-subtle`, emerald rgba). [SOURCE: file read 2026-05-20]

**Changes made**:
- `server/routes/suggestions.ts`:
  - `SuggestionProvenance` type exported.
  - `SuggestionItem` gains optional `provenance` + `reason`. [VERIFIED via eval — score moved]
  - `ClaudePick.reason` documented; was already a soft optional, now intentional.
  - `SUBMIT_TOOL.description` rewritten to ASK for a reason (≤90 chars, library/like-grounded). Was "Do not include reasoning."
  - `SUBMIT_TOOL.input_schema.properties.picks.items.properties` adds `reason` field with description. Not required — Claude may omit.
  - `validate()` propagates `pick.reason` (trimmed to 120 chars defensively) onto accepted items with `provenance: 'personalized'`.
  - Trending return paths (cold-start, force=trending, claude_threw fallback, fill top-up) tag items `{provenance: 'trending', reason: null}`.
  - Discover fill tags items `{provenance: 'discover', reason: null}`.
- `src/lib/hooks/useSuggested.ts`:
  - `SuggestionProvenance` type exported.
  - Response type + mapper pass `provenance` and `reason` through. [VERIFIED via build]
- `src/lib/hooks/useTrending.ts`:
  - `TrendingItem` gains optional `provenance` + `reason`. Also exported `TrendingItemProvenance` for downstream typing. [VERIFIED]
- `src/components/search/TrendingRow.tsx`:
  - Card gets `trending__card--{provenance}` modifier class + `data-provenance` attribute.
  - Tooltip combines `title — reason` when reason exists.
  - New `<p className="trending__reason">` rendered inside the button; CSS keeps it `opacity:0;max-height:0` at rest, reveals on hover/focus with a 140–200ms transition.
- `src/components/search/TrendingRow.css`:
  - `.trending__reason` style block (2-line clamp, mono font, faint color, hover/focus reveal).
  - `.trending__card--personalized:hover` gets a faint inset emerald box-shadow; discover/trending get neutral hover treatments. Visual contract: same row at rest, different signal on attention.

**Verification results**:
- `npm test` → 151 passed (16 files), 969ms. No regression. [VERIFIED]
- `npm run build` → client + server bundle clean. CSS bundle 95.74→96.38 KB (+640 bytes). [VERIFIED]
- `npm run eval:recs` → 4 passed, 252ms. `trustScaffolding` moved from 1 → 3 across all scenarios (provenance now tagged on every item; reason still null because mock Claude doesn't generate reasons). [VERIFIED]
- Live dev-server probe — DEFERRED to next iteration after the harness can supply reasons. The change is observable enough through the eval.

**Skeptic response (VARIANT skeptic — argue the OPPOSITE)**:
- Variant argument: "The cards should stay anonymous — adding provenance / reasons puts marketing chrome on a tool. Users don't care WHY Claude picked something; they just want to add the show. The whole strip is sub-page-load distraction."
- Counter: PRODUCT.md says voice is "considered. quiet confidence." The visual contract here doesn't break that — reasons hide at rest, reveal only on hover/focus. Provenance is a CSS modifier, not a badge. The card stays calm. The point isn't marketing; it's so a household member can tell at a glance whether the strip is doing its job. When everything is unlabeled, trending fallback looks indistinguishable from a real personalized pick — and that erodes trust silently. Variant rejected; keep the change.
- Standard skeptic checks:
  - a. Target improved? trustScaffolding 1→3 in eval. ✓
  - b. Other regressions? All 151 tests + 4 eval scenarios still pass. ✓
  - c. INFERRED items? The `≤90 char` schema description is INFERRED guidance — Claude may comply or not. Logged for iter 4 verification (will require a live call).
  - d. Citation spot-check: no external citations made.
  - e. Tests green: ✓

**Rubric scores after iter 3** (real-world | mocked):
| # | Dim | Iter 2 (real) | Iter 3 (real) | Iter 3 (mocked) |
|---|-----|---------------|---------------|-----------------|
| 1 | Personalized fill | 2 | 2 | 5 |
| 2 | Hygiene | 4 | 4 | 5 |
| 3 | Personalization signal | 3 | 3 | 4 |
| 4 | Refresh variety | 2 | 2 | 2.33 |
| 5 | Latency | 2 | 2 | 5 |
| 6 | Honest degradation | 3 | 3 | 5 |
| 7 | Trust scaffolding | 1 | 3 | 3 |

Real-world trustScaffolding moves 1 → 3 because the schema and rendering exist; reason rate will need a live Claude call to verify. Held at 3 in the table until that confirmation lands.

**Next action (iteration 4)**: Refresh variety (dim 4, real=2). The route already has the RECENTLY_SHOWN block + temperature 0.7. The deterministic stride=3 in the eval shows the mock can't differentiate variety improvements. Need to: (a) extend the mock Claude to RESPECT the RECENTLY_SHOWN block by skipping titles already passed in (validating the cache-suffix injection is actually shaping pick selection), AND (b) consider hardening the rotation in the real route by making the RECENTLY_SHOWN block louder or by appending a per-request randomized seed-clause to break the cached-prefix determinism. Score should move from 2 → ≥3 with the mock change alone.
