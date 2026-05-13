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

async function fetchSuggested(
  kind: 'movie' | 'tv',
  aiEnabled: boolean,
): Promise<SuggestionResult> {
  // When AI is off, append ?force=trending so the backend skips the
  // Claude call and returns TMDB trending instead — free + instant.
  const url = aiEnabled
    ? apiUrl(`/api/suggestions/${kind}`)
    : apiUrl(`/api/suggestions/${kind}`, { force: 'trending' })
  const r = await fetch(url, { credentials: 'include' })
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

export function useSuggestedMovies(aiEnabled: boolean) {
  return useQuery({
    queryKey: ['suggestions', 'movie', aiEnabled ? 'ai' : 'trending'],
    queryFn: () => fetchSuggested('movie', aiEnabled),
    staleTime: 0,
    refetchOnMount: 'always',
  })
}

export function useSuggestedTv(aiEnabled: boolean) {
  return useQuery({
    queryKey: ['suggestions', 'tv', aiEnabled ? 'ai' : 'trending'],
    queryFn: () => fetchSuggested('tv', aiEnabled),
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
      // Prefix cancel — covers both ['suggestions', kind, 'ai'] and
      // ['suggestions', kind, 'trending'] cache entries since toggling
      // the AI switch swaps between them.
      await qc.cancelQueries({ queryKey: ['suggestions', kind] })
      const variants = [
        ['suggestions', kind, 'ai'] as const,
        ['suggestions', kind, 'trending'] as const,
      ]
      const snapshot = variants.map((key) => ({
        key,
        prev: qc.getQueryData<SuggestionResult>(key),
      }))
      for (const { key, prev } of snapshot) {
        if (prev) {
          qc.setQueryData<SuggestionResult>(key, {
            ...prev,
            items: prev.items.filter((i) => i.id !== tmdbId),
          })
        }
      }
      return { snapshot }
    },
    onError: (_e, _id, ctx) => {
      // Roll back optimistic removal across both cache slots.
      for (const { key, prev } of ctx?.snapshot ?? []) {
        if (prev) qc.setQueryData(key, prev)
      }
    },
  })
}
