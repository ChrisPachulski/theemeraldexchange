import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../api/base'
import { errorStatus, throwApiError } from '../api/errors'
import type { TrendingItem } from './useTrending'

// Library-aware personalized suggestions for the Discover surface. The
// backend asks Claude (or the local recommender) for a taste-matched
// lineup, scored against the library with explicit rejections filtered
// out (and also passed in-prompt).
//
// The lineup is CACHED for the session (`staleTime: Infinity`) and only
// refreshed on an explicit user action — the strip's Refresh button
// (`refetch()`, which bypasses staleTime), or a dislike draining the
// strip to its low-water mark (useSetFeedback invalidates this key).
// It deliberately does NOT re-fetch on mount or on toggling the
// Recommended ⇄ Trending switch: re-running on every remount/toggle
// yanked the lineup out from under the user mid-browse — flipping to
// Trending and back re-ran the whole (slow, paid) recommender, and any
// surface remount swapped the picks before the user could act on the
// one they were eyeing. Stability while browsing beats churn; variety
// still comes from the backend's temperature on each explicit refresh.

type SuggestionSource =
  | 'personalized'
  | 'personalized_filled'
  | 'personalized_empty_trending_fallback'
  | 'recommender'
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
  /** Number of Claude API calls made for this request (1 = initial only, 2 = initial + retry). Max is MAX_CLAUDE_CALLS_PER_REQUEST=2. */
  callCount?: number
  /** Anthropic prompt cache hit rate (0.0–1.0). 1.0 = library block fully cached (10x cheaper); 0.0 = no cache hit (first call of day or library changed). */
  cacheHitRate?: number
  /** Number of items in the recently-shown buffer (after pool-size cap). Helps diagnose whether the cap is preventing power-user saturation (iter 65). */
  recentlyShownCount?: number
  /** Server-side path tag — e.g. 'recommender_fallback_trending' when
   *  the local recommender returned nothing usable and the route
   *  degraded to TMDB trending. Used by the SPA to surface the right
   *  hint (a recommender outage is NOT a missing-Anthropic-key
   *  problem). */
  path?: string
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
    available_on?: string[]
  }>
  _diag?: SuggestionDiag
}

export type SuggestionResult = {
  items: TrendingItem[]
  source: SuggestionSource | null
  diag: SuggestionDiag | null
}

async function fetchSuggested(
  kind: 'movie' | 'tv',
  forceTrending: boolean,
): Promise<SuggestionResult> {
  // forceTrending is the caller's resolved decision (see the tabs): the
  // user picked "Trending", OR personalization isn't achievable (no local
  // recommender and no BYO key). When forcing trending we send
  // ?force=trending so the backend serves TMDB trending in every mode —
  // including local-recommender mode, which otherwise always personalizes.
  const url = forceTrending
    ? apiUrl(`/api/suggestions/${kind}`, { force: 'trending' })
    : apiUrl(`/api/suggestions/${kind}`)
  // No key header: the BYO Anthropic key lives server-side now (PUT
  // /api/settings/anthropic-key) and the legacy Claude path reads the
  // stored key itself when the header is absent. The browser never
  // holds the key post-migration.
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) {
    // Throw instead of returning empty so React Query surfaces
    // suggested.isError / suggested.error to the UI. Silently
    // collapsing 401/402/429/5xx into "no results" hid every backend
    // failure mode behind an indistinguishable blank strip.
    await throwApiError(r, 'Suggestions')
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
      available_on: row.available_on,
    })),
    source: data.source ?? null,
    diag: data._diag ?? null,
  }
}

export function useSuggested(
  kind: 'movie' | 'tv',
  forceTrending: boolean,
  /** Masked server fingerprint of the user's stored key (useUserApiKey),
   *  or null when no key is set. Non-secret cache discriminator only. */
  keyFingerprint: string | null,
) {
  // Third segment is the resolved feed (trending vs recommended) so
  // flipping the toggle is a distinct query that refetches. Fourth is
  // the non-secret masked fingerprint of the stored key: when the key
  // changes (set/replace/clear via /api/settings/anthropic-key), the
  // query key changes, so TanStack Query treats it as a different query
  // and refetches instead of serving a lineup minted under the old key.
  return useQuery({
    queryKey: ['suggestions', kind, forceTrending ? 'trending' : 'recommended', keyFingerprint ?? 'none'],
    queryFn: () => fetchSuggested(kind, forceTrending),
    // Cache the lineup for the session; refresh only on explicit action
    // (Refresh button refetch / dislike low-water invalidation). See the
    // module header for why mount/toggle must NOT re-fetch.
    staleTime: Infinity,
    retry: (failureCount, err) => {
      // Don't retry 4xx — the user needs to fix their key / re-auth,
      // not wait for a network blip.
      const status = errorStatus(err)
      if (status !== undefined && status >= 400 && status < 500) return false
      return failureCount < 1
    },
  })
}

// useDismissSuggestion is superseded by useSetFeedback in
// useUserFeedback.ts. The dot-click flow there handles the same
// "hide this card forever" path via the per-user dislike signal,
// which the backend also rolls into the household rejection list.
