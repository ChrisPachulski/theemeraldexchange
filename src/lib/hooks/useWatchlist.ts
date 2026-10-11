import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { applyToggle, watchlistApi, type WatchlistEntry, type WatchlistToggle } from '../api/watchlist'

const KEY = ['watchlist']

export function useWatchlist() {
  return useQuery({ queryKey: KEY, queryFn: watchlistApi.list, staleTime: 60_000 })
}

/** Add or remove a title. The list flips at once; the server's echo replaces
 *  it, and a failed write puts the old list back. */
export function useToggleWatchlist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (t: WatchlistToggle) => watchlistApi.toggle(t),
    onMutate: async (t) => {
      await qc.cancelQueries({ queryKey: KEY })
      const prev = qc.getQueryData<WatchlistEntry[]>(KEY)
      if (prev) qc.setQueryData(KEY, applyToggle(prev, t))
      return { prev }
    },
    onError: (_e, _t, ctx) => {
      if (ctx?.prev) qc.setQueryData(KEY, ctx.prev)
    },
    onSuccess: (items) => qc.setQueryData(KEY, items),
  })
}
