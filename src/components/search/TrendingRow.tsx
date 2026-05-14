import type { TrendingItem } from '../../lib/hooks/useTrending'
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
    onLike: (id: number) => void
    onDislike: (id: number) => void
  }
  /**
   * Optional AI on/off toggle anchored to the bottom-right of the
   * section. When provided, the household can switch between Claude-
   * backed personalization and free TMDB trending without leaving
   * the surface. Hide entirely when the caller has no API key set.
   */
  ai?: { enabled: boolean; onToggle: () => void }
}

export function TrendingRow({
  items,
  loading,
  onPick,
  pendingId,
  label,
  feedback,
  ai,
}: Props) {
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
    if (!ai) return null
    return (
      <section className="trending">
        <h3 className="trending__label">{label ?? 'Trending this week'}</h3>
        <div className="trending__footer">
          <AiToggle enabled={ai.enabled} onToggle={ai.onToggle} />
        </div>
      </section>
    )
  }

  return (
    <section className="trending">
      <h3 className="trending__label">{label ?? 'Trending this week'}</h3>
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
                  onLike={() => feedback.onLike(item.id)}
                  onDislike={() => feedback.onDislike(item.id)}
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
