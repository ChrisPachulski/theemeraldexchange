import './MediaCard.css'

type Props = {
  poster?: string
  title: string
  year?: number
  meta?: string
  overview?: string
  inLibrary?: boolean
  onClick?: () => void
}

export function MediaCard({ poster, title, year, meta, overview, inLibrary, onClick }: Props) {
  // Metadata pieces are joined with the signature double-dash separator
  // (typographic punctuation per DESIGN.md). The year, when present, is
  // rendered as the first chip-aligned datum.
  const chips: string[] = []
  if (year) chips.push(String(year))
  if (meta) chips.push(meta)

  return (
    <button type="button" className="media-card" onClick={onClick}>
      <div className="media-card__poster">
        {poster ? (
          <img
            src={poster}
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
        {overview && <p className="media-card__overview">{overview}</p>}
      </div>
    </button>
  )
}
