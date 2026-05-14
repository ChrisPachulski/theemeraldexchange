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
const CLAUDE_OVERFETCH = 30 // ask for 30 so we can drop a few during filtering

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
  reason?: string
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

// Compact library line: "Title (Year) — genre1, genre2". Genres give
// Claude enough signal to taste-match without ballooning tokens.
function formatLibraryItem(it: { title: string; year?: number; genres?: string[] }): string {
  const yr = it.year ? ` (${it.year})` : ''
  const g = it.genres && it.genres.length > 0 ? ` — ${it.genres.slice(0, 3).join(', ')}` : ''
  return `${it.title}${yr}${g}`
}

// Stable system prompt — never changes per request, ideal cache prefix.
const SYSTEM_PROMPT = `You are a media taste-matching agent for a household media server. Given the household's library and an explicit "never suggest" list, return ranked recommendations that match their existing taste — same era, tone, genre clusters, directorial sensibilities, and adjacent recommendations from beloved titles.

Rules:
- Recommend titles NOT in the household's library and NOT on the rejection list.
- Mirror the genre distribution of the library. If 60% of the library is live-action drama, ~60% of your recommendations should be live-action drama. Do NOT over-index on any single genre cluster (e.g. don't return all-Animation or all-Anime just because those tags are present; they're a slice, not the whole picture).
- Each recommendation should have a clear analog in the library — name the closest matches in your reasoning, even if you don't return the reason field.
- Prefer well-regarded, mainstream-adjacent titles. Critical reception and audience love are signals; obscurity for its own sake is not.
- Modest variety across calls is fine, but recommendations should land in the "obvious yes" zone for someone who already loves what's in the library.
- Real, released titles only. No imaginary or future-dated releases.
- Be exact with titles and years so they can be looked up in TMDB.

Output is consumed by code — return JSON only, no commentary.`

function buildLibraryBlock(
  kind: 'movie' | 'tv',
  library: Array<{ title: string; year?: number; genres?: string[] }>,
  rejections: number[],
): string {
  const header = kind === 'movie' ? 'MOVIES' : 'TV SHOWS'
  const libLines = library.map(formatLibraryItem).join('\n')
  const rejLine =
    rejections.length > 0
      ? `\n\nNEVER SUGGEST (TMDB ids, already explicitly rejected by the household): ${rejections.join(', ')}`
      : ''
  return `Household ${header} library (${library.length} titles):\n${libLines}${rejLine}`
}

// Per-user block — stays SHORT and goes after the cached library so it
// can vary per caller without invalidating the cached prefix. We pass
// TMDB ids because looking them back up in the library context above
// is something Claude can do; sending titles would double the tokens
// and obscure the matchback.
function buildUserLikesBlock(likedIds: number[]): string {
  if (likedIds.length === 0) return ''
  return `\n\nThis user has explicitly LIKED the following TMDB ids (positive signal — recommend more in this vein): ${likedIds.join(', ')}`
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
          reason: { type: 'string' as const },
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
    max_tokens: 4096,
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
        content: `Recommend ${CLAUDE_OVERFETCH} ${kind === 'movie' ? 'movies' : 'TV shows'} for this household. Mirror the library's genre distribution — return a proportional mix across drama, comedy, action, animation, documentary, etc., based on what they actually have. Weight toward the user's liked TMDB ids when present. Don't over-fit to a single tag.`,
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

  const rejected = new Set(type === 'movie' ? rejections.movie : rejections.tv)
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
  const likedIds = type === 'movie' ? userFeedback.movie.liked : userFeedback.tv.liked

  const client = new Anthropic({ apiKey: userKey })
  const libraryBlock = buildLibraryBlock(type, library, type === 'movie' ? rejections.movie : rejections.tv)
  const userLikesBlock = buildUserLikesBlock(likedIds)

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
