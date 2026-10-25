import { useQuery } from '@tanstack/react-query'
import { iptvApi, type ListParams } from '../api/iptv'

export function useIptvLive(params: ListParams, enabled = true) {
  return useQuery({
    queryKey: ['iptv', 'live', params],
    queryFn: () => iptvApi.listLive(params),
    staleTime: 5 * 60 * 1000,
    enabled,
  })
}
