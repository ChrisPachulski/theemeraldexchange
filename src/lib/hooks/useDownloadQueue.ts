import { useQuery } from '@tanstack/react-query'
import { sab } from '../api/sab'
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

export function useDownloadHistory(limit = 10) {
  return useQuery({
    queryKey: ['sab', 'history', limit],
    queryFn: () => sab.history(limit),
    staleTime: 30_000,
  })
}
