import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../api/base'

// Deep-link resolver for in-library titles. The server route
// /api/plex/library-links walks every Plex library section and emits
// a map indexed by tmdb / tvdb / imdb so the SPA can resolve a ratingKey
// regardless of which Plex agent built the library. Combined with the
// household's PLEX_SERVER_ID this produces a URL that opens the title's
// page in Plex web (PLAY is one tap away).
//
// When no id matches (item not in Plex's GUID set yet, or Plex hasn't
// indexed it), linkFor falls back to a Plex search URL so the overlay
// still does something useful — the user lands on Plex's search results
// for the title and one more tap gets them watching. The icon is only
// suppressed when both the id lookup AND the title fallback have nothing
// to work with.
//
// 5-minute staleTime matches the server-side cache so React Query and
// the Plex round-trip live on the same rhythm.

// app.plex.tv is Plex's hosted web client — works on AND off network.
// Plex's auth + relay infrastructure routes the request to the home
// server regardless of where the user clicks from. The LAN URL
// (http://theemeraldexchange.local:32400/web) was mDNS-only and broke
// for every household member outside the house.
const PLEX_WEB_BASE = 'https://app.plex.tv/desktop'
const PLEX_LIBRARY_LINKS_PATH = '/api/plex/library-links'
const PLEX_SERVER_ID_PATH = '/api/plex/server-id'

export type KindMap = {
  byTmdb: Record<string, string>
  byTvdb: Record<string, string>
  byImdb: Record<string, string>
}

export type LinkMap = { movie: KindMap; tv: KindMap }
type ServerIdResponse = { serverId: string | null }

function emptyKindMap(): KindMap {
  return { byTmdb: {}, byTvdb: {}, byImdb: {} }
}

async function fetchLinks(): Promise<LinkMap> {
  const r = await fetch(apiUrl(PLEX_LIBRARY_LINKS_PATH), { credentials: 'include' })
  if (!r.ok) {
    // 409 (no_plex_token) and 502 (plex_unreachable) both yield an
    // empty map — linkFor still falls back to the search URL when a
    // title is supplied, so the overlay can render in degraded mode.
    return { movie: emptyKindMap(), tv: emptyKindMap() }
  }
  return (await r.json()) as LinkMap
}

async function fetchServerId(): Promise<string | null> {
  const r = await fetch(apiUrl(PLEX_SERVER_ID_PATH), { credentials: 'include' })
  if (!r.ok) return null
  const body = (await r.json()) as ServerIdResponse
  return body.serverId ?? null
}

// Builds the Plex web deep-link URL given a ratingKey. When serverId
// is missing (PLEX_SERVER_ID env var unset), falls back to the Plex
// root URL.
export function buildPlexDeepLink(serverId: string | null, ratingKey: string): string {
  if (!serverId) return PLEX_WEB_BASE
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`)
  return `${PLEX_WEB_BASE}/index.html#!/server/${serverId}/details?key=${key}`
}

// Plex search URL — lands the user on Plex web's search results for
// the title. Used when the GUID lookup misses (e.g. Plex hasn't matched
// the item, or the library was built with an agent that doesn't emit
// any of the three external ids we index by).
export function buildPlexSearchLink(title: string): string {
  return `${PLEX_WEB_BASE}/index.html#!/search?query=${encodeURIComponent(title)}`
}

export type LinkLookup = {
  tmdbId?: number | string | null
  tvdbId?: number | string | null
  imdbId?: string | null
  title?: string | null
}

// Pure resolver — exported so the fallback chain (tmdb → tvdb → imdb →
// search-by-title) can be unit-tested without standing up React Query.
// Returns null only when no external id matches AND no title is given.
export function resolvePlexLink(
  map: LinkMap | null | undefined,
  serverId: string | null,
  kind: 'movie' | 'tv',
  lookup: LinkLookup,
): string | null {
  const kindMap = map?.[kind] ?? { byTmdb: {}, byTvdb: {}, byImdb: {} }
  const tmdb = lookup.tmdbId != null ? String(lookup.tmdbId) : null
  const tvdb = lookup.tvdbId != null ? String(lookup.tvdbId) : null
  const imdb = lookup.imdbId ?? null

  const ratingKey =
    (tmdb && kindMap.byTmdb[tmdb]) ||
    (tvdb && kindMap.byTvdb[tvdb]) ||
    (imdb && kindMap.byImdb[imdb]) ||
    null

  if (ratingKey) return buildPlexDeepLink(serverId, ratingKey)

  const title = lookup.title?.trim()
  if (title) return buildPlexSearchLink(title)

  return null
}

export function usePlexLinks(): {
  linkFor: (kind: 'movie' | 'tv', lookup: LinkLookup) => string | null
  isLoading: boolean
} {
  const links = useQuery({
    queryKey: ['plex', 'library-links'],
    queryFn: fetchLinks,
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  })
  const serverId = useQuery({
    queryKey: ['plex', 'server-id'],
    queryFn: fetchServerId,
    // Server id never changes during a session; cache it forever.
    staleTime: Infinity,
  })

  const linkFor = (kind: 'movie' | 'tv', lookup: LinkLookup): string | null =>
    resolvePlexLink(links.data ?? null, serverId.data ?? null, kind, lookup)

  return {
    linkFor,
    isLoading: links.isLoading || serverId.isLoading,
  }
}
