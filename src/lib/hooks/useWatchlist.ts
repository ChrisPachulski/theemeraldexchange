import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { applyToggle, watchlistApi, type WatchlistEntry, type WatchlistToggle } from '../api/watchlist'
import { useAuth } from '../auth'

// Keyed by account: a toggle that resolves after an account switch writes into
// its own account's entry, never the next account's list.
function useWatchlistKey() {
  return ['watchlist', useAuth().user?.sub] as const
}

export function useWatchlist() {
  return useQuery({ queryKey: useWatchlistKey(), queryFn: watchlistApi.list, staleTime: 60_000 })
}

/** Add or remove a title. The list flips at once; the server's echo replaces
 *  it, and a failed write puts the old list back. */
export function useToggleWatchlist() {
  const qc = useQueryClient()
  const key = useWatchlistKey()
  return useMutation({
    mutationFn: (t: WatchlistToggle) => watchlistApi.toggle(t),
    // The key rides the context: the hook re-renders under the next account
    // before a slow toggle resolves, and later callbacks see that render's key.
    onMutate: async (t) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<WatchlistEntry[]>(key)
      if (prev) qc.setQueryData(key, applyToggle(prev, t))
      return { prev, key }
    },
    onError: (_e, _t, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev)
    },
    onSuccess: (items, _t, ctx) => qc.setQueryData(ctx.key, items),
  })
}
