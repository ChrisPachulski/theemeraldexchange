// Personalized library-aware suggestions for the Movies and TV
// Discover surfaces. On every refresh, this route:
//
//   1. Pulls the current library from Sonarr/Radarr.
//   2. Reads the persistent reject list.
//   3. Asks Claude (Haiku 4.5) for ranked recommendations grounded in
//      the household's actual taste, with rejections passed in-prompt
//      as "never suggest these."
//   4. Looks each title up in TMDB to enrich with id/poster/year.
//   5. Filters anything already in the library or on the reject list
//      (defense in depth — Claude is told but may slip).
//   6. Returns up to 20 items in TrendingItem shape so the existing
//      TrendingRow component is a drop-in consumer.
//
// Cold start: if the library has fewer than 3 items, falls back to
// TMDB's trending-this-week feed. Personalization is meaningless
// without a taste signal.
//
// Prompt caching: the system prompt + library + rejections are sent
// as one cached block (cache_control: ephemeral, 5-minute TTL). The
// per-request user message is short and varies — variety knob is
// temperature 0.8 plus prompt instruction to avoid identical lists.

import { Hono } from 'hono'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, type Env } from '../middleware/auth.js'
import { requireTrustedOrigin } from '../middleware/csrf.js'
import { sonarrFetch } from '../services/sonarr.js'
import { radarrFetch } from '../services/radarr.js'
import { getRejections, updateRejectionTitleIfPresent } from '../services/rejections.js'
import { getUserFeedback, updateLikedTitleIfPresent } from '../services/userFeedback.js'
import { appendUsageEvent, computeCostCents } from '../services/usageLog.js'
import { scoreOnce, postShown, postImpressions, type RecommenderScoredItem } from '../services/recommender.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'
import { sanitizeTitle } from '../services/sanitize.js'
import { iptvDb } from '../services/iptvDbSingleton.js'
import { mediaLibraryDb } from '../services/mediaLibraryDbSingleton.js'
import { env } from '../env.js'
import { reportServerEvent } from '../services/serverTelemetry.js'

const MODEL = 'claude-haiku-4-5'

// Cap concurrent TMDB /search lookups. validate() previously fired one
// Promise.all over every survivor (~30+), which can burst past TMDB's rate
// limit and 429 the whole batch (a self-DoS). 8 keeps the pick list fast (a few
// short waves) without hammering the upstream.
const TMDB_LOOKUP_CONCURRENCY = 8

