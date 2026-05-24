import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../api/base'

// Server-configured policy limits surfaced to the SPA so tooltips and
// gates can explain them without hardcoding values in two places.
export type Limits = {
  minFreeGb: number
  maxMovieGb: number
  maxTvGbPerEpisode: number
  /** When true, the server routes every personalized request through
   *  the local recommender sidecar — the SPA's "AI" toggle becomes
   *  inert (toggling it can't switch the path off) and should be
   *  hidden. Optional for forward-compat with older backends. */
  useLocalRecommender?: boolean
}

const DEFAULT_LIMITS: Limits = {
  minFreeGb: 100,
  maxMovieGb: 10,
  maxTvGbPerEpisode: 5,
  useLocalRecommender: false,
}

export function useLimits() {
  return useQuery({
    queryKey: ['limits'],
    queryFn: async (): Promise<Limits> => {
      const r = await fetch(apiUrl('/api/limits'), { credentials: 'include' })
      if (!r.ok) return DEFAULT_LIMITS
      return (await r.json()) as Limits
    },
    staleTime: 60 * 60 * 1000,
    placeholderData: DEFAULT_LIMITS,
  })
}
