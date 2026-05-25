import { useQuery } from '@tanstack/react-query'
import { iptvApi } from '../api/iptv'

function stableChannelIds(channelIds: number[]): number[] {
  return [...new Set(channelIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b)
}

export function useIptvEpgNow(channelIds: number[]) {
  const ids = stableChannelIds(channelIds)
  return useQuery({
    queryKey: ['iptv', 'epg', 'now', ids.join(',')],
    queryFn: () => iptvApi.epgNow(ids),
    staleTime: 60_000,
    enabled: ids.length > 0,
  })
}

export function useIptvEpgGrid(fromIso: string, toIso: string, categoryId?: number) {
  return useQuery({
    queryKey: ['iptv', 'epg', 'grid', fromIso, toIso, categoryId ?? null],
    queryFn: () => iptvApi.epgGrid(fromIso, toIso, categoryId),
    staleTime: 60_000,
  })
}

export function useIptvEpgChannel(channelId: number | null, fromIso: string, toIso: string) {
  return useQuery({
    queryKey: ['iptv', 'epg', 'channel', channelId, fromIso, toIso],
    queryFn: () => iptvApi.epgChannel(channelId!, fromIso, toIso),
    enabled: channelId != null,
    staleTime: 60_000,
  })
}
