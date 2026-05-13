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
import { env } from '../env.js'

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
- Prefer titles the household is statistically likely to enjoy based on what they already chose to add.
- Mix obvious adjacent picks with one or two non-obvious deeper cuts each call.
- Vary your selections across calls — do not return the same list every time. Pull from the long tail.
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
      ? `\n\nNEVER SUGGEST (TMDB ids, already explicitly rejected): ${rejections.join(', ')}`
      : ''
  return `Household ${header} library (${library.length} titles):\n${libLines}${rejLine}`
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

async function tmdbTrending(kind: 'movie' | 'tv'): Promise<SuggestionItem[]> {
  if (!env.tmdbApiKey) return []
  const url = new URL(`${TMDB_BASE}/trending/${kind}/week`)
  url.searchParams.set('api_key', env.tmdbApiKey)
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) return []
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
  return (data.results ?? []).slice(0, TARGET_COUNT).map((r) => {
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

async function callClaude(
  client: Anthropic,
  kind: 'movie' | 'tv',
  libraryBlock: string,
): Promise<ClaudePick[]> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    temperature: 0.8,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
      },
      {
        type: 'text',
        text: libraryBlock,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Recommend ${CLAUDE_OVERFETCH} ${kind === 'movie' ? 'movies' : 'TV shows'} for this household. Pull from the long tail — do not just return the same well-known titles every call. Mix safe adjacent picks with a couple of deeper cuts.`,
      },
    ],
    // Constrain to a typed JSON shape so the response is parseable.
    output_config: {
      format: { type: 'json_schema', schema: PICK_SCHEMA },
    },
  })

  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') return []
  try {
    const parsed = JSON.parse(block.text) as { picks?: ClaudePick[] }
    return Array.isArray(parsed.picks) ? parsed.picks : []
  } catch {
    return []
  }
}

suggestions.get('/:type', async (c) => {
  const type = c.req.param('type')
  if (type !== 'movie' && type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }

  // Library + rejections in parallel.
  const [library, rejections] = await Promise.all([
    type === 'movie' ? fetchRadarrLibrary() : fetchSonarrLibrary(),
    getRejections(),
  ])

  const rejected = new Set(type === 'movie' ? rejections.movie : rejections.tv)
  const libraryTmdbIds = new Set(
    library.map((l) => l.tmdbId).filter((id): id is number => typeof id === 'number'),
  )

  // Cold start: library too small for meaningful taste signal.
  if (library.length < COLD_START_THRESHOLD) {
    const trending = (await tmdbTrending(type)).filter(
      (i) => !rejected.has(i.id) && !libraryTmdbIds.has(i.id),
    )
    return c.json({ source: 'trending', items: trending.slice(0, TARGET_COUNT) })
  }

  // No Anthropic key configured — fall back to trending so the surface
  // still functions, just without personalization.
  if (!env.anthropicApiKey) {
    const trending = (await tmdbTrending(type)).filter(
      (i) => !rejected.has(i.id) && !libraryTmdbIds.has(i.id),
    )
    return c.json({ source: 'trending_fallback', items: trending.slice(0, TARGET_COUNT) })
  }

  const client = new Anthropic({ apiKey: env.anthropicApiKey })
  const libraryBlock = buildLibraryBlock(type, library, type === 'movie' ? rejections.movie : rejections.tv)

  let picks: ClaudePick[] = []
  try {
    picks = await callClaude(client, type, libraryBlock)
  } catch (e) {
    console.error('[suggestions] Claude call failed:', e)
    const trending = (await tmdbTrending(type)).filter(
      (i) => !rejected.has(i.id) && !libraryTmdbIds.has(i.id),
    )
    return c.json({ source: 'trending_fallback', items: trending.slice(0, TARGET_COUNT) })
  }

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
