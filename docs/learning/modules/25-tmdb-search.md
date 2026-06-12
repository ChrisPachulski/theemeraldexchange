
# TMDB Bridge Teaching Dossier

## 1. WHAT

TMDB (The Movie Database) is a free, community-curated metadata service that catalogs movies, TV shows, cast, crew, images, and ratings. In theemeraldexchange, the backend runs a HTTP proxy to TMDB's REST API, keeping your API credentials server-side so the frontend never sees them. The backend exposes three TMDB endpoints: `/api/tmdb/credits` (cast/crew for detail modals), `/api/tmdb/trending/movie` and `/api/tmdb/trending/tv` (popular titles this week, shown in the Discover tab). Search happens upstream in Radarr/Sonarr (your download managers), not TMDB directly; TMDB is consulted for supplemental metadata and recommendations backfilling.

## 2. WHY

**Why proxy TMDB through the backend?**

1. **Credential secrecy.** TMDB API keys unlock your account quota (rate limits, historical lookups). If the key is in frontend JavaScript, it's discoverable via DevTools → a malicious actor can drain your monthly request allowance or scrape TMDB data impersonating you.

2. **Rate-limit budget control.** TMDB free tier allows ~40 requests per 10 seconds. The frontend can't know how many in-flight requests exist; the backend owns a single TMDB connection and throttles concurrent calls (8 concurrent `/search` lookups via `TMDB_LOOKUP_CONCURRENCY`).

3. **Caching and coalescing.** Module-level caches (one per process) deduplicate requests: if two users search "Inception" simultaneously, only one TMDB call fires; both get the cached result.

4. **Safe fallbacks.** If TMDB is down or not configured (503), the backend returns 503 and the frontend gracefully omits the cast section instead of crashing.

---

## 3. MAP

**Key files and search walkthrough:**

| Path | Lines | Role |
|------|-------|------|
| `/server/routes/tmdb.ts` | 54–99 | GET `/api/tmdb/credits` — cast lookup with TVDB-to-TMDB fallback |
| `/server/routes/tmdb.ts` | 108–122 | GET `/api/tmdb/trending/:type` — trending week endpoint |
| `/server/services/suggestionsTmdb.ts` | 1–100 | TMDB HTTP client, rate-limit 429 retry, module-level caches |
| `/src/lib/api/tmdb.ts` | 1–58 | Frontend client wrapper; `fetchCast(…)` and image base URL |
| `/server/services/radarr.ts` | (search bridge) | Radarr passes `tmdbId` in search results; backend adds it to grab requests |
| `/recommender/workers/tmdb_client.py` | (data feed) | Python recommender ingest: `tmdb_id` is the primary join key for feedback signals |

**Search walkthrough (add-movie flow):**

1. User types "Inception" in the Add Movie modal (`AddMovieModal.tsx`).
2. Modal calls `radarr.searchMovies(title)` → Radarr's `/search` returns results with `tmdbId`.
3. User picks a result → modal calls `radarr.addMovie({tmdbId, profileId, …})`.
4. Backend posts to Radarr with the `tmdbId` to link the grab.
5. Later, detail modal calls `fetchCast({type: 'movie', tmdbId})` → backend `/api/tmdb/credits?type=movie&tmdbId=550` → TMDB `/movie/550/credits` returns {cast, crew}.

---

## 4. PREREQUISITES

**Before reading the code, know:**

- **API key basics:** A string that proves you have a TMDB account and a quota. Kept in `TMDB_READ_ACCESS_TOKEN` (OAuth bearer token) or `TMDB_API_KEY` (legacy query-param auth). The app tries the bearer first; if not set, uses the legacy key.
- **HTTP headers:** `Authorization: Bearer <token>` is how OAuth tells a server "here's my identity." Query-param auth puts the key in the URL instead—less secure but sometimes required.
- **REST endpoints:** `/movie/{id}/credits` returns cast + crew for movie id 550. `/find/{external_id}?external_source=tvdb_id` looks up a TVDB id in TMDB (because TV shows are cross-cataloged).
- **Rate limits and 429:** When a service is overwhelmed, it returns HTTP 429 ("Too Many Requests") with a `Retry-After` header (e.g., "wait 5 seconds"). The client should sleep then retry.
- **Fetch timeouts:** Network requests can hang forever if not bounded. Timeouts kill the request after N milliseconds.

---

## 5. GOTCHAS & WAR STORIES

1. **TVDB ↔ TMDB mismatch.** Sonarr uses TVDB (TheTVDB database), but TMDB is separate. To get TMDB credits for a Sonarr show, you must first call `/find/{tvdbId}?external_source=tvdb_id` to get the TMDB id, THEN fetch `/tv/{tmdbId}/aggregate_credits`. Miss this and you get a 404 for a show that exists in TMDB.

2. **Aggregate vs. single credits.** Movies have `/movie/{id}/credits` (one role per actor). TV shows have `/tv/{id}/aggregate_credits` (multiple seasons of the same role rolled up: `roles: [{character, episode_count}]`). Code must handle both shapes—see `CastMember` type in `src/lib/api/tmdb.ts:17`.

