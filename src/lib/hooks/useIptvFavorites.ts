import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { iptvApi, type FavoriteRow } from '../api/iptv'

const KEY = ['iptv', 'favorites'] as const

type ToggleFavoriteInput = {
  kind: FavoriteRow['kind']
  itemId: string
  currentlyFav: boolean
}

export function useIptvFavorites() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => iptvApi.favorites(),
    staleTime: 5 * 60 * 1000,
  })
}

export function useIptvFavoriteSet(): Set<string> {
  const q = useIptvFavorites()
  return useMemo(
    () => new Set((q.data ?? []).map((f) => `${f.kind}:${f.item_id}`)),
    [q.data],
  )
}

export function useToggleIptvFavorite() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ kind, itemId, currentlyFav }: ToggleFavoriteInput) => {
      if (currentlyFav) await iptvApi.removeFavorite(kind, itemId)
      else await iptvApi.addFavorite(kind, itemId)
    },
    onMutate: async ({ kind, itemId, currentlyFav }) => {
      await qc.cancelQueries({ queryKey: KEY })
      const prev = qc.getQueryData<FavoriteRow[]>(KEY) ?? []
      const next = currentlyFav
        ? prev.filter((f) => !(f.kind === kind && f.item_id === itemId))
        : [
            { sub: '', kind, item_id: itemId, added_ts: new Date().toISOString() },
            ...prev.filter((f) => !(f.kind === kind && f.item_id === itemId)),
          ]
      qc.setQueryData<FavoriteRow[]>(KEY, next)
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData<FavoriteRow[]>(KEY, ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEY })
    },
  })
}
