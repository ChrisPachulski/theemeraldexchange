// server/services/suggestionsTmdb.ts
//
// TMDB client for the suggestions route: search/trending/discover
// fetchers with bounded timeouts and a single Retry-After-honouring 429
// retry, plus the module-level caches and in-flight coalescing maps
// that bound TMDB volume. Single-instance semantics are intentional:
// one cache per process, shared across all requests and users (cache
// keys are global, not per-user). Tests flush the caches through
// _setTmdbApiKeyForTests / _resetTmdbInFlightForTests.

import { env } from '../env.js'
import { updateRejectionTitleIfPresent } from './rejections.js'
import { updateLikedTitleIfPresent } from './userFeedback.js'
import type { SuggestionItem } from './suggestionsShared.js'

// Cap concurrent TMDB /search lookups. validate() previously fired one
// Promise.all over every survivor (~30+), which can burst past TMDB's rate
// limit and 429 the whole batch (a self-DoS). 8 keeps the pick list fast (a few
// short waves) without hammering the upstream.
export const TMDB_LOOKUP_CONCURRENCY = 8

type TmdbAuthMode = 'bearer' | 'query'

// TMDB credential snapshot read at module load. Mutable so tests can
// flip it without rebuilding the whole env. Production code reads
// through this indirection so tmdbLookup/tmdbTrending/tmdbTitleById
// all observe the same value and auth mode.
let _tmdbKey: string | null = env.tmdbReadAccessToken ?? env.tmdbApiKey
let _tmdbAuthMode: TmdbAuthMode | null = env.tmdbReadAccessToken
  ? 'bearer'
  : env.tmdbApiKey
    ? 'query'
    : null
export function _setTmdbApiKeyForTests(k: string | null, authMode: TmdbAuthMode = 'query'): void {
  _tmdbKey = k
  _tmdbAuthMode = k ? authMode : null
  // Caches are module-scoped — without flushing them, a test that
  // populates the cache leaks state into the next test (the
  // subsequent route call sees a cache hit and never fires fetch,
  // making "did the route call /trending or /discover?" assertions
  // unreliable).
  for (const k of Object.keys(trendingCache)) delete trendingCache[k as 'movie' | 'tv']
  for (const k of Object.keys(discoverCache)) delete discoverCache[k as 'movie' | 'tv']
  lookupResultCache.clear()
  titleByIdNullCache.clear()
}

const TMDB_BASE = 'https://api.themoviedb.org/3'

// Resolve a TMDB id → canonical title via the direct /{kind}/{id}
// endpoint (no search, single round-trip). Used to backfill legacy
// rejection / liked rows that were saved before PR #65 introduced
// titled entries. Returns null when the key is missing, the id is
// dead, or TMDB rate-limited us — caller falls back to `[TMDB id N]`
// bullets in the prompt.
// Backfill knobs. With hundreds of legacy bare-id rows on the NAS,
// a one-shot Promise.all firing 500+ simultaneous TMDB requests blows
// past TMDB's rate limit AND can hang for minutes if any single call
// times out. Cap how many we resolve per call so the route stays
// responsive — the rest get fallback bullets this turn and upgrade
// across subsequent refreshes.
//
// TMDB rate limit is ~40 req / 10s on the free tier. Each suggestions
// call also burns ~22 pick-lookups, so backfill needs to leave room
// or call 2 (cache cold for lookups) gets 429-throttled and returns
// 1–4 items instead of 20. 10 backfill + 22 lookups = 32, fits.
const BACKFILL_MAX_PER_CALL = 10
const TMDB_TIMEOUT_MS = 2500

// TMDB 429 retry helper. On a 429 response, TMDB includes a
// Retry-After header (seconds). We honour it once — a single retry
// with the actual back-off keeps the route responsive while preventing
// permanent silent failures on transient rate-limit spikes.
//
// The retry wait is bounded by both the caller's AbortSignal AND a
// hard 2 s ceiling: callers set the abort timer to TMDB_TIMEOUT_MS
// (2.5 s), so a longer Retry-After would just put us to sleep past the
// abort and retry with an already-aborted signal — a wasted second
// network round-trip. Bailing early on a long Retry-After is
// indistinguishable from a normal 429 to the caller (returns the 429
// Response), and the caller's fallback path handles it.
// Returns the fetch Response (may still be non-ok) or null on network error.
const TMDB_MAX_RETRY_WAIT_MS = 2_000

