import { useCallback, useMemo } from 'react'
import { useLimits } from './useLimits'
import { useSuggested } from './useSuggested'
import { useSuggestionMode, type SuggestionMode } from './useSuggestionMode'
import { useUserApiKey } from './useUserApiKey'
import { useFeedback, useSetFeedback } from './useUserFeedback'
import type { TrendingItem } from './useTrending'
import type { DotState } from '../../components/search/FeedbackDots'

// Shared orchestration for the Discover suggestion strip (TrendingRow)
// on the Movies and TV tabs. The two tabs were 600-line twins whose
// strip wiring (personalization gating, mode toggle, library filtering,
// feedback dots, refresh) had drifted-copy risk; this hook is the single
// home for that behavior. The PICK flow (card click -> Radarr/Sonarr
// lookup -> DetailModal) stays in the tabs — it genuinely differs.
//
// OWNER-MANDATED refresh semantics (do not change here or in consumers):
// the lineup is cached for the session and only ever replaced by
//   1. the strip's explicit Refresh button (refresh() below),
//   2. a dislike draining the strip to its low-water mark
//      (useSetFeedback's lazy refill), or
//   3. a natural remount.
// A *like* must NEVER swap the lineup, and nothing here may invalidate
// or refetch the ['suggestions'] queries on judgement/toggle/remount.
// History: the auto-refresh-on-all-judged, the trending tail-padding,
// and the staleTime:0 churn were each removed after explicit owner
// complaints — see useSuggested's module header.

export type SuggestionStripFeedback = {
  stateFor: (id: number) => DotState
  onLike: (id: number, title: string) => void
  onDislike: (id: number, title: string) => void
  /** True when the feedback store is unreachable — dots render disabled. */
  unavailable: boolean
  /** The latest optimistic mutation rolled back. Keep dots enabled so the
   * user can retry, but surface the failure instead of silently reverting. */
  saveFailed?: boolean
}

export type SuggestionStrip = {
  /** The raw suggestions query — loading/error/source/diag/isFetching. */
  suggested: ReturnType<typeof useSuggested>
  /** Library-filtered, id-deduped items ready for TrendingRow. */
  items: TrendingItem[]
  /** Strip header label, adjusted to the served source. */
  label: string
  /** Explicit-refresh trigger (the header button). Stable identity. */
  refresh: () => void
  /** Per-card feedback-dot wiring for TrendingRow. */
  feedback: SuggestionStripFeedback
  /** Recommended <-> Trending toggle; undefined when personalization is
   *  not achievable (nothing to switch to). */
  mode?: { value: SuggestionMode; onChange: (next: SuggestionMode) => void }
  /** True when the local recommender runs or the user has a BYO key. */
  personalizedAchievable: boolean
}

export function useSuggestionStrip(
  kind: 'movie' | 'tv',
  /** TMDB ids already in the household library. Defense in depth — the
   *  backend filters too; this catches races (just-added title, etc.). */
  libraryTmdbIds: ReadonlySet<number>,
): SuggestionStrip {
  const userKey = useUserApiKey()
  const limits = useLimits()
  const localRecommender = limits.data?.useLocalRecommender === true
  // Personalization is achievable when the free on-NAS recommender runs,
  // or the user supplied a BYO Anthropic key. The Recommended <-> Trending
  // toggle is only meaningful when it is. Default to Recommended only when
  // it's free (local recommender); BYO-key-only deployments default to
  // Trending so they don't spend tokens until the user opts in.
  const personalizedAchievable = localRecommender || userKey.hasKey
  const { mode: suggestionMode, setMode: setSuggestionMode } = useSuggestionMode(
    localRecommender ? 'recommended' : 'trending',
  )
  const forceTrending = !personalizedAchievable || suggestionMode === 'trending'
  // The fingerprint (masked last-4, non-secret) only discriminates the
  // query cache — the actual key lives server-side and never rides a
  // request from the browser.
  const suggested = useSuggested(kind, forceTrending, userKey.fingerprint)

  const feedbackQuery = useFeedback()
  const setFeedback = useSetFeedback(kind)
  const stateFor = useCallback(
    (id: number): DotState => {
      const fb = feedbackQuery.data?.[kind]
      if (!fb) return 'unset'
      if (fb.liked.some((e) => e.id === id)) return 'liked'
      if (fb.disliked.some((e) => e.id === id)) return 'disliked'
      return 'unset'
    },
    [feedbackQuery.data, kind],
  )

  // Filter out library overlap and dedupe by id (TrendingRow keys on
  // item.id; a duplicate would render twice and emit a React warning).
  const items = useMemo(() => {
    const seen = new Set<number>()
    return (suggested.data?.items ?? []).filter((t) => {
      if (libraryTmdbIds.has(t.id)) return false
      if (seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
  }, [suggested.data, libraryTmdbIds])

  // Manual refresh trigger = a fresh recommender run. refetch() re-hits
  // /api/suggestions/<kind>, which (local recommender on) re-scores.
  // Depend on the stable refetch fn, not the whole query result — the
  // result object is a fresh reference every render and would make this
  // memo a no-op.
  const refetch = suggested.refetch
  const refresh = useCallback(() => {
    void refetch()
  }, [refetch])

  // Label adjusts based on whether the backend served personalized recs
  // or fell back to TMDB trending (cold start or no API key).
  // 'recommender' is the local-model source — also a personalized pick,
  // just from the on-NAS model rather than Claude.
  const src = suggested.data?.source
  const label =
    src && (src.startsWith('personalized') || src === 'recommender')
      ? 'Picked for you'
      : kind === 'movie'
        ? 'Trending movies this week'
        : 'Trending this week'

  const feedback: SuggestionStripFeedback = {
    stateFor,
    onLike: (id, title) => {
      const current = stateFor(id)
      setFeedback.mutate({ tmdbId: id, title, signal: current === 'liked' ? null : 'like' })
    },
    onDislike: (id, title) => {
      const current = stateFor(id)
      setFeedback.mutate({ tmdbId: id, title, signal: current === 'disliked' ? null : 'dislike' })
    },
    // Feedback store unreachable -> dots render disabled with a tooltip +
    // inline label hint. Otherwise dots silently appear "unset,"
    // indistinguishable from a clean first-run.
    unavailable: !!feedbackQuery.error,
    saveFailed: !!setFeedback.error,
  }

  return {
    suggested,
    items,
    label,
    refresh,
    feedback,
    mode: personalizedAchievable
      ? { value: suggestionMode, onChange: setSuggestionMode }
      : undefined,
    personalizedAchievable,
  }
}
