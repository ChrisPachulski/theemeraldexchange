import { useQuery } from '@tanstack/react-query'
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

type SuggestionSource =
  | 'personalized'
  | 'personalized_filled'
  | 'personalized_empty_trending_fallback'
  | 'trending'
  | 'trending_fallback'

export type SuggestionDiag = {
  libraryCount?: number
  rejectionCount?: number
  /** Top-5 genre distribution of the library — e.g. ["Drama 42%", "Crime 28%"]. Mirrors the TARGET GENRE MIX Claude was instructed to follow. */
  libraryGenres?: string[]
  accepted?: number
  retryAttempted?: boolean
  fillSource?: string
  reason?: string
  /** Anthropic error message when reason === 'claude_threw'. */
  claudeError?: string
  /** Anthropic HTTP status when reason === 'claude_threw'. */
  claudeStatus?: number
  /** Number of items in the pre-fetched TMDB candidate pool (iter 8). */
  poolSize?: number
  /** Number of Claude picks that matched a pool item (bypassed TMDB /search). */
  poolHits?: number
  /** Fraction of accepted picks that were pool hits (0.0–1.0). 1.0 = all picks from pool; 0.0 = pool didn't help. */
  poolHitRate?: number
  /** Cold-start: minimum library size required for personalized recs. */
  threshold?: number
  /** Cold-start: human-readable hint on how to unlock personalization. */
  hint?: string
  /** Total Claude picks dropped by validation (library match + reject + lookup null + dedupe). Cost transparency. */
  droppedPicks?: number
  /** Estimated cost of this refresh in cents (Haiku 4.5 rates). Helps household monitor API spend. */
  costCents?: number
  /** True when Claude stopped generating early due to max_tokens — picks may be incomplete. */
  claudeTruncated?: boolean
  lastCounters?: {
    lookupNulls?: number
    droppedAsDedupe?: number
    droppedAsRejected?: number
    droppedAsLibrary?: number
    droppedAsYearMismatch?: number
    poolHits?: number
  }
}

// Where this card actually came from. Mirrors the server-side
// SuggestionProvenance type. Lets the UI render personalized picks
// differently from discover/trending fills.
export type SuggestionProvenance = 'personalized' | 'discover' | 'trending'

type SuggestionsResponse = {
  source: SuggestionSource
  items: Array<{
    id: number
    title: string
    posterPath: string | null
    overview?: string
    year?: number
    provenance?: SuggestionProvenance
    reason?: string | null
  }>
  _diag?: SuggestionDiag
}

export type SuggestionResult = {
  items: TrendingItem[]
  source: SuggestionSource | null
  diag: SuggestionDiag | null
}

export class SuggestionsError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`suggestions ${status}: ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
  }
}

async function fetchSuggested(
  kind: 'movie' | 'tv',
  aiEnabled: boolean,
  apiKey: string | null,
): Promise<SuggestionResult> {
  // AI only flips on when both the toggle says yes AND the user has
  // an API key. Without a key, force ?force=trending so the backend
  // skips the (now-required) BYO key check and returns TMDB trending.
  const useAi = aiEnabled && !!apiKey
  const url = useAi
    ? apiUrl(`/api/suggestions/${kind}`)
    : apiUrl(`/api/suggestions/${kind}`, { force: 'trending' })
  const headers: Record<string, string> = {}
  if (useAi && apiKey) headers['X-Anthropic-Api-Key'] = apiKey
  const r = await fetch(url, { credentials: 'include', headers })
  if (!r.ok) {
    // Throw instead of returning empty so React Query surfaces
    // suggested.isError / suggested.error to the UI. Silently
    // collapsing 401/402/429/5xx into "no results" hid every backend
    // failure mode behind an indistinguishable blank strip.
    const body = await r.text().catch(() => '')
    throw new SuggestionsError(r.status, body)
  }
  const data = (await r.json()) as SuggestionsResponse
  return {
    items: (data.items ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      posterPath: row.posterPath,
      overview: row.overview,
      year: row.year,
      provenance: row.provenance,
      reason: row.reason ?? null,
    })),
    source: data.source ?? null,
    diag: data._diag ?? null,
  }
}

export function useSuggestedMovies(aiEnabled: boolean, apiKey: string | null) {
  return useQuery({
    queryKey: ['suggestions', 'movie', aiEnabled && apiKey ? 'ai' : 'trending'],
    queryFn: () => fetchSuggested('movie', aiEnabled, apiKey),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: (failureCount, err) => {
      // Don't retry 4xx — the user needs to fix their key / re-auth,
      // not wait for a network blip.
      if (err instanceof SuggestionsError && err.status >= 400 && err.status < 500) return false
      return failureCount < 1
    },
  })
}

export function useSuggestedTv(aiEnabled: boolean, apiKey: string | null) {
  return useQuery({
    queryKey: ['suggestions', 'tv', aiEnabled && apiKey ? 'ai' : 'trending'],
    queryFn: () => fetchSuggested('tv', aiEnabled, apiKey),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: (failureCount, err) => {
      if (err instanceof SuggestionsError && err.status >= 400 && err.status < 500) return false
      return failureCount < 1
    },
  })
}

// useDismissSuggestion is superseded by useSetFeedback in
// useUserFeedback.ts. The dot-click flow there handles the same
// "hide this card forever" path via the per-user dislike signal,
// which the backend also rolls into the household rejection list.
