import { useQuery } from '@tanstack/react-query'
import { iptvApi, type ListParams } from '../api/iptv'

export function useIptvSeries(params: ListParams) {
  return useQuery({
    queryKey: ['iptv', 'series', params],
    queryFn: () => iptvApi.listSeries(params),
    staleTime: 5 * 60 * 1000,
  })
}

export function useIptvSeriesDetail(id: number | null) {
  return useQuery({
    queryKey: ['iptv', 'series', 'detail', id],
    queryFn: () => iptvApi.seriesDetail(id!),
    enabled: id != null,
    staleTime: 6 * 60 * 60 * 1000,
  })
}
