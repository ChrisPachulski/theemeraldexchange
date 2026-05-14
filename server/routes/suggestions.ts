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
// per-request user message is short and varies; temperature 0.4
// keeps picks near the "obvious adjacent" zone.

import { Hono } from 'hono'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, type Env } from '../middleware/auth.js'
import { sonarrFetch } from '../services/sonarr.js'
import { radarrFetch } from '../services/radarr.js'
import { getRejections } from '../services/rejections.js'
import { getUserFeedback } from '../services/userFeedback.js'
import { appendUsageEvent, computeCostCents } from '../services/usageLog.js'
import { env } from '../env.js'

const MODEL = 'claude-haiku-4-5'

export const suggestions = new Hono<Env>()

suggestions.use('*', requireAuth)

const TMDB_BASE = 'https://api.themoviedb.org/3'
const COLD_START_THRESHOLD = 3
const TARGET_COUNT = 20
// Overfetch is the wall-clock killer: output tokens dominate Haiku
// latency, and each pick costs ~15-30 tokens (title + year). 22 leaves
// a 10% buffer against the rare run where post-filter eats a few.
const CLAUDE_OVERFETCH = 22

type SuggestionItem = {
  id: number
  title: string
  posterPath: string | null
  overview?: string
  year?: number
}

type ClaudePick = {
  title: string
  year?: number
}

type SonarrSeries = { title: string; year?: number; tmdbId?: number; genres?: string[] }
type RadarrMovie = { title: string; year?: number; tmdbId?: number; genres?: string[] }

async function fetchSonarrLibrary(): Promise<SonarrSeries[]> {
  const r = await sonarrFetch('/api/v3/series', { method: 'GET' })
  if (!r.ok) return []
  return (await r.json()) as SonarrSeries[]
}

async function fetchRadarrLibrary(): Promise<RadarrMovie[]> {
  const r = await radarrFetch('/api/v3/movie', { method: 'GET' })
  if (!r.ok) return []
  return (await r.json()) as RadarrMovie[]
}

// Library line is "Title (Year)" — we used to attach Sonarr/Radarr
// genres but Claude already knows what genre "Sons of Anarchy" is,
// and the extra ~40 tokens × 150 titles ballooned the cached prefix
// for no taste-matching gain (verified: removing genres did not
// degrade pick quality on the 157-show test library).
function formatLibraryItem(it: { title: string; year?: number }): string {
  const yr = it.year ? ` (${it.year})` : ''
  return `${it.title}${yr}`
}

// Stable system prompt — never changes per request, ideal cache prefix.
const SYSTEM_PROMPT = `You are a media taste-matching agent for a household media server. Given the household's library and an explicit "never suggest" list, return ranked recommendations that match their existing taste — same era, tone, genre clusters, directorial sensibilities, and adjacent recommendations from beloved titles.

Rules:
- Recommend titles NOT in the household's library and NOT on the rejection list.
- Mirror the genre distribution of the library you can infer from the titles. If most of the library is live-action drama, most of your recommendations should be live-action drama. Do NOT over-index on any single genre cluster (e.g. don't return all-Animation or all-Anime just because those titles are present; they're a slice, not the whole picture).
- Prefer well-regarded, mainstream-adjacent titles. Critical reception and audience love are signals; obscurity for its own sake is not.
- Modest variety across calls is fine, but recommendations should land in the "obvious yes" zone for someone who already loves what's in the library.
- Real, released titles only. No imaginary or future-dated releases.
- Be exact with titles and years so they can be looked up in TMDB.

Output is consumed by code — return JSON only with fields {title, year}. Do NOT include a reason field or any commentary. Brevity in output is critical for latency.`

function buildLibraryBlock(
  kind: 'movie' | 'tv',
  library: Array<{ title: string; year?: number; genres?: string[] }>,
  rejections: Array<{ id: number; title: string }>,
): string {
  // Library + household rejections share a cache key — both are
  // household-shared and stable across users. Rejection entries
  // without a title (legacy bare-id rows on disk) are still in the
  // post-filter set but omitted from the bullets here — they upgrade
  // the next time a member re-clicks the dot.
  const header = kind === 'movie' ? 'MOVIES' : 'TV SHOWS'
  const libLines = library.map(formatLibraryItem).join('\n')
  const titledRejects = rejections.filter((r) => r.title.length > 0)
  if (titledRejects.length === 0) {
    return `Household ${header} library (${library.length} titles):\n${libLines}`
  }
  const rejectLines = titledRejects.map((r) => `- ${r.title}`).join('\n')
  return (
    `Household ${header} library (${library.length} titles):\n${libLines}\n\n` +
    `NEVER SUGGEST — the household has explicitly rejected these, ` +
    `and you should also avoid stylistically near matches:\n${rejectLines}`
  )
}

