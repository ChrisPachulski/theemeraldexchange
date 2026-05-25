import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { iptvApi, type HistoryRow, type IptvHistoryKind, type PutHistoryInput } from '../api/iptv'

const KEY = ['iptv', 'history'] as const
const REPORT_INTERVAL_MS = 5000

export function useIptvHistory(limit = 50) {
  return useQuery({
    queryKey: [...KEY, limit],
    queryFn: () => iptvApi.history(limit),
    staleTime: 60_000,
  })
}

export function useIptvHistoryIndex(): Map<string, HistoryRow> {
  const q = useIptvHistory(100)
  return useMemo(() => {
    const map = new Map<string, HistoryRow>()
    for (const row of q.data ?? []) map.set(`${row.kind}:${row.item_id}`, row)
    return map
  }, [q.data])
}

export function useReportPosition(kind: IptvHistoryKind, itemId: string) {
  const qc = useQueryClient()
  const lastReportTs = useRef<number>(0)
  const { mutate } = useMutation({
    mutationFn: (input: PutHistoryInput) => iptvApi.putHistory(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
    },
  })

  useEffect(() => {
    lastReportTs.current = 0
  }, [kind, itemId])

  return useCallback((positionSecs: number, durationSecs?: number | null, completed?: boolean) => {
    const now = Date.now()
    if (now - lastReportTs.current < REPORT_INTERVAL_MS) return
    lastReportTs.current = now
    mutate({ kind, itemId, positionSecs, durationSecs, completed })
  }, [kind, itemId, mutate])
}
