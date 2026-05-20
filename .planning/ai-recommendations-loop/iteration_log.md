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
