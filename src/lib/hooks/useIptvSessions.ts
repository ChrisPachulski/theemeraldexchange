import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { iptvApi } from '../api/iptv'

// Polled every 5s so the connections widget reflects what's actually
// holding slots without the user having to refresh. 5s matches the
// player's history-report cadence so we don't beat the server harder
// than necessary.
export function useIptvSessions() {
  return useQuery({
    queryKey: ['iptv', 'sessions'],
    queryFn: () => iptvApi.listSessions(),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  })
}

export function useKillIptvSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => iptvApi.killSession(sessionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['iptv', 'sessions'] })
    },
  })
}
