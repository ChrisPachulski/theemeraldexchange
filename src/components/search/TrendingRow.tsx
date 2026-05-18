import type { TrendingItem } from '../../lib/hooks/useTrending'
import type { SuggestionDiag } from '../../lib/hooks/useSuggested'
import { AiToggle } from './AiToggle'
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
  }
  /**
   * Optional AI on/off toggle anchored to the bottom-right of the
   * section. When provided, the household can switch between Claude-
   * backed personalization and free TMDB trending without leaving
   * the surface. Hide entirely when the caller has no API key set.
   */
  ai?: { enabled: boolean; onToggle: () => void }
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
  ai,
  error,
  source,
  diag,
}: Props) {
  if (error) {
    const { headline, hint } = describeError(error)
    return (
      <section className="trending">
        <h3 className="trending__label">{label ?? 'Trending this week'}</h3>
        <div className="trending__empty">
          <p className="trending__empty-headline">{headline}</p>
          <p className="trending__empty-hint">{hint}</p>
        </div>
        {ai && (
          <div className="trending__footer">
            <AiToggle enabled={ai.enabled} onToggle={ai.onToggle} />
          </div>
        )}
      </section>
    )
  }

  if (loading) {
    return (
      <section className="trending" aria-busy="true">
        <h3 className="trending__label trending__label--loading">
          {ai?.enabled ? 'Finding picks for you' : 'Loading trending'}
          <span className="trending__loading-dot" aria-hidden="true" />
          {ai?.enabled && (
            <span className="trending__loading-hint">takes a few seconds…</span>
          )}
        </h3>
        <div className="trending__row">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="trending__card trending__card--skeleton" />
          ))}
        </div>
        {ai && (
          <div className="trending__footer">
            <AiToggle enabled={ai.enabled} onToggle={ai.onToggle} />
          </div>
        )}
      </section>
    )
  }

  if (items.length === 0) {
    const emptyHint = describeEmptySource(source, diag)
    if (!ai && !emptyHint) return null
    return (
      <section className="trending">
        <h3 className="trending__label">{label ?? 'Trending this week'}</h3>
        {emptyHint && (
          <div className="trending__empty">
            <p className="trending__empty-hint">{emptyHint}</p>
          </div>
        )}
        {ai && (
          <div className="trending__footer">
            <AiToggle enabled={ai.enabled} onToggle={ai.onToggle} />
          </div>
        )}
      </section>
    )
  }

  // Subtle hint when items are present but came from a degraded source
  // (e.g. Claude failed, falling back to trending). The strip still
  // renders normally; the hint just tells the user why their picks
  // don't look personalized.
  const sourceHint =
    source === 'trending_fallback'
      ? 'AI was unreachable — showing trending.'
      : source === 'personalized_filled' || source === 'personalized_empty_trending_fallback'
        ? 'A few picks are from trending — not enough personalized matches this round.'
        : null

  return (
    <section className="trending">
      <h3 className="trending__label">
        {label ?? 'Trending this week'}
        {sourceHint && <span className="trending__source-hint"> · {sourceHint}</span>}
      </h3>
      <div className="trending__row">
        {items.slice(0, 16).map((item) => {
          const isPending = pendingId === item.id
          return (
            <div key={item.id} className="trending__card-wrap">
              <button
                type="button"
                className={`trending__card${isPending ? ' trending__card--pending' : ''}`}
                onClick={() => onPick(item.id)}
                disabled={isPending}
                title={item.title}
              >
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
                  {item.year && <span className="trending__year">{item.year}</span>}
                </div>
              </button>
              {feedback && (
                <FeedbackDots
                  state={feedback.stateFor(item.id)}
                  onLike={() => feedback.onLike(item.id, item.title)}
                  onDislike={() => feedback.onDislike(item.id, item.title)}
                  title={item.title}
                />
              )}
            </div>
          )
        })}
      </div>
      {ai && (
        <div className="trending__footer">
          <AiToggle enabled={ai.enabled} onToggle={ai.onToggle} />
        </div>
      )}
    </section>
  )
}