async function tmdbFetchWithRetry(
  url: URL,
  signal: AbortSignal,
): Promise<Response | null> {
  const headers = {
    Accept: 'application/json',
    ...(_tmdbKey && _tmdbAuthMode === 'bearer' ? { Authorization: `Bearer ${_tmdbKey}` } : {}),
  }
  const requestUrl = new URL(url)
  if (_tmdbKey && _tmdbAuthMode === 'query') {
    requestUrl.searchParams.set('api_key', _tmdbKey)
  }
  let r: Response
  try {
    r = await fetch(requestUrl, { headers, signal })
  } catch {
    return null
  }
  if (r.status === 429) {
    const retryAfterStr = r.headers.get('retry-after')
    const requestedMs = retryAfterStr ? Number(retryAfterStr) * 1000 : 2_000
    if (!Number.isFinite(requestedMs) || requestedMs > TMDB_MAX_RETRY_WAIT_MS) {
      console.warn(
        '[suggestions] TMDB 429 — Retry-After',
        retryAfterStr,
        'exceeds budget; surfacing 429 to caller',
      )
      return r
    }
    console.warn('[suggestions] TMDB 429 — retrying after', requestedMs, 'ms')
    const aborted = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), requestedMs)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          res(true)
        },
        { once: true },
      )
    })
    if (aborted) return r
    try {
      r = await fetch(requestUrl, { headers, signal })
    } catch {
      return null
    }
  }
  return r
}
// Trending and discover surfaces don't churn second-to-second; 5 min
// TTL slashes background TMDB volume by 5x without measurable user-
// facing freshness loss. The single-flight lookup coalescing covers
// the brief moments after expiry when concurrent calls would race.
const TRENDING_CACHE_TTL_MS = 300_000
const LOOKUP_RESULT_CACHE_TTL_MS = 10_000
const LOOKUP_RESULT_CACHE_MAX_KEYS = 500

// In-flight coalescing maps for TMDB GETs. Two parallel suggestions
// calls (movie + tv mounting at once, household members refreshing,
// retry path racing the prefetch) frequently ask TMDB for the same
// id or title. Coalesce to one fetch, return the same promise to
// every concurrent caller. Title search also keeps a short settled
// result cache to cover sequential retry/refresh bursts.
const titleByIdInFlight = new Map<string, Promise<string | null>>()
const lookupInFlight = new Map<string, Promise<SuggestionItem | null>>()
const lookupResultCache = new Map<string, { item: SuggestionItem | null; expiresAt: number }>()
const TITLE_BY_ID_NULL_CACHE_TTL_MS = 5 * 60 * 1000
const TITLE_BY_ID_NULL_CACHE_MAX_KEYS = 1000
const titleByIdNullCache = new Map<string, number>()

export function _resetTmdbInFlightForTests(): void {
  titleByIdInFlight.clear()
  lookupInFlight.clear()
  lookupResultCache.clear()
  titleByIdNullCache.clear()
}

function titleByIdNullCached(key: string, now = Date.now()): boolean {
  const expiresAt = titleByIdNullCache.get(key)
  if (expiresAt === undefined) return false
  if (expiresAt > now) return true
  titleByIdNullCache.delete(key)
  return false
}

function cacheNullTitleById(key: string): void {
  titleByIdNullCache.delete(key)
  titleByIdNullCache.set(key, Date.now() + TITLE_BY_ID_NULL_CACHE_TTL_MS)
  while (titleByIdNullCache.size > TITLE_BY_ID_NULL_CACHE_MAX_KEYS) {
    const oldest = titleByIdNullCache.keys().next()
    if (oldest.done) break
    titleByIdNullCache.delete(oldest.value)
  }
}

