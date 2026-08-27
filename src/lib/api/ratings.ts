import { apiUrl } from './base'
import { throwApiError } from './errors'

// IMDb / Rotten Tomatoes / Metacritic via the backend OMDb proxy, keyed by
// IMDb id. 503 = OMDB_API_KEY not configured; treated as "no scores" so the
// cards fall back to whatever Sonarr/Radarr carry.

export type TitleRatings = { imdb: number | null; rt: number | null; metacritic: number | null }
export type RatingsMap = Record<string, TitleRatings>

export const RATINGS_BATCH = 60

export async function fetchRatings(ids: string[]): Promise<RatingsMap> {
  if (ids.length === 0) return {}
  const res = await fetch(apiUrl(`/api/ratings?ids=${ids.join(',')}`), { credentials: 'include' })
  if (res.status === 401 || res.status === 403) await throwApiError(res, 'ratings')
  if (res.status === 503) return {}
  if (!res.ok) throw new Error(`ratings failed: ${res.status}`)
  return (await res.json()) as RatingsMap
}

/** '8.6 IMDb · 92% RT · 74 MC' — omits missing sources; undefined when all are. */
export function fmtRatings(r: TitleRatings | undefined): string | undefined {
  if (!r) return undefined
  const pieces: string[] = []
  if (r.imdb !== null) pieces.push(`${r.imdb.toFixed(1)} IMDb`)
  if (r.rt !== null) pieces.push(`${r.rt}% RT`)
  if (r.metacritic !== null) pieces.push(`${r.metacritic} MC`)
  return pieces.length ? pieces.join(' · ') : undefined
}
