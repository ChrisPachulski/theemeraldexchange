import { useQuery } from '@tanstack/react-query'
import { iptvApi } from '../api/iptv'

export function useIptvCategories(kind: 'live' | 'vod' | 'series') {
  return useQuery({
    queryKey: ['iptv', 'categories', kind],
    queryFn: () => iptvApi.categories(kind),
    staleTime: 6 * 60 * 60 * 1000,
  })
}
