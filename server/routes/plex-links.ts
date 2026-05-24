// /api/plex/library-links — resolves external ids (tmdb / tvdb / imdb)
// to Plex ratingKeys for every item the household has in Plex. The SPA
// uses this to render a "Play in Plex" overlay on in-library cards that
// deep-links straight to the title's metadata page in Plex web (where
// PLAY is one tap).
//
// Why a multi-id resolver: Sonarr/Radarr carry tmdbId AND tvdbId/imdbId.
// Plex's GUID set depends on the agent the library was built with —
// libraries built with the legacy "Plex TV Series (TVDB)" agent emit
// only tvdb:// GUIDs, so a tmdb-only resolver returns an empty TV map
// and the overlay never renders for TV. Walking every GUID and indexing
// by all three id systems makes the overlay bulletproof regardless of
// which agent populated the library.
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

type KindMap = {
  byTmdb: Record<string, string>
  byTvdb: Record<string, string>
  byImdb: Record<string, string>
}

export type LinkMap = {
  movie: KindMap
  tv: KindMap
}

const PLEX_LINKS_TTL_MS = 5 * 60_000

// Bound every PMS fetch the link resolver makes. Without a timeout, a
// hung PMS would leave buildMap's promise unresolved forever; that
// unresolved promise is what getMap shares as `inFlight`, so every
// later /api/plex/library-links caller piles onto the same dead
// promise and the resolver wedges until the process restarts. The
// finally clause inside getMap only fires once buildMap settles, so
// the timeout MUST live inside plexJson where it can actually abort
// the fetch.
const PLEX_LINKS_FETCH_TIMEOUT_MS = 10_000

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

type ExternalIds = { tmdb: string | null; tvdb: string | null; imdb: string | null }

function stripQuery(id: string): string {
  const qIx = id.indexOf('?')
  return qIx >= 0 ? id.slice(0, qIx) : id
}

// Extracts every external id Plex attaches to an item. Plex stores
// each external id as a separate entry like { id: "tmdb://12345" } —
// `tvdb://`, `imdb://`, and `tmdb://` are the three we care about. Some
// libraries only emit one of the three depending on which Plex agent
// scanned them; indexing by all three guarantees a match regardless of
// agent.
function externalIdsFromGuids(guids: PlexGuid[] | undefined): ExternalIds {
  const out: ExternalIds = { tmdb: null, tvdb: null, imdb: null }
  if (!guids) return out
  for (const g of guids) {
    if (!g.id) continue
    if (g.id.startsWith('tmdb://')) out.tmdb = stripQuery(g.id.slice('tmdb://'.length))
    else if (g.id.startsWith('tvdb://')) out.tvdb = stripQuery(g.id.slice('tvdb://'.length))
    else if (g.id.startsWith('imdb://')) out.imdb = stripQuery(g.id.slice('imdb://'.length))
  }
  return out
}

async function plexJson<T>(
  pathAndQuery: string,
  token: string,
): Promise<T> {
  const url = `${env.plexServerUrl}${pathAndQuery}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PLEX_LINKS_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': token,
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`plex ${res.status}: ${body.slice(0, 200)}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

function emptyKindMap(): KindMap {
  return { byTmdb: {}, byTvdb: {}, byImdb: {} }
}

async function buildMap(token: string): Promise<LinkMap> {
  type SectionsResponse = { MediaContainer: { Directory?: PlexSection[] } }
  type AllResponse = { MediaContainer: { Metadata?: PlexMetadata[] } }

  const sectionsBody = await plexJson<SectionsResponse>('/library/sections', token)
  const sections = sectionsBody.MediaContainer.Directory ?? []
  const movieSections = sections.filter((s) => s.type === 'movie')
  const tvSections = sections.filter((s) => s.type === 'show')

  const map: LinkMap = { movie: emptyKindMap(), tv: emptyKindMap() }

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
      const ids = externalIdsFromGuids(item.Guid)
      if (ids.tmdb) map.movie.byTmdb[ids.tmdb] = item.ratingKey
      if (ids.tvdb) map.movie.byTvdb[ids.tvdb] = item.ratingKey
      if (ids.imdb) map.movie.byImdb[ids.imdb] = item.ratingKey
    }
  }
  for (const r of tvResults) {
    for (const item of r.MediaContainer.Metadata ?? []) {
      const ids = externalIdsFromGuids(item.Guid)
      if (ids.tmdb) map.tv.byTmdb[ids.tmdb] = item.ratingKey
      if (ids.tvdb) map.tv.byTvdb[ids.tvdb] = item.ratingKey
      if (ids.imdb) map.tv.byImdb[ids.imdb] = item.ratingKey
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

plexLinks.get('/server-id', async (c) => {
  return c.json({ serverId: env.plexServerId })
})
