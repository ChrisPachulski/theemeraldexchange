import { useQueries } from '@tanstack/react-query'
import { fetchRatings, RATINGS_BATCH, type RatingsMap } from '../api/ratings'

// One query per RATINGS_BATCH-sized chunk of IMDb ids (sorted, so the same
// library page always hits the same cache keys). Returns a merged map; chunks
// still loading simply contribute nothing yet.
export function useRatings(imdbIds: Array<string | undefined>): RatingsMap {
  const ids = [...new Set(imdbIds.filter((s): s is string => Boolean(s)))].sort()
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += RATINGS_BATCH) chunks.push(ids.slice(i, i + RATINGS_BATCH))
  const results = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: ['ratings', chunk.join(',')],
      queryFn: () => fetchRatings(chunk),
      staleTime: 24 * 60 * 60 * 1000,
    })),
  })
  return Object.assign({}, ...results.map((r) => r.data ?? {})) as RatingsMap
}
