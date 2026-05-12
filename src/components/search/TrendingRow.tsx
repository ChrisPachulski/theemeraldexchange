import type { TrendingItem } from '../../lib/hooks/useTrending'
import './TrendingRow.css'

// Trending-this-week strip rendered above search results on the
// Discover surface. Horizontal scroll, dense poster cards.
//
// Posters come from TMDB. We size them at w342 — wide enough for
// retina while keeping the row light.

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

type Props = {
  items: TrendingItem[]
  loading?: boolean
  onPick: (id: number) => void
  /** True while a card's lookup-then-open flow is mid-flight. */
  pendingId?: number | null
  label?: string
}

export function TrendingRow({ items, loading, onPick, pendingId, label }: Props) {
  if (loading) {
    return (
      <section className="trending" aria-busy="true">
        <h3 className="trending__label">{label ?? 'Trending this week'}</h3>
        <div className="trending__row">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="trending__card trending__card--skeleton" />
          ))}
        </div>
      </section>
    )
  }
  if (items.length === 0) return null

  return (
    <section className="trending">
      <h3 className="trending__label">{label ?? 'Trending this week'}</h3>
      <div className="trending__row">
        {items.slice(0, 16).map((item) => {
          const isPending = pendingId === item.id
          return (
            <button
              key={item.id}
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
          )
        })}
      </div>
    </section>
  )
}