// Per-user "liked" block. Sent after the cached prefix so it can vary
// per caller without invalidating the household library cache.
// Entries without a title (legacy bare-id rows) are omitted — they
// upgrade on the next dot click.
function buildUserLikesBlock(liked: Array<{ id: number; title: string }>): string {
  const titled = liked.filter((e) => e.title.length > 0)
  if (titled.length === 0) return ''
  const lines = titled.map((e) => `- ${e.title}`).join('\n')
  return (
    `This user has explicitly LIKED — recommend more in this vein ` +
    `(positive taste signal):\n${lines}`
  )
}

async function tmdbLookup(
  kind: 'movie' | 'tv',
  title: string,
  year: number | undefined,
): Promise<SuggestionItem | null> {
  if (!env.tmdbApiKey) return null
  const url = new URL(`${TMDB_BASE}/search/${kind}`)
  url.searchParams.set('api_key', env.tmdbApiKey)
  url.searchParams.set('query', title)
  if (year) {
    url.searchParams.set(kind === 'movie' ? 'primary_release_year' : 'first_air_date_year', String(year))
  }
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) return null
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
  const top = data.results?.[0]
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
}

// TMDB returns 20 items per page on /trending/{type}/week. We paginate
// up to TRENDING_MAX_PAGES so that once a household has rejected the
// obvious choices, deeper-tail trending titles still surface instead
// of the strip going empty. The route still filters + slices to
// TARGET_COUNT at the end; this just gives the filter more raw fuel
// to work with. ~100 items is enough headroom in practice — TMDB's
// trending tail thins out quickly past page 5 anyway.
const TRENDING_MAX_PAGES = 5

async function tmdbTrending(kind: 'movie' | 'tv'): Promise<SuggestionItem[]> {
  if (!env.tmdbApiKey) return []
  type TmdbRow = {
    id: number
    title?: string
    name?: string
    poster_path: string | null
    overview?: string
    release_date?: string
    first_air_date?: string
  }
  const all: TmdbRow[] = []
  for (let page = 1; page <= TRENDING_MAX_PAGES; page++) {
    const url = new URL(`${TMDB_BASE}/trending/${kind}/week`)
    url.searchParams.set('api_key', env.tmdbApiKey)
    url.searchParams.set('page', String(page))
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) break
    const data = (await r.json()) as { results?: TmdbRow[] }
    const rows = data.results ?? []
    all.push(...rows)
    if (rows.length < 20) break // TMDB returned a short page, no more to fetch
  }
  return all.map((r) => {
    const date = r.release_date || r.first_air_date || ''
    const y = date ? Number(date.slice(0, 4)) : undefined
    return {
      id: r.id,
      title: r.title || r.name || '',
      posterPath: r.poster_path,
      overview: r.overview,
      year: Number.isFinite(y) ? y : undefined,
    }
  })
}

