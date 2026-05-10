import { useQuery } from '@tanstack/react-query'
import { sab } from '../api/sab'
import { sonarr } from '../api/sonarr'
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

export function useDownloadHistory(limit = 10) {
  return useQuery({
    queryKey: ['sab', 'history', limit],
    queryFn: () => sab.history(limit),
    staleTime: 30_000,
  })
}
