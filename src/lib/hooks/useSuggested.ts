import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../api/base'
import type { TrendingItem } from './useTrending'

// Library-aware personalized suggestions for the Discover surface. The
// backend asks Claude on every refresh — output is taste-matched
// against what's already in the library, with explicit rejections
// filtered out (and also passed to Claude in-prompt).
//
// Always re-fetches on mount (`staleTime: 0`, `refetchOnMount: 'always'`)
// per the product spec. Variety comes from temperature on the backend
// plus a prompt instruction not to return identical lists.

type SuggestionSource = 'personalized' | 'trending' | 'trending_fallback'

type SuggestionsResponse = {
  source: SuggestionSource
  items: Array<{
    id: number
    title: string
    posterPath: string | null
    overview?: string
    year?: number
  }>
}

export type SuggestionResult = {
  items: TrendingItem[]
  source: SuggestionSource | null
}

async function fetchSuggested(kind: 'movie' | 'tv'): Promise<SuggestionResult> {
  const r = await fetch(apiUrl(`/api/suggestions/${kind}`), { credentials: 'include' })
  if (!r.ok) return { items: [], source: null }
  const data = (await r.json()) as SuggestionsResponse
  return {
    items: (data.items ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      posterPath: row.posterPath,
      overview: row.overview,
      year: row.year,
    })),
    source: data.source ?? null,
  }
}

export function useSuggestedMovies() {
  return useQuery({
    queryKey: ['suggestions', 'movie'],
    queryFn: () => fetchSuggested('movie'),
    staleTime: 0,
    refetchOnMount: 'always',
  })
}

export function useSuggestedTv() {
  return useQuery({
    queryKey: ['suggestions', 'tv'],
    queryFn: () => fetchSuggested('tv'),
    staleTime: 0,
    refetchOnMount: 'always',
  })
}

// Dismiss a suggestion forever. Optimistically removes the item from
// the in-memory query result so the card disappears immediately, then
// POSTs to /api/rejections so future refreshes never resurrect it.
export function useDismissSuggestion(kind: 'movie' | 'tv') {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (tmdbId: number) => {
      const r = await fetch(apiUrl('/api/rejections'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: kind, tmdbId }),
      })
      if (!r.ok) throw new Error(`rejection ${r.status}`)
    },
    onMutate: async (tmdbId) => {
      const key = ['suggestions', kind]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<SuggestionResult>(key)
      if (prev) {
        qc.setQueryData<SuggestionResult>(key, {
          ...prev,
          items: prev.items.filter((i) => i.id !== tmdbId),
        })
      }
      return { prev }
    },
    onError: (_e, _id, ctx) => {
      // Roll back the optimistic removal if the network call failed.
      if (ctx?.prev) qc.setQueryData(['suggestions', kind], ctx.prev)
    },
  })
}
