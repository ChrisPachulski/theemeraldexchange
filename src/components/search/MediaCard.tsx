import type { RatingPiece } from '../../lib/api/ratings'
import { RatingChips } from './RatingChips'
import { posterImg } from '../../lib/api/images'
import './MediaCard.css'

type Props = {
  poster?: string
  title: string
  year?: number
  meta?: string
  overview?: string
  /** Score chips (icon + value), in source order. */
  rating?: RatingPiece[]
  inLibrary?: boolean
  /** Local playback finished: a Watched badge on the poster. */
  watched?: boolean
  /** Local playback in progress (0..1): a resume bar along the poster's base. */
  progress?: number | null
  onClick?: () => void
}

export function MediaCard({ poster, title, year, meta, overview, rating, inLibrary, watched, progress, onClick }: Props) {
  // Metadata pieces are joined with the signature double-dash separator
  // (typographic punctuation per DESIGN.md). The year, when present, is
  // rendered as the first chip-aligned datum.
  const chips: string[] = []
  if (year) chips.push(String(year))
  if (meta) chips.push(meta)
  const img = posterImg(poster)

  return (
    <button type="button" className="media-card" onClick={onClick}>
      <div className="media-card__poster">
        {img ? (
          <img
            {...img}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="media-card__poster-fallback" aria-hidden="true">
            {title.charAt(0)}
          </div>
        )}
        {inLibrary && (
          <span className="media-card__badge">
            <span className="media-card__badge-dot" aria-hidden="true" />
            In library
          </span>
        )}
        {watched && (
          <span className="media-card__badge">
            <span className="media-card__badge-dot" aria-hidden="true" />
            Watched
          </span>
        )}
        {progress != null && (
          <span className="media-card__progress" aria-hidden="true">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        )}
      </div>
      <div className="media-card__body">
        <h3 className="media-card__title">{title}</h3>
        {chips.length > 0 && (
          <p className="media-card__meta" aria-label="metadata">
            {chips.map((c, i) => (
              <span key={i} className="media-card__meta-piece">
                {i > 0 && (
                  <span className="media-card__meta-sep" aria-hidden="true">--</span>
                )}
                <span className="media-card__meta-text">{c}</span>
              </span>
            ))}
          </p>
        )}
        {rating && <RatingChips pieces={rating} />}
        {overview && <p className="media-card__overview">{overview}</p>}
      </div>
    </button>
  )
}
