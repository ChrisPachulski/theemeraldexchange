
# Backend Suggestions & Feedback Teaching Dossier

---

## 1. WHAT

When a user clicks the red (dislike) or green (like) dot on a suggestion card, the SPA sends a `POST /api/feedback`. That single HTTP call actually writes to TWO separate files on disk: `userFeedback.json` records *whose* preference it was (private, per-member), and `rejections.json` records the household-wide veto list (shared). The suggestions route (`GET /api/suggestions/:type`) then reads both stores every time it fetches picks — it filters out anything already in the household's library or rejection list, then asks either the local Python recommender sidecar or (in legacy mode) Claude to pick movies/TV the household hasn't seen and hasn't vetoed. To keep the two stores consistent under rapid concurrent dot-clicks, every write to feedback or rejections for the *same title* is serialized through a per-item promise mutex before either file is touched.

---

## 2. WHY

**Why two stores?**
`userFeedback.json` and `rejections.json` solve different problems. Likes are private: Alice's favorite film shouldn't appear as a "suggested for everyone" signal — it's hers. Dislikes, however, are household-wide vetoes: if Alice marks Transformers as unwanted, Bob shouldn't see it either, even though Bob never clicked the red dot. Two separate files let the backend enforce these different scoping rules. `userFeedback.json` is keyed by user `sub`, while `rejections.json` is a flat household list.

**Why is a veto permanent?**
A dislike is a "never suggest again" contract. If the backend quietly dropped old reds to save space (a FIFO eviction), vetoed titles would resurface in the strip after enough new dislikes accumulated. The user saw the title, clicked the red dot, and it came back anyway — that breaks trust immediately and repeatably. So the rejection list is intentionally unbounded; it is bounded only at *render time* inside the suggestions route (slicing the strip to 20), never at persistence time.

**Why two stores' mutations are ordered (dislike branch writes rejections first)?**
If we wrote `userFeedback` first and then `rejections` crashed, Alice's personal dislike would be stored but the title would still appear for Bob. The reverse order (rejections first, then personal) has a clean rollback: if the personal write fails, we check whether any *other* user still dislikes the title before undoing the household veto — so we never remove another user's protection. This asymmetry is intentional and documented in the route comments.

**Why does filtering happen backend-side?**
The recommender sidecar already receives the library, rejections, and feedback IDs in the `/score` request body, so it can exclude them during ranking. The Hono backend adds a *second* post-filter (`filterRecommenderSafe`) as defense-in-depth: even if the sidecar or Claude returns a stale pick, the route drops it before the response leaves the server. For the TMDB trending path (force=trending or cold-start fallback), the filtering happens in `filterHouseholdSafe` which is the only layer doing the job. Putting this in the backend means neither the SPA nor the sidecar can accidentally leak a vetoed or already-owned title to any client.

