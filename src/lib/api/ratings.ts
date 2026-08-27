import { apiUrl } from './base'
import { throwApiError } from './errors'

// IMDb / Rotten Tomatoes (Tomatometer + Popcornmeter) / Metacritic via the
// backend, keyed by IMDb id. `pending` lists ids the server is still filling
// from upstream; the hook polls while it is non-empty.

export type TitleRatings = {
  imdb: number | null
  rt: number | null
  rtAudience: number | null
  metacritic: number | null
}
export type RatingsMap = Record<string, TitleRatings>
export type RatingsResponse = { ratings: RatingsMap; pending: string[] }

export const RATINGS_BATCH = 60

export async function fetchRatings(ids: string[]): Promise<RatingsResponse> {
  if (ids.length === 0) return { ratings: {}, pending: [] }
  const res = await fetch(apiUrl(`/api/ratings?ids=${ids.join(',')}`), { credentials: 'include' })
  if (res.status === 401 || res.status === 403) await throwApiError(res, 'ratings')
  if (!res.ok) throw new Error(`ratings failed: ${res.status}`)
  return (await res.json()) as RatingsResponse
}

/** '8.6 IMDb · 96% RT · 97% Popcorn · 74 MC' — omits missing sources; undefined when all are. */
export function fmtRatings(r: TitleRatings | undefined): string | undefined {
  if (!r) return undefined
  const pieces: string[] = []
  if (r.imdb !== null) pieces.push(`${r.imdb.toFixed(1)} IMDb`)
  if (r.rt !== null) pieces.push(`${r.rt}% RT`)
  if (r.rtAudience !== null) pieces.push(`${r.rtAudience}% Popcorn`)
  if (r.metacritic !== null) pieces.push(`${r.metacritic} MC`)
  return pieces.length ? pieces.join(' · ') : undefined
}
