// /api/plex/library-links — resolves tmdb ids to Plex ratingKeys for
// every item the household has in Plex. The SPA uses this to render a
// "Play in Plex" overlay on in-library cards that deep-links straight
// to the title's metadata page in Plex web (where PLAY is one tap).
//
// Why a resolver: Sonarr/Radarr carry tmdbId; Plex web URLs need
// `ratingKey` (Plex's internal id) + `PLEX_SERVER_ID` (the server's
// machine identifier). This route walks every Plex library section,
// parses each item's GUIDs, and emits a flat
// `{ movie: { tmdbId: ratingKey }, tv: { tmdbId: ratingKey } }` map.
//
// Cost: one Plex `/library/sections` + N section walks per cache miss.
// On a 1000-item library this is ~200–500ms end-to-end. Cached for
// PLEX_LINKS_TTL_MS so household traffic stays cheap. In-flight
// coalescing collapses concurrent requests (e.g. two tabs mounting at
// once) to a single upstream call.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'

export const plexLinks = new Hono<Env>()
plexLinks.use('*', requireAuth)

export type LinkMap = {
  movie: Record<string, string>
  tv: Record<string, string>
}

// 5-minute TTL — matches the LIBRARY_CACHE_TTL_MS rhythm in the
// suggestions route; the Plex library doesn't churn faster than that
// in practice (new items take longer than 5 min to land + scan anyway).
const PLEX_LINKS_TTL_MS = 5 * 60_000

type CacheEntry = { value: LinkMap; expiresAt: number }
let cache: CacheEntry | null = null
let inFlight: Promise<LinkMap> | null = null

export function _resetPlexLinksCacheForTests(): void {
  cache = null
  inFlight = null
}

type PlexSection = {
  key: string
  type: string
  title?: string
}

type PlexGuid = { id?: string }

type PlexMetadata = {
  ratingKey: string
  title?: string
  Guid?: PlexGuid[]
}

// Extracts the numeric tmdb id from a Plex GUID array. Plex stores
// each external id as a separate entry like { id: "tmdb://12345" }.
// Returns null when no tmdb GUID is attached (some library items
// haven't matched yet; the SPA falls back to a Plex title search for
// those).
function tmdbIdFromGuids(guids: PlexGuid[] | undefined): string | null {
  if (!guids) return null
  for (const g of guids) {
    if (!g.id) continue
    if (g.id.startsWith('tmdb://')) {
      const id = g.id.slice('tmdb://'.length)
      // Plex sometimes appends a `?lang=…`; strip it.
      const qIx = id.indexOf('?')
      return qIx >= 0 ? id.slice(0, qIx) : id
    }
  }
  return null
}

async function plexJson<T>(
  pathAndQuery: string,
  token: string,
): Promise<T> {
  const url = `${env.plexServerUrl}${pathAndQuery}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': token,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`plex ${res.status}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

async function buildMap(token: string): Promise<LinkMap> {
  type SectionsResponse = {
    MediaContainer: {
      Directory?: PlexSection[]
    }
  }
  type AllResponse = {
    MediaContainer: {
      Metadata?: PlexMetadata[]
    }
  }

  const sectionsBody = await plexJson<SectionsResponse>('/library/sections', token)
  const sections = sectionsBody.MediaContainer.Directory ?? []
  const movieSections = sections.filter((s) => s.type === 'movie')
  const tvSections = sections.filter((s) => s.type === 'show')

  const map: LinkMap = { movie: {}, tv: {} }

  // Fetch every section's `/all?includeGuids=1`. Parallel across
  // sections; serial inside a section (one Plex call returns the
  // whole section's metadata). Most households have 1 of each — this
  // is effectively two parallel calls.
  const movieResults = await Promise.all(
    movieSections.map((s) =>
      plexJson<AllResponse>(`/library/sections/${s.key}/all?includeGuids=1`, token).catch(
        () => ({ MediaContainer: { Metadata: [] as PlexMetadata[] } }),
      ),
    ),
  )
  const tvResults = await Promise.all(
    tvSections.map((s) =>
      plexJson<AllResponse>(`/library/sections/${s.key}/all?includeGuids=1`, token).catch(
        () => ({ MediaContainer: { Metadata: [] as PlexMetadata[] } }),
      ),
    ),
  )

  for (const r of movieResults) {
    for (const item of r.MediaContainer.Metadata ?? []) {
      const tmdb = tmdbIdFromGuids(item.Guid)
      if (tmdb) map.movie[tmdb] = item.ratingKey
    }
  }
  for (const r of tvResults) {
    for (const item of r.MediaContainer.Metadata ?? []) {
      const tmdb = tmdbIdFromGuids(item.Guid)
      if (tmdb) map.tv[tmdb] = item.ratingKey
    }
  }
  return map
}

async function getMap(token: string): Promise<LinkMap> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.value
  if (inFlight) return inFlight
  inFlight = buildMap(token)
    .then((value) => {
      cache = { value, expiresAt: Date.now() + PLEX_LINKS_TTL_MS }
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

plexLinks.get('/library-links', async (c) => {
  const session = c.get('session')
  if (!session.plexAuthToken) {
    return c.json({ error: 'no_plex_token' }, 409)
  }
  try {
    const map = await getMap(session.plexAuthToken)
    return c.json(map)
  } catch (e) {
    console.error('[plex-links] resolver failed:', e instanceof Error ? e.message : String(e))
    return c.json({ error: 'plex_unreachable', detail: String(e) }, 502)
  }
})

// /server-id surfaces the configured PLEX_SERVER_ID so the SPA can
// build deep links without needing a Vite-time env variable. Returned
// as `null` when unset — the SPA falls back to the Plex root URL.
plexLinks.get('/server-id', async (c) => {
  return c.json({ serverId: env.plexServerId })
})
