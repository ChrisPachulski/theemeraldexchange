import { useQuery } from '@tanstack/react-query'
import { sab } from '../api/sab'
import { sonarr } from '../api/sonarr'
import { radarr } from '../api/radarr'
import { useDocumentVisible } from './useVisibility'

// All three queues poll in lockstep (same interval/staleTime) so the
// Downloads tab never mixes a stale Sonarr snapshot with a fresh SAB
// one — the season-cluster math would flicker otherwise.
function usePolledQueue<T>(queryKey: [string, string], queryFn: () => Promise<T>) {
  const visible = useDocumentVisible()
  return useQuery({
    queryKey,
    queryFn,
    refetchInterval: visible ? 3000 : false,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  })
}

export const useDownloadQueue = () => usePolledQueue(['sab', 'queue'], sab.queue)
export const useSonarrQueue = () => usePolledQueue(['sonarr', 'queue'], sonarr.queue)
export const useRadarrQueue = () => usePolledQueue(['radarr', 'queue'], radarr.queue)

export function useDownloadHistory(limit = 10) {
  return useQuery({
    queryKey: ['sab', 'history', limit],
    queryFn: () => sab.history(limit),
    staleTime: 30_000,
  })
}
