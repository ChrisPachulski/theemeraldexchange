import type { ReactNode } from 'react'
import type { TrendingItem } from '../../lib/hooks/useTrending'
import type { SuggestionDiag } from '../../lib/hooks/useSuggested'
import type { SuggestionMode } from '../../lib/hooks/useSuggestionMode'
import { StripModeToggle } from './StripModeToggle'
import { FeedbackDots, type DotState } from './FeedbackDots'
import './TrendingRow.css'

// Suggestion strip rendered on Movies + TV Discover surfaces. Sources:
//   - personalized: Claude-backed recommendations (when the user has
//     their AI key set and the toggle is on)
//   - trending:     TMDB trending feed (cold-start, AI off, or no key)
//
// Each card has a pair of feedback dots below the caption — red for
// "don't suggest again" (per-user dislike, household-wide veto), green
// for "show me more like this" (per-user positive signal to Claude).

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

type Props = {
  items: TrendingItem[]
  loading?: boolean
  onPick: (id: number) => void
  /** True while a card's lookup-then-open flow is mid-flight. */
  pendingId?: number | null
  label?: string
  /**
   * Per-card feedback state lookup. When provided, the dots row
   * renders under each card; clicking fires onLike/onDislike.
   */
  feedback?: {
    stateFor: (id: number) => DotState
    onLike: (id: number, title: string) => void
    onDislike: (id: number, title: string) => void
    /** True when the feedback store is unreachable. Dots render
     *  disabled with a "feedback unavailable" tooltip and the label
     *  carries an inline hint so the user can tell the difference
     *  between "I haven't set any dots" and "dots can't load." */
    unavailable?: boolean
  }
  /**
   * Optional Recommended ⇄ Trending toggle anchored to the bottom-right
   * of the section. When provided, the household can switch between their
   * personalized picks and TMDB trending without leaving the surface.
   * Hide entirely when personalization isn't achievable (no local
   * recommender and no API key) — there's nothing to switch to.
   */
  mode?: { value: SuggestionMode; onChange: (next: SuggestionMode) => void }
  /** Fetch error from the suggestions query, if any. Surfaces 4xx/5xx
   * to the user instead of rendering an indistinguishable blank strip. */
  error?: unknown
  /** Response `source` for the current items — used to show "trending
   * fallback (Claude unreachable)" hints so silent degradations are
   * visible. */
  source?: string | null
  /** Response `_diag` payload for the current items. Drives the
   * specific "why is this empty" hint when accepted=0. */
  diag?: SuggestionDiag | null
  /** Manual refresh trigger. When provided, a refresh button renders in
   * the strip header AND the strip never collapses to `null` on an empty
   * round — so the control is always reachable even when the recommender
   * returns nothing (the local-recommender-mode "strip vanished" bug). */
  onRefresh?: () => void
  /** True while a refresh/refetch is in flight. Disables + spins the
   * refresh button so repeated taps don't stack duplicate runs. */
  refreshing?: boolean
}

