
# *arr / SAB Bridge — Teaching Dossier

---

## 1. WHAT

Imagine a household library system with two specialist librarians and a delivery truck. **Radarr** is the movie librarian: you tell it "I want Dune," it searches for a download and files it away once it arrives. **Sonarr** is the TV librarian: same idea but it tracks whole series, knows which episodes you have, and automatically fetches new ones as they air. **SABnzbd** (SAB) is the delivery truck — it actually downloads the files from Usenet or torrent sources, sits in a queue, and hands the finished files to the librarians to import into the library. The *arr/SAB bridge in theemeraldexchange is the set of backend routes and services that lets the web SPA talk to these three tools in a controlled way: no direct API access, no user can reach the librarians' private keys, and every "request a movie" action goes through a size-cap layer that keeps a stray 80 GB 4K rip from filling your NAS.

---

## 2. WHY — why bridge through the backend?

**Auth**: Radarr, Sonarr, and SAB each have an API key that grants full admin access (delete history, change root folders, add any torrent). Those keys are held only by the backend process via environment variables — they never reach the browser. A SPA calling Radarr directly would expose the key to every logged-in user's DevTools.

**Capping**: Radarr's own automatic search will grab whatever its quality profile scores highest — which can easily be a 50 GB 4K HDR Blu-ray remux. The backend intercepts before Radarr can auto-grab, runs its own release search, and filters every candidate to `size ≤ env.maxMovieBytes`. Users therefore can't accidentally fill the NAS. Sonarr has the same cap on a per-episode basis (`env.maxTvBytesPerEpisode`).

**Toasts / event log**: The backend appends every grab attempt to a persistent JSONL file (`grabLog.ts`). When a grab fails (releases over cap, parse rejection, indexer error), the admin sees *why* in the admin panel rather than just a silent gap in the library. The SPA receives structured status codes (`424 capped_grab_not_started`, `200 monitoring`) that it turns into toast messages.

**Allow-list**: Only a curated set of Radarr and Sonarr endpoints are exposed (read-only GETs are open to any authenticated member; mutate POSTs are rate-limited; admin-only ops like DELETE are gated). A non-admin cannot reach `/api/v3/rootfolder` for a destructive DELETE or pass arbitrary `qualityProfileId` to change the quality policy — the backend strips those fields from non-admin bodies in the "materialization" step.

---

## 3. MAP — key files and the "user requests a movie" walkthrough

### Key files

