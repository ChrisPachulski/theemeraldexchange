import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../api/base'

// Trending row data for the Discover landing surface. TMDB returns a
// week-window list of the hottest titles, which gives users something
// to browse before they search. We surface a slim subset of fields —
// just enough to render a poster + title card.

export type TrendingItem = {
  /** TMDB id — used to look up the title in Sonarr/Radarr via tmdb:N. */
  id: number
  /** TV uses `name`, movies use `title`. TMDB returns whichever applies. */
  title: string
  /** TMDB poster_path; relative to https://image.tmdb.org/t/p/wNNN. */
  posterPath: string | null
  overview?: string
  /** Year extracted from release_date / first_air_date. */
  year?: number
}

type TmdbTrendingRow = {
  id: number
  title?: string
  name?: string
  poster_path: string | null
  overview?: string
  release_date?: string
  first_air_date?: string
}

async function fetchTrending(kind: 'movie' | 'tv'): Promise<TrendingItem[]> {
  const r = await fetch(apiUrl(`/api/tmdb/trending/${kind}`), {
    credentials: 'include',
  })
  if (!r.ok) return []
  const data = (await r.json()) as { results?: TmdbTrendingRow[] }
  return (data.results ?? []).map((row) => {
    const date = row.release_date || row.first_air_date || ''
    const year = date ? Number(date.slice(0, 4)) : undefined
    return {
      id: row.id,
      title: row.title || row.name || '',
      posterPath: row.poster_path,
      overview: row.overview,
      year: Number.isFinite(year) ? year : undefined,
    }
  })
}

export function useTrendingMovies() {
  return useQuery({
    queryKey: ['tmdb', 'trending', 'movie'],
    queryFn: () => fetchTrending('movie'),
    staleTime: 60 * 60_000, // 1 hour — trending barely shifts within the hour
  })
}

export function useTrendingTv() {
  return useQuery({
    queryKey: ['tmdb', 'trending', 'tv'],
    queryFn: () => fetchTrending('tv'),
    staleTime: 60 * 60_000,
  })
}
