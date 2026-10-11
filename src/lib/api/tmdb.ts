import { apiUrl } from './base'
import { throwApiError } from './errors'

// TMDB cast/crew, trailers, related titles and people via the backend
// proxy. Key stays server-side; this client only knows the shape of the
// response. When TMDB_API_KEY isn't configured, the backend returns 503
// and we treat it as "nothing" so the detail modal can simply omit the
// section.

export type CastMember = {
  id: number
  name: string
  /** Single-credit (movies) — top character. */
  character?: string
  /**
   * Aggregate credits (TV) return an array of role objects with
   * episode_count. We flatten to the most-credited role for display.
   */
  roles?: Array<{ character?: string; episode_count?: number }>
  profile_path: string | null
  order?: number
}

type CreditsResponse = {
  cast?: CastMember[]
  crew?: unknown[]
}

export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185'

// Auth failures keep their status (session expiry handling), 503 (no TMDB
// key) is "nothing", any other failure throws.
async function tmdbGet<T>(path: string, scope: string): Promise<T | null> {
  const res = await fetch(apiUrl(path), { credentials: 'include' })
  if (res.status === 401 || res.status === 403) await throwApiError(res, scope)
  if (res.status === 503) return null
  if (!res.ok) throw new Error(`${scope} failed: ${res.status}`)
  return (await res.json()) as T
}

export async function fetchCast(args: {
  type: 'tv' | 'movie'
  tvdbId?: number
  tmdbId?: number
}): Promise<CastMember[]> {
  const params = new URLSearchParams({ type: args.type })
  if (args.tvdbId) params.set('tvdbId', String(args.tvdbId))
  if (args.tmdbId) params.set('tmdbId', String(args.tmdbId))
  const data = await tmdbGet<CreditsResponse>(`/api/tmdb/credits?${params}`, 'TMDB credits')
  return data?.cast ?? []
}

/** A title as the server's TMDB routes key it: movies by TMDB id, shows by
 *  TVDB id (what Sonarr tracks). The watchlist uses the same ids. */
export type TmdbRef = { kind: 'movie' | 'tv'; id: number }

function refQuery(ref: TmdbRef): string {
  return new URLSearchParams({
    type: ref.kind,
    [ref.kind === 'movie' ? 'tmdbId' : 'tvdbId']: String(ref.id),
  }).toString()
}

/** A YouTube trailer or extra (official trailers first, server-ranked). */
export type TmdbVideo = { key: string; name: string; type: string; official: boolean }

export async function fetchVideos(ref: TmdbRef): Promise<TmdbVideo[]> {
  const data = await tmdbGet<{ videos?: TmdbVideo[] }>(`/api/tmdb/videos?${refQuery(ref)}`, 'TMDB videos')
  return data?.videos ?? []
}

/** A "More like this" title, shaped for TrendingRow (id = TMDB id). */
export type RelatedItem = { id: number; title: string; year?: number; posterPath: string | null }

export async function fetchRelated(ref: TmdbRef): Promise<RelatedItem[]> {
  const data = await tmdbGet<{
    items?: Array<{ tmdbId: number; title: string; year: number | null; posterPath: string | null }>
  }>(`/api/tmdb/related?${refQuery(ref)}`, 'TMDB related')
  return (data?.items ?? []).map((r) => ({
    id: r.tmdbId,
    title: r.title,
    year: r.year ?? undefined,
    posterPath: r.posterPath,
  }))
}

/** One filmography row (TMDB combined credits; id is the title's TMDB id). */
export type PersonCredit = {
  id: number
  media_type: 'movie' | 'tv'
  title: string | null
  name: string | null
  poster_path: string | null
  release_date: string | null
  first_air_date: string | null
  character: string | null
}

export type PersonDetail = {
  id: number
  name: string
  profile_path: string | null
  biography: string | null
  known_for_department: string | null
  cast: PersonCredit[]
}

/** Null when TMDB isn't configured. */
export function fetchPerson(personId: number): Promise<PersonDetail | null> {
  return tmdbGet<PersonDetail>(`/api/tmdb/person/${personId}`, 'TMDB person')
}

/** Pick the most-credited character for an aggregate (TV) cast row. */
export function castCharacter(member: CastMember): string | undefined {
  if (member.character) return member.character
  if (member.roles && member.roles.length > 0) {
    const top = [...member.roles].sort(
      (a, b) => (b.episode_count ?? 0) - (a.episode_count ?? 0),
    )[0]
    return top?.character
  }
  return undefined
}