async function tmdbTitleById(kind: 'movie' | 'tv', id: number): Promise<string | null> {
  if (!_tmdbKey) return null
  const key = `${kind}:${id}`
  if (titleByIdNullCached(key)) return null
  const existing = titleByIdInFlight.get(key)
  if (existing) return existing
  const promise = (async () => {
    const url = new URL(`${TMDB_BASE}/${kind}/${id}`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS)
    try {
      const r = await tmdbFetchWithRetry(url, controller.signal)
      if (!r || !r.ok) return null
      const data = (await r.json()) as { title?: string; name?: string }
      return data.title || data.name || null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  })()
    .then((title) => {
      if (title) titleByIdNullCache.delete(key)
      else cacheNullTitleById(key)
      return title
    })
    .finally(() => {
      titleByIdInFlight.delete(key)
    })
  titleByIdInFlight.set(key, promise)
  return promise
}

// Resolve at most BACKFILL_MAX_PER_CALL untitled ids per request.
// In-flight requests are bounded by the slice size; each has a hard
// 2.5s timeout. Total worst-case backfill cost ≈ 2.5s regardless of
// how many legacy rows are sitting on disk.
async function resolveTitles(
  kind: 'movie' | 'tv',
  needed: Array<{ id: number; title: string }>,
): Promise<Map<number, string>> {
  const now = Date.now()
  const slice = needed
    .filter((e) => !titleByIdNullCached(`${kind}:${e.id}`, now))
    .slice(0, BACKFILL_MAX_PER_CALL)
  const titles = await Promise.all(slice.map((e) => tmdbTitleById(kind, e.id)))
  const out = new Map<number, string>()
  for (let i = 0; i < slice.length; i++) {
    const t = titles[i]
    if (t) out.set(slice[i].id, t)
  }
  return out
}

export async function backfillRejectionTitles(
  kind: 'movie' | 'tv',
  entries: Array<{ id: number; title: string }>,
): Promise<Array<{ id: number; title: string }>> {
  const needed = entries.filter((e) => !e.title)
  if (needed.length === 0) return entries
  const updates = await resolveTitles(kind, needed)
  if (updates.size === 0) return entries
  // Persist in parallel via the title-only helper. Critically NOT
  // addRejection: TMDB resolution can take seconds, during which the
  // user might clear or flip the signal via /api/feedback. addRejection
  // would happily recreate a row that was just cleared (resurrecting
  // a household veto the user removed). updateRejectionTitleIfPresent
  // short-circuits to a no-op when the row is gone.
  //
  // allSettled (not all): backfill is non-critical UX polish; a disk
  // failure here must NOT kill the user's suggestions request — the
  // prompt still has the (id, title) pairs in memory.
  const writes = await Promise.allSettled(
    Array.from(updates, ([id, title]) =>
      updateRejectionTitleIfPresent(kind, id, title),
    ),
  )
  for (const r of writes) {
    if (r.status === 'rejected') {
      console.error('[suggestions] rejection title backfill failed:', r.reason)
    }
  }
  return entries.map((e) => (updates.has(e.id) ? { ...e, title: updates.get(e.id)! } : e))
}

export async function backfillLikedTitles(
  sub: string,
  kind: 'movie' | 'tv',
  entries: Array<{ id: number; title: string }>,
): Promise<Array<{ id: number; title: string }>> {
  const needed = entries.filter((e) => !e.title)
  if (needed.length === 0) return entries
  const updates = await resolveTitles(kind, needed)
  if (updates.size === 0) return entries
  // Same race protection as backfillRejectionTitles — never use setLike
  // here. setLike routes through mutate(), which clears the opposite
  // signal and pushes a like, so a backfill firing after the user
  // cleared/flipped would silently restore an old like. The title-only
  // helper updates the row in place if it still exists and is no-op
  // otherwise.
  const writes = await Promise.allSettled(
    Array.from(updates, ([id, title]) =>
      updateLikedTitleIfPresent(sub, kind, id, title),
    ),
  )
  for (const r of writes) {
    if (r.status === 'rejected') {
      console.error('[suggestions] liked title backfill failed:', r.reason)
    }
  }
  return entries.map((e) => (updates.has(e.id) ? { ...e, title: updates.get(e.id)! } : e))
}

export async function tmdbLookup(
  kind: 'movie' | 'tv',
  title: string,
  year: number | undefined,
): Promise<SuggestionItem | null> {
  if (!_tmdbKey) return null
  const key = `${kind}:${title.toLowerCase()}:${year ?? ''}`
  const now = Date.now()
  const cached = lookupResultCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.item ? { ...cached.item } : null
  }
  if (cached) lookupResultCache.delete(key)
  const existing = lookupInFlight.get(key)
  if (existing) return existing
  const promise = (async (): Promise<SuggestionItem | null> => {
    const runSearch = async (withYear: boolean) => {
      const url = new URL(`${TMDB_BASE}/search/${kind}`)
      url.searchParams.set('query', title)
      if (withYear && year) {
        url.searchParams.set(kind === 'movie' ? 'primary_release_year' : 'first_air_date_year', String(year))
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS)
      let r: Response | null
      try {
        r = await tmdbFetchWithRetry(url, controller.signal)
      } finally {
        clearTimeout(timer)
      }
      if (!r || !r.ok) return null
      const data = (await r.json()) as {
        results?: Array<{
          id: number
          title?: string
          name?: string
          poster_path: string | null
          overview?: string
          release_date?: string
          first_air_date?: string
        }>
      }
      return data.results?.[0] ?? null
    }
    // Try with the year hint first (disambiguates ambiguous titles like
    // "Heat" or "Pinocchio"). If that returns nothing, retry without
    // the year — TMDB's first_air_date_year filter is strict and
    // Claude routinely gives the latest-season year for TV shows
    // (e.g. "Severance (2025)" for season 2) when TMDB indexes the
    // series-premiere year (2022). The post-lookup year-proximity
    // guard (±5) still catches genuinely-wrong matches.
    //
    // Note: runSearch already uses tmdbFetchWithRetry for 429 handling.
    let top = await runSearch(true)
    if (!top && year) {
      top = await runSearch(false)
    }
    if (!top) return null
    const date = top.release_date || top.first_air_date || ''
    const parsedYear = date ? Number(date.slice(0, 4)) : undefined
    return {
      id: top.id,
      title: top.title || top.name || title,
      posterPath: top.poster_path,
      overview: top.overview,
      year: Number.isFinite(parsedYear) ? parsedYear : undefined,
    }
  })().then((item) => {
    lookupResultCache.set(key, {
      item: item ? { ...item } : null,
      expiresAt: Date.now() + LOOKUP_RESULT_CACHE_TTL_MS,
    })
    while (lookupResultCache.size > LOOKUP_RESULT_CACHE_MAX_KEYS) {
      const oldest = lookupResultCache.keys().next().value
      if (!oldest) break
      lookupResultCache.delete(oldest)
    }
    return item
  }).finally(() => {
    lookupInFlight.delete(key)
  })
  lookupInFlight.set(key, promise)
  return promise
}

