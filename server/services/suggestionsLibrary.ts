// server/services/suggestionsLibrary.ts
//
// Sonarr/Radarr library snapshot for the suggestions route: TTL cache,
// in-flight dedup, and the stale-fallback that keeps household-safe
// filtering alive through a transient upstream outage. Module-level
// state is intentional — one cache per process, shared by every
// request (the suggestions route is the only consumer); tests reset it
// via the _reset*ForTests escape hatches.

import { sonarrFetch } from './sonarr.js'
import { radarrFetch } from './radarr.js'

type SonarrSeries = { title: string; year?: number; tmdbId?: number; genres?: string[] }
type RadarrMovie = { title: string; year?: number; tmdbId?: number; genres?: string[] }
export type LibraryItem = SonarrSeries | RadarrMovie

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
export class LibraryUnavailableError extends Error {
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

export function librarySnapshotAgeMs(kind: 'movie' | 'tv'): number | undefined {
  const fetchedAt = libraryStaleFallback[kind]?.fetchedAt
  return fetchedAt === undefined ? undefined : Math.max(0, Date.now() - fetchedAt)
}

export async function fetchLibraryCached(kind: 'movie' | 'tv'): Promise<LibraryItem[]> {
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
