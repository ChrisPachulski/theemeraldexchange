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

/** One score with its source; rendered as an icon + value chip. */
export type RatingPiece = {
  kind: 'imdb' | 'rt' | 'popcorn' | 'mc' | 'tvdb' | 'tmdb'
  value: string
  /** Numeric score for icon state (fresh/rotten, Metacritic colour). */
  score: number
  /** Screen-reader / tooltip text. */
  label: string
}

/** Icon-chip pieces from OMDb/RT scores; empty when every source is null. */
export function ratingPieces(r: TitleRatings | undefined): RatingPiece[] {
  if (!r) return []
  const out: RatingPiece[] = []
  if (r.imdb !== null) out.push({ kind: 'imdb', value: r.imdb.toFixed(1), score: r.imdb, label: `IMDb ${r.imdb.toFixed(1)}` })
  if (r.rt !== null) out.push({ kind: 'rt', value: `${r.rt}%`, score: r.rt, label: `Rotten Tomatoes Tomatometer ${r.rt}%` })
  if (r.rtAudience !== null) out.push({ kind: 'popcorn', value: `${r.rtAudience}%`, score: r.rtAudience, label: `Rotten Tomatoes Popcornmeter ${r.rtAudience}%` })
  if (r.metacritic !== null) out.push({ kind: 'mc', value: String(r.metacritic), score: r.metacritic, label: `Metacritic ${r.metacritic}` })
  return out
}