3. **Rate-limit avalanche.** Naïve code fires 30 concurrent TMDB requests (one per search result) and gets a 429. The backend's `TMDB_LOOKUP_CONCURRENCY = 8` queue prevents this by serializing in batches.

4. **No key = graceful fallback.** If `TMDB_API_KEY` and `TMDB_READ_ACCESS_TOKEN` are both unset (e.g., in CI), `/api/tmdb/credits` returns `{ error: 'tmdb_not_configured', status: 503 }`. Frontend checks `res.status === 503` and treats it as "no cast"—modal still renders, just omits the section.

5. **Legacy rejection backfill.** Recommender stores feedback by `tmdb_id`. Old rows predated title storage, so they're bare ids. On `GET /suggestions`, the backend backfills titles by calling `tmdbTitleById(id)`. With hundreds of stale rows, this alone can exceed the TMDB quota—capped at `BACKFILL_MAX_PER_CALL = 10` per call to leave room for active lookups.

---

## 6. QUIZ BANK

**Q1: Search and add.** A user searches "Oppenheimer" and sees results. Describe why Radarr returns `tmdbId: 505642` and what the backend does with it.

**Answer:** Radarr's `/search` endpoint queries TMDB internally and returns results (including tmdbId). The backend proxies this call to Radarr, not TMDB. When the user clicks "Add," the modal sends `{tmdbId: 505642, profileId, rootFolder}` back to Radarr. Radarr uses the tmdbId as a canonical identifier so it can fetch metadata, posters, and ratings from TMDB independently. The backend never touches TMDB for search—Radarr does that; the backend only fetches cast (credits) and trending (which the SPA uses for the Discover landing row).

---

**Q2: Why does a 503 not break the detail modal?**

**Answer:** The backend `/api/tmdb/credits` returns 503 if `TMDB_API_KEY` and `TMDB_READ_ACCESS_TOKEN` are both unset. The frontend `fetchCast(…)` checks `if (res.status === 503) return []` and returns an empty cast array instead of throwing. The detail modal renders; the Cast section is simply hidden by the empty array. This keeps the app usable even if TMDB is misconfigured.

---

**Q3: TV vs. movie credits.** A detail modal for a TV show requests cast. Walk through the three calls the backend makes.

**Answer:** 
1. Frontend calls `GET /api/tmdb/credits?type=tv&tvdbId=121` (Sonarr's TVDB id).
2. Backend calls `GET /find/121?external_source=tvdb_id` to find the TMDB id (returns `{tv_results: [{id: 1399}]}`).
3. Backend calls `GET /tv/1399/aggregate_credits` to get cast with episode counts.
4. Backend returns the response to the frontend; frontend extracts `cast[]` and sorts by highest `episode_count` per role via `castCharacter(…)`.

---

**Q4: Why does the recommender care about tmdb_id?**

**Answer:** The recommender Python service stores user feedback (likes, dislikes, watches) keyed by `tmdb_id` in a SQLite database. When generating suggestions, it joins that feedback against a catalog of tmdb_ids to personalize rankings. If a movie is added to the library without a tmdb_id linkage, the recommender can't match feedback to it and can't personalize suggestions for that title.

---

## 7. CODE-READING EXERCISE

**Guided walk: server/routes/tmdb.ts (TV credits path).**

Open `/server/routes/tmdb.ts`, lines 61–82 (the `type === 'tv'` branch of `/credits`).

1. **Lines 62–65:** Extract and validate `tvdbId` from query string. `positiveIntId(…)` rejects garbage (strings, negatives, floats) to prevent query amplification attacks (1000 junk queries = 1000 TMDB requests).

2. **Lines 68–70:** Call TMDB's `/find/{tvdbId}?external_source=tvdb_id`. This is the TVDB→TMDB bridge. Result is an array of matches (could be multiple TV shows with the same external id, though rare).

3. **Lines 71–76:** Error handling. If TMDB returns non-200, return 502 (bad gateway) so the caller knows TMDB is unreachable, not the backend. If the response has no `tv_results` entry or it's empty, return an empty `{cast: [], crew: []}` (graceful fallback).

4. **Lines 77–82:** With the TMDB id now known, fetch `/tv/{id}/aggregate_credits` (role aggregation across all seasons). Return the raw response to the frontend.

**Why aggregate_credits, not credits?** Credits would list each season separately; aggregate rolls them into one per actor. The TV modal wants to show "Sarah Michelle Gellar as Buffy Summers (142 episodes)" not "142 separate credits, one per season."

**Stop and answer:** What happens if TMDB's `/find` returns `{tv_results: []}` (empty array)? Trace line 75–76.

_Expected answer: Line 75 extracts `findData.tv_results?.[0]?.id`, which is `undefined` when the array is empty. Line 76 checks `if (!id)` and returns an empty cast array. The frontend renders the cast section with zero cast members (hidden)._

