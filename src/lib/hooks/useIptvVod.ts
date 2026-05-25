import { useQuery } from '@tanstack/react-query'
import { iptvApi, type ListParams } from '../api/iptv'

export function useIptvVod(params: ListParams) {
  return useQuery({
    queryKey: ['iptv', 'vod', params],
    queryFn: () => iptvApi.listVod(params),
    staleTime: 5 * 60 * 1000,
  })
}

export function useIptvVodDetail(id: number | null) {
  return useQuery({
    queryKey: ['iptv', 'vod', 'detail', id],
    queryFn: () => iptvApi.vodDetail(id!),
    enabled: id != null,
    staleTime: 6 * 60 * 60 * 1000,
  })
}
