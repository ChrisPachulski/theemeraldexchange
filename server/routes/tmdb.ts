// TMDB credits proxy. We keep the API key server-side and surface only
// the credits endpoint, scoped to either a Sonarr-tracked TV show
// (identified by TVDB id) or a Radarr-tracked movie (TMDB id).
//
// Sonarr/Radarr don't expose cast in their v3 APIs, so the detail modal
// reaches here for cast data. If neither TMDB_READ_ACCESS_TOKEN nor
// TMDB_API_KEY is set, this route returns 503 and the frontend gracefully
// omits the cast section.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { fetchWithTimeout, WAN_TIMEOUT_MS } from '../services/upstream.js'

export const tmdb = new Hono<Env>()

tmdb.use('*', requireAuth)

const TMDB_BASE = 'https://api.themoviedb.org/3'

// TMDB/TVDB ids are positive integers. Validate before spending an
// upstream call so garbage query values can't each turn into an
// outbound TMDB request (response-size / rate-limit amplification on
// the shared TMDB budget). Mirrors recommenderEvents.ts:49 and
// grabs.ts:42, which gate ids with Number.isSafeInteger(...) > 0 before
// forwarding.
function positiveIntId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

async function tmdbFetch(path: string, params: Record<string, string> = {}) {
  if (!(env.tmdbReadAccessToken ?? env.tmdbApiKey)) {
    return null
  }
  const url = new URL(`${TMDB_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (env.tmdbReadAccessToken) {
    headers.Authorization = `Bearer ${env.tmdbReadAccessToken}`
  } else if (env.tmdbApiKey) {
    url.searchParams.set('api_key', env.tmdbApiKey)
  }
  return fetchWithTimeout(
    url,
    { headers },
    WAN_TIMEOUT_MS,
    `tmdb${path}`,
  )
}

tmdb.get('/credits', async (c) => {
  if (!(env.tmdbReadAccessToken ?? env.tmdbApiKey)) {
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }

  const type = c.req.query('type')

  if (type === 'tv') {
    const tvdbId = positiveIntId(c.req.query('tvdbId'))
    if (tvdbId === null) {
      return c.json({ error: 'invalid_tvdbId' }, 400)
    }
    // TVDB → TMDB lookup. /find returns matches across types; we take
    // the first tv_results entry.
    const findRes = await tmdbFetch(`/find/${tvdbId}`, {
      external_source: 'tvdb_id',
    })
    if (!findRes || !findRes.ok) {
      return c.json({ error: 'tmdb_find_failed', status: findRes?.status }, 502)
    }
    const findData = (await findRes.json()) as { tv_results?: Array<{ id: number }> }
    const id = findData.tv_results?.[0]?.id
    if (!id) return c.json({ cast: [], crew: [] })
    const credits = await tmdbFetch(`/tv/${id}/aggregate_credits`)
    if (!credits || !credits.ok) {
      return c.json({ error: 'tmdb_credits_failed', status: credits?.status }, 502)
    }
    const data = await credits.json()
    return c.json(data)
  }

  if (type === 'movie') {
    const tmdbId = positiveIntId(c.req.query('tmdbId'))
    if (tmdbId === null) {
      return c.json({ error: 'invalid_tmdbId' }, 400)
    }
    const credits = await tmdbFetch(`/movie/${tmdbId}/credits`)
    if (!credits || !credits.ok) {
      return c.json({ error: 'tmdb_credits_failed', status: credits?.status }, 502)
    }
    const data = await credits.json()
    return c.json(data)
  }

  return c.json({ error: 'invalid_query' }, 400)
})

// Trending feed — surfaces TMDB's week-window list of the most-talked-
// about titles for the requested type. Used by the Discover tab as a
// landing row so users see something to browse before they search.
//
// Type param: 'movie' or 'tv'. We pin the window to 'week' (vs 'day')
// because day-trending whipsaws on news cycles; week reads as "what's
// hot right now" without being volatile.
tmdb.get('/trending/:type', async (c) => {
  if (!(env.tmdbReadAccessToken ?? env.tmdbApiKey)) {
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }
  const type = c.req.param('type')
  if (type !== 'movie' && type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }
  const res = await tmdbFetch(`/trending/${type}/week`)
  if (!res || !res.ok) {
    return c.json({ error: 'tmdb_trending_failed', status: res?.status }, 502)
  }
  const data = (await res.json()) as { results?: unknown[] }
  return c.json(data)
})
