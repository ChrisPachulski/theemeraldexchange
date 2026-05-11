import { useQuery } from '@tanstack/react-query'
import { sab } from '../api/sab'
import { sonarr } from '../api/sonarr'
import { radarr } from '../api/radarr'
import { useDocumentVisible } from './useVisibility'

export function useDownloadQueue() {
  const visible = useDocumentVisible()
  return useQuery({
    queryKey: ['sab', 'queue'],
    queryFn: sab.queue,
    refetchInterval: visible ? 3000 : false,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  })
}

// Mirrors useDownloadQueue cadence — both feed the same panel and
// should stay in lockstep so the season-cluster math doesn't flicker
// between a stale Sonarr snapshot and a fresh SAB one.
export function useSonarrQueue() {
  const visible = useDocumentVisible()
  return useQuery({
    queryKey: ['sonarr', 'queue'],
    queryFn: sonarr.queue,
    refetchInterval: visible ? 3000 : false,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  })
}

// Same cadence as Sonarr queue — surfaces in-flight movie work
// (delay/pending/queued states) while SAB has no active slot, so the
// Downloads tab can show "indexer working" instead of "Queue is Open."
export function useRadarrQueue() {
  const visible = useDocumentVisible()
  return useQuery({
    queryKey: ['radarr', 'queue'],
    queryFn: radarr.queue,
    refetchInterval: visible ? 3000 : false,
    refetchIntervalInBackground: false,
    staleTime: 1500,
  })
}

export function useDownloadHistory(limit = 10) {
  return useQuery({
    queryKey: ['sab', 'history', limit],
    queryFn: () => sab.history(limit),
    staleTime: 30_000,
  })
}
