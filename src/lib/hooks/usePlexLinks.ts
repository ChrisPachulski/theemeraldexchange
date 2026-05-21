import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../api/base'

// Deep-link resolver for in-library titles. The server route
// /api/plex/library-links walks every Plex library section and emits
// a flat `{ movie: { tmdbId: ratingKey }, tv: { tmdbId: ratingKey } }`
// map. Combined with the household's PLEX_SERVER_ID it produces a URL
// that opens the title's page in Plex web (PLAY is one tap away).
//
// 5-minute staleTime matches the server-side cache so React Query and
// the Plex round-trip live on the same rhythm.

const PLEX_WEB_BASE = 'http://theemeraldexchange.local:32400/web'
const PLEX_LIBRARY_LINKS_PATH = '/api/plex/library-links'
const PLEX_SERVER_ID_PATH = '/api/plex/server-id'

type LinkMap = {
  movie: Record<string, string>
  tv: Record<string, string>
}

type ServerIdResponse = { serverId: string | null }

async function fetchLinks(): Promise<LinkMap> {
  const r = await fetch(apiUrl(PLEX_LIBRARY_LINKS_PATH), { credentials: 'include' })
  if (!r.ok) {
    // 409 (no_plex_token) and 502 (plex_unreachable) both yield an
    // empty map — the UI simply doesn't render the play overlay, and
    // the existing card behavior is preserved. We don't toast or
    // surface this to the user; the absence of the icon is the signal.
    return { movie: {}, tv: {} }
  }
  return (await r.json()) as LinkMap
}

async function fetchServerId(): Promise<string | null> {
  const r = await fetch(apiUrl(PLEX_SERVER_ID_PATH), { credentials: 'include' })
  if (!r.ok) return null
  const body = (await r.json()) as ServerIdResponse
  return body.serverId ?? null
}

// Builds the Plex web deep-link URL. When serverId is missing (e.g.
// PLEX_SERVER_ID env var not set), falls back to the Plex root URL —
// better than nothing; the household member can still navigate.
// Exported so the URL contract can be unit-tested without standing up
// React Query in jsdom.
export function buildPlexDeepLink(serverId: string | null, ratingKey: string): string {
  if (!serverId) return PLEX_WEB_BASE
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`)
  return `${PLEX_WEB_BASE}/index.html#!/server/${serverId}/details?key=${key}`
}

export function usePlexLinks(): {
  linkFor: (kind: 'movie' | 'tv', tmdbId: number) => string | null
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

  const linkFor = (kind: 'movie' | 'tv', tmdbId: number): string | null => {
    const map = links.data
    if (!map) return null
    const ratingKey = map[kind][String(tmdbId)]
    if (!ratingKey) return null
    return buildPlexDeepLink(serverId.data ?? null, ratingKey)
  }

  return {
    linkFor,
    isLoading: links.isLoading || serverId.isLoading,
  }
}