const PICK_SCHEMA = {
  type: 'object' as const,
  properties: {
    picks: {
      type: 'array' as const,
      description: 'Ordered list of recommendations, most-likely-loved first.',
      items: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' as const },
          year: { type: 'integer' as const },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
}

type ClaudeCallResult = {
  picks: ClaudePick[]
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
  }
}

async function callClaude(
  client: Anthropic,
  kind: 'movie' | 'tv',
  libraryBlock: string,
  userLikesBlock: string,
): Promise<ClaudeCallResult> {
  const response = await client.messages.create({
    model: MODEL,
    // 22 picks × ~30 tokens (title+year+JSON syntax) ≈ 700 tokens.
    // 1024 leaves headroom for unusually long titles without letting
    // Claude wander into reasoning text. Output tokens dominate Haiku
    // latency, so this cap is a direct wall-clock win.
    max_tokens: 1024,
    // 0.4 keeps Claude near the high-probability "obvious adjacent
    // picks" the system prompt asks for. Earlier 0.8 combined with
    // long-tail framing pushed the model into obscure-genre territory
    // (heavily anime against a 75-Animation-tagged but otherwise
    // wide-ranging library — see PR #63).
    temperature: 0.4,
    system: [
      // System prompt — frozen, always cacheable.
      { type: 'text', text: SYSTEM_PROMPT },
      // Library + household rejections — same for all household
      // members, cached once per ~5min TTL window.
      {
        type: 'text',
        text: libraryBlock,
        cache_control: { type: 'ephemeral' },
      },
      // Per-user likes — small, varies per caller, sits AFTER the
      // cached prefix so it doesn't invalidate the library cache.
      ...(userLikesBlock ? [{ type: 'text' as const, text: userLikesBlock }] : []),
    ],
    messages: [
      {
        role: 'user',
        content: `Recommend ${CLAUDE_OVERFETCH} ${kind === 'movie' ? 'movies' : 'TV shows'} for this household. Mirror the library's genre distribution — return a proportional mix across drama, comedy, action, animation, documentary, etc., based on what they actually have. Weight toward the user's explicitly LIKED titles when present, and strictly avoid the household's NEVER SUGGEST list (and stylistically near matches). Don't over-fit to a single tag.`,
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: PICK_SCHEMA },
    },
  })

  const usage = {
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? undefined,
  }

  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') return { picks: [], usage }
  try {
    const parsed = JSON.parse(block.text) as { picks?: ClaudePick[] }
    return { picks: Array.isArray(parsed.picks) ? parsed.picks : [], usage }
  } catch {
    return { picks: [], usage }
  }
}

suggestions.get('/:type', async (c) => {
  const type = c.req.param('type')
  if (type !== 'movie' && type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }

  // ?force=trending — client opts out of the Claude call to avoid
  // burning tokens (e.g., the household-level AI toggle is off).
  // Same downstream shape as the cold-start path so the SPA renders
  // identically.
  const force = c.req.query('force')

  // Library + rejections in parallel.
  const [library, rejections] = await Promise.all([
    type === 'movie' ? fetchRadarrLibrary() : fetchSonarrLibrary(),
    getRejections(),
  ])

  const kindRejections = type === 'movie' ? rejections.movie : rejections.tv
  const rejected = new Set(kindRejections.map((r) => r.id))
  const libraryTmdbIds = new Set(
    library.map((l) => l.tmdbId).filter((id): id is number => typeof id === 'number'),
  )

  if (force === 'trending') {
    const trending = (await tmdbTrending(type)).filter(
      (i) => !rejected.has(i.id) && !libraryTmdbIds.has(i.id),
    )
    return c.json({ source: 'trending', items: trending.slice(0, TARGET_COUNT) })
  }

  // Cold start: library too small for meaningful taste signal.
  if (library.length < COLD_START_THRESHOLD) {
    const trending = (await tmdbTrending(type)).filter(
      (i) => !rejected.has(i.id) && !libraryTmdbIds.has(i.id),
    )
    return c.json({ source: 'trending', items: trending.slice(0, TARGET_COUNT) })
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

  const session = c.get('session')
  const userFeedback = await getUserFeedback(session.sub)
  const liked = type === 'movie' ? userFeedback.movie.liked : userFeedback.tv.liked

  const client = new Anthropic({ apiKey: userKey })
  const libraryBlock = buildLibraryBlock(type, library, kindRejections)
  const userLikesBlock = buildUserLikesBlock(liked)

  let result: ClaudeCallResult
  try {
    result = await callClaude(client, type, libraryBlock, userLikesBlock)
    // Successful call (whether or not the model returned picks) —
    // record token spend against the caller.
    await appendUsageEvent({
      sub: session.sub,
      username: session.username,
      type: 'claude_call',
      model: MODEL,
      kind: type,
      ...result.usage,
      costCents: computeCostCents(result.usage),
    })
  } catch (e) {
    console.error('[suggestions] Claude call failed:', e)
    await appendUsageEvent({
      sub: session.sub,
      username: session.username,
      type: 'claude_error',
      model: MODEL,
      kind: type,
      error: e instanceof Error ? e.message : String(e),
    })
    const trending = (await tmdbTrending(type)).filter(
      (i) => !rejected.has(i.id) && !libraryTmdbIds.has(i.id),
    )
    return c.json({ source: 'trending_fallback', items: trending.slice(0, TARGET_COUNT) })
  }
  const picks = result.picks

  // Look each pick up in TMDB. Run in parallel, dedupe by id, filter
  // anything already-library or already-rejected.
  const lookups = await Promise.all(
    picks.map((p) => tmdbLookup(type, p.title, p.year).catch(() => null)),
  )
  const seen = new Set<number>()
  const items: SuggestionItem[] = []
  for (const r of lookups) {
    if (!r) continue
    if (seen.has(r.id)) continue
    if (rejected.has(r.id)) continue
    if (libraryTmdbIds.has(r.id)) continue
    seen.add(r.id)
    items.push(r)
    if (items.length >= TARGET_COUNT) break
  }

  return c.json({ source: 'personalized', items })
})