| File | Role |
|---|---|
| `server/routes/radarr.ts` | Movie add route (`POST /api/v3/movie`), `grabBestUnderCap`, upgrade route |
| `server/routes/sonarr.ts` | Series add route, `grabTvUnderCap` (fire-and-forget spawn) |
| `server/routes/sab.ts` | SAB queue/history proxy, admin-only pause/resume/delete |
| `server/routes/grabs.ts` | Read-only grab log endpoint (`/recent`, `/by-item`) |
| `server/services/radarr.ts` | `radarrFetch` helper + `radarrRootFolders` |
| `server/services/sonarr.ts` | `sonarrFetch` helper + `sonarrRootFolders` |
| `server/services/sab.ts` | `sabCall` helper (wraps SAB's `?mode=` API) |
| `server/services/grabLog.ts` | Append-only JSONL event log; `GrabEventType` union |
| `server/services/arrGrab.ts` | `createReservationLedger`, `createGrabEventRecorder` (shared) |
| `server/services/arrAdd.ts` | `gateRootFolderSpace`, `materializeNonAdminAddBody`, `Release` type |
| `server/services/grabEventType.driftguard.test.ts` | Cross-language contract test: server vs. client `GrabEventType` union |
| `src/lib/api/radarr.ts` | SPA-side typed wrapper for the `/api/radarr/…` proxy |
| `src/lib/api/grabs.ts` | SPA-side `GrabEventType` (must stay in sync with server) |

### "User requests a movie" — end-to-end walkthrough

1. **User clicks "Add Movie"** in the SPA (`AddMovieModal`). The SPA calls `POST /api/radarr/api/v3/movie` with a body containing `{ tmdbId, title, year }` and (for non-admins) no quality/folder fields.

2. **`resolveMovieAddBody`** (`radarr.ts:355`): because the session role is not `admin` with an explicit `rootFolderPath`, the raw body goes through `materializeNonAdminMovieBody`. That function strips anything outside `NON_ADMIN_RADARR_ALLOW` (only metadata fields survive) and calls Radarr upstream to resolve the configured root folder path and quality profile. This prevents a direct-POST from pinning a more permissive profile.

3. **Space gate** (`radarr.ts:385`): `validateRadarrRootFolderSpace` asks Radarr for its root folder list, gets `freeSpace`, then calls `gateRootFolderSpace` (shared in `arrAdd.ts`). This checks free bytes minus in-flight reservations against `env.minFreeBytes`. If the disk is too full, the request returns a `507`/`503` before touching Radarr.

4. **Cap rewrite** (`radarr.ts:399`): `wantedSearch` is captured (did the user ask to start downloading now?). The body is modified: `searchForMovie: false` — disabling Radarr's own search — and if `wantedSearch` is true, `monitored: false`. This means Radarr's RSS sweep cannot auto-grab an oversized release later.

5. **`POST /api/v3/movie` to Radarr** (`radarr.ts:406`): the backend calls upstream Radarr, which creates the movie record and returns a 201 with the new movie JSON (including an integer `id`).

6. **`recoverCreatedMovie`** (`radarr.ts:485`): parses the 201 body to get `{ id, title }`. If parsing fails (e.g. a proxy injected HTML), re-fetches by `tmdbId` as a fallback. Without this, a bad 201 body would strand a dead unmonitored movie with no grab ever attempted.

7. **`settleCappedMovieGrab` → `grabBestUnderCap`** (`radarr.ts:542`, `radarr.ts:101`): this is the heart of the cap pipeline:
   - Records `grab_started` event to grab log.
   - Waits 1 500 ms for Radarr to wire the record.
   - `GET /api/v3/release?movieId=<id>` — asks Radarr's indexer for matching releases.
   - Partitions results: all → `radarrAccepted` (not `rejected`, not `temporarilyRejected`, size > 0) → `eligible` (size ≤ `env.maxMovieBytes` AND leaves ≥ `env.minFreeBytes` free).
   - Sorts eligible by `qualityWeight` descending; picks the best.
   - Calls `radarrReservations.reserve(rootFolder, best.size)` — atomically reduces the in-flight headroom so a concurrent add can't clear the gate against the same snapshot.
   - `POST /api/v3/release` to Radarr with `{ guid, indexerId }` — Radarr tells SAB to download it.
   - Releases the reservation (regardless of grab success/failure).
   - Records `grab_succeeded` or `grab_failed` to the grab log.

8. **Outcome mapping** (`radarr.ts:556`):
   - `grab_succeeded` → return `null` (caller falls through to the normal 201 response + `signalAdded`).
   - `search_failed` or `grab_failed` → **roll back** (`deleteCreatedMovie`), return `424 capped_grab_failed`.
   - `no_releases` or `no_matching_releases` → **keep the movie**, flip it to `monitored: true` so Radarr's RSS sync will grab it when a release appears; return `200 { status: 'monitoring' }`.
   - `all_rejected_by_cap` → **roll back**, return `424 capped_grab_not_started`.

9. **`signalAdded`** (`radarr.ts:427`): only fires at the keep-success paths. Posts `signal: 'added'` to the local recommender so the optimizer learns from real conversions, not phantom ones for movies that got rolled back.

10. **SAB downloads the file**. Radarr watches SAB's queue. When the download completes, Radarr imports the file into the library and marks the movie as having a file.

---

## 4. PREREQUISITES — fundamentals first

**Usenet vs. torrents (eli5)**: Usenet is a decades-old message network where binary files (video, software) are posted as encoded messages on "groups." A provider like Eweka stores those messages on servers. SABnzbd reads a `.nzb` file (like a shopping list describing which message IDs make up the whole video), downloads and assembles all the parts, and you get an MP4/MKV. It is one-directional (you only download, no seeding) and typically faster than torrents, but articles expire after weeks/years and a DMCA takedown can delete them mid-download. Torrents are peer-to-peer: everyone who has the file shares pieces; slower and leaves a trace, but content lives as long as anyone seeds it.

**What is an "import"?** When SAB finishes downloading, the file lands in a "completed downloads" folder. Radarr/Sonarr watch that folder, recognize the file by name-matching (that is why unparseable release names cause rejections), and *import* it — copy or hard-link the file into the organized library folder (`/media/Movies/Dune (2021)/Dune.mkv`), update their own database (the file is now "have file"), and optionally rename it to their naming scheme.

**What is a quality profile?** Radarr and Sonarr maintain "quality profiles" that define which video codecs/resolutions they will accept and in what order they prefer upgrades. The "Choose Me" profile in this codebase is intentionally curated to exclude 4K tiers, acting as a second line of defense behind the backend's byte cap.

**What is an indexer?** An indexer is a search catalog that knows which `.nzb` or torrent files exist for a given title, season, and quality tier. Radarr/Sonarr query the indexer when you trigger a search.

---

## 5. GOTCHAS & WAR STORIES

### The 424 no_matching_releases bug (commit 64cf4ce)

**What happened**: A user tried to add "Far Far Away Idol." Radarr returned four releases for it, but all four came back with `rejected: true` because the titles were unparseable by Radarr's matching engine. The earlier code did not distinguish between "releases exist but Radarr rejected them for parse/title reasons" and "releases exist but all exceed our size cap." Both were lumped into the `all_rejected_by_cap` bucket, which triggered a rollback (movie deleted) and a `424` error toast.

**Why it was wrong**: Rolling back on a parse-rejection is punishing the user for Radarr's inability to parse the release name. The cap never applied at all — no release was even checked against `env.maxMovieBytes`. From the user's perspective, they tried to add a movie, it failed silently, and now the movie isn't in the library even in a "monitoring" state.

**The fix** (`server/routes/radarr.ts:136`): a third bucket was introduced — `no_matching_releases` — for the case where `all.length > 0` but `radarrAccepted.length === 0`. `no_matching_releases` and `no_releases` are now treated identically: keep the movie, flip it to monitored. The cap rollback (`all_rejected_by_cap`) only fires when Radarr-accepted releases exist and every one of them is over the byte ceiling or disk headroom threshold.

**The GrabEventType drift guard**: when `no_matching_releases` was added to the server's `GrabEventType` union, the client union in `src/lib/api/grabs.ts` lagged behind. The `GrabActivityPanel` builds exhaustive `Record<GrabEventType, ...>` label maps; the missing key resolved to `undefined` at runtime and the event was silently swallowed in the UI. The test in `server/services/grabEventType.driftguard.test.ts` was added to catch this: it parses both files with a regex, compares the member sets, and fails if they diverge. When you add a new `GrabEventType` member, the drift guard will fail CI until you add it to both files.

### 'added' signal only on keep-paths

The recommender's `signal: 'added'` was originally fired immediately after Radarr returned a 201. That meant a successful add followed by a cap-triggered rollback (movie deleted) still counted as a conversion, poisoning the optimizer with phantom data. The `signalAdded` closure is defined early but is only *invoked* at the keep-success paths (monitored fallback + grab_succeeded), never at rollback paths. If you add a new "keep" branch, you must call `signalAdded()` there. If you add a new rollback branch, you must ensure `signalAdded()` is not called.

### Radarr vs. Sonarr behavioral difference

**Radarr's grab is synchronous and rollback-capable**: the `POST /api/v3/movie` handler awaits `grabBestUnderCap`, inspects the result, and can delete the movie if the grab fails. The SPA gets a single response that encodes the final state (kept/rolled-back/monitoring). Toast messages (`capped_grab_*`) are possible.

**Sonarr's grab is fire-and-forget**: `grabTvUnderCap` is called with `void` and the series-add handler returns immediately with Sonarr's 201. TV series have multiple seasons and many episodes; a synchronous grab could hold the HTTP connection for 20–30 seconds. The tradeoff is that Sonarr has no rollback semantics — a TV series that has no cap-eligible releases just stays in the library monitored (Sonarr will pick it up via RSS). There is no `no_matching_releases` rollback path for Sonarr; it always keeps the series.

---

## 6. QUIZ BANK

(Six hard application-style questions. No definition recall — you must reason about behavior or trace code.)

---

**Q1.** A user adds a movie. Radarr returns six releases. Three have `rejected: true` with the reason "Unable to parse release." Two have `rejected: false` but their sizes are 45 GB and 62 GB, both exceeding `env.maxMovieBytes` (25 GB). One has `rejected: false` but `size: 0`. What value does `grabBestUnderCap` return, and what does the route handler do with the movie record?

**A1.** `radarrAccepted` = releases where `!rejected && !temporarilyRejected && size > 0`. The three rejected ones are excluded. The size-zero one is excluded. That leaves the 45 GB and 62 GB releases (both `rejected: false`, both `size > 0`). So `radarrAccepted.length = 2` but `eligible.length = 0` because both exceed `env.maxMovieBytes`. The `status` branch resolves to `all_rejected_by_cap` (radarrAccepted > 0, eligible = 0). `settleCappedMovieGrab` calls `deleteCreatedMovie` and returns a `424 capped_grab_not_started`.

---

**Q2.** Same scenario as Q1, but now all six releases have `rejected: true`. What status does `grabBestUnderCap` return, and what happens to the movie record?

**A2.** `radarrAccepted.length = 0`. The branch resolves to `no_matching_releases` (all.length = 6 > 0, radarrAccepted.length = 0). `settleCappedMovieGrab` calls `setMovieMonitored(created, true)`, fires `signalAdded()`, and returns `200 { status: 'monitoring', phase: 'no_matching_releases' }`. The movie stays in Radarr as a monitored item.

---

**Q3.** Two users add the same movie concurrently. The root folder has 28 GB free and `env.minFreeBytes` is 5 GB. The best eligible release is 24 GB. Walk through what the in-flight reservation ledger does to prevent both grabs from succeeding simultaneously. What happens to the second request?

**A3.** When request A calls `radarrReservations.reserve(rootFolder, 24 GB)`, the ledger records 24 GB in-flight. Available bytes = 28 GB − 24 GB = 4 GB. Request B subsequently calls `radarrReservations.availableBytes(rootFolder)` and gets 4 GB. The `eligible` filter requires `availableBytes - r.size >= env.minFreeBytes`, i.e. 4 GB − 24 GB = −20 GB ≥ 5 GB — false. So request B finds `eligible.length = 0`. With `radarrAccepted.length > 0`, it returns `all_rejected_by_cap`. The movie from request B gets rolled back with a 424.

---

**Q4.** A developer adds a new `GrabEventType` member called `'quota_exceeded'` to `server/services/grabLog.ts` and starts emitting it from the Sonarr cap pipeline, but forgets to update `src/lib/api/grabs.ts`. Which test fails and why? What is the exact user-visible consequence in production before the fix?

**A4.** The drift guard test in `server/services/grabEventType.driftguard.test.ts` fails: specifically the test `'client union covers every server GrabEventType member (no silent-undefined drift)'`, which finds `['quota_exceeded']` in `missingOnClient` and calls `expect(missingOnClient).toEqual([])`. In production before the fix, `GrabActivityPanel` builds an exhaustive `Record<GrabEventType, ...>` label map keyed off the *client* union. Events with type `'quota_exceeded'` arrive from the API but the label-map lookup returns `undefined`, causing the panel to silently display a blank or broken row for those events.

---

**Q5.** The `signalAdded` function is defined in the `POST /api/v3/movie` handler closure. Trace exactly the two places in `settleCappedMovieGrab` and the handler where it is legitimately called, and the reason it is NOT called in the `all_rejected_by_cap` branch.

**A5.** `signalAdded` is called in two keep-success paths: (1) inside `settleCappedMovieGrab` at the `no_releases`/`no_matching_releases` branch (`radarr.ts:593` — `signalAdded()` after `setMovieMonitored` succeeds); and (2) back in the main handler after `settleCappedMovieGrab` returns `null` (i.e. `grab_succeeded`, `radarr.ts:472`). It is NOT called in `all_rejected_by_cap` because that branch rolls back — `deleteCreatedMovie` removes the movie, so there is no conversion to record. Firing it there would poison the recommender with an `added` signal for a title that no longer exists in the library.

---

**Q6.** A user adds a TV series with `addOptions.searchForMissingEpisodes: true`. The series has three seasons. Sonarr marks seasons 1 and 2 as monitored. Indexer search returns: Season 1 full-season pack (15 GB, 10 episodes = 1.5 GB/ep, `rejected: false`); Season 2 Episode 1 (1 GB, `rejected: false`); Season 2 Episode 1 (1.2 GB, same episode, `rejected: false`, lower qualityWeight). `env.maxTvBytesPerEpisode` is 2 GB. Describe the `finalPicks` selected by `grabTvUnderCap`, including the tie-break logic.

**A6.** Both Season 2 Episode 1 releases pass the cap (1 GB / 1 episode = 1 GB/ep ≤ 2 GB; 1.2 GB/ep ≤ 2 GB). Season 1 pack: 15 GB / 10 ep = 1.5 GB/ep ≤ 2 GB — passes. `bestByChunk` deduplication: key `S1-pack` → only one entry. Key `S2E1` → two entries. Tie-break: same episode number → pick by `qualityWeight` descending, then `size` ascending on tie. Assuming qualityWeights differ, the one with higher qualityWeight wins; if equal, the smaller 1 GB release wins. `finalPicks` construction: season pack `S1-pack` is added to `packs`. `packSeasons = {1}`. For the `S2E1` winner (say 1 GB), `seasonNumber=2`, not in `packSeasons`, episode not yet covered → added. Final: `[S1-pack, S2E1-winner]`. Both grab POSTs are issued; the reservation covers the combined `plannedBytes` and is released in the `finally` block.

---

## 7. CODE-READING EXERCISE

**File to read: `server/routes/radarr.ts`, focusing on `grabBestUnderCap` (lines 101–224) and `settleCappedMovieGrab` (lines 542–643).**

Work through the following questions against the actual source (no notes):

1. Find the line where `radarrAccepted` is defined. What three conditions must ALL be true for a release to be in this array?

2. Below `radarrAccepted`, `eligible` is derived. What two additional conditions does `eligible` add? (Hint: one involves `env`, one involves the reservation ledger.)

3. The code determines `status` by checking `all.length`, then `radarrAccepted.length`. Write out the three `status` values and the condition that selects each one.

4. On line ~176, `radarrReservations.reserve(rootFolder, best.size)` is called. If it returns `false`, what status does `grabBestUnderCap` return? Why `false` — what would cause the reserve to fail even though the eligible filter just passed?

5. In `settleCappedMovieGrab`, find all the paths where `deleteCreatedMovie` is called. For each, state which `grab.status` value triggered it. Then find the paths where `setMovieMonitored` is called instead. What distinguishes the two groups conceptually?

6. `signalAdded()` is called twice: once inside `settleCappedMovieGrab` and once in the main handler after `settleCappedMovieGrab` returns `null`. Identify the grab status that corresponds to each call.

7. (Challenge) If Radarr's 201 response body is valid JSON but has no `title` field, `isUsableCreatedMovie` returns false. The code then calls `lookupMovieByTmdbId`. If that also fails, the route calls `rejectUnverifiedAdd`. Trace exactly what happens to the movie on disk (Radarr) at that point. Does the user see a 201, a 424, or something else?

---

