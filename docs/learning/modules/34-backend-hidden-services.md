
# Backend Hidden Services — Teaching Dossier

*Four services that run silently and keep the system honest.*

---

## 1. WHAT — "The Quiet Machinery"

Most backend code responds to requests. These four modules do not — they enforce invariants, record intent, and prepare the system for failure before anyone notices. `watchSignal.ts` decides, with pure arithmetic, whether a viewing session constitutes a real taste signal. `sourcePrecedence.ts` arbitrates which media backend should serve a title, layering fallback logic so the user never sees a blank source-error when another path exists. `dbBackup.ts` + `dbBackupScheduler.ts` take consistent point-in-time snapshots of every SQLite database on a nightly cron, verify their integrity, and stamp a freshness timestamp that other parts of the system rely on before running destructive operations. `suggestionsClaudePath.ts` + `suggestionsPrompt.ts` implement the full BYO-key Claude recommendations pipeline — candidate pool selection, a structured tool-use prompt, one bounded retry pass, graceful fill, and per-request cost accounting — even though production has bypassed this path in favour of the local Python recommender since the sidecar shipped. Together they are the system's immune system: they almost never appear in a stack trace, but the moment any one of them is missing, something quietly rots.

---

## 2. WHY — Per Service

### watchSignal.ts
**Constraint: implicit-feedback loop must not be noisy.**
Every five seconds the IPTV progress endpoint receives a heartbeat. If each heartbeat fired a "watched" signal to the recommender, the implicit-feedback training set would be dominated by titles the household sampled for 30 seconds and abandoned. The 40 % threshold was chosen deliberately low (a ~40-minute commitment on a 100-minute film) to catch "watched most of it then stopped" while being high enough to exclude accidental starts and failed experiments. The `crossedWatchThreshold` edge-detection prevents duplicate fires on the same viewing session — the recommender receives exactly one `watched` signal per crossing, no matter how many more progress ticks follow.

### sourcePrecedence.ts
**Constraint: §9 Resolution-A — source arbitration must be at grant time, not mid-session.**
The architectural contract (`§9`) distinguishes between a pre-session grant (where auto-fallback is acceptable because no playback state has been established) and a mid-session source change (which requires explicit user consent, because switching source can mean codec/quality changes and progress-attribution ambiguity). The module encodes the precedence order `media-core (M3+) > Plex > IPTV`, probes live availability via lightweight HTTP endpoints (not full content checks), and returns either a resolved source or a `source_unavailable` payload with alternatives so the client can surface "switch source?" rather than a bare error.

### dbBackup.ts + dbBackupScheduler.ts
**Constraint: `server.db` loss silently revokes every paired device token (it holds `server_id`).**
The pre-existing migration backup gate only fires when a destructive migration runs — a disk failure or accidental volume delete at any other time was unrecoverable. The scheduler wires a nightly cron (default `30 3 * * *`) to `runScheduledBackup`, which uses SQLite's `VACUUM INTO` to produce a transactionally consistent copy of each live database. The snapshot is integrity-checked immediately after writing (before pruning older copies), so a corrupted source or a disk-full truncation is detected while good backups still exist. The `last_backup_at` stamp it writes to `server_state` doubles as the freshness signal the destructive-migration gate checks before allowing a schema-breaking deploy to proceed.

### suggestionsClaudePath.ts + suggestionsPrompt.ts
**Constraint: self-hosters without the Python recommender sidecar still deserve personalized recommendations.**
Production runs with `USE_LOCAL_RECOMMENDER=1`, so this path is unreachable in the deployed instance. It exists so operators who cannot or do not want to run the Python sidecar can supply their own Anthropic API key (via request header or stored in `userApiKeys`) and get Claude-powered recommendations. The pipeline is non-trivial: it pre-fetches a genre-seeded TMDB candidate pool, assembles a layered prompt with explicit cache-control boundaries on the stable library block, forces structured output via tool use, validates picks against the household's rejection and library sets, and retries once with explicit rejection feedback before filling any remaining slots from TMDB discover or trending.

---

## 3. MAP — Key Functions, Callers, Mini-Walkthroughs

