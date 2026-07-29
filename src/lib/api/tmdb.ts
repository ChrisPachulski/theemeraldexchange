import { apiUrl } from './base'
import { throwApiError } from './errors'

// TMDB cast/crew via the backend proxy. Key stays server-side; this
// client only knows the shape of the response. When TMDB_API_KEY isn't
// configured, the backend returns 503 and we treat it as "no cast" so
// the detail modal can simply omit the section.

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

export async function fetchCast(args: {
  type: 'tv' | 'movie'
  tvdbId?: number
  tmdbId?: number
}): Promise<CastMember[]> {
  const params = new URLSearchParams({ type: args.type })
  if (args.tvdbId) params.set('tvdbId', String(args.tvdbId))
  if (args.tmdbId) params.set('tmdbId', String(args.tmdbId))
  const res = await fetch(apiUrl(`/api/tmdb/credits?${params}`), {
    credentials: 'include',
  })
  if (res.status === 401 || res.status === 403) await throwApiError(res, 'TMDB credits')
  // 503 = TMDB_API_KEY not configured. Treat as empty cast — modal hides
  // the section. Other failures bubble.
  if (res.status === 503) return []
  if (!res.ok) throw new Error(`TMDB credits failed: ${res.status}`)
  const data = (await res.json()) as CreditsResponse
  return data.cast ?? []
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
