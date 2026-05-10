import { useQuery } from '@tanstack/react-query'
import { fetchCast } from '../api/tmdb'

// Cast for a TV show (lookup by TVDB id) or a movie (TMDB id). Cached
// for 24h since cast data rarely changes within a session and TMDB
// quotas are generous but not unlimited.

type Args =
  | { type: 'tv'; tvdbId: number; enabled?: boolean }
  | { type: 'movie'; tmdbId: number; enabled?: boolean }

export function useCast(args: Args) {
  const id = 'tvdbId' in args ? args.tvdbId : args.tmdbId
  return useQuery({
    queryKey: ['tmdb', 'cast', args.type, id],
    queryFn: () =>
      fetchCast(
        args.type === 'tv'
          ? { type: 'tv', tvdbId: args.tvdbId }
          : { type: 'movie', tmdbId: args.tmdbId },
      ),
    enabled: args.enabled !== false && Boolean(id),
    staleTime: 24 * 60 * 60 * 1000,
  })
}
