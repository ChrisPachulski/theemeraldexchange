import { useQuery } from '@tanstack/react-query'
import { radarr } from '../api/radarr'

export function useMovieSearch(term: string, enabled = true) {
  const trimmed = term.trim()
  return useQuery({
    queryKey: ['radarr', 'lookup', trimmed],
    queryFn: () => radarr.lookup(trimmed),
    enabled: enabled && trimmed.length >= 2,
    staleTime: 60_000,
  })
}