**Why the `filterRecommenderSafe` / `filterHouseholdSafe` split?**
`filterHouseholdSafe` (used for trending and Claude paths) includes both the full normalized title AND the "base form" (everything before the first `:` or dash). This catches subtitle variants — if you own "A Knight of the Seven Kingdoms: The Hedge Knight", normalizing the base form catches the plain "A Knight of the Seven Kingdoms" TMDB entry too. BUT for the recommender path, including the base form caused the franchise-collision bug (PR #107): owning *one* Batman film collapsed the base form to `"batman"`, which then blocked every Batman title from ever being suggested. So `filterRecommenderSafe` uses full-title-only matching via `libraryTitlesFull` (built with `{ includeBase: false }`).

**Why does `force=trending` short-circuit before any recommender/Claude call?**
The SPA exposes a "Recommended ↔ Trending" toggle. Trending is an explicit user choice to bypass personalization. If that signal reached the recommender or Claude it would be ignored (they always personalize). The force=trending check at the top of the route handler honors the toggle *regardless of which personalization engine is active*, and it's the only place that needs to know about it.

**Why must tmdb_id be > 0 at the /score boundary?**
The Python recommender's schema validates `tmdb_id` as a `PositiveStrictInt`. A 0 is not a valid TMDB id — Sonarr series routinely carry `tmdbId:0` because they key on TVDB ids instead. Sending even one 0 in the library or feedback array causes the recommender to return a 422, which the Hono backend interprets as a sidecar failure and falls back to plain trending for the *entire response* — silently. The fix is to strip any id ≤ 0 before building the `/score` request body.

---

## 3. MAP

**Key files:**

- `server/routes/feedback.ts` — Hono route for POST/DELETE /api/feedback; owns the per-item mutex, rollback logic, and recommender mirror calls
- `server/routes/suggestions.ts` — Hono route for GET /api/suggestions/:type; owns force=trending short-circuit, filter construction, and path dispatch
- `server/services/userFeedback.ts` — per-user likes/dislikes JSON store; owns write queue, atomic writes, anotherUserDislikes query
- `server/services/rejections.ts` — household-wide veto JSON store; owns write queue, atomic writes, id-set query
- `server/services/recommender.ts` — HTTP client for the Python sidecar; defines scoreOnce, postFeedback, postRejection, postClearFeedback, postShown
- `server/services/recommenderCaller.ts` — lifts an auth Session into the InternalPrincipal caller shape the recommender client expects
- `server/services/suggestionsShared.ts` — pure helpers: normalizeTitle, normalizeTitleBase, titleSetFrom, titleMatches, mapLimit, TARGET_COUNT
- `server/services/suggestionsRecommenderPath.ts` — full implementation of the USE_LOCAL_RECOMMENDER=1 path; calls scoreOnce, applies filterRecommenderSafe, handles trending fallback
- `server/services/suggestionsRecommenderPath.ts:87` — the tmdbId>0 guard that strips Sonarr zeroes before building the /score library payload

**One dislike click, end to end:**

1. User clicks red dot on "Batman v Superman" (tmdbId=209112, type=movie).
2. SPA sends `POST /api/feedback` with `{ type: "movie", tmdbId: 209112, signal: "dislike", title: "Batman v Superman: Dawn of Justice" }`.
3. `feedback.ts` validates kind/signal/tmdbId (`feedback.ts:94-101`), then enters `withItemLock("movie", 209112, ...)` (`feedback.ts:108`).
4. Inside the lock, signal is "dislike" — route calls `getRejectionIds("movie")` to record whether the household veto already exists (`feedback.ts:128`), then `addRejection("movie", 209112, title)` to write `rejections.json` first (`feedback.ts:129`).
5. `addRejection` in `rejections.ts:164` serializes through `writeQueue`, clones the file, pushes the new entry, writes a temp file, renames atomically over the real file, updates `cached`.
6. Then `setDislike(session.sub, "movie", 209112, title)` writes `userFeedback.json` via the same snapshot-then-swap pattern (`userFeedback.ts:236`).
7. If `setDislike` throws, route calls `anotherUserDislikes` (`userFeedback.ts:334`) — if no other user dislikes the title, it calls `removeRejection` to roll back the household veto (`feedback.ts:138`).
8. Back on the happy path, route fires two fire-and-forget mirrors: `postFeedback` (sends `{ sub, kind, tmdb_id, signal: "dislike" }` to `/events/feedback`) and `postRejection` (sends `{ kind, tmdb_id }` to `/events/rejection`) so the Python sidecar's tables stay in sync (`feedback.ts:204-208`).
9. Route returns `{ ok: true }` to the SPA.
10. On the next `GET /api/suggestions/movie`, the route reads `rejections.json` and builds `rejected = new Set([..., 209112, ...])`. `filterRecommenderSafe` (or `filterHouseholdSafe`) drops any pick whose id is in that set — Batman v Superman never appears again.

---

## 4. PREREQUISITES

Before studying this module, a beginner should understand:

- **JavaScript Promises and async/await**: `writeQueue` is a chained promise acting as a single-writer queue; you must understand why `.then(fn)` on a settled promise runs `fn` asynchronously but in order.
- **Promise chaining for serialization**: the pattern `writeQueue = op.catch(...)` is a specific trick for keeping a queue alive even after a failure. Understand the difference between `op` (returned to caller, can reject) and `writeQueue` (the recovery tail, never rejects).
- **Node.js filesystem basics**: `fs.readFile`, `fs.writeFile`, `fs.rename` — specifically why `rename(2)` is atomic (the OS either swaps the file or doesn't; no reader ever sees a partial write).
- **HTTP route handlers in Hono** (or Express-style frameworks): what a middleware is, how `c.get('session')` retrieves data set by earlier middleware, and what `c.json(...)` does.
- **JSON as a simple database**: these stores are JSON files with an in-memory `cached` pointer. Understand cache invalidation: `cached = snapshot` only after a successful write.
- **Basic concurrency concepts**: what a "race condition" is — two writes happening at the same time, both reading the old state, each overwriting the other's change.

---

## 5. GOTCHAS & WAR STORIES

**Franchise-collision bug — PR #107 ("movie strip capped ~8")**

The original `filterHouseholdSafe` was used for ALL paths including the local recommender. It built `libraryTitles` via `titleSetFrom(library)`, which with `includeBase: true` (the default) added not just full normalized titles but also base forms — the part before the first `:` or `–`. Owning "Batman: Bad Blood" added `"batman"` to the set. Then `titleMatches(pick, libraryTitles)` checked whether any pick's base form was in that set. "Batman v Superman", "The Dark Knight", "Batman Begins" — every pick whose base form collided with `"batman"` was silently dropped. The recommender returned 20 items; only 7 survived the filter. The user saw a strip of 7 and had no way to diagnose why.

The fix: `filterRecommenderSafe` uses `libraryTitlesFull` (built with `{ includeBase: false }`) and `rejectedTitles` (also `includeBase: false`). Base-form matching survives only in `filterHouseholdSafe`, which is now limited to the trending and Claude paths where titles genuinely can come back without a TMDB id and subtitle variants need to be caught.

**Silent 409 rollback cap bug — PR #106 ("feedback dot cap fix")**

Before PR #106, both `userFeedback.ts` and the old version of `rejections.ts` had a hard cap: when the disliked/rejected list exceeded 500 entries, `addRejection` returned a 409. The `feedback.ts` route interpreted that as an error and rolled back. From the user's perspective: the red dot appeared, then disappeared, and the title kept coming back. The user had no idea they'd hit a cap — the 409 was swallowed. The fix was to remove the cap entirely (both likes and dislikes are now unbounded at the persistence layer) and rely on the render-layer slice (20 items) to keep responses manageable. The lesson: silent capacity failures in a feedback store create the exact user experience the store was built to prevent.

**tmdbId:0 breaking the entire TV batch — memory entry (recommender_tmdb_id_positive)**

Sonarr routinely stores series with `tmdbId: 0` because it keys off TVDB ids. The `/score` request payload included these as `{ tmdb_id: 0 }`. The Python recommender's `PositiveStrictInt` Pydantic validator rejected the whole request body with a 422. The Hono backend caught the 422 as a `RecommenderError`, logged a warning, and fell back to TMDB trending for the entire household's TV suggestions — silently. No error surfaced in the SPA. The fix in `suggestionsRecommenderPath.ts:87` strips any `tmdb_id` that is not a positive integer before building the request, omitting the field entirely for those items (a title-only `LibraryItem` is valid per the sidecar schema). The lesson: one bad value in an array can 422 the whole batch; validate at the boundary before you send.

---

## 6. QUIZ BANK

**Q1.** A user dislikes Movie A. Fifteen minutes later, a second user dislikes Movie A from a different browser tab. An hour later, the first user changes their mind and removes their dislike. Should Movie A be removed from `rejections.json`? Why or why not, and what code makes this determination?

**A1.** No. The second user still dislikes Movie A, so the household veto must stay. In `feedback.ts` (DELETE handler), after clearing the first user's personal feedback via `clearFeedback`, the route calls `anotherUserDislikes(session.sub, type, tmdbId)` (defined in `userFeedback.ts:334`). This iterates all *other* users in the feedback file and checks whether any of them still has the title in their `disliked` list. When it returns `true`, `removeRejection` is never called, and `rejections.json` is left intact.

**Q2.** The recommender sidecar is down (connection refused). Describe exactly what the user sees when they open the Movies tab, and trace which code path produces that result.

**A2.** The user sees the TMDB trending strip, not a personalized list. In `suggestionsRecommenderPath.ts:105`, `scoreOnce` throws a `RecommenderError` (connection refused). The catch block logs a warning and sets `recSucceeded = false` but does not re-throw. Execution continues: `recItems` is empty, so `safe.length === 0`, and the route falls into the trending fallback branch (`suggestionsRecommenderPath.ts:130`). If a TMDB key is configured, `tmdbTrending(type)` is called, the result is passed through `filterHouseholdSafe`, and the response JSON has `source: "trending"`. The SPA renders this identically to a successful personalized response (same `TrendingItem` shape); the degradation is silent unless the user reads the `_diag` object in devtools.

**Q3.** Why does the `dislike` branch in `feedback.ts` write `addRejection` *before* `setDislike`, while the `like` (red-to-green) branch writes `removeRejection` *before* `setLike`? What would break if the order were reversed in either case?

**A3.** The ordering is chosen so that the rollback is always cheaper/cleaner than the forward failure. For dislike: if `addRejection` succeeds but `setDislike` throws, the route rolls back the rejection with `removeRejection` — a simple undo, no prior state reconstruction. If the order were reversed (setDislike first, addRejection crashes), the personal dislike would be stored but the household veto would be missing — the title would vanish from the current user's strip but keep appearing for everyone else, and there'd be no way to detect the inconsistency without scanning both files. For like: `removeRejection` first means if `setLike` throws, the route can restore the rejection via `addRejection`. Reversed, a setLike success followed by removeRejection crash would leave the personal signal stored as "like" but the household veto still in place — the user's green dot would be permanent, but the title would still be filtered out of every suggestions call, making the like functionally invisible.

**Q4.** A user has owned "Batman: Bad Blood" (Radarr). The recommender returns "The Dark Knight" (id=155) as its top pick. With the pre-PR-#107 code, would "The Dark Knight" survive `filterHouseholdSafe`? With the post-PR-#107 code using `filterRecommenderSafe`, would it survive? Explain both outcomes.

**A4.** Pre-#107: No. `titleSetFrom(library)` with `includeBase: true` adds the base form of "Batman: Bad Blood" — `normalizeTitleBase("Batman: Bad Blood")` returns `"batman"`. `titleMatches("The Dark Knight", libraryTitles)` checks whether `"batman"` is in the set. It is. `filterHouseholdSafe` drops the pick. Post-#107: Yes. `filterRecommenderSafe` uses `libraryTitlesFull`, built with `{ includeBase: false }`. That set contains `"batmanbadbblood"` (the full normalized title) but NOT `"batman"`. `normalizeTitle("The Dark Knight")` returns `"darkknight"`, which is not in `libraryTitlesFull`. The pick survives.

**Q5.** The Python recommender's `PositiveStrictInt` type rejects `tmdb_id: 0`. Sonarr carries `tmdbId: 0` on many series. If the Hono backend sends the full unfiltered library array to `/score`, what happens to the user's TV suggestions, and where in the code does the fix live?

**A5.** The entire `/score` request fails with a 422 Unprocessable Entity. `scoreOnce` throws a `RecommenderError` with `status: 422`. The catch block in `suggestionsRecommenderPath.ts` logs a warning and falls back to trending — silently degrading the user's entire TV suggestion strip to plain trending, not personalized recommendations. The fix lives in `suggestionsRecommenderPath.ts:87`: the library array is mapped with a conditional spread — `tmdb_id` is only included when `typeof it.tmdbId === 'number' && it.tmdbId > 0`. For Sonarr entries with `tmdbId: 0`, the field is omitted entirely, producing a title-only `LibraryItem` that the sidecar accepts.

---

## 7. CODE-READING EXERCISE

**File: `server/services/userFeedback.ts`**
**Focus: the write queue pattern (lines 52 and 236–270)**

Open `server/services/userFeedback.ts`. Locate these two module-level variables near the top:

```ts
let cached: FeedbackFile | null = null
let writeQueue: Promise<void> = Promise.resolve()
```

Now find the `mutate` function (around line 228). Read the body carefully. Answer these questions as you go:

1. `const op = writeQueue.then(async () => { ... })` — this does NOT immediately execute the inner function. When does it execute? What does chaining on `writeQueue` guarantee?

2. At line 267: `writeQueue = op.catch((err) => { console.error(...) })`. Why is `writeQueue` being updated to the *catch* version of `op`, not to `op` itself? What happens if a write fails and `writeQueue` still points to the rejected `op`?

3. At line 271: `return op` (not `return writeQueue`). Why does the caller receive `op` and not the updated `writeQueue`? What's the difference in behavior for the route handler that `await`s the returned promise?

4. Inside the inner `async () => { ... }` block at line 238: `const file = await load()` fetches from `cached` if set. If two mutations queue up in rapid succession, the second mutation calls `load()` while holding the lock — but `cached` was set by the *first* mutation after its write succeeded. Is this safe? Would the second mutation ever see stale data?

5. At line 260: `const snapshot: FeedbackFile = { ...file, [sub]: updatedUser }`. Then `await persistSnapshot(snapshot)`. Then `cached = snapshot`. Why is `cached` updated *after* the persist, not before? What would happen if persist threw and `cached` had already been updated?

**Expected insights from working through this:**
- The `writeQueue` chain is a single-concurrency async mutex: each new operation waits for the previous one to settle before starting.
- The "two-ref" pattern (`op` to caller, `writeQueue = op.catch(...)`) ensures that a single write failure doesn't permanently break the queue for all subsequent callers — the catch branch returns `undefined` (not a rejection), so the next `.then(fn)` on `writeQueue` runs immediately rather than skipping.
- `cached = snapshot` only after persist means that on a crash mid-write, the next `load()` re-reads from disk and finds the *old* file, not ghost state from a failed write.
- Because the second mutation in the queue reads `cached` *inside* `.then(...)` (after the first mutation has already updated `cached`), it always sees the freshest persisted state.

---