// TMDB returns 20 items per page on /trending/{type}/week. We paginate
// up to TRENDING_MAX_PAGES so that once a household has rejected the
// obvious choices, deeper-tail trending titles still surface instead
// of the strip going empty. The route still filters + slices to
// TARGET_COUNT at the end; this just gives the filter more raw fuel
// to work with. ~100 items is enough headroom in practice — TMDB's
// trending tail thins out quickly past page 5 anyway.
const TRENDING_MAX_PAGES = 5

// Short-lived in-memory cache for the TMDB trending response. "Trending
// this week" doesn't churn second-to-second, and refetching ~100 rows
// on every refresh contributes to the TMDB rate-limit problem. 60s
// TTL is well under the time it takes the trending feed to meaningfully
// shift, and is reset for tests by _setTmdbApiKeyForTests().
const trendingCache: { [K in 'movie' | 'tv']?: { items: SuggestionItem[]; expiresAt: number } } = {}

// TMDB genre-name → genre-id mapping per kind. Sonarr/Radarr return
// genre *names*; TMDB /discover takes ids. Lowercased keys, with
// common aliases so e.g. Sonarr's "Action" doesn't lose its TV match
// against "Action & Adventure". Unknown names quietly drop.
const TMDB_GENRE_IDS: { movie: Record<string, number>; tv: Record<string, number> } = {
  movie: {
    action: 28,
    adventure: 12,
    animation: 16,
    comedy: 35,
    crime: 80,
    documentary: 99,
    drama: 18,
    family: 10751,
    fantasy: 14,
    history: 36,
    horror: 27,
    music: 10402,
    musical: 10402,
    mystery: 9648,
    romance: 10749,
    'science fiction': 878,
    'sci-fi': 878,
    'sci-fi & fantasy': 878,
    thriller: 53,
    war: 10752,
    western: 37,
    biography: 36,
    sport: 99,
  },
  tv: {
    action: 10759,
    adventure: 10759,
    'action & adventure': 10759,
    animation: 16,
    anime: 16,
    comedy: 35,
    crime: 80,
    documentary: 99,
    drama: 18,
    family: 10751,
    fantasy: 10765,
    history: 18,
    horror: 9648,
    kids: 10762,
    mystery: 9648,
    news: 10763,
    reality: 10764,
    'science fiction': 10765,
    'sci-fi': 10765,
    'sci-fi & fantasy': 10765,
    'soap': 10766,
    talk: 10767,
    thriller: 9648,
    war: 10768,
    'war & politics': 10768,
    western: 37,
    romance: 10749,
  },
}

