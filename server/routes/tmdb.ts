// TMDB credits proxy. We keep the API key server-side and surface only
// the credits endpoint, scoped to either a Sonarr-tracked TV show
// (identified by TVDB id) or a Radarr-tracked movie (TMDB id).
//
// Sonarr/Radarr don't expose cast in their v3 APIs, so the detail modal
// reaches here for cast data. If TMDB_API_KEY isn't set, this route
// returns 503 and the frontend gracefully omits the cast section.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'

export const tmdb = new Hono<Env>()

tmdb.use('*', requireAuth)

const TMDB_BASE = 'https://api.themoviedb.org/3'

async function tmdbFetch(path: string, params: Record<string, string> = {}) {
  if (!env.tmdbApiKey) {
    return null
  }
  const url = new URL(`${TMDB_BASE}${path}`)
  url.searchParams.set('api_key', env.tmdbApiKey)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return fetch(url, { headers: { Accept: 'application/json' } })
}

tmdb.get('/credits', async (c) => {
  if (!env.tmdbApiKey) {
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }

  const type = c.req.query('type')
  const tvdbId = c.req.query('tvdbId')
  const tmdbId = c.req.query('tmdbId')

  if (type === 'tv' && tvdbId) {
    // TVDB → TMDB lookup. /find returns matches across types; we take
    // the first tv_results entry.
    const findRes = await tmdbFetch(`/find/${encodeURIComponent(tvdbId)}`, {
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

  if (type === 'movie' && tmdbId) {
    const credits = await tmdbFetch(`/movie/${encodeURIComponent(tmdbId)}/credits`)
    if (!credits || !credits.ok) {
      return c.json({ error: 'tmdb_credits_failed', status: credits?.status }, 502)
    }
    const data = await credits.json()
    return c.json(data)
  }

  return c.json({ error: 'invalid_query' }, 400)
})