/** Concurrency-bounded map that preserves input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

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

export const suggestions = new Hono<Env>()

suggestions.use('*', requireAuth)

// /:type below is a GET, but with USE_LOCAL_RECOMMENDER=1 it writes
// rec_log and recently_shown via the sidecar impression endpoint. The
// global CSRF gate skips GETs, so without an explicit Origin check
// here a hostile page could fire a credentialed GET (cookies are
// SameSite=None in prod) and poison a victim's recommendation
// rotation. requireTrustedOrigin opts back in to the same Origin
// allowlist the state-changing routes use.
suggestions.use('*', requireTrustedOrigin)

const TMDB_BASE = 'https://api.themoviedb.org/3'
// Minimum library size for a meaningful taste signal. Below this, the
// genre distribution is statistically noise (3 shows can be all Drama
// for genre-unrelated reasons). At 10, the household has at least a
// 2-3 genre cluster + enough titles to fill the PRIORITY TASTE block
// partially. Below 10 → trending fill (correct UX: new server, cold
// library). Raised from 3 (Agent C #5) — the prior threshold allowed
// near-empty libraries to burn API budget on low-quality suggestions.
const COLD_START_THRESHOLD = 10
const TARGET_COUNT = 20
// Headroom for post-validation drops. With TARGET_COUNT=20 we need
// enough surplus that the routine library/lookup/dedupe shedding still
// leaves a full strip. 30 fits comfortably under max_tokens=4096.
// Previously 2048 which could truncate a 30-pick response with reasons
// (30 picks × ~80 tokens/pick = ~2400 output tokens, plus tool_use
// wrapper ~100 tokens = ~2500 total — right at the old 2048 ceiling).
// Raised to 4096 (iter 39) so reasons never cause truncation.
const CLAUDE_OVERFETCH = 30
// Provenance — WHERE this card actually came from. Lets the UI render
// a personalized pick differently from a trending fill, and lets the
// household member tell at a glance whether the strip is doing its job
// or quietly degrading. Trust scaffolding (rubric dim 7).
//   'personalized' — Claude submitted it, validator accepted it
//   'discover'     — TMDB /discover library-genre fill (taste-aware fallback)
//   'trending'     — TMDB /trending fill (last resort)
export type SuggestionProvenance = 'personalized' | 'discover' | 'trending'

type SuggestionItem = {
  id: number
  title: string
  posterPath: string | null
  overview?: string
  year?: number
  // Per-pick provenance + reason. Populated on every return path so
  // the UI can render an honest signal even when the response source
  // is a mix (e.g. `personalized_filled`). `reason` is a tight, ≤120-char
  // string when present — populated for personalized picks from
  // Claude's own short rationale; null for fills.
  provenance?: SuggestionProvenance
  reason?: string | null
  available_on?: string[]
}

type ClaudePick = {
  title: string
  year?: number
  // Optional: a single tight clause Claude returns when it can ground
  // the pick in a library neighbor or like signal. Surfaced verbatim
  // as the per-card reason — voice constraint enforced by the tool
  // schema's description, NOT by post-trimming, because Claude tends
  // to comply better when the field is described as "short" up-front.
  reason?: string
}

type SonarrSeries = { title: string; year?: number; tmdbId?: number; genres?: string[] }
type RadarrMovie = { title: string; year?: number; tmdbId?: number; genres?: string[] }
type LibraryItem = SonarrSeries | RadarrMovie

// Sonarr/Radarr full-library fetches dominate the network cost of the
// suggestions route — a household with 500 entries downloads ~1MB on
// every refresh, every user. Cache for LIBRARY_CACHE_TTL_MS so the
// upstream is hit at most once per kind per window. In-flight promises
// are also memoized so a concurrent burst (e.g. a household member
// hitting refresh on both Movies and TV at the same time, or two
// users mounting simultaneously) collapses to a single upstream call.
const LIBRARY_CACHE_TTL_MS = 30_000
const LIBRARY_FAILURE_CACHE_TTL_MS = 15_000
const LIBRARY_STALE_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000
const libraryCache: { [k in 'movie' | 'tv']?: { items: LibraryItem[]; expiresAt: number } } = {}
const libraryInFlight: { [k in 'movie' | 'tv']?: Promise<LibraryItem[]> } = {}

export function _resetLibraryCacheForTests(): void {
  delete libraryCache.movie
  delete libraryCache.tv
  delete libraryInFlight.movie
  delete libraryInFlight.tv
}

// Thrown when a Sonarr/Radarr fetch failed AND there's no prior
// snapshot to fall back to. The handler converts this into a 502 so
// the SPA can surface "library unavailable" instead of receiving
// generic trending picks that would silently leak owned titles back
// into the strip (cold-start path treats an empty library as "user
// has nothing, just show trending").
class LibraryUnavailableError extends Error {
  constructor(kind: 'movie' | 'tv', cause: unknown) {
    super(`upstream library fetch failed for ${kind}`, { cause })
    this.name = 'LibraryUnavailableError'
  }
}

async function fetchSonarrLibraryRaw(): Promise<SonarrSeries[]> {
  const r = await sonarrFetch('/api/v3/series', { method: 'GET' })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Sonarr /api/v3/series returned ${r.status}: ${body.slice(0, 200)}`)
  }
  const data = (await r.json()) as SonarrSeries[]
  if (!Array.isArray(data)) {
    throw new Error('Sonarr /api/v3/series returned a non-array body')
  }
  return data
}

async function fetchRadarrLibraryRaw(): Promise<RadarrMovie[]> {
  const r = await radarrFetch('/api/v3/movie', { method: 'GET' })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Radarr /api/v3/movie returned ${r.status}: ${body.slice(0, 200)}`)
  }
  const data = (await r.json()) as RadarrMovie[]
  if (!Array.isArray(data)) {
    throw new Error('Radarr /api/v3/movie returned a non-array body')
  }
  return data
}

// Last-known successful library. Kept across cache windows so a transient
// upstream outage can still filter already-owned titles, but expired after
// a day so a prolonged Sonarr/Radarr outage fails closed instead of serving
// a stale household snapshot as authoritative.
const libraryStaleFallback: { [k in 'movie' | 'tv']?: { items: LibraryItem[]; fetchedAt: number } } = {}

function librarySnapshotAgeMs(kind: 'movie' | 'tv'): number | undefined {
  const fetchedAt = libraryStaleFallback[kind]?.fetchedAt
  return fetchedAt === undefined ? undefined : Math.max(0, Date.now() - fetchedAt)
}

async function fetchLibraryCached(kind: 'movie' | 'tv'): Promise<LibraryItem[]> {
  const now = Date.now()
  const cached = libraryCache[kind]
  if (cached && cached.expiresAt > now) return cached.items
  const inFlight = libraryInFlight[kind]
  if (inFlight) return inFlight
  const promise = (kind === 'movie' ? fetchRadarrLibraryRaw() : fetchSonarrLibraryRaw())
    .then((items): LibraryItem[] => {
      // Only the TTL cache requires non-empty (a real empty library is
      // possible on fresh installs; pinning it is fine). The stale
      // fallback is updated either way so the next failure has the
      // freshest snapshot to fall back to.
      const fetchedAt = Date.now()
      libraryCache[kind] = { items, expiresAt: fetchedAt + LIBRARY_CACHE_TTL_MS }
      libraryStaleFallback[kind] = { items, fetchedAt }
      return items
    })
    .catch((err): LibraryItem[] => {
      // Upstream went sideways. Prefer the stale snapshot over routing
      // into cold-start with no real library — household-safe filtering
      // is what makes the strip useful. If we've never had a successful
      // fetch, surface a 502 so the SPA shows "library unavailable"
      // instead of pretending the household is empty.
      const stale = libraryStaleFallback[kind]
      if (stale) {
        const ageMs = Date.now() - stale.fetchedAt
        if (ageMs > LIBRARY_STALE_FALLBACK_MAX_AGE_MS) {
          console.error(
            `[suggestions] ${kind} library fetch failed and stale snapshot is expired (${Math.round(ageMs / 3_600_000)}h old) — failing closed:`,
            err instanceof Error ? err.message : String(err),
          )
          throw new LibraryUnavailableError(kind, err)
        }
        console.warn(
          `[suggestions] ${kind} library fetch failed, serving stale snapshot of ${stale.items.length} items (${Math.round(ageMs / 3_600_000)}h old):`,
          err instanceof Error ? err.message : String(err),
        )
        libraryCache[kind] = { items: stale.items, expiresAt: Date.now() + LIBRARY_FAILURE_CACHE_TTL_MS }
        return stale.items
      }
      console.error(
        `[suggestions] ${kind} library fetch failed and no stale snapshot — failing closed:`,
        err instanceof Error ? err.message : String(err),
      )
      throw new LibraryUnavailableError(kind, err)
    })
    .finally(() => {
      delete libraryInFlight[kind]
    })
  libraryInFlight[kind] = promise
  return promise
}

// Test-only reset of the stale fallback; the existing
// _resetLibraryCacheForTests already clears libraryCache + inFlight
// but the stale snapshot is intentionally process-lifetime, so tests
// reach in here to clear it between cases.
export function _resetLibraryStaleFallbackForTests(): void {
  delete libraryStaleFallback.movie
  delete libraryStaleFallback.tv
}

async function fetchSonarrLibrary(): Promise<SonarrSeries[]> {
  return (await fetchLibraryCached('tv')) as SonarrSeries[]
}

async function fetchRadarrLibrary(): Promise<RadarrMovie[]> {
  return (await fetchLibraryCached('movie')) as RadarrMovie[]
}

// Compact library line: "Title (Year) — genre1, genre2". Genres give
// Claude enough signal to taste-match without ballooning tokens.
function formatLibraryItem(it: { title: string; year?: number; genres?: string[] }): string {
  const yr = it.year ? ` (${it.year})` : ''
  const title = sanitizeTitle(it.title)
  const genres = it.genres?.map((g) => sanitizeTitle(g)).filter(Boolean).slice(0, 3) ?? []
  const g = genres.length > 0 ? ` — ${genres.join(', ')}` : ''
  return `${title}${yr}${g}`
}

// Stable system prompt — never changes per request, ideal cache prefix.
const SYSTEM_PROMPT = `You are a media taste-matching agent for a household media server. Given the household's library and an explicit "never suggest" list, return ranked recommendations that match their existing taste — same era, tone, genre clusters, directorial sensibilities, and adjacent recommendations from beloved titles.

Rules:
- HARD RULE: Never recommend a title in the household's library. Library titles are listed in full below — every one of them. A server-side validator filters library matches by id and by normalized title (including subtitle base form) before the user sees the response, so recommending a library title costs the household one slot of the count contract AND one paid output token for nothing. Reach further into your knowledge instead.
- HARD RULE: Never recommend a title in the NEVER SUGGEST list. The complete list is shipped below — not a sample. Same cost as library overlap: the validator drops it, the user sees a shorter strip, and the household paid for tokens that produced no value. Avoid stylistically-near matches too (close remakes, alternate-name re-releases, the "season 2 of an existing rejected show").
- Mirror the genre distribution of the library. If 60% of the library is live-action drama, ~60% of your recommendations should be live-action drama. Do NOT over-index on any single genre cluster (e.g. don't return all-Animation or all-Anime just because those tags are present; they're a slice, not the whole picture).
- Each recommendation should have a clear analog in the library — name the closest matches in your reasoning, even if you don't return the reason field.
- Prefer well-regarded, mainstream-adjacent titles. Critical reception and audience love are signals; obscurity for its own sake is not.
- Modest variety across calls is fine, but recommendations should land in the "obvious yes" zone for someone who already loves what's in the library.
- Real, released titles only. No imaginary or future-dated releases.
- Be exact with titles and years so they can be looked up in TMDB.
- COUNT CONTRACT: always fill the requested number of picks. A short list or empty array is a system failure; if you can't find perfect matches, return your best attempts. A downstream validator filters overlaps with the library/never-list, so borderline picks are welcome — never return fewer than asked.

Output is consumed by code — return JSON only, no commentary.`

// Normalize a title for cross-source matching. Sonarr/Radarr's title
// and TMDB's title sometimes disagree on punctuation, articles, or
// suffixes. Lowercase, strip leading articles, drop non-alphanumeric.
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim()
}

// Base title — everything before the first subtitle separator
// (`:`, em-dash, en-dash, ` - `). Catches the very common case where
// Sonarr stores "A Knight of the Seven Kingdoms: The Hedge Knight"
// but TMDB / Claude refer to it as "A Knight of the Seven Kingdoms"
// (or vice versa). Empty when the title has no subtitle.
function normalizeTitleBase(t: string): string {
  const cut = t.split(/[:—–]|\s-\s/)[0]
  if (!cut || cut === t) return ''
  const normalized = normalizeTitle(cut)
  // Short bases (≤4 chars) collide with too many unrelated titles:
  // "It: Chapter Two" → "it" blocked every "It" anything; "Up:
  // Special Edition" → "up" blocked every two-letter pick. Long
  // enough to be a meaningful franchise root, short enough to still
  // catch real subtitle dedupes like "starwars" or "missionimpossible".
  if (normalized.length < 5) return ''
  return normalized
}

// Build the matchable-title set from a list of entries. By default
// includes both the full normalized title and the base (pre-subtitle)
// form when the title has a subtitle — appropriate for the library
// (a different cut of an owned title is still a dupe).
//
// For the rejection set, pass {includeBase: false}. Rejecting one
// franchise entry ("Avatar: The Last Airbender") should NOT blanket-
// ban every other work sharing the franchise root ("Avatar: The Way
// of Water" is an unrelated film). The id-set check still catches
// exact-id rejections; only the title surface narrows here.
function titleSetFrom(
  entries: Array<{ title: string }>,
  opts: { includeBase?: boolean } = {},
): Set<string> {
  const includeBase = opts.includeBase ?? true
  const out = new Set<string>()
  for (const e of entries) {
    if (!e.title) continue
    out.add(normalizeTitle(e.title))
    if (includeBase) {
      const base = normalizeTitleBase(e.title)
      if (base) out.add(base)
    }
  }
  return out
}

// Does a pick title match anything in the set? Checks the pick's
// full and base forms against the set.
function titleMatches(pick: string, set: Set<string>): boolean {
  if (set.size === 0) return false
  if (set.has(normalizeTitle(pick))) return true
  const base = normalizeTitleBase(pick)
  if (base && set.has(base)) return true
  return false
}

// Render a list of {id, title} entries as prompt bullets. Untitled
// entries (legacy bare-id rows the backfill couldn't resolve — e.g.
// TMDB key missing or the id was retired) still appear so Claude
// knows the household has rejected/liked something with that id;
// they just can't taste-match without the name. Better honest signal
// than silent omission.
function renderEntryBullets(entries: Array<{ id: number; title: string }>): string {
  return entries
    .map((e) => (e.title ? `- ${e.title}` : `- [TMDB id ${e.id}]`))
    .join('\n')
}

// Ship the full rejection set in the cached prefix. The old 75-cap
// existed so the model wouldn't anchor on a long NEVER list — but in
// practice, hiding rejections from the model means it keeps proposing
// them, the post-filter drops them, the retry fires with the same
// blind spot, and the user pays Claude $ for picks that were always
// going to be filtered. Cached at 0.1x base rate this is essentially
// free; counter-anchoring is handled in the prompt language instead.

// Compute the top-N genre distribution from a library. Returned as
// `["Drama 38%", "Action 22%", …]` strings so it can be dropped
// straight into the prompt. Genres are denominator-weighted by total
// genre tags (not titles), so a title tagged Drama+Crime contributes
// to both buckets — that matches how taste actually works (you don't
// have to pick one).
function computeGenreDistribution(
  library: Array<{ genres?: string[] }>,
  topN: number,
): string[] {
  const counts = new Map<string, number>()
  let total = 0
  for (const item of library) {
    if (!item.genres) continue
    for (const g of item.genres) {
      if (!g) continue
      counts.set(g, (counts.get(g) ?? 0) + 1)
      total++
    }
  }
  if (total === 0) return []
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([g, n]) => `${g} ${Math.round((n / total) * 100)}%`)
}

function buildLibraryBlock(
  kind: 'movie' | 'tv',
  library: Array<{ title: string; year?: number; genres?: string[] }>,
  rejections: Array<{ id: number; title: string }>,
): string {
  const header = kind === 'movie' ? 'MOVIES' : 'TV SHOWS'
  const libLines = library.map(formatLibraryItem).join('\n')
  // Concrete distribution beats abstract "mirror the genres". Sent
  // alongside the library so Claude has both the raw signal and the
  // pre-computed shape to match against.
  const distribution = computeGenreDistribution(library, 6)
  const distLine =
    distribution.length > 0
      ? `\n\nTARGET GENRE MIX (match these proportions across your picks): ${distribution.join(', ')}`
      : ''
  const libraryAndGenres =
    `Household ${header} library (${library.length} titles, do NOT suggest any of these):\n${libLines}${distLine}`
  if (rejections.length === 0) {
    return libraryAndGenres
  }
  // Ship every rejection. Titled rows first so the most useful
  // taste-signal bullets dominate the start of the block, untitled
  // rows after as `[TMDB id N]` fallbacks.
  const titled = rejections.filter((r) => r.title)
  const untitled = rejections.filter((r) => !r.title)
  const promptRejections = [...titled, ...untitled]
  // Rejections FIRST in the block — the most attended-to position
  // after the system prompt. Library follows as taste signal. Putting
  // rejections in their own labeled section (NEVER SUGGEST) ahead of
  // the library list makes the constraint structurally unmissable.
  return (
    `NEVER SUGGEST — the household has explicitly rejected every title below (${promptRejections.length} total). ` +
    `This is a hard contract: any recommendation matching this list will be silently dropped, the user will see a shorter strip, and the household's API budget will have paid for nothing. Every pick you submit MUST NOT appear here. Audit each pick against this list before calling the tool.\n` +
    `${renderEntryBullets(promptRejections)}\n\n` +
    libraryAndGenres
  )
}


// Per-user "liked" block. Sent after the cached prefix so it can vary
// per caller without invalidating the household library cache. Same
// fallback rule as rejections — every liked id appears, untitled ones
// render as `[TMDB id N]`.
//
// Recency weighting (Agent C #3): liked entries are stored oldest-first
// (push semantics). Reversing the array puts the most-recently-liked
// title at the top of the block — the highest-attention position after
// the label. Claude should up-weight the first bullets because they
// represent the user's freshest taste signal.
function buildUserLikesBlock(liked: Array<{ id: number; title: string }>): string {
  if (liked.length === 0) return ''
  // Reverse so newest likes appear first (highest prompt attention).
  const recencyOrdered = [...liked].reverse()
  return (
    `This user has explicitly LIKED the following — recommend more in this vein ` +
    `(strongest positive taste signal; items listed first are the MOST RECENTLY liked):\n${renderEntryBullets(recencyOrdered)}`
  )
}

// Volatile "priority taste signal" block — the top-N library titles
// most representative of the household's taste cluster, hoisted to a
// high-attention position right before the user message.
//
// Why this exists: the cached library block can be hundreds of titles
// long. LLM positional underweighting (well-documented in long-context
// settings) means titles deep in that list contribute little signal.
// By extracting the most-genre-typical titles into a short volatile
// block AFTER the cache, we give Claude a high-salience taste anchor
// that doesn't invalidate the cache (volatile block stays outside the
// cache_control region).
//
// Relevance score = sum of (1 / rank of each genre in the top distribution)
// per matched genre tag. Titles with multiple top-genre matches surface
// first. A title with one top-1 genre beats a title with three top-7
// genres. Limited to PRIORITY_TASTE_CAP titles; only fires when the
// library is larger than the cap (otherwise the cached block already
// fits in the attended zone).
const PRIORITY_TASTE_CAP = 30
const PRIORITY_TASTE_TRIGGER = 60 // below this size, full library fits — skip block

function buildPriorityTasteBlock(
  library: Array<{ title: string; year?: number; genres?: string[] }>,
): string {
  if (library.length < PRIORITY_TASTE_TRIGGER) return ''
  // Compute genre rank (most-common = rank 1).
  const counts = new Map<string, number>()
  for (const item of library) {
    if (!item.genres) continue
    for (const g of item.genres) {
      if (!g) continue
      counts.set(g, (counts.get(g) ?? 0) + 1)
    }
  }
  const rankedGenres = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([g], i) => [g, 1 / (i + 1)] as [string, number])
  const genreRank = new Map(rankedGenres)
  // Score each title by sum of genre weights.
  const scored = library.map((it) => {
    let score = 0
    for (const g of it.genres ?? []) {
      score += genreRank.get(g) ?? 0
    }
    return { item: it, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, PRIORITY_TASTE_CAP).map(({ item }) => item)
  if (top.length === 0) return ''
  const lines = top.map((it) => `- ${formatLibraryItem(it)}`).join('\n')
  return (
    `PRIORITY TASTE SIGNAL — the ${top.length} library titles that most strongly anchor the household's taste cluster ` +
    `(of ${library.length} total). Weight your recommendations toward titles a viewer of these would obviously want next:\n${lines}`
  )
}

// Fisher-Yates shuffle — mutates and returns the array. Used to
// randomize the candidate pool order per refresh so Claude sees a
// different numbered list each call even when the TMDB cache is warm.
// The pool is a per-request copy (filterHouseholdSafe returns a new
// array), so mutating it is safe.
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]!
    arr[j] = tmp!
  }
  return arr
}

// Per-user rolling buffer of recently-served titles. The Claude prompt
// prefix (system + library + rejections) is cached, and at temperature
// 0.4–0.7 a deterministic prefix produces near-identical pick lists
// across refreshes — refreshes look like nothing changed, dot-clicks
// look unreactive, the strip "feels stuck." This buffer is injected
// as a volatile RECENTLY SHOWN block so the model rotates picks
// between calls without the household-cache prefix being invalidated.
//
// In-memory only — soft signal, not load-bearing. Resets on restart.
// Capped at RECENTLY_SHOWN_CAP per (sub, kind); newest items pushed
// to the front, older items LRU'd off the tail. Untitled items are
// dropped (a bare-id row is no signal to the model).
// Ship the full recently-shown buffer so Claude actually rotates
// instead of cycling through the same picks the user just saw. The
// language in buildRecentlyShownBlock keeps this a soft preference,
// not a hard NEVER — the previous 20-cap meant a 30-pick refresh
// could re-include the last batch the user just dismissed.
const RECENTLY_SHOWN_CAP = 150
const RECENTLY_SHOWN_MAX_KEYS = 200
const recentlyShown = new Map<string, Array<{ id: number; title: string }>>()

function recentKey(sub: string, kind: 'movie' | 'tv'): string {
  return `${sub}:${kind}`
}

export function _resetRecentlyShownForTests(): void {
  recentlyShown.clear()
}

function getRecentlyShown(sub: string, kind: 'movie' | 'tv'): Array<{ id: number; title: string }> {
  const key = recentKey(sub, kind)
  const items = recentlyShown.get(key)
  if (!items) return []
  recentlyShown.delete(key)
  recentlyShown.set(key, items)
  return items
}

function recordShown(
  sub: string,
  kind: 'movie' | 'tv',
  items: Array<{ id: number; title: string }>,
): void {
  const key = recentKey(sub, kind)
  const prev = recentlyShown.get(key) ?? []
  const merged: Array<{ id: number; title: string }> = []
  const seen = new Set<number>()
  for (const item of items) {
    if (item.title && !seen.has(item.id)) {
      seen.add(item.id)
      merged.push({ id: item.id, title: item.title })
    }
  }
  for (const item of prev) {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      merged.push(item)
      if (merged.length >= RECENTLY_SHOWN_CAP) break
    }
  }
  recentlyShown.set(key, merged.slice(0, RECENTLY_SHOWN_CAP))
  while (recentlyShown.size > RECENTLY_SHOWN_MAX_KEYS) {
    const oldest = recentlyShown.keys().next().value
    if (!oldest) break
    recentlyShown.delete(oldest)
  }
}

// The "rotate, don't repeat" instruction goes in the volatile portion
// of the system stack so it doesn't break the cache prefix. Empty
// when the user has no history yet (first call after restart).
function buildRecentlyShownBlock(items: Array<{ id: number; title: string }>): string {
  if (items.length === 0) return ''
  const bullets = items.map((i) => `- ${i.title}`).join('\n')
  // Soft preference, not a NEVER. The earlier wording ("only repeat
  // if absolutely no comparable alternative exists") read to the
  // model as a hard exclusion and collapsed candidate pools after a
  // few refreshes.
  // Strengthened from "mild preference" to "strong preference" now
  // that the CANDIDATE POOL gives Claude 60 fresh candidates to choose
  // from — no risk of collapsing the candidate space. The pool ensures
  // there's always an alternative, so the repeated-if-best-fit escape
  // hatch is no longer needed as a guard.
  return (
    `RECENTLY SHOWN to this user (strong preference for fresh picks — avoid these titles; ` +
    `with the CANDIDATE POOL available there is always an alternative):\n${bullets}`
  )
}

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

async function backfillRejectionTitles(
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

async function backfillLikedTitles(
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

async function tmdbLookup(
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

function genreNamesToTmdbIds(kind: 'movie' | 'tv', names: string[]): number[] {
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
function topGenreNames(library: Array<{ genres?: string[] }>, n: number): string[] {
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

async function fetchCandidatePool(
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
async function tmdbDiscoverByGenres(
  kind: 'movie' | 'tv',
  genreIds: number[],
): Promise<SuggestionItem[]> {
  return fetchCandidatePool(kind, genreIds)
}

async function tmdbTrending(kind: 'movie' | 'tv'): Promise<SuggestionItem[]> {
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

// Format the candidate pool for the prompt. Numbered list so Claude
// can reference items by number if it wants; title + year so it can
// match back exactly. Description deliberately says "from this list"
// to make the constraint explicit.
function buildCandidatePoolBlock(candidates: SuggestionItem[]): string {
  if (candidates.length === 0) return ''
  const lines = candidates
    .map((c, i) => {
      const yr = c.year ? ` (${c.year})` : ''
      return `${i + 1}. ${c.title}${yr}`
    })
    .join('\n')
  return (
    `CANDIDATE POOL — ${candidates.length} pre-vetted titles from your household's top genres (already screened: none are in your library or NEVER SUGGEST list). ` +
    `RANK these by how well they match the household's taste. Pick your recommendations PRIMARILY from this list — only reach outside it when the pool lacks good adjacents for a specific sub-genre the household clearly loves.\n\n` +
    lines
  )
}

// Tool-use enforced output. Claude is forced to call this tool, which
// owns the exact shape of valid output. The tool definition is also
// where the model is reminded what NOT to submit — duplicate guidance
// to the system prompt because the tool's `description` is rendered
// in close proximity to the call site at inference time.
const SUBMIT_TOOL = {
  name: 'submit_recommendations',
  description:
    'Submit the ranked list of recommended titles. Prefer titles from the CANDIDATE POOL when provided — they are already verified against the household library and NEVER SUGGEST list. Each entry MUST be a real, released title that is NOT in the household library and NOT on the NEVER SUGGEST list. For each pick, ALWAYS include a `reason`: a single short clause (≤90 chars) naming a specific library title or genre cluster — e.g. "neighbor of Severance", "for fans of Heat", "same prestige-crime tone as The Wire". The reason MUST reference something concrete in the household library or likes, NOT marketing copy. A reason is required for every pick that has a clear library analog (which is almost all of them — if you cannot ground a pick in the library, reconsider the pick).',
  input_schema: {
    type: 'object' as const,
    properties: {
      picks: {
        type: 'array' as const,
        description: 'Ordered list, most-likely-loved first.',
        items: {
          type: 'object' as const,
          properties: {
            title: { type: 'string' as const },
            year: { type: 'integer' as const },
            reason: {
              type: 'string' as const,
              description:
                'Required one-clause grounding (≤90 chars) naming a specific library title or cluster — e.g. "neighbor of Breaking Bad" or "same director as their Heat". This is what makes the recommendation trustworthy and personalised rather than generic. Only omit if the pick has zero connection to the library (rare).',
            },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    },
    required: ['picks'],
    additionalProperties: false,
  },
}

type UsageBlock = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: { picks?: ClaudePick[] }
}

// Track whether the last Claude call was truncated by max_tokens.
// Threaded through ClaudeResponse so the route handler can surface it
// in _diag without coupling readToolUse to the diag builder.
type ClaudeResponse = {
  toolUse: ToolUseBlock | null
  picks: ClaudePick[]
  usage: UsageBlock
  truncated?: boolean
}

function extractUsage(usage: Anthropic.Messages.Usage | undefined): UsageBlock {
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? undefined,
  }
}

function readToolUse(response: Anthropic.Messages.Message): ClaudeResponse {
  const usage = extractUsage(response.usage)
  const tu = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
  )
  if (!tu) {
    console.error(
      '[suggestions] Claude returned no tool_use block; content types:',
      response.content.map((b) => b.type).join(','),
      'stop_reason:',
      response.stop_reason,
    )
    return { toolUse: null, picks: [], usage }
  }
  // When max_tokens cuts off mid-tool-use, the SDK still returns the
  // block but the JSON `input` is truncated — picks parses to an empty
  // array and the route silently returns nothing. Log loudly and surface
  // the truncated flag so _diag exposes it to the UI.
  const truncated = response.stop_reason === 'max_tokens'
  if (truncated) {
    console.error(
      '[suggestions] tool_use truncated by max_tokens — picks list will be incomplete or empty; raise max_tokens or shrink CLAUDE_OVERFETCH',
    )
  }
  const input = tu.input as { picks?: unknown }
  // Guard against malformed tool_use input: picks must be a non-null array
  // of objects with at least a string title field. Any other shape is treated
  // as an empty list so the retry/fill chain handles the shortage gracefully
  // rather than crashing on undefined pick.title access downstream.
  const rawPicks = Array.isArray(input.picks) ? input.picks : []
  const picks: ClaudePick[] = rawPicks
    .filter(
      (p): p is ClaudePick =>
        p !== null &&
        typeof p === 'object' &&
        typeof (p as { title?: unknown }).title === 'string' &&
        (p as ClaudePick).title.trim().length > 0,
    )
  if (rawPicks.length > 0 && picks.length < rawPicks.length) {
    console.warn(
      '[suggestions] readToolUse: filtered',
      rawPicks.length - picks.length,
      'malformed picks (missing/non-string title)',
    )
  }
  return {
    toolUse: { type: 'tool_use', id: tu.id, name: tu.name, input: input as { picks?: ClaudePick[] } },
    picks,
    usage,
    truncated,
  }
}

// System message stack shared between initial call and retry. Library
// + rejections live in the cached prefix; user-likes, recently-shown,
// and the candidate pool vary per caller and stay outside the cache.
// The candidate pool is placed last (highest attention) because it is
// the most immediately actionable context — Claude should read it right
// before being asked to pick.
function systemStack(
  libraryBlock: string,
  priorityTasteBlock: string,
  userLikesBlock: string,
  recentlyShownBlock: string,
  candidatePoolBlock: string,
): Array<{
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}> {
  return [
    { type: 'text', text: SYSTEM_PROMPT },
    { type: 'text', text: libraryBlock, cache_control: { type: 'ephemeral' } },
    // Volatile blocks AFTER the cache — high-attention position.
    // Priority taste signal first (the strongest positive signal),
    // then explicit likes, then recently-shown rotation, then the
    // candidate pool so Claude's final context before generating is
    // a numbered ranked-pool invitation.
    ...(priorityTasteBlock ? [{ type: 'text' as const, text: priorityTasteBlock }] : []),
    ...(userLikesBlock ? [{ type: 'text' as const, text: userLikesBlock }] : []),
    ...(recentlyShownBlock ? [{ type: 'text' as const, text: recentlyShownBlock }] : []),
    ...(candidatePoolBlock ? [{ type: 'text' as const, text: candidatePoolBlock }] : []),
  ]
}

// Per-request entropy seed. The system prefix is cached (cache_control:
// ephemeral on the library block) so temperature alone barely shifts
// the pick distribution across refreshes — the cached prefix dominates.
// Injecting an unguessable, per-call salt in the USER message (outside
// the cache) gives Claude something to pivot on, so refresh variety
// stops being a function of temperature alone. The salt has no semantic
// meaning, just entropy. Refresh variety (rubric dim 4).
function refreshSalt(): string {
  // crypto.randomUUID is available on Node 20+ and modern browsers.
  // 16 hex chars (64 bits) — enough entropy to ensure each request
  // looks unique to the model's attention. Math.random fallback for
  // test environments without crypto.
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    // Two UUIDs sliced and concatenated give 16 unique hex chars.
    return g.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  }
  const hi = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  const lo = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return hi + lo
}

function userAsk(
  kind: 'movie' | 'tv',
  n: number,
  salt: string,
  genreHint?: string,
): string {
  // Salt is placed at the BEGINNING of the user message so it's in the
  // highest-attention position — the model attends more to the start of
  // user content. This maximises the per-call entropy signal that breaks
  // cache-prefix determinism. (Iter 43: moved from end to start; length
  // raised from 8 to 16 hex chars for stronger entropy.)
  //
  // genreHint (iter 55): the top-2 genres from the library with percentages,
  // repeated in the volatile user message for high-attention positioning.
  // The same distribution already lives in the cached library block
  // (TARGET GENRE MIX line), but the volatile repetition here ensures
  // it's in the most recently attended context — the same intentional
  // redundancy used by the PRIORITY TASTE block. Only emitted when the
  // library has genre data (not cold-start).
  const genreClause = genreHint
    ? `\n\nGENRE FOCUS this call: ${genreHint}. The CANDIDATE POOL already reflects these genres; lean into them.`
    : ''
  return (
    `[Request salt: ${salt}]\n\n` +
    `Recommend exactly ${n} ${kind === 'movie' ? 'movies' : 'TV shows'} for this household by calling submit_recommendations. ` +
    `Use the household's library and likes as taste signal; aim for a proportional mix across the library's genres, weighted toward explicitly liked titles. ` +
    `\n\n` +
    `Before you submit, audit every pick: any title in the household library or the NEVER SUGGEST list must be replaced. A pick that matches either list is a wasted recommendation — the user pays for the token and sees a shorter strip. ` +
    `Return ${n} picks, never fewer; if obvious matches are exhausted, reach into deeper-cut adjacent recommendations rather than repeating from those lists.\n\n` +
    `ROTATION QUOTA: at least 30% of your picks this round should be titles that did NOT appear in the RECENTLY SHOWN block (when one is present). The cached prefix tends to make refreshes look identical — rotation is the only way the household sees new faces.` +
    genreClause
  )
}

// Higher temperature drives meaningfully different picks across
// refreshes (the cached prompt prefix would otherwise produce near-
// identical lists at low temp). 0.7 still keeps Claude in the
// "obvious yes" zone the system prompt asks for.
const CLAUDE_TEMPERATURE = 0.7

// Anthropic overload / service-error retry wrapper.
// HTTP 529 (Overloaded) and 503 (Service Unavailable) are documented
// Anthropic transient states — a single retry after a short fixed
// delay clears most of them without burning a second token budget.
// The Anthropic SDK throws `APIStatusError` with .status for these;
// other errors propagate immediately (401 bad key, 400 bad prompt, etc.).
// Max 2 attempts (1 retry), 3 s wait — bounded cost: worst case adds
// 3 s to a refresh that was already failing.
const ANTHROPIC_RETRY_STATUSES = new Set([529, 503])
const ANTHROPIC_RETRY_DELAY_MS = 3_000
const ANTHROPIC_RETRY_MAX = 2 // total attempts including the first
const CLAUDE_TIMEOUT_MS = 20_000

class ClaudeTimeoutError extends Error {
  constructor() {
    super(`Claude request exceeded ${CLAUDE_TIMEOUT_MS}ms`)
    this.name = 'ClaudeTimeoutError'
  }
}

async function withClaudeDeadline<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ClaudeTimeoutError())
    }, CLAUDE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([fn(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withAnthropicRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < ANTHROPIC_RETRY_MAX; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const status =
        typeof (e as { status?: unknown }).status === 'number'
          ? (e as { status: number }).status
          : undefined
      if (status !== undefined && ANTHROPIC_RETRY_STATUSES.has(status) && attempt < ANTHROPIC_RETRY_MAX - 1) {
        console.warn('[suggestions] Anthropic transient error', status, '— retrying after', ANTHROPIC_RETRY_DELAY_MS, 'ms')
        await new Promise((res) => setTimeout(res, ANTHROPIC_RETRY_DELAY_MS))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

async function callClaudeInitial(
  client: Anthropic,
  kind: 'movie' | 'tv',
  libraryBlock: string,
  priorityTasteBlock: string,
  userLikesBlock: string,
  recentlyShownBlock: string,
  candidatePoolBlock: string,
  salt: string,
  genreHint?: string,
): Promise<ClaudeResponse> {
  const response = await withAnthropicRetry(() =>
    withClaudeDeadline((signal) =>
      client.messages.create({
        model: MODEL,
        // 4096 gives full headroom for 30 picks with per-pick reasons.
        // 30 picks × ~80 tokens each = ~2400 output tokens + envelope;
        // the prior 2048 ceiling could truncate mid-JSON when reasons
        // were present. Haiku 4.5 max_output is 8192; 4096 is safe.
        max_tokens: 4096,
        temperature: CLAUDE_TEMPERATURE,
        system: systemStack(libraryBlock, priorityTasteBlock, userLikesBlock, recentlyShownBlock, candidatePoolBlock),
        tools: [SUBMIT_TOOL],
        tool_choice: { type: 'tool', name: SUBMIT_TOOL.name, disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: userAsk(kind, CLAUDE_OVERFETCH, salt, genreHint) }],
      }, { timeout: CLAUDE_TIMEOUT_MS, signal }),
    ),
  )
  return readToolUse(response)
}

async function callClaudeRetry(
  client: Anthropic,
  kind: 'movie' | 'tv',
  libraryBlock: string,
  priorityTasteBlock: string,
  userLikesBlock: string,
  recentlyShownBlock: string,
  candidatePoolBlock: string,
  prior: ToolUseBlock,
  rejectedPicks: Array<{ title: string; reason: string }>,
  nNeeded: number,
  salt: string,
  genreHint?: string,
): Promise<ClaudeResponse> {
  const rejectedSummary = rejectedPicks
    .slice(0, 15)
    .map((r) => `  - "${r.title}" — ${r.reason}`)
    .join('\n')
  const toolResultText =
    `${rejectedPicks.length} of your picks were rejected by the household-safety validator:\n${rejectedSummary}\n\n` +
    `Call submit_recommendations again with ${nNeeded} REPLACEMENT picks that don't conflict.`
  // Retry intentionally drops the recently-shown block from the system
  // stack: the retry is exactly when Claude needs more candidate
  // freedom, not the same rotation blocklist that just constrained the
  // initial call. We pass it through the function signature only so
  // the call-site remains symmetric; if a caller really wants it,
  // they can pass a non-empty string.
  void recentlyShownBlock
  const response = await withAnthropicRetry(() =>
    withClaudeDeadline((signal) =>
      client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        temperature: CLAUDE_TEMPERATURE,
        system: systemStack(libraryBlock, priorityTasteBlock, userLikesBlock, '', candidatePoolBlock),
        tools: [SUBMIT_TOOL],
        tool_choice: { type: 'tool', name: SUBMIT_TOOL.name, disable_parallel_tool_use: true },
        messages: [
          { role: 'user', content: userAsk(kind, CLAUDE_OVERFETCH, salt, genreHint) },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: prior.id, name: prior.name, input: prior.input },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: prior.id, content: toolResultText },
            ],
          },
        ],
      }, { timeout: CLAUDE_TIMEOUT_MS, signal }),
    ),
  )
  return readToolUse(response)
}

function mergeUsage(a: UsageBlock, b: UsageBlock): UsageBlock {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheCreationInputTokens:
      (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0) || undefined,
    cacheReadInputTokens:
      (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) || undefined,
  }
}

// Tiny timing collector — emits a Server-Timing response header so
// the browser devtools Network tab shows the per-phase breakdown.
// Names follow the Server-Timing spec (RFC 8673) so DevTools renders
// them as a stacked bar.
function makeTiming(): {
  mark: (name: string) => () => void
  header: () => string
} {
  const entries: Array<{ name: string; ms: number }> = []
  return {
    mark(name) {
      const start = performance.now()
      return () => entries.push({ name, ms: performance.now() - start })
    },
    header() {
      return entries.map((e) => `${e.name};dur=${e.ms.toFixed(1)}`).join(', ')
    },
  }
}

function tagIptvAvailability(items: SuggestionItem[]): SuggestionItem[] {
  const ids = Array.from(new Set(items.map((item) => item.id).filter((id) => Number.isInteger(id))))
  if (ids.length === 0) return items

  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = iptvDb().raw.prepare(`
      SELECT DISTINCT tmdb_id
      FROM iptv_title_link
      WHERE tmdb_id IN (${placeholders})
        AND removed_at IS NULL
    `).all(...ids) as Array<{ tmdb_id: number }>
    const linked = new Set(rows.map((row) => row.tmdb_id))
    if (linked.size === 0) return items

    return items.map((item) => {
      if (!linked.has(item.id)) return item
      const available = item.available_on ? [...item.available_on] : []
      if (!available.includes('iptv')) available.push('iptv')
      return { ...item, available_on: available }
    })
  } catch (err) {
    console.warn('[suggestions] iptv availability lookup failed:', err instanceof Error ? err.message : String(err))
    return items
  }
}

// Stamp available_on:['local'] for suggestion items the household already
// has on disk, cross-referencing media-core's read-only media.db. Pure:
// returns a new array, never mutates the input. Composes with
// tagIptvAvailability — an item can carry both 'iptv' and 'local'.
//
// Matching strategy (mirrors the M3 finding):
//   PRIMARY  — tmdb_id JOIN. This is the durable seam: it lights up
//              automatically once media-core's TMDB enrichment lands.
//   FALLBACK — normalized title + EXACT year, for items not matched by
//              id (today every media.db row has tmdb_id=NULL). The local
//              `title` column is currently reversed/quality-token junk, so
//              the fallback is deliberately strict: normalizeTitle() both
//              sides, require an exact year match, and skip empty/<5-char
//              normalized titles to suppress false positives. We query
//              only movies/shows (never the ~21k episodes).
function tagLocalAvailability(
  items: SuggestionItem[],
  kind: 'movie' | 'tv',
): SuggestionItem[] {
  // Gate: when media-core is not enabled there is no local library to tag.
  if (!env.useMediaCore) return items
  if (items.length === 0) return items

  const db = mediaLibraryDb()
  // Graceful degrade: missing/unopenable media.db → leave items untouched.
  if (!db) return items

  const table = kind === 'tv' ? 'shows' : 'movies'

  try {
    // --- PRIMARY: tmdb_id join -------------------------------------------
    const ids = Array.from(
      new Set(items.map((item) => item.id).filter((id) => Number.isInteger(id))),
    )
    const matchedById = new Set<number>()
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      const rows = db.raw
        .prepare(
          `SELECT DISTINCT tmdb_id FROM ${table} WHERE tmdb_id IN (${placeholders})`,
        )
        .all(...ids) as Array<{ tmdb_id: number | null }>
      for (const row of rows) {
        if (row.tmdb_id != null) matchedById.add(row.tmdb_id)
      }
    }

    // --- FALLBACK: normalized title + exact year -------------------------
    // Only for items NOT already matched by id. Build a lookup of local
    // (normalizedTitle|year) keys, then probe per unmatched item.
    const unmatched = items.filter(
      (item) => !matchedById.has(item.id) && typeof item.year === 'number',
    )
    const matchedByTitle = new Set<string>() // keyed by item.id|title to mark items
    if (unmatched.length > 0) {
      // Pull local rows (id-less or otherwise) once; movies/shows only,
      // never episodes. Year must be present for an exact match.
      const localRows = db.raw
        .prepare(`SELECT title, year FROM ${table} WHERE year IS NOT NULL`)
        .all() as Array<{ title: string | null; year: number | null }>
      const localKeys = new Set<string>()
      for (const row of localRows) {
        if (!row.title || row.year == null) continue
        const norm = normalizeTitle(row.title)
        // Skip junk: empty or implausibly short normalized titles collide
        // with too many unrelated rows once articles/punctuation are gone.
        if (norm.length < 5) continue
        localKeys.add(`${norm}|${row.year}`)
      }
      if (localKeys.size > 0) {
        for (const item of unmatched) {
          const norm = normalizeTitle(item.title)
          if (norm.length < 5) continue
          if (localKeys.has(`${norm}|${item.year}`)) {
            matchedByTitle.add(`${item.id}::${item.title}::${item.year}`)
          }
        }
      }
    }

    if (matchedById.size === 0 && matchedByTitle.size === 0) return items

    return items.map((item) => {
      const hit =
        matchedById.has(item.id) ||
        matchedByTitle.has(`${item.id}::${item.title}::${item.year}`)
      if (!hit) return item
      const available = item.available_on ? [...item.available_on] : []
      if (!available.includes('local')) available.push('local')
      return { ...item, available_on: available }
    })
  } catch (err) {
    console.warn(
      '[suggestions] local availability lookup failed:',
      err instanceof Error ? err.message : String(err),
    )
    return items
  }
}

suggestions.get('/:type', async (c) => {
  const type = c.req.param('type')
  if (type !== 'movie' && type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }

  const timing = makeTiming()
  const setTimingHeader = () => {
    const h = timing.header()
    if (h) c.header('Server-Timing', h)
  }

  // ?force=trending — client opts out of the Claude call to avoid
  // burning tokens (e.g., the household-level AI toggle is off).
  // Same downstream shape as the cold-start path so the SPA renders
  // identically.
  const force = c.req.query('force')

  // Fully parallel prologue. The session is set by the auth middleware
  // before this handler runs, so feedback can race library/rejections.
  // Cost is bounded — feedback is a JSON read with module cache; even
  // when the request short-circuits to cold-start or trending, the
  // unawaited fetch settles harmlessly off the hot path.
  const session = c.get('session')
  // Don't swallow errors here. getUserFeedback already returns an empty
  // bucket cleanly on ENOENT (first run / unknown sub). Any other
  // failure — IO error, or the fail-closed parse-corruption path added
  // in round 12 — should surface as a 500 instead of silently
  // serving generic suggestions while real likes/dislikes are
  // unreachable.
  //
  // Several branches below early-return (force=trending, cold-start,
  // missing BYO key) WITHOUT awaiting this promise. Attach a no-op
  // handler so a rejection on those paths doesn't trigger Node's
  // unhandledRejection (which crashes the process under default
  // settings). Branches that actually consume the value still await
  // the original promise and re-throw — attaching a separate .catch
  // chain doesn't suppress that re-throw, it only marks the rejection
  // as "handled" for the unhandled-rejection bookkeeping.
  const userFeedbackPromise = getUserFeedback(session.sub)
  userFeedbackPromise.catch(() => {
    // intentional: handler exists so unhandledRejection won't fire on
    // early-return paths; consumption-side await still re-throws.
  })
  const endPrologue = timing.mark('prologue')
  let library: LibraryItem[]
  let rejections: Awaited<ReturnType<typeof getRejections>>
  try {
    ;[library, rejections] = await Promise.all([
      type === 'movie' ? fetchRadarrLibrary() : fetchSonarrLibrary(),
      getRejections(),
    ])
  } catch (err) {
    endPrologue()
    setTimingHeader()
    // Without a real library, "show trending" silently leaks
    // already-owned titles back into the strip — the cold-start path
    // treats an empty library as "user has nothing." Surface the
    // failure instead so the SPA can show "library unavailable" and
    // retry on the next refresh.
    if (err instanceof LibraryUnavailableError) {
      return c.json(
        { error: 'library_unavailable', kind: type },
        502,
      )
    }
    throw err
  }
  endPrologue()

  const kindRejections = type === 'movie' ? rejections.movie : rejections.tv
  const rejected = new Set(kindRejections.map((r) => r.id))
  const libraryTmdbIds = new Set(
    library.map((l) => l.tmdbId).filter((id): id is number => typeof id === 'number'),
  )
  // Secondary library guard: Sonarr/Radarr entries without a tmdbId
  // wouldn't match the id set, and titles often disagree across
  // sources on subtitles ("X: The Y" vs "X"). titleSetFrom() includes
  // both the full normalized title and the pre-subtitle base form.
  const libraryTitles = titleSetFrom(library)
  // Rejections are exact-title only (no base form) — a "no" on
  // "Avatar: The Last Airbender" shouldn't blanket-ban every other
  // work in the Avatar franchise.
  const rejectedTitles = titleSetFrom(kindRejections, { includeBase: false })

  // Single household-aware filter used by EVERY return path —
  // personalized picks, cold-start trending, force=trending, claude-
  // error fallback, and the auto-fallback when picks all dropped.
  // Without this, trending-source paths used id-only filtering and
  // any library entry lacking a tmdbId slipped through as a
  // duplicate (e.g. A Knight of the Seven Kingdoms).
  function filterHouseholdSafe(items: SuggestionItem[]): SuggestionItem[] {
    return items.filter(
      (i) =>
        !rejected.has(i.id) &&
        !libraryTmdbIds.has(i.id) &&
        !titleMatches(i.title, rejectedTitles) &&
        !titleMatches(i.title, libraryTitles),
    )
  }

  // Include top genre distribution in every diag response so the
  // personalization signal is observable: callers can compare what
  // Claude was instructed to mirror against what actually rendered.
  const libraryGenres = computeGenreDistribution(library, 5)
  const snapshotAgeMs = librarySnapshotAgeMs(type)
  const diag = (extra: Record<string, unknown> = {}) => ({
    libraryCount: library.length,
    rejectionCount: kindRejections.length,
    libraryGenres: libraryGenres.length > 0 ? libraryGenres : undefined,
    librarySnapshotAgeHours:
      snapshotAgeMs === undefined ? undefined : Number((snapshotAgeMs / 3_600_000).toFixed(2)),
    ...extra,
  })

  // Local-recommender fast path. When USE_LOCAL_RECOMMENDER=1, the
  // Python sidecar in the same compose stack does retrieval + ranking
  // for FREE — no Claude tokens, no BYO key, no household-cost concern.
  // It takes precedence over BOTH force=trending and the server-side
  // cold-start short-circuit:
  //
  //   - force=trending was a token-cost escape hatch from when Claude
  //     was the only personalization path. With a free local model the
  //     SPA still sends ?force=trending for no-key users (so the BYO-
  //     key gate below doesn't 402 them), but pure trending is the
  //     WRONG default when personalized output is available at zero
  //     cost. Override.
  //
  //   - Cold-start: the sidecar's own cold_start_trending recipe
  //     handles small libraries internally (see recommender/app/main.py)
  //     and produces a comparable shape. Running BOTH cold-start checks
  //     would either short-circuit before the recommender could try,
  //     or leak the inconsistency between the two libraries (server
  //     reads Sonarr/Radarr live; sidecar reads its own DB).
  //
  // BYO-key Claude branch below still fires when USE_LOCAL_RECOMMENDER
  // is OFF — legacy path for deployments without the sidecar.
  if (env.useLocalRecommender) {
    const caller = recommenderCallerFromSession(session)
    const userFeedback = await userFeedbackPromise
    const likedRaw = type === 'movie' ? userFeedback.movie.liked : userFeedback.tv.liked
    const dislikedRaw =
      type === 'movie' ? userFeedback.movie.disliked : userFeedback.tv.disliked

    const recItems: RecommenderScoredItem[] = []
    const endRec = timing.mark('recommender')
    let modelVersion = 'unknown'
    let recipe = 'unknown'
    let recDiag: Record<string, unknown> = {}
    // Distinguish "sidecar healthy but returned nothing usable" from
    // "sidecar threw". Both collapse to safe.length === 0 below, but
    // only the former should mirror the trending fallback back to the
    // sidecar via postShown — posting /events/shown to a sidecar that
    // just failed /score is doomed to fail too, and the bounded timeout
    // produces a second log line per refresh during an outage.
    let recSucceeded = false
    try {
      const resp = await scoreOnce({
        sub: session.sub,
        kind: type,
        n: TARGET_COUNT,
        exclude_recently_shown: true,
        library: library
          .map((it) => ({
            ...(typeof it.tmdbId === 'number' ? { tmdb_id: it.tmdbId } : {}),
            title: it.title,
            source: type === 'movie' ? ('radarr' as const) : ('sonarr' as const),
          }))
          .filter((it) => it.tmdb_id !== undefined || it.title),
        feedback: [
          ...likedRaw.map((e) => ({ tmdb_id: e.id, signal: 'like' as const })),
          ...dislikedRaw.map((e) => ({ tmdb_id: e.id, signal: 'dislike' as const })),
        ],
        household_rejections: kindRejections.map((r) => r.id),
      }, caller)
      recItems.push(...resp.items)
      modelVersion = resp.model_version
      recipe = resp.recipe
      recDiag = resp.diag
      recSucceeded = true
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      console.warn('[suggestions] recommender call failed, falling back to trending:', detail)
      // The fallback keeps the request working, but a recommender that is down
      // silently degrades EVERY user to trending — surface it (warning level so
      // Glitchtip groups occurrences) instead of hiding it in stdout.
      void reportServerEvent({
        level: 'warning',
        message: 'recommender scoreOnce failed; served trending fallback',
        context: { error: detail },
      })
    }
    endRec()

    const mapped: SuggestionItem[] = recItems.map((it) => ({
      id: it.tmdb_id,
      title: it.title ?? '?',
      posterPath: it.poster_path,
      overview: it.overview ?? undefined,
      year: it.year ?? undefined,
      provenance: it.provenance,
      reason: it.reason,
    }))
    const safe = filterHouseholdSafe(mapped)

    if (safe.length === 0) {
      // Recommender returned nothing usable (down, empty catalog, or all
      // filtered). Degrade to TMDB trending so the strip is never empty.
      if (!_tmdbKey) {
        setTimingHeader()
        return c.json({
          source: 'recommender',
          items: [],
          _diag: diag({
            path: 'recommender_empty_no_tmdb_fallback',
            modelVersion,
            recipe,
            rec: recDiag,
          }),
        })
      }
      const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
        ...it,
        provenance: 'trending' as const,
        reason: null,
      }))
      const shown = trending.slice(0, TARGET_COUNT)
      // Tell the sidecar these fallback items were shown so the next
      // refresh's exclude_recently_shown filter sees them. Without
      // this, a sidecar that's healthy but returns empty/all-filtered
      // for this household replays the same trending cards every poll.
      // Mirrors the partial-fill postShown below; fire-and-forget,
      // bounded by services/recommender.ts timeout. Skip on
      // recSucceeded=false — posting to /events/shown when /score just
      // failed costs a second 3s timeout + log line per refresh
      // during an outage, with zero benefit (the sidecar isn't
      // going to record anything either way).
      if (shown.length > 0 && recSucceeded) {
        void postShown(session.sub, type, shown.map((it) => it.id), caller)
      }
      setTimingHeader()
      return c.json({
        source: 'trending',
        items: tagIptvAvailability(shown),
        _diag: diag({
          path: 'recommender_fallback_trending',
          modelVersion,
          recipe,
          rec: recDiag,
        }),
      })
    }

    // Partial-fill: the recommender can legitimately return fewer than
    // TARGET_COUNT after KNN + recently-shown exclusion + household
    // rejection filtering (a household that's seen most of the
    // catalog, or a tight taste cluster that doesn't have N viable
    // neighbors yet). Pre-fill commit: returning the short list as-is
    // gave users 1-19 item strips even though TMDB trending had clean
    // fallbacks available. Top up with trending, dedupe against the
    // recommender's picks, mark provenance='trending' so the SPA can
    // render the join visibly. Source stays 'recommender' since the
    // primary engine succeeded — only the tail is fill.
    let items = safe.slice(0, TARGET_COUNT)
    let fillCount = 0
    if (items.length < TARGET_COUNT && _tmdbKey) {
      const have = new Set(items.map((it) => it.id))
      const trending = filterHouseholdSafe(await tmdbTrending(type))
        .filter((it) => !have.has(it.id))
        .map((it) => ({
          ...it,
          provenance: 'trending' as const,
          reason: null,
        }))
      const need = TARGET_COUNT - items.length
      const fill = trending.slice(0, need)
      fillCount = fill.length
      items = [...items, ...fill]
      // Tell the sidecar these fill items were shown so the next
      // refresh's exclude_recently_shown filter sees them. Without
      // this, a household with a tight taste cluster (where fill
      // fires every refresh) would see the SAME trending cards
      // every poll until they aged out of TMDB's trending window.
      // Fire-and-forget; bounded by services/recommender.ts timeout.
      if (fill.length > 0) {
        void postShown(session.sub, type, fill.map((it) => it.id), caller)
      }
    }
    const recById = new Map(recItems.map((it) => [it.tmdb_id, it]))
    const renderedRecImpressions = items
      .map((it, rank) => ({ item: recById.get(it.id), rank }))
      .filter((entry): entry is { item: RecommenderScoredItem; rank: number } => entry.item !== undefined)
      .map(({ item, rank }) => ({
        tmdb_id: item.tmdb_id,
        rank,
        score: item.score,
        provenance: item.provenance,
        model_version: modelVersion,
      }))
    if (renderedRecImpressions.length > 0) {
      void postImpressions(session.sub, type, renderedRecImpressions, caller)
    }

    setTimingHeader()
    return c.json({
      source: 'recommender',
      items: tagLocalAvailability(tagIptvAvailability(items), type),
      _diag: diag({
        modelVersion,
        recipe,
        rec: recDiag,
        costCents: 0,
        // Visible in diag so a household seeing a lot of trending fill
        // can tell us "recommender returned N, trending filled M" —
        // helps diagnose taste-cluster saturation vs catalog gaps.
        recommenderReturned: safe.length,
        fillCount,
      }),
    })
  }

  // Legacy (non-recommender) trending short-circuits. Only reachable
  // when USE_LOCAL_RECOMMENDER is OFF — when it's on, the block above
  // returns first and these never fire (intentional: a free local
  // model beats hard-coded trending fallback in every case).
  if (!_tmdbKey) {
    setTimingHeader()
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }

  if (force === 'trending') {
    const endTrending = timing.mark('trending')
    const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
      ...it,
      provenance: 'trending' as const,
      reason: null,
    }))
    endTrending()
    setTimingHeader()
    return c.json({ source: 'trending', items: tagIptvAvailability(trending.slice(0, TARGET_COUNT)), _diag: diag() })
  }

  // Cold start: library too small for meaningful taste signal.
  if (library.length < COLD_START_THRESHOLD) {
    console.warn('[suggestions] Cold-start path: library too small to filter', diag())
    const endTrending = timing.mark('trending')
    const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
      ...it,
      provenance: 'trending' as const,
      reason: null,
    }))
    endTrending()
    setTimingHeader()
    return c.json({
      source: 'trending',
      items: tagIptvAvailability(trending.slice(0, TARGET_COUNT)),
      _diag: diag({
        reason: 'library_below_threshold',
        libraryCount: library.length,
        threshold: COLD_START_THRESHOLD,
        hint: `Add at least ${COLD_START_THRESHOLD - library.length} more title(s) to get personalized recommendations`,
      }),
    })
  }

  // BYO key model — caller must supply their Anthropic key in the
  // request header. 402 is the semantically correct response: "you
  // need to provide credentials/funds yourself before this resource
  // is available." Distinguishes from auth failure (401) and upstream
  // breakage (5xx).
  const userKey = (c.req.header('x-anthropic-api-key') ?? '').trim()
  if (!userKey || !userKey.startsWith('sk-ant-')) {
    return c.json({ error: 'api_key_required', hint: 'set your key in the user menu' }, 402)
  }

  // Already in flight from the prologue — just await the resolution.
  const userFeedback = await userFeedbackPromise
  const likedRaw = type === 'movie' ? userFeedback.movie.liked : userFeedback.tv.liked

  // Start the candidate pool fetch in parallel with the backfill.
  // topGenreIds only needs `library`, which is already resolved.
  // Parallelizing the pool fetch with backfill saves the cold-cache
  // pool latency (1–2 s) when backfill is also doing TMDB calls;
  // on cache-hit the pool resolves in <1ms regardless.
  // Use top-5 genres instead of top-3 (iter 16). More genre coverage
  // gives Claude a richer pool, especially for households with 4-5
  // distinct clusters (e.g. Crime + Drama + Sci-Fi + Thriller + History).
  // Top-3 was fine for a 20-item "Fill" but for the pool we want
  // broader coverage to avoid the pool being dominated by a single genre.
  const topGenreIds = genreNamesToTmdbIds(type, topGenreNames(library, 5))
  const endPool = timing.mark('candidatePool')
  const rawPoolPromise = topGenreIds.length > 0 ? fetchCandidatePool(type, topGenreIds) : Promise.resolve([] as SuggestionItem[])

  // Backfill missing titles on legacy entries so the Claude prompt
  // carries the *entire* rejection + likes context, not a silently
  // trimmed subset. Resolved titles are persisted so this cost is
  // one-time per entry. Backfill failures fall through to
  // `[TMDB id N]` bullets — Claude still sees the id is gated.
  const [kindRejectionsTitled, liked, rawPool] = await Promise.all([
    backfillRejectionTitles(type, kindRejections),
    backfillLikedTitles(session.sub, type, likedRaw),
    rawPoolPromise,
  ])
  endPool()

  const client = new Anthropic({ apiKey: userKey })
  const libraryBlock = buildLibraryBlock(type, library, kindRejectionsTitled)
  const priorityTasteBlock = buildPriorityTasteBlock(library)
  const userLikesBlock = buildUserLikesBlock(liked)

  // Filter pool BEFORE building the recently-shown block so we know
  // the pool size to cap the recently-shown list proportionally.
  // Pool items pass through filterHouseholdSafe to drop library entries
  // and rejects. Shuffle the pool before presenting it to Claude so
  // each refresh sees a different ordering of the numbered list — this
  // is the per-refresh pool variety knob. The TMDB /discover cache still
  // serves the same 60 items per TTL window, but Claude's pick
  // distribution changes across refreshes because it sees a freshly
  // shuffled numbered list. The poolByTitle map is order-independent so
  // the fast-path lookup works regardless of shuffle order.
  const safePool = shuffleInPlace(filterHouseholdSafe(rawPool))

  // Cap recently-shown proportionally to pool size. With a 60-item pool
  // and a 150-item recently-shown list, Claude would have almost no fresh
  // candidates. Cap at 80% of pool size (min 30) so at least 20% of the
  // pool is "uncontested" fresh territory every refresh. When the pool
  // is empty, fall back to the full recently-shown buffer.
  const recentlyShownCap = safePool.length > 0
    ? Math.max(Math.floor(safePool.length * 0.8), 30)
    : RECENTLY_SHOWN_CAP
  const recentlyShownAll = getRecentlyShown(session.sub, type)
  const recentlyShownTrimmed = recentlyShownAll.slice(0, recentlyShownCap)
  const recentlyShownBlock = buildRecentlyShownBlock(recentlyShownTrimmed)
  const poolByTitle = new Map<string, SuggestionItem[]>()
  for (const it of safePool) {
    const key = normalizeTitle(it.title)
    const existing = poolByTitle.get(key)
    if (existing) existing.push(it)
    else poolByTitle.set(key, [it])
  }
  const candidatePoolBlock = buildCandidatePoolBlock(safePool)
  const isAcceptedPoolHit = (item: SuggestionItem): boolean =>
    (poolByTitle.get(normalizeTitle(item.title)) ?? []).some((poolItem) => poolItem.id === item.id)
  const countAcceptedPoolHits = (items: SuggestionItem[]): number =>
    items.reduce((count, item) => count + (isAcceptedPoolHit(item) ? 1 : 0), 0)

  // Tool-use enforced pipeline:
  //   1. Pre-fetch a candidate pool from TMDB /discover (genre-seeded,
  //      quality-sorted). Claude ranks from this pool instead of
  //      generating from its popularity prior.
  //   2. Claude is forced to call submit_recommendations with N picks
  //   3. We validate each pick — pool hits skip the TMDB lookup (id
  //      already known), non-pool picks fall back to /search lookup
  //   4. If we don't have TARGET_COUNT survivors, re-prompt Claude
  //      with a tool_result describing exactly which picks were
  //      rejected and why — single retry, bounded cost
  //   5. If still short, fill from pool remainder → trending
  //
  // The id-set post-filter remains as defense-in-depth but is no
  // longer load-bearing; Claude is told exactly what failed and
  // self-corrects on the retry pass. Pool picks skip /search lookup
  // entirely — the TMDB id is already resolved, so the validation
  // path is a cheap in-memory check instead of a network round-trip.

  const validate = async (
    picks: ClaudePick[],
  ): Promise<{
    accepted: SuggestionItem[]
    rejectedForRetry: Array<{ title: string; reason: string }>
    counters: { lookupNulls: number; droppedAsDedupe: number; droppedAsRejected: number; droppedAsLibrary: number; droppedAsYearMismatch: number; poolHits: number }
  }> => {
    const accepted: SuggestionItem[] = []
    const rejectedForRetry: Array<{ title: string; reason: string }> = []
    const counters = { lookupNulls: 0, droppedAsDedupe: 0, droppedAsRejected: 0, droppedAsLibrary: 0, droppedAsYearMismatch: 0, poolHits: 0 }

    // Pre-validate by title BEFORE the TMDB lookup. If Claude's pick
    // title already matches a library or rejection title, we don't
    // need to burn a TMDB lookup just to reject it. This is the
    // single biggest TMDB load reduction — the call-2 rate-limit
    // failure mode that caused only 1–4 items to render.
    //
    // Also check the pool: if the pick title exactly matches a pool
    // item, we already have the TMDB id and metadata — skip the lookup.
    const survivors: Array<{ pick: ClaudePick; poolItem: SuggestionItem | null }> = []
    const seen = new Set<number>()
    for (const p of picks) {
      if (!p.title) continue
      if (titleMatches(p.title, rejectedTitles)) {
        counters.droppedAsRejected++
        rejectedForRetry.push({ title: p.title, reason: 'on the household NEVER SUGGEST list (matched by title)' })
        continue
      }
      if (titleMatches(p.title, libraryTitles)) {
        counters.droppedAsLibrary++
        rejectedForRetry.push({ title: p.title, reason: 'already in the household library (matched by title)' })
        continue
      }
      // Pool fast-path: if the pick title unambiguously matches a pool
      // item, accept it immediately without a TMDB /search round-trip.
      const poolMatches = poolByTitle.get(normalizeTitle(p.title)) ?? []
      const poolItem = p.year
        ? poolMatches.find((it) => it.year === p.year) ?? null
        : poolMatches.length === 1 ? poolMatches[0] : null
      if (poolItem) {
        if (seen.has(poolItem.id)) {
          counters.droppedAsDedupe++
          rejectedForRetry.push({ title: p.title, reason: 'duplicate of an earlier pick in this batch' })
          continue
        }
        counters.poolHits++
        seen.add(poolItem.id)
        const reason = typeof p.reason === 'string' && p.reason.trim().length > 0
          ? p.reason.trim().slice(0, 120)
          : null
        accepted.push({ ...poolItem, provenance: 'personalized', reason })
        if (accepted.length >= TARGET_COUNT) break
        continue
      }
      survivors.push({ pick: p, poolItem: null })
    }

    // Non-pool picks fall back to TMDB /search lookup.
    if (accepted.length < TARGET_COUNT) {
      const lookups = await mapLimit(survivors, TMDB_LOOKUP_CONCURRENCY, ({ pick }) =>
        tmdbLookup(type, pick.title, pick.year).catch(() => null),
      )
      for (let i = 0; i < lookups.length; i++) {
        if (accepted.length >= TARGET_COUNT) break
        const r = lookups[i]
        const pick = survivors[i].pick
        const original = pick.title
        if (!r) {
          counters.lookupNulls++
          rejectedForRetry.push({ title: original, reason: 'TMDB lookup failed — title may be misspelled' })
          continue
        }
        // Year-proximity guard, movies only. TV has too many legitimate
        // year-mismatch cases (Claude giving the latest-season year vs
        // TMDB's series-premiere year; long-running shows; reboots that
        // share a name with originals) — the post-lookup library and
        // rejection re-checks already defend against genuinely-wrong
        // matches, and the in-lookup year-then-no-year retry handles
        // the disambiguation. For movies the guard still catches
        // remake confusion ("Heat" 1995 vs 1986).
        if (type === 'movie' && pick.year && r.year && Math.abs(r.year - pick.year) > 5) {
          counters.droppedAsYearMismatch++
          rejectedForRetry.push({
            title: original,
            reason: `TMDB top match was "${r.title}" (${r.year}), but you asked for ${pick.year} — likely a different work; pick a closer title or use the exact year`,
          })
          continue
        }
        if (seen.has(r.id)) {
          counters.droppedAsDedupe++
          rejectedForRetry.push({ title: original, reason: 'duplicate of an earlier pick in this batch' })
          continue
        }
        if (rejected.has(r.id) || titleMatches(r.title, rejectedTitles)) {
          counters.droppedAsRejected++
          rejectedForRetry.push({ title: original, reason: 'on the household NEVER SUGGEST list' })
          continue
        }
        if (libraryTmdbIds.has(r.id) || titleMatches(r.title, libraryTitles)) {
          counters.droppedAsLibrary++
          rejectedForRetry.push({ title: original, reason: 'already in the household library' })
          console.warn('[suggestions] library duplicate dropped:', {
            kind: type,
            pickId: r.id,
            pickTitle: r.title,
            normalized: { full: normalizeTitle(r.title), base: normalizeTitleBase(r.title) },
            matchedById: libraryTmdbIds.has(r.id),
            matchedByTitle: titleMatches(r.title, libraryTitles),
          })
          continue
        }
        seen.add(r.id)
        // Tag personalized provenance + carry Claude's reason through
        // validation. Trim to 120 chars defensively so a chatty model
        // can't blow up the response payload; the schema asks for ≤90.
        const reason = typeof pick.reason === 'string' && pick.reason.trim().length > 0
          ? pick.reason.trim().slice(0, 120)
          : null
        accepted.push({ ...r, provenance: 'personalized', reason })
      }
    }
    return { accepted, rejectedForRetry, counters }
  }

  let totalUsage: UsageBlock = {}
  let r1: ClaudeResponse
  let claudeTruncated: boolean
  let claudeCallCount = 0
  let usageLogFailed = false
  const recordUsageEvent = async (event: Parameters<typeof appendUsageEvent>[0]): Promise<void> => {
    try {
      await appendUsageEvent(event)
    } catch (err) {
      usageLogFailed = true
      console.error('[suggestions] usage log append failed:', err)
    }
  }
  // One salt per request — shared by initial + retry. Refresh variety
  // hangs on this: the cached library prefix makes deterministic Claude
  // calls otherwise. Salt rides outside the cache (in the user msg).
  const salt = refreshSalt()
  // Genre hint: top-2 genres from the library with percentages, repeated
  // in the volatile user message for high-attention positioning (iter 55).
  // Complements the TARGET GENRE MIX line in the cached library block.
  // Empty when the library has no genre data (uncommon; Sonarr/Radarr always
  // populate genres for well-catalogued libraries).
  const genreHint = libraryGenres.length > 0
    ? libraryGenres.slice(0, 2).join(' and ')
    : undefined
  const endClaudeInitial = timing.mark('claudeInitial')
  try {
    r1 = await callClaudeInitial(client, type, libraryBlock, priorityTasteBlock, userLikesBlock, recentlyShownBlock, candidatePoolBlock, salt, genreHint)
    claudeCallCount++
    totalUsage = mergeUsage(totalUsage, r1.usage)
    claudeTruncated = r1.truncated ?? false
  } catch (e) {
    endClaudeInitial()
    const errorMsg = e instanceof Error ? e.message : String(e)
    // Pull the API status off Anthropic SDK errors so the SPA can
    // distinguish 401 (bad key) from 429 (rate limit) from 5xx (their
    // outage) from 4xx (our prompt). The SDK exposes .status on
    // APIError subclasses.
    const errorStatus =
      typeof (e as { status?: unknown }).status === 'number'
        ? ((e as { status: number }).status)
        : undefined
    console.error('[suggestions] Claude call failed:', errorMsg, errorStatus ?? '')
    await recordUsageEvent({
      sub: session.sub,
      username: session.username,
      type: 'claude_error',
      model: MODEL,
      kind: type,
      error: errorMsg,
    })
    const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
      ...it,
      provenance: 'trending' as const,
      reason: null,
    }))
    setTimingHeader()
    return c.json({
      source: 'trending_fallback',
      items: tagIptvAvailability(trending.slice(0, TARGET_COUNT)),
      _diag: diag({ reason: 'claude_threw', claudeError: errorMsg, claudeStatus: errorStatus, ...(usageLogFailed ? { usageLogFailed: true } : {}) }),
    })
  }
  endClaudeInitial()

  const endValidate1 = timing.mark('validate1')
  const v1 = await validate(r1.picks)
  endValidate1()
  const accepted = v1.accepted
  let lastCounters = v1.counters
  let triedRetry = false

  // Retry once when there's actionable feedback for Claude:
  //   - rejectedForRetry > 0 → tell Claude which picks were dropped
  //     and why, so it can produce different picks
  //   - picks.length === 0 → Claude returned an empty array (likely
  //     hit max_tokens truncation or saw the constraints as
  //     unsatisfiable). Re-prompt; the explicit count contract in the
  //     user message should land harder on the second pass.
  // Skip retry when picks resolved cleanly but happened to fall short
  // — re-asking the same prompt without rejection feedback would just
  // produce the same list.
  if (
    r1.toolUse &&
    accepted.length < TARGET_COUNT &&
    (v1.rejectedForRetry.length > 0 || r1.picks.length === 0)
  ) {
    triedRetry = true
    const nNeeded = Math.min(CLAUDE_OVERFETCH, TARGET_COUNT - accepted.length + 4)
    const endClaudeRetry = timing.mark('claudeRetry')
    try {
      const r2 = await callClaudeRetry(
        client,
        type,
        libraryBlock,
        priorityTasteBlock,
        userLikesBlock,
        recentlyShownBlock,
        candidatePoolBlock,
        r1.toolUse,
        v1.rejectedForRetry,
        nNeeded,
        salt,
        genreHint,
      )
      claudeCallCount++
      totalUsage = mergeUsage(totalUsage, r2.usage)
      endClaudeRetry()
      const endValidate2 = timing.mark('validate2')
      const v2 = await validate(r2.picks)
      endValidate2()
      // Accumulate drop counts across both validation passes so the
      // reported droppedPicks reflects the TOTAL cost of dropped picks
      // (both initial and retry), not just the retry pass's drops.
      // Before iter 59, lastCounters was replaced (not merged), meaning
      // a request that dropped 10 picks in call 1 + 8 in call 2 showed
      // only 8 in _diag — understating the waste. Merged now so the
      // >10 droppedPicks UI warning fires correctly for multi-pass waste.
      const c1 = lastCounters
      const c2 = v2.counters
      lastCounters = {
        lookupNulls: (c1.lookupNulls ?? 0) + (c2.lookupNulls ?? 0),
        droppedAsDedupe: (c1.droppedAsDedupe ?? 0) + (c2.droppedAsDedupe ?? 0),
        droppedAsRejected: (c1.droppedAsRejected ?? 0) + (c2.droppedAsRejected ?? 0),
        droppedAsLibrary: (c1.droppedAsLibrary ?? 0) + (c2.droppedAsLibrary ?? 0),
        droppedAsYearMismatch: (c1.droppedAsYearMismatch ?? 0) + (c2.droppedAsYearMismatch ?? 0),
        // Sum pool hits across both passes — pool hits in the initial
        // pass still count toward "this refresh used the pre-vetted
        // pool." Previously we replaced with retry-only, which under-
        // reported poolHits/poolHitRate in _diag whenever the retry
        // contributed fewer pool-matched picks than the initial pass.
        poolHits: (c1.poolHits ?? 0) + (c2.poolHits ?? 0),
      }
      const acceptedIds = new Set(accepted.map((a) => a.id))
      for (const item of v2.accepted) {
        if (!acceptedIds.has(item.id)) {
          accepted.push(item)
          acceptedIds.add(item.id)
          if (accepted.length >= TARGET_COUNT) break
        }
      }
    } catch (e) {
      console.error('[suggestions] Claude retry failed:', e)
      // Fall through with whatever we accepted from r1.
    }
  }

  const refreshCostCents = computeCostCents(totalUsage)
  // Prompt cache hit rate: cacheRead / (input + cacheRead + cacheCreation).
  // 1.0 = library block always came from cache (best case — 10x cheaper);
  // 0.0 = no cache hits (first call of the day or library changed).
  // Surfaced in _diag so the household can see whether prompt caching is
  // working. A persistently 0.0 rate suggests the library fingerprint is
  // thrashing (library changing too frequently or TTL too short).
  const totalInputTokens =
    (totalUsage.inputTokens ?? 0) +
    (totalUsage.cacheReadInputTokens ?? 0) +
    (totalUsage.cacheCreationInputTokens ?? 0)
  const cacheHitRate = totalInputTokens > 0
    ? Math.round(((totalUsage.cacheReadInputTokens ?? 0) / totalInputTokens) * 100) / 100
    : 0
  await recordUsageEvent({
    sub: session.sub,
    username: session.username,
    type: 'claude_call',
    model: MODEL,
    kind: type,
    callCount: claudeCallCount,
    ...totalUsage,
    costCents: refreshCostCents,
  })

  // Still short of target after the retry — fill so the user always
  // sees a full strip. Prefer library-aware discover (TMDB popularity
  // sorted by the household's top genres) over generic trending; fall
  // back to trending when no genres map. Source labels stay stable so
  // the SPA's typed switch keeps working — fillSource diagnostic
  // surfaces which path actually fired.
  if (accepted.length < TARGET_COUNT) {
    const endFill = timing.mark('fill')
    const fillIds = new Set(accepted.map((a) => a.id))
    // topGenreIds already computed above for the candidate pool —
    // reuse it so the fill path shares the same cached discover call.
    let fillSource: 'discover' | 'trending' | 'discover+trending' = 'trending'
    let fill: SuggestionItem[] = []
    if (topGenreIds.length > 0) {
      const discover = filterHouseholdSafe(await tmdbDiscoverByGenres(type, topGenreIds))
        .filter((t) => !fillIds.has(t.id))
        .map((it) => ({ ...it, provenance: 'discover' as const, reason: null }))
      if (discover.length > 0) {
        fill = discover
        fillSource = 'discover'
      }
    }
    // If discover didn't return enough, top up with trending so the
    // strip still fills.
    if (accepted.length + fill.length < TARGET_COUNT) {
      const fillIdsAfter = new Set([...fillIds, ...fill.map((f) => f.id)])
      const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
      ...it,
      provenance: 'trending' as const,
      reason: null,
    })).filter(
        (t) => !fillIdsAfter.has(t.id),
      )
      fill = [...fill, ...trending]
      fillSource = fillSource === 'discover' ? 'discover+trending' : 'trending'
    }
    const filled = [...accepted, ...fill].slice(0, TARGET_COUNT)
    endFill()
    console.warn('[suggestions] Personalized picks short of target — filling', {
      kind: type,
      sub: session.sub,
      libraryCount: library.length,
      rejectionCount: kindRejectionsTitled.length,
      titledRejections: kindRejectionsTitled.filter((r) => r.title).length,
      accepted: accepted.length,
      retryAttempted: triedRetry,
      fillSource,
      lastCounters,
    })
    recordShown(session.sub, type, filled)
    setTimingHeader()
    // Compute total dropped picks across all validation passes for cost transparency.
    const droppedTotal =
      (lastCounters.droppedAsLibrary ?? 0) +
      (lastCounters.droppedAsRejected ?? 0) +
      (lastCounters.lookupNulls ?? 0) +
      (lastCounters.droppedAsYearMismatch ?? 0) +
      (lastCounters.droppedAsDedupe ?? 0)
    const filledPoolHits = countAcceptedPoolHits(accepted)
    const filledCounters = { ...lastCounters, poolHits: filledPoolHits }
    const filledPoolHitRate = accepted.length > 0
      ? Math.round((filledPoolHits / accepted.length) * 100) / 100
      : 0
    // recentlyShownCount: how many titles are in the active recently-shown
    // buffer for this request (after cap). Helps the household observe
    // whether the pool-cap is firing (recentlyShownCount < recentlyShownAll
    // means the cap kicked in). Surfaced in _diag for observability.
    const recentlyShownCount = recentlyShownTrimmed.length
    if (accepted.length === 0) {
      return c.json({
        source: 'personalized_empty_trending_fallback',
        items: tagIptvAvailability(filled),
        _diag: diag({ accepted: 0, retryAttempted: triedRetry, fillSource, lastCounters: filledCounters, poolSize: safePool.length, poolHitRate: 0, droppedPicks: droppedTotal, costCents: refreshCostCents, cacheHitRate, callCount: claudeCallCount, recentlyShownCount, ...(claudeTruncated ? { claudeTruncated: true } : {}), ...(usageLogFailed ? { usageLogFailed: true } : {}) }),
      })
    }
    return c.json({
      source: 'personalized_filled',
      items: tagIptvAvailability(filled),
      _diag: diag({ accepted: accepted.length, retryAttempted: triedRetry, fillSource, lastCounters: filledCounters, poolSize: safePool.length, poolHits: filledPoolHits, poolHitRate: filledPoolHitRate, droppedPicks: droppedTotal, costCents: refreshCostCents, cacheHitRate, callCount: claudeCallCount, recentlyShownCount, ...(claudeTruncated ? { claudeTruncated: true } : {}), ...(usageLogFailed ? { usageLogFailed: true } : {}) }),
    })
  }

  const droppedTotal =
    (lastCounters.droppedAsLibrary ?? 0) +
    (lastCounters.droppedAsRejected ?? 0) +
    (lastCounters.lookupNulls ?? 0) +
    (lastCounters.droppedAsYearMismatch ?? 0) +
    (lastCounters.droppedAsDedupe ?? 0)
  const finalAccepted = accepted.slice(0, TARGET_COUNT)
  // Pool hit rate: fraction of accepted personalized picks that came from
  // the pool (vs needing a full TMDB /search round-trip). 1.0 = ideal
  // (every pick pre-vetted), 0.0 = pool didn't help. Observable in devtools.
  // Use lastCounters (accumulated across initial + retry, per iter 59)
  // not v1.counters — previously we under-reported on the retry path.
  const poolHitsTotal = countAcceptedPoolHits(finalAccepted)
  const finalCounters = { ...lastCounters, poolHits: poolHitsTotal }
  const poolHitRate = finalAccepted.length > 0
    ? Math.round((poolHitsTotal / finalAccepted.length) * 100) / 100
    : 0
  recordShown(session.sub, type, finalAccepted)
  setTimingHeader()
  return c.json({
    source: 'personalized',
    items: tagIptvAvailability(finalAccepted),
    _diag: diag({ accepted: accepted.length, retryAttempted: triedRetry, poolSize: safePool.length, poolHits: poolHitsTotal, poolHitRate, lastCounters: finalCounters, droppedPicks: droppedTotal, costCents: refreshCostCents, cacheHitRate, callCount: claudeCallCount, recentlyShownCount: recentlyShownTrimmed.length, ...(claudeTruncated ? { claudeTruncated: true } : {}), ...(usageLogFailed ? { usageLogFailed: true } : {}) }),
  })
})