export function genreNamesToTmdbIds(kind: 'movie' | 'tv', names: string[]): number[] {
  const table = TMDB_GENRE_IDS[kind]
  const ids = new Set<number>()
  for (const n of names) {
    const id = table[n.toLowerCase().trim()]
    if (id) ids.add(id)
  }
  return Array.from(ids)
}

// Pick the top-N genres from a library for discover-based fill. Same
// counting as computeGenreDistribution but returns names so they can
// be id-mapped per kind.
export function topGenreNames(library: Array<{ genres?: string[] }>, n: number): string[] {
  const counts = new Map<string, number>()
  for (const item of library) {
    if (!item.genres) continue
    for (const g of item.genres) {
      if (!g) continue
      counts.set(g, (counts.get(g) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([g]) => g)
}

// --- Candidate pool + discover fill (share cache) --------------------
//
// Architecture: Claude ranks from a pre-fetched TMDB pool rather than
// generating titles from its popularity prior. The pool is fetched via
// /discover seeded by the household's top genres, quality-sorted
// (vote_average.desc) so it skews toward acclaimed niche titles rather
// than blockbusters. The same pool doubles as the fill source when
// Claude picks fall short of TARGET_COUNT.
//
// Shared cache: both the pool (pre-Claude) and the fill (post-Claude)
// call the same fetch function, so a single TMDB /discover request
// serves both uses per refresh cycle.
const CANDIDATE_POOL_PAGES = 3
// Novelty lane: one extra page sorted by recency (primary_release_date.desc
// for movies, first_air_date.desc for TV). Appended to the quality-sorted
// pool as ~20% of items to break the "same acclaimed classics every refresh"
// pattern. Quality filter still applied (vote_count.gte=30 — lower threshold
// for recent titles which haven't accumulated many votes yet). Iter 40.
const CANDIDATE_POOL_NOVELTY_PAGES = 1
const discoverCache: { [k in 'movie' | 'tv']?: { key: string; items: SuggestionItem[]; expiresAt: number } } = {}

export async function fetchCandidatePool(
  kind: 'movie' | 'tv',
  genreIds: number[],
): Promise<SuggestionItem[]> {
  if (!_tmdbKey || genreIds.length === 0) return []
  // Pipe = OR so we get titles matching ANY of the household's top
  // genres (Drama OR Crime OR Sci-Fi), not the near-empty intersection.
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const genreKey = genreIds.slice().sort((a, b) => a - b).join('|')
  const key = `${today}:${genreKey}`
  const cached = discoverCache[kind]
  if (cached && cached.key === key && cached.expiresAt > now) {
    return cached.items.slice()
  }
  type TmdbRow = {
    id: number
    title?: string
    name?: string
    poster_path: string | null
    overview?: string
    release_date?: string
    first_air_date?: string
  }
  // Quality-sorted pages (acclaimed niche titles, vote_count≥100)
  const qualityPagesPromise = Promise.all(
    Array.from({ length: CANDIDATE_POOL_PAGES }, async (_, i) => {
      const url = new URL(`${TMDB_BASE}/discover/${kind}`)
      url.searchParams.set('page', String(i + 1))
      // Quality-sorted so the pool skews toward acclaimed niche titles
      // in the household's genres, not pure popularity blockbusters.
      // vote_count.gte raised from 100→200 (iter 66 deep skeptic): 100 is
      // permissive enough to include obscure films with minimal signal.
      // 200 is still accessible for niche genres while filtering genuine noise.
      // Novelty lane retains the lower ≥30 threshold (newer films haven't
      // accumulated votes yet — the recency filter already handles novelty).
      url.searchParams.set('sort_by', 'vote_average.desc')
      url.searchParams.set('vote_count.gte', '200')
      url.searchParams.set('with_genres', genreKey)
      url.searchParams.set(kind === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte', today)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS)
      try {
        const r = await tmdbFetchWithRetry(url, controller.signal)
        if (!r || !r.ok) {
          if (r && r.status !== 429) {
            // 429s are already logged inside tmdbFetchWithRetry after the retry fails
            console.error('[suggestions] TMDB /discover (pool) non-ok:', r.status, 'page', i + 1)
          }
          return null
        }
        const data = (await r.json()) as { results?: TmdbRow[] }
        return data.results ?? []
      } catch (e) {
        console.error('[suggestions] TMDB /discover (pool) threw on page', i + 1, e instanceof Error ? e.message : String(e))
        return null
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  // Novelty lane: recent releases in the same genres. Lower vote_count
  // threshold so newer titles that haven't accumulated many votes yet
  // are still eligible. Runs in parallel with quality pages.
  const noveltyPagesPromise = Promise.all(
    Array.from({ length: CANDIDATE_POOL_NOVELTY_PAGES }, async (_, i) => {
      const url = new URL(`${TMDB_BASE}/discover/${kind}`)
      url.searchParams.set('page', String(i + 1))
      url.searchParams.set('sort_by', kind === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc')
      url.searchParams.set('vote_count.gte', '30')
      url.searchParams.set('with_genres', genreKey)
      url.searchParams.set(kind === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte', today)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS)
      try {
        const r = await tmdbFetchWithRetry(url, controller.signal)
        if (!r || !r.ok) return null
        const data = (await r.json()) as { results?: TmdbRow[] }
        return data.results ?? []
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  const [qualityPages, noveltyPages] = await Promise.all([qualityPagesPromise, noveltyPagesPromise])
  // Collect all rows: quality first, then novelty (novelty appended so
  // Claude's numbered list leads with quality picks — novelty items appear
  // at the end where they serve as "freshness anchors" without dominating).
  const all: TmdbRow[] = []
  for (const rows of qualityPages) if (rows && rows.length > 0) all.push(...rows)
  for (const rows of noveltyPages) if (rows && rows.length > 0) all.push(...rows)
  // Deduplicate by TMDB id — /discover pages can return the same title
  // on multiple pages when genres overlap or pagination has off-by-one
  // drift. Dedup ensures the pool's numbered list sent to Claude is
  // clean and the poolByTitle map has no id collisions.
  const seenIds = new Set<number>()
  const items: SuggestionItem[] = []
  for (const r of all) {
    if (!r.id || seenIds.has(r.id)) continue
    seenIds.add(r.id)
    const date = r.release_date || r.first_air_date || ''
    if (date && date > today) continue
    const y = date ? Number(date.slice(0, 4)) : undefined
    items.push({
      id: r.id,
      title: r.title || r.name || '',
      posterPath: r.poster_path,
      overview: r.overview,
      year: Number.isFinite(y) ? y : undefined,
    })
  }
  // Only cache successful, non-empty pools. A TMDB outage / rate-limit
  // burst that fails every page would otherwise pin an empty result
  // here for the full TTL, blanking the recommender-down + Claude-error
  // fallback pools long after TMDB is healthy again. Leaving the cache
  // entry untouched on empty lets the next call retry immediately.
  if (items.length > 0) {
    discoverCache[kind] = { key, items, expiresAt: now + TRENDING_CACHE_TTL_MS }
  }
  return items.slice()
}

// Discover-based fill source — delegates to fetchCandidatePool so
// pool and fill share the same cache and TMDB call.
export async function tmdbDiscoverByGenres(
  kind: 'movie' | 'tv',
  genreIds: number[],
): Promise<SuggestionItem[]> {
  return fetchCandidatePool(kind, genreIds)
}

export async function tmdbTrending(kind: 'movie' | 'tv'): Promise<SuggestionItem[]> {
  if (!_tmdbKey) return []
  const now = Date.now()
  const cached = trendingCache[kind]
  if (cached && cached.expiresAt > now) return cached.items.slice()
  type TmdbRow = {
    id: number
    title?: string
    name?: string
    poster_path: string | null
    overview?: string
    release_date?: string
    first_air_date?: string
  }
  // Fire all pages in parallel. The TMDB free tier (~40 req / 10s)
  // comfortably absorbs 5 concurrent /trending calls, and parallel
  // pagination cuts cold-start + fill latency from ~5x serial to ~1x.
  // Each page has its own bounded timeout — without it, one stuck TMDB
  // connection would keep the Promise.all pending forever and stall
  // every trending-dependent code path (force=trending, cold start,
  // recommender-down fallback, Claude-error fallback). allSettled
  // hardens that further: even if a per-page handler throws past its
  // own try/catch, the remaining pages still resolve.
  const settled = await Promise.allSettled(
    Array.from({ length: TRENDING_MAX_PAGES }, async (_, i) => {
      const url = new URL(`${TMDB_BASE}/trending/${kind}/week`)
      url.searchParams.set('page', String(i + 1))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS)
      try {
        const r = await tmdbFetchWithRetry(url, controller.signal)
        if (!r || !r.ok) {
          if (r && r.status !== 429) {
            console.error('[suggestions] TMDB /trending non-ok:', r.status, 'page', i + 1)
          }
          return null
        }
        const data = (await r.json()) as { results?: TmdbRow[] }
        return data.results ?? []
      } catch (e) {
        console.error('[suggestions] TMDB /trending fetch threw on page', i + 1, e instanceof Error ? e.message : String(e))
        return null
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  const all: TmdbRow[] = []
  for (const p of settled) {
    const rows = p.status === 'fulfilled' ? p.value : null
    if (rows && rows.length > 0) all.push(...rows)
    else if (p.status === 'rejected') {
      console.error('[suggestions] TMDB /trending page settled rejected:', p.reason instanceof Error ? p.reason.message : String(p.reason))
    }
  }
  const seenIds = new Set<number>()
  const items: SuggestionItem[] = []
  for (const r of all) {
    if (!r.id || seenIds.has(r.id)) continue
    seenIds.add(r.id)
    const date = r.release_date || r.first_air_date || ''
    const y = date ? Number(date.slice(0, 4)) : undefined
    items.push({
      id: r.id,
      title: r.title || r.name || '',
      posterPath: r.poster_path,
      overview: r.overview,
      year: Number.isFinite(y) ? y : undefined,
    })
  }
  // Don't cache empty results. If every /trending page failed (TMDB
  // outage, rate-limit storm, network partition), pinning [] for the
  // full TTL keeps the trending strip blank for cold-start, force=
  // trending, recommender-down fallback, and Claude-error fallback
  // long after TMDB has recovered. Letting the entry stay missing
  // makes the next call retry.
  if (items.length > 0) {
    trendingCache[kind] = { items, expiresAt: now + TRENDING_CACHE_TTL_MS }
  }
  return items.slice()
}

// Truthiness accessor for the module-private key — the route gates the
// trending/legacy paths on "is TMDB usable at all" without needing the
// key value itself.
export function tmdbKeyConfigured(): boolean {
  return _tmdbKey !== null
}