// Strip header: the section label plus the optional refresh control,
// laid out on one row. Used by every TrendingRow branch (loaded, empty,
// error) so the refresh affordance and label placement stay identical
// regardless of state. `children` carries the inline source/feedback
// hints that the loaded state appends after the label text.
function StripHeader({
  label,
  onRefresh,
  refreshing,
  children,
}: {
  label?: string
  onRefresh?: () => void
  refreshing?: boolean
  children?: ReactNode
}) {
  return (
    <div className="trending__header">
      <h3 className="trending__label">
        {label ?? 'Trending this week'}
        {children}
      </h3>
      {onRefresh && (
        <button
          type="button"
          className={`trending__refresh${refreshing ? ' trending__refresh--busy' : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh suggestions"
          title="Refresh suggestions"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
            <path
              d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}

function describeError(error: unknown): { headline: string; hint: string } {
  const e = error as { status?: number; body?: string; message?: string } | undefined
  const status = e?.status
  if (status === 401 || status === 403) {
    return { headline: 'Session expired', hint: 'Try signing out and back in.' }
  }
  if (status === 402) {
    return {
      headline: 'AI key needed for personalized picks',
      hint: 'Open the user menu and paste your Anthropic API key (starts with sk-ant-…).',
    }
  }
  if (status === 429) {
    return { headline: 'Rate limited', hint: 'Too many requests — try again in a minute.' }
  }
  if (typeof status === 'number' && status >= 500) {
    return { headline: 'Suggestions service errored', hint: 'Check the server logs and refresh.' }
  }
  return {
    headline: 'Couldn’t load suggestions',
    hint: e?.message ?? 'Network or backend error — refresh to retry.',
  }
}

// Pick the dominant reason from the per-pick drop counters so the
// empty-strip hint reflects what actually killed the request, not a
// generic catch-all. Returns null when the diag is missing or the
// counters don't strongly point at one cause.
function dominantDropReason(
  counters: NonNullable<SuggestionDiag['lastCounters']> | undefined,
): string | null {
  if (!counters) return null
  const entries: Array<[string, number]> = [
    ['library', counters.droppedAsLibrary ?? 0],
    ['rejected', counters.droppedAsRejected ?? 0],
    ['lookup', counters.lookupNulls ?? 0],
    ['year', counters.droppedAsYearMismatch ?? 0],
    ['dedupe', counters.droppedAsDedupe ?? 0],
  ]
  const total = entries.reduce((s, [, n]) => s + n, 0)
  if (total === 0) return null
  const [top, topN] = entries.sort((a, b) => b[1] - a[1])[0]
  // Only call out a dominant cause when it's the clear majority.
  if (topN / total < 0.5) return null
  switch (top) {
    case 'library':
      return 'Most picks were already in your library — try a wider library or be patient as Claude rotates.'
    case 'rejected':
      return 'Most picks were on your NEVER list — try clearing a few red dots.'
    case 'lookup':
      return 'Most picks didn’t resolve on TMDB (rate-limit or unknown title). Try again in a moment.'
    case 'year':
      return 'Most picks were dropped on year mismatch — likely a Claude/TMDB year disagreement.'
    case 'dedupe':
      return 'Most picks were duplicates of each other. Refresh to get a new batch.'
    default:
      return null
  }
}

function describeEmptySource(
  source: string | null | undefined,
  diag: SuggestionDiag | null | undefined,
): string | null {
  // Cold-start path: library too small for meaningful taste signal.
  // Surface the actionable hint so the user knows exactly what to do.
  if (source === 'trending' && diag?.reason === 'library_below_threshold') {
    return diag.hint ?? `Your library needs ${diag.threshold ?? 10}+ titles for personalized picks — showing trending for now.`
  }
  if (source === 'trending_fallback') {
    if (diag?.reason === 'claude_threw') {
      const status = diag.claudeStatus
      const msg = diag.claudeError
      const prefix =
        status === 401 ? 'AI key rejected (401)'
        : status === 402 ? 'AI account out of credit (402)'
        : status === 429 ? 'Anthropic rate-limited (429)'
        : status === 413 ? 'Prompt too large (413)'
        : typeof status === 'number' && status >= 500 ? `Anthropic outage (${status})`
        : 'Claude errored'
      return msg ? `${prefix}: ${msg.slice(0, 200)} — showing trending.` : `${prefix} — showing trending.`
    }
    return 'Claude was unreachable — showing trending instead.'
  }
  if (source === 'personalized_empty_trending_fallback') {
    const specific = dominantDropReason(diag?.lastCounters)
    if (specific) return specific
    // No clear majority — Claude likely returned an empty/short list.
    return 'Claude returned no usable picks this round. Refresh to try again, or check the server log.'
  }
  return null
}

export function TrendingRow({
  items,
  loading,
  onPick,
  pendingId,
  label,
  feedback,
  mode,
  error,
  source,
  diag,
  onRefresh,
  refreshing,
}: Props) {
  if (error) {
    const { headline, hint } = describeError(error)
    return (
      <section className="trending">
        <StripHeader label={label} onRefresh={onRefresh} refreshing={refreshing} />
        <div className="trending__empty">
          <p className="trending__empty-headline">{headline}</p>
          <p className="trending__empty-hint">{hint}</p>
        </div>
        {mode && (
          <div className="trending__footer">
            <StripModeToggle value={mode.value} onChange={mode.onChange} />
          </div>
        )}
      </section>
    )
  }

  if (loading) {
    return (
      <section className="trending" aria-busy="true">
        <h3 className="trending__label trending__label--loading">
          {mode?.value === 'recommended' ? 'Finding picks for you' : 'Loading trending'}
          <span className="trending__loading-dot" aria-hidden="true" />
          {mode?.value === 'recommended' && (
            <span className="trending__loading-hint">takes a few seconds…</span>
          )}
        </h3>
        <div className="trending__row">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="trending__card trending__card--skeleton" />
          ))}
        </div>
        {mode && (
          <div className="trending__footer">
            <StripModeToggle value={mode.value} onChange={mode.onChange} />
          </div>
        )}
      </section>
    )
  }

  if (items.length === 0) {
    // Specific degraded-source hint if we have one; otherwise a generic
    // "nothing this round" line when a refresh control is present (so the
    // empty state still explains itself). Previously the whole strip
    // returned `null` here when neither an AI toggle nor a source hint
    // applied — which is exactly how the TV strip silently vanished in
    // local-recommender mode (no toggle shown, source/path not matched by
    // describeEmptySource). With a refresh control wired in, the strip
    // must stay on screen so the user can re-run it.
    const emptyHint =
      describeEmptySource(source, diag) ??
      (onRefresh ? 'No fresh picks this round — refresh to run the recommender again.' : null)
    if (!mode && !emptyHint && !onRefresh) return null
    return (
      <section className="trending">
        <StripHeader label={label} onRefresh={onRefresh} refreshing={refreshing} />
        {emptyHint && (
          <div className="trending__empty">
            <p className="trending__empty-hint">{emptyHint}</p>
          </div>
        )}
        {mode && (
          <div className="trending__footer">
            <StripModeToggle value={mode.value} onChange={mode.onChange} />
          </div>
        )}
      </section>
    )
  }

  // Subtle hint when items are present but came from a degraded source
  // (e.g. Claude failed, falling back to trending). The strip still
  // renders normally; the hint just tells the user why their picks
  // don't look personalized. Also surfaces cold-start context.
  // Note: droppedPicks > 10 means significant API budget was wasted on
  // picks that were filtered post-generation. Surfacing this to the user
  // when it happens motivates them to check their library/rejection lists.
  const droppedWarning =
    (diag?.droppedPicks ?? 0) > 10
      ? ` (${diag!.droppedPicks} picks filtered — some API credit was used on invalid suggestions)`
      : ''
  // When Claude hit max_tokens the JSON was truncated and the strip may
  // be shorter than expected. Surface an honest hint so the user isn't
  // confused by a partial strip.
  const truncatedHint =
    diag?.claudeTruncated
      ? ' (AI response was cut short — refresh for a full strip)'
      : ''
  // When source=trending and no AI context is shown (no toggle rendered),
  // the strip is operating in no-key or AI-off mode. Show a quiet nudge
  // so new users understand they can unlock personalized picks. But
  // suppress it when the server tagged the path as a local-recommender
  // fallback (`recommender_fallback_trending`) — in that mode Anthropic
  // is irrelevant; the household runs the free local sidecar and the
  // trending strip is a transient outage indicator, not a "you need a
  // key" prompt.
  const isRecommenderFallback = diag?.path === 'recommender_fallback_trending'
  const noAiNudge =
    source === 'trending' && !diag?.reason && !mode && !isRecommenderFallback
      ? 'Add an Anthropic key to unlock picks tailored to your library.'
      : null
  const sourceHint =
    source === 'trending_fallback'
      ? 'AI was unreachable — showing trending.'
      : isRecommenderFallback
        ? 'Recommender is catching its breath — showing trending while it recovers.'
        : source === 'trending' && diag?.reason === 'library_below_threshold'
          ? (diag.hint ?? 'Library too small for personalized picks — showing trending.')
          : noAiNudge
            ? noAiNudge
            : source === 'personalized_filled' || source === 'personalized_empty_trending_fallback'
              ? `A few picks are from trending — not enough personalized matches this round.${droppedWarning}${truncatedHint}`
              : source === 'personalized' && (droppedWarning || truncatedHint)
                ? `${droppedWarning}${truncatedHint}`.trim()
                : null

  return (
    <section className="trending">
      <StripHeader label={label} onRefresh={onRefresh} refreshing={refreshing}>
        {sourceHint && <span className="trending__source-hint"> · {sourceHint}</span>}
        {feedback?.unavailable && (
          <span className="trending__source-hint" role="status">
            {' '}
            · Feedback unavailable
          </span>
        )}
      </StripHeader>
      <div className="trending__row">
        {items.slice(0, 16).map((item) => {
          const isPending = pendingId === item.id
          // Trust scaffolding: card carries a provenance modifier class
          // so the styling can differentiate a Claude pick from a
          // discover/trending fill (the actual visual contract lives in
          // TrendingRow.css). Reason — when present — populates the
          // browser tooltip alongside the title, AND renders as a small
          // ground-line below the title on hover/focus. Quiet by
          // default; visible when the user looks for it.
          const provClass = item.provenance ? ` trending__card--${item.provenance}` : ''
          const tipParts = [item.title]
          if (item.reason) tipParts.push(item.reason)
          const tooltip = tipParts.join(' — ')
          return (
            <div key={item.id} className="trending__card-wrap">
              <button
                type="button"
                className={`trending__card${isPending ? ' trending__card--pending' : ''}${provClass}`}
                onClick={() => onPick(item.id)}
                disabled={isPending}
                title={tooltip}
                data-provenance={item.provenance ?? undefined}
              >
                {/* Provenance pip — faint dot in the top-left corner for
                    personalized/discover picks. Quiet at rest, brighter on
                    hover. Trending cards get no pip (no taste signal to
                    signal). aria-hidden because it's purely decorative. */}
                {(item.provenance === 'personalized' || item.provenance === 'discover') && (
                  <span
                    className="trending__pip"
                    aria-hidden="true"
                    title={item.provenance === 'personalized' ? 'Personalized for you' : 'From your genre picks'}
                  />
                )}
                {item.posterPath ? (
                  <img
                    className="trending__poster"
                    src={`${TMDB_POSTER_BASE}${item.posterPath}`}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="trending__poster trending__poster--fallback" aria-hidden="true">
                    {item.title.charAt(0)}
                  </div>
                )}
                <div className="trending__caption">
                  <span className="trending__title">{item.title}</span>
                  {item.available_on?.includes('iptv') && (
                    <span className="suggestion-badge suggestion-badge--iptv" title="Available via IPTV">IPTV</span>
                  )}
                  {item.year && <span className="trending__year">{item.year}</span>}
                </div>
                {item.reason && (
                  <p className="trending__reason" aria-label={`Why: ${item.reason}`}>
                    {item.reason}
                  </p>
                )}
              </button>
              {feedback && (
                <FeedbackDots
                  state={feedback.stateFor(item.id)}
                  onLike={() => feedback.onLike(item.id, item.title)}
                  onDislike={() => feedback.onDislike(item.id, item.title)}
                  title={item.title}
                  disabledReason={
                    feedback.unavailable
                      ? "Feedback unavailable — couldn't reach the server"
                      : undefined
                  }
                />
              )}
            </div>
          )
        })}
      </div>
      {mode && (
        <div className="trending__footer">
          <StripModeToggle value={mode.value} onChange={mode.onChange} />
        </div>
      )}
    </section>
  )
}