### watchSignal.ts
- `WATCH_QUALIFY_FRACTION` (line 13): exported constant `0.4`. Referenced in tests and in the route to explain threshold to future readers.
- `watchQualified(p: WatchPoint): boolean` (line 22): returns `true` if `p.completed === 1` OR if `position_secs / duration_secs >= 0.4`. Returns `false` when `duration_secs` is null or zero (can't compute a fraction).
- `crossedWatchThreshold(prior, now): boolean` (line 37): returns `true` only when `now` qualifies AND `prior` did not (or prior is absent). Guards the single-fire invariant.

**Caller:** `server/routes/iptv.ts` — the `maybeEmitWatched` function (line 264) is invoked by the IPTV watch-history POST handler on every progress tick. It reads the prior `WatchPoint` from the DB, calls `crossedWatchThreshold`, and fires `postFeedback({ signal: 'watched' })` to the recommender exactly once per threshold crossing.

**Mini-walkthrough:**
1. User watches 38 % of a film → progress POST arrives → `prior = { position_secs: 2700, duration_secs: 7200, completed: 0 }` (37.5 %), `now.position_secs = 2882` (40.0 %).
2. `watchQualified(prior)` → `2700/7200 = 0.375 < 0.4` → `false`.
3. `watchQualified(now)` → `2882/7200 = 0.400 >= 0.4` → `true`.
4. `crossedWatchThreshold(prior, now)` → now qualifies, prior did not → `true`.
5. `maybeEmitWatched` resolves TMDB id from IPTV DB, calls `postFeedback({ signal: 'watched' })`.
6. On the very next tick at 42 %: `watchQualified(prior)` is now `true` → `crossedWatchThreshold` returns `false` → no second fire.

### sourcePrecedence.ts
- `probeIptv(): Promise<boolean>` (line 56): calls Xtream `/player_api.php` with a LAN timeout. 5xx or timeout → `false`; 4xx (bad creds) → `false`; 2xx → `true`.
- `probePlex(): Promise<boolean>` (line 84): calls Plex `/identity` with a LAN timeout. Unauthenticated endpoint.
- `buildCandidates(item): Promise<ResolvedSource[]>` (line 110): builds the ordered candidate list. In M1.5 only IPTV can serve items (no `ratingKey` mapping for Plex). Returns `[{ source: 'iptv', ... }]` when IPTV is reachable, `[]` otherwise.
- `resolveSourcePrecedence(item): Promise<PrecedenceResult>` (line 145): the public API. Returns `{ resolved: ResolvedSource }` if any candidate is available, or `{ resolved: null, alternatives: [...] }` with a Plex alternative if PMS is up.

**Callers:** `server/routes/iptv.ts` at lines 599 (live grant), 675 (catchup grant), 974 (VOD grant), 1050 (series grant). Every IPTV grant endpoint calls `resolveSourcePrecedence` before constructing the play URL.

**Mini-walkthrough (live grant):**
1. User taps a live channel → `POST /api/iptv/grant/live/:streamId`.
2. Grant handler calls `resolveSourcePrecedence({ kind: 'live', id: '4321' })`.
3. `buildCandidates` probes IPTV → `res.ok = true` → returns `[{ source: 'iptv', kind: 'live', id: '4321' }]`.
4. `resolveSourcePrecedence` returns `{ resolved: { source: 'iptv', kind: 'live', id: '4321' } }`.
5. Grant handler constructs the Xtream stream URL, issues the token, responds `200`.
6. If IPTV is down: `buildCandidates` returns `[]`; `probePlex` is called as a fallback probe; if PMS is up, `alternatives` contains `{ source: 'plex', ... }` and the handler responds `503` with `source_unavailable` + alternatives for the client to surface.

### dbBackup.ts + dbBackupScheduler.ts
- `backupStamp(d): string` (line 34): produces a filesystem-safe ISO timestamp (`2026-06-11T03-30-00-000Z`).
- `vacuumIntoHandle(db, destPath): void` (line 44): calls `db.exec("VACUUM INTO '...'")` on an already-open handle. Used for `server.db` (owned by the live `serverDb()` singleton) to avoid a locking race.
- `vacuumIntoPath(srcPath, destPath): void` (line 56): opens a short-lived connection with `busy_timeout = 5000` for databases not held open by a singleton (iptv.db on non-IPTV-disabled builds).
- `verifySnapshot(destPath): void` (line 74): opens the freshly written snapshot read-only, runs `PRAGMA integrity_check`, throws if not `'ok'`. Runs before `pruneSnapshots` so a corrupt snapshot never silently replaces a good one.
- `pruneSnapshots(dir, prefix, keep): void` (line 89): reads the backup directory, sorts snapshots lexicographically (ISO timestamps sort chronologically), removes all but the newest `keep` entries.
- `runScheduledBackup(now): BackupResult` (line 121): orchestrates the full pass — `mkdirSync` the backup dir, snapshot `server.db` via live handle, optionally snapshot `iptv.db` via short-lived connection, verify both, prune both, stamp `server_state.last_backup_at`, return `{ dir, files, stampedAt }`.
- `registerDbBackupSchedule(cronExpr): ScheduledTask` (`dbBackupScheduler.ts` line 13): validates the cron expression (falls back to `30 3 * * *` on invalid input), registers `node-cron`, calls `runScheduledBackup` on each tick, logs success or fires a telemetry error event on failure.

**Caller:** `server/index.ts` line 85 — `cronTasks.push(registerDbBackupSchedule(env.DB_BACKUP_CRON))`.

**Mini-walkthrough:**
1. 3:30 AM — cron fires → `runScheduledBackup()` is called.
2. `mkdirSync(env.DB_BACKUP_DIR, { recursive: true })` ensures the directory exists.
3. `vacuumIntoHandle(serverDb().raw, 'server-2026-06-11T03-30-00-000Z.db')` — atomic consistent copy while the server is live.
4. `verifySnapshot(...)` — opens the snapshot read-only, checks `PRAGMA integrity_check = ok`, closes it.
5. `pruneSnapshots(dir, 'server', env.DB_BACKUP_KEEP)` — removes snapshots beyond the retention window.
6. `vacuumIntoPath(env.IPTV_DB_PATH, 'iptv-...')` if the iptv.db file exists, same verify+prune.
7. `INSERT INTO server_state ... ON CONFLICT DO UPDATE SET value = ...` stamps `last_backup_at = '2026-06-11T03:30:00.000Z'`.
8. Returns `{ dir, files: ['server-...db', 'iptv-...db'], stampedAt }`. Scheduler logs success.
9. If step 4 throws (integrity check fails), `pruneSnapshots` never runs — the corrupt snapshot and all prior good snapshots remain on disk.

### suggestionsClaudePath.ts + suggestionsPrompt.ts
Key functions in `suggestionsPrompt.ts`:
- `MODEL` (line 14): `'claude-haiku-4-5'` — deliberate cost choice; the cheapest capable model.
- `CLAUDE_OVERFETCH = 30` (line 23): asks Claude for 30 picks when the target is 20, to absorb post-validation drops.
- `buildLibraryBlock(kind, library, rejections): string` (line 98): constructs the stable cached prompt prefix — all rejections ("NEVER SUGGEST"), then the full library with genre distribution. This block carries `cache_control: { type: 'ephemeral' }` so Anthropic caches it at 0.1x input token cost across refreshes.
- `buildPriorityTasteBlock(library): string` (line 186): extracts the top-30 genre-weighted library titles into a volatile (uncached) high-attention block placed after the cache boundary. Only fires when library > 60 titles.
- `buildUserLikesBlock(liked): string` (line 154): reverses the likes array (newest first), caps at 500 for prompt token budget.
- `buildCandidatePoolBlock(candidates): string` (line 225): numbered list of pre-vetted TMDB titles for Claude to rank from.
- `refreshSalt(): string` (line 401): 16 hex chars of entropy injected into the volatile user message to break cache-prefix determinism across refreshes.
- `callClaudeInitial(...)` (line 514): wraps the Anthropic SDK call with `withAnthropicRetry` (handles 529/503 transients) and `withClaudeDeadline` (20 s abort). Forces `tool_choice: { type: 'tool', name: 'submit_recommendations' }`.
- `callClaudeRetry(...)` (line 545): reconstructs the multi-turn conversation as `user → assistant (prior tool_use) → user (tool_result describing rejections)` and calls Claude again. Drops the recently-shown block so Claude has more freedom.

Key functions in `suggestionsClaudePath.ts`:
- `runClaudeSuggestionPath(c, ctx): Promise<Response>` (line 64): the top-level handler. Short-circuits on missing TMDB key (503), cold library (< 10 titles → trending), and missing API key (402). Otherwise: fetches candidate pool + backfills titles in parallel, calls `callClaudeInitial`, validates picks, conditionally retries, fills remaining slots from TMDB discover/trending, records usage event and `recordShown`.

**Callers:** `server/routes/suggestions.ts` line 301 — `return runClaudeSuggestionPath(c, ctx)` — reached only when `USE_LOCAL_RECOMMENDER` is off.

**Mini-walkthrough (happy path):**
1. GET `/api/suggestions/movie` with `x-anthropic-api-key: sk-ant-...` and a 50-title library.
2. Prologue (in `suggestions.ts`) builds `ctx` — library list, rejection IDs, filter function, timing hooks.
3. `runClaudeSuggestionPath`: confirms TMDB configured, library ≥ 10, API key present and starts with `sk-ant-`.
4. `fetchCandidatePool` (top-5 genres → TMDB /discover, cached 1 h) + `backfillRejectionTitles` + `backfillLikedTitles` — all in parallel.
5. Pool filtered through `filterHouseholdSafe` (drops library + rejects), shuffled.
6. `callClaudeInitial`: sends cached library block + volatile taste/likes/recently-shown/pool blocks → Claude calls `submit_recommendations({ picks: [...30 items] })`.
7. `validatePicks`: each pick is checked against rejection IDs, library IDs, and normalized titles. Pool hits skip the TMDB /search round-trip. Returns `accepted` + `rejectedForRetry`.
8. If `accepted.length < 20` and `rejectedForRetry.length > 0` → `callClaudeRetry` with a `tool_result` explaining exactly which picks were dropped and why.
9. After retry validation, if still < 20 → fill from TMDB discover → trending.
10. `recordShown` logs what was served. `appendUsageEvent` records token counts + cost.
11. Response: `{ source: 'personalized', items: [...20], _diag: { accepted, poolHits, poolHitRate, costCents, cacheHitRate, ... } }`.

---

## 4. PREREQUISITES — Fundamentals First

Before studying these services a learner should understand:

1. **SQLite WAL mode** — why two connections to the same WAL database can coexist, and what `VACUUM INTO` guarantees (consistent snapshot without locking writers).
2. **Event-driven implicit feedback** — the distinction between explicit feedback (user clicks Like/Dislike) and implicit feedback (inferred from behaviour). Why a raw play-count is too noisy and why completion/threshold logic is needed.
3. **Hono route context (`Context<Env>`)** — how middleware attaches the typed `session` object to the request context, since both watchSignal callers and the Claude path receive `session.sub` from it.
4. **Anthropic prompt caching** — what `cache_control: { type: 'ephemeral' }` does, how it reduces costs for stable content, and why volatile blocks must be placed AFTER the cached region.
5. **node-cron basics** — cron expression syntax (five fields: minute hour day month weekday), `ScheduledTask.stop()` for graceful shutdown.
6. **The §9 source-arbitration contract** — the project design constraint that fallback is only permitted pre-session; mid-session changes require explicit user action. This motivates the "probe at grant time, not during playback" design of `sourcePrecedence.ts`.

---

## 5. GOTCHAS & WAR STORIES

**watchSignal.ts — duration_secs can be null.**
The IPTV API does not always supply duration metadata for live streams or for VOD items whose catalog entry hasn't been scraped yet. If `duration_secs` is null or zero, `watchQualified` always returns `false` — the signal never fires for that item regardless of how long the user watches. The `completed` flag is the escape hatch: if the player explicitly marks playback done, the signal fires even without duration. A `null` duration doesn't cause an error, but it means implicit feedback is silently absent for those items.

**watchSignal.ts — re-watch re-fires, and that's intentional.**
If a household re-watches a title and the progress row is reset to `position_secs = 0`, the next qualifying tick will `crossedWatchThreshold` again (`prior` is now under threshold). This was a deliberate choice: the recommender upserts the signal idempotently (a second `watched` for the same title doesn't corrupt the model), and a re-watch is itself a meaningful positive signal.

**sourcePrecedence.ts — Plex appears in `alternatives` but cannot actually serve IPTV items in M1.5.**
`probePlex` is called even in the success path (when IPTV is up) only in the failure branch. But in `buildCandidates` Plex is explicitly NOT added as a candidate even when reachable, because there is no `ratingKey ↔ stream_id` mapping yet. The comment at line 103 is explicit: "Included only in available_alternatives via probeIptv path so UI can surface 'switch to Plex?'". If you see Plex in `alternatives` on a `source_unavailable` 503 response, it means PMS is reachable but the IPTV panel is down — not that Plex can serve the content.

**dbBackup.ts — VACUUM INTO refuses to overwrite an existing file.**
If two backup runs fire within the same millisecond (possible in tests or under a clock rollback), the second `VACUUM INTO` would throw "output file already exists." The code explicitly `fs.rmSync(destPath, { force: true })` before each `VACUUM INTO` call. This is a one-liner that's easy to miss if you ever refactor the backup loop.

**dbBackup.ts — verification happens before pruning, not after.**
`verifySnapshot` is called immediately after each `VACUUM INTO`. If it throws, `pruneSnapshots` is never reached — all prior good snapshots remain on disk. The ordering is load-bearing: reversing it would mean a corrupted snapshot could silently delete the last good backup before the error is detected.

**suggestionsClaudePath.ts — the `_diag` field is a debugging lifeline, not dead code.**
Every response path populates a `_diag` object with `poolHits`, `poolHitRate`, `droppedPicks`, `costCents`, `cacheHitRate`, `callCount`, `recentlyShownCount`, and when applicable `claudeTruncated`. In production the frontend ignores it, but opening the network tab and inspecting the suggestions response gives a complete picture of why a particular refresh produced its lineup. If `cacheHitRate` is 0.0 on every request, the library fingerprint is changing too fast and the household is paying full input token rates.

**suggestionsPrompt.ts — `callClaudeRetry` drops the recently-shown block.**
The retry pass intentionally omits `recentlyShownBlock` from the system stack. The recently-shown constraint contributed to the initial pass having rejectable picks; removing it gives Claude more freedom on the retry. This means a retry response may include titles that were recently shown — the post-validation `recordShown` will update the shown log anyway, so the next request's recently-shown block will capture them.

---

## 6. QUIZ BANK

**Q1.** A user watches 38 % of a two-hour film, stops, then resumes and reaches 41 %. How many times does `postFeedback({ signal: 'watched' })` fire for that title? Explain with reference to `crossedWatchThreshold`.

**A1.** Exactly once. When the user stops at 38 %, `watchQualified(now)` returns `false` (37.5 % < 40 %), so `crossedWatchThreshold` returns `false` and no signal fires. On resume, when the position first crosses 40 %, `prior` is the last persisted row (still < 40 %) and `now` qualifies → `crossedWatchThreshold` returns `true` → signal fires. All subsequent progress ticks have `prior` already qualifying, so `crossedWatchThreshold` returns `false` for every remaining tick.

**Q2.** IPTV is down. The Plex server is reachable. A user requests a live grant. What HTTP status does the grant endpoint return, and what is in the response body? Why can't the backend automatically switch to Plex?

**A2.** The grant endpoint returns `503` with a `source_unavailable` reason and a body that includes `available_alternatives: [{ source: 'plex', displayName: 'Plex', kind: 'live', id: '<streamId>' }]`. The backend cannot automatically switch to Plex because (a) there is no `ratingKey ↔ stream_id` mapping in M1.5 — Plex cannot construct a play URL for an IPTV stream ID — and (b) the §9 contract requires explicit user consent for source changes, even if the mapping existed, because switching source mid-session implies a potential codec/quality/progress-attribution change.

**Q3.** The nightly backup runs and `verifySnapshot` throws a non-'ok' integrity result. What happens to: (a) the corrupt snapshot file, (b) prior good snapshots, (c) the `last_backup_at` stamp in `server_state`?

**A3.** (a) The corrupt snapshot file stays on disk — `rmSync` was called before `VACUUM INTO`, but the new file was written (even if corrupt) and `verifySnapshot` opens and checks it before any cleanup. (b) Prior good snapshots are preserved: `pruneSnapshots` is never reached because `runScheduledBackup` throws before it. (c) `last_backup_at` is NOT updated — the stamp write happens after the verify+prune block. The destructive-migration gate will see a stale stamp and should block the migration.

**Q4.** A self-hoster runs without the Python recommender sidecar and has 8 titles in their library. They hit `GET /api/suggestions/movie`. What does the response look like, and what is the `source` field?

**A4.** `runClaudeSuggestionPath` fires (because `USE_LOCAL_RECOMMENDER` is off). The library size check `library.length < COLD_START_THRESHOLD` (10) is `true` → the cold-start path executes: `tmdbTrending('movie')` is called, filtered through `filterHouseholdSafe`, and the first `TARGET_COUNT` results are returned. The response body is `{ source: 'trending', items: [...], _diag: { reason: 'library_below_threshold', libraryCount: 8, threshold: 10, hint: '...' } }`. No Anthropic API call is made; the household's API key is never used.

**Q5.** A Claude suggestions response has `source: 'personalized_filled'` and `_diag.accepted = 14`. What does this tell you about what happened during the request, and what populated the remaining 6 slots?

**A5.** Claude's initial + retry passes together yielded only 14 picks that passed household-safety validation (not in library, not in rejections, not year-mismatched, not deduplicated). The fill path then ran: first TMDB `/discover` filtered by the household's top genres (if any genre IDs were available), then TMDB trending as a fallback, filtered through `filterHouseholdSafe` and deduplicated against the 14 accepted picks. The final strip has 20 items: 14 Claude-personalized picks + 6 from discover/trending. The `_diag.fillSource` field (`'discover'`, `'trending'`, or `'discover+trending'`) tells you which fill path actually contributed.

**Q6.** Why does `buildLibraryBlock` put rejections BEFORE the library in the prompt text, and what does the `cache_control: { type: 'ephemeral' }` annotation on the library block mean for per-request cost?

**A6.** Rejections are placed first ("NEVER SUGGEST" at the top of the block) because LLM attention is highest at the beginning of a context section — the constraint that directly reduces wasted API spend (a rejected pick burns tokens and produces no user value) is placed where Claude is most likely to internalize it. The `cache_control: { type: 'ephemeral' }` annotation tells Anthropic's infrastructure to cache this message block across API calls with the same content. On a cache hit, these tokens are billed at ~0.1x the normal input token rate. The `cacheHitRate` in `_diag` shows the fraction of input tokens that were served from cache; a rate near 1.0 means the library hasn't changed since the last call and the household is paying roughly one-tenth of the full cost for the library block.

---

## 7. CODE-READING EXERCISE — A Guided Walk Through watchSignal.ts

This exercise is self-contained: all you need is the file at `server/services/watchSignal.ts` (42 lines total).

**Step 1 — Read the module header (lines 1–11).**
Notice the comment says "pure (no DB/network)". This is an architectural claim, not just a style note. A pure module has no side effects: it can be unit-tested directly with no mocks, no running database, no fake HTTP server. Look at the imports — there are none. Everything the module does is a function of its inputs.

**Step 2 — Examine the WatchPoint interface (lines 15–19).**
There are exactly three fields. Ask: why `completed: number` and not `completed: boolean`? SQLite stores booleans as integers (0/1). The interface reflects the raw DB row shape rather than a TypeScript ideal, so the code that reads from the DB can pass the row directly without a mapping step. This is a pragmatic design choice — convenience over type purity.

**Step 3 — Read watchQualified (lines 22–28).**
Trace the three branches in order:
- Branch 1: `completed === 1` → `true`. Why is this first? Because a completed flag should trump any position calculation. A player that fires `completed=1` at 35 % (e.g., skipped to end) is still a real watch signal.
- Branch 2: duration known and positive → ratio check. Note `!= null` (not `!== null`): this also catches `undefined`, which might appear if a row from the DB has a missing field. Defensive widening.
- Branch 3: duration null or zero → `false`. Not an error — silently produces no signal.

**Step 4 — Read crossedWatchThreshold (lines 37–41).**
This function is an edge detector: it returns `true` only on the TRANSITION from not-qualified to qualified. Trace its three guards:
- Guard 1: `if (!watchQualified(now)) return false` — if current state doesn't qualify, there's no crossing, full stop.
- Guard 2: `if (prior && watchQualified(prior)) return false` — if the prior state already qualified, the crossing already happened; don't fire again.
- Guard 3 (implicit fall-through): if `now` qualifies and `prior` didn't (or didn't exist), return `true`.

Notice the asymmetry: `prior` uses `&&` (falsy check) not `!= null`. This means `prior = undefined` (no DB row, first ever progress tick for this title) falls through to `true` — a missing prior row is treated as "not yet qualified", which is correct: the first qualifying tick on a brand-new session should fire.

**Step 5 — Think about the re-watch case.**
What happens if a household re-watches a title and the progress row is reset to `position_secs = 0, completed = 0` before the new watch starts? When the new watch crosses 40 %, `prior` is the reset row (under threshold) and `now` qualifies → `crossedWatchThreshold` returns `true` → signal fires again. Is this a bug? No — the comment at line 41 explicitly calls it harmless because the recommender upserts idempotently. A re-watch is positive signal. The design accepts a second fire rather than adding complexity to track watch-session epochs.

**Step 6 — Look at the test file** (`server/services/watchSignal.test.ts`).
The tests cover: `completed=1` regardless of position, exactly-40 % boundary, just-under-40 %, null duration, zero duration, first-ever-tick with `undefined` prior, under-threshold pair, under→qualified crossing, qualified→qualified (no re-fire). Every behaviour documented in the source comments has a corresponding test. This is the standard to aim for in pure service modules: if it has no side effects, there is no excuse for less than full branch coverage.

---

