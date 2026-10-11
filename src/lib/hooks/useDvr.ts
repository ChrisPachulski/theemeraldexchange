import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dvrApi, type DvrRecording } from '../api/dvr'
import { useLimits } from './useLimits'

const KEY = ['dvr', 'recordings'] as const

/** DVR surfaces show only when the server mounted /api/dvr (off in prod today). */
export function useDvrEnabled(): boolean {
  return useLimits().data?.dvrEnabled === true
}

export function useDvrRecordings(enabled = true) {
  return useQuery({ queryKey: KEY, queryFn: dvrApi.list, enabled, staleTime: 30_000 })
}

// The server owns status transitions, so a new row is never inserted
// optimistically; the list just refetches.
export function useScheduleRecording() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: dvrApi.schedule,
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  })
}

// Optimistic like Apple DvrStore.delete: the row goes at once and comes back
// if the DELETE fails.
export function useDeleteRecording() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: dvrApi.remove,
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: KEY })
      const prev = qc.getQueryData<DvrRecording[]>(KEY)
      if (prev) qc.setQueryData<DvrRecording[]>(KEY, prev.filter((r) => r.id !== id))
      return { prev }
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData<DvrRecording[]>(KEY, ctx.prev)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  })
}
