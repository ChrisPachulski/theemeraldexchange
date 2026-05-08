import { useQuery } from '@tanstack/react-query'
import { sonarr } from '../api/sonarr'

export function useSeriesSearch(term: string) {
  const trimmed = term.trim()
  return useQuery({
    queryKey: ['sonarr', 'lookup', trimmed],
    queryFn: () => sonarr.lookup(trimmed),
    enabled: trimmed.length >= 2,
    staleTime: 60_000,
  })
}
