import { useQuery } from '@tanstack/react-query'
import { sonarr } from '../api/sonarr'

// Episodes for a single Sonarr series. Fetched on demand by the
// detail modal when a library show opens, so the seasons disclosure
// can show per-episode air dates (including future episodes).
export function useSonarrEpisodes(seriesId: number | null) {
  return useQuery({
    queryKey: ['sonarr', 'episodes', seriesId],
    queryFn: () => sonarr.episodes(seriesId as number),
    enabled: seriesId !== null,
    staleTime: 5 * 60_000,
  })
}
