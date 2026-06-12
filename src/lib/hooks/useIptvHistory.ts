import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { iptvApi, type HistoryRow, type IptvHistoryKind, type PutHistoryInput } from '../api/iptv'

const KEY = ['iptv', 'history'] as const
const REPORT_INTERVAL_MS = 5000

/** The history-row fields the resume helpers read — a structural subset of
 *  HistoryRow so any row (or a hand-built test row) satisfies it. */
export type ResumeFields = Pick<HistoryRow, 'position_secs' | 'duration_secs' | 'completed'>

/** Resume progress as a 0-100 percentage for the card/episode resume bars, or
 *  null when there's nothing to show (no row, or already completed). A row with
 *  no known duration shows an empty bar (0) rather than hiding it. */
export function resumePercent(row: ResumeFields | undefined): number | null {
  if (!row || row.completed) return null
  if (!row.duration_secs || row.duration_secs <= 0) return 0
  return Math.min(100, Math.max(0, (row.position_secs / row.duration_secs) * 100))
}

/** The seconds offset to resume from, or undefined when there's no resume point
 *  (no row, completed, or position at/below 0). undefined — never 0 — so the
 *  player treats it as a fresh start. */
export function resumePosition(row: ResumeFields | undefined): number | undefined {
  if (!row || row.completed || row.position_secs <= 0) return undefined
  return row.position_secs
}

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
