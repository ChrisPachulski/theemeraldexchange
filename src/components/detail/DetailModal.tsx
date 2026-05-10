import { useEffect, useRef } from 'react'
import './DetailModal.css'

// Plex-style item-detail modal.
//
// Takes over most of the viewport and shows everything Sonarr / Radarr
// expose for the item: poster, title, year, runtime, network/studio,
// status, genres, ratings, plot, season counts (TV), release dates
// (movies). Action footer offers Add / Remove depending on library state.
//
// Cast data is intentionally omitted — Sonarr and Radarr don't expose it
// in their v3 APIs. Adding cast would require a TMDB integration.

export type DetailMeta = {
  label: string
  value: string
}

type Props = {
  open: boolean
  onClose: () => void
  /** Hero poster URL. */
  poster?: string
  /** Optional fanart / backdrop image. Falls back to poster. */
  backdrop?: string
  title: string
  /** Optional pre-title eyebrow ('TV', 'Movie', etc). */
  kind: string
  year?: number
  /** Short metadata strip under the title (year · runtime · network). */
  metaStrip: string[]
  /** Genres → rendered as inline pills. */
  genres?: string[]
  /** Plot / summary text. */
  overview?: string
  /** Detail key/value rows for the metadata block. */
  meta: DetailMeta[]
  /** Optional rating display, like '8.6 IMDb · 92% RT'. */
  rating?: string
  /** Whether the item is in the user's library. */
  inLibrary: boolean
  /** Whether the actor is allowed to remove. */
  canRemove: boolean
  /** Triggered when the user clicks 'Add to library'. */
  onAdd?: () => void
  /** Triggered when the user clicks 'Remove from library'. */
  onRemove?: () => void
}

export function DetailModal({
  open,
  onClose,
  poster,
  backdrop,
  title,
  kind,
  year,
  metaStrip,
  genres,
  overview,
  meta,
  rating,
  inLibrary,
  canRemove,
  onAdd,
  onRemove,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open) {
      if (!d.open) d.showModal()
      // Focus the close button so screen readers announce the modal but
      // the user doesn't accidentally trigger Add/Remove on Enter.
      closeBtnRef.current?.focus()
    } else if (d.open) {
      d.close()
    }
  }, [open])

  if (!open) return null

  const titleId = 'detail-title'
  const overviewId = 'detail-overview'

  return (
    <dialog
      ref={dialogRef}
      className="detail"
      aria-labelledby={titleId}
      aria-describedby={overview ? overviewId : undefined}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <article className="detail__panel">
        {backdrop && (
          <div
            className="detail__backdrop"
            style={{ backgroundImage: `url(${backdrop})` }}
            aria-hidden="true"
          />
        )}

        <button
          ref={closeBtnRef}
          type="button"
          className="detail__close"
          onClick={onClose}
          aria-label="Close detail view"
        >
          {'×'}
        </button>

        <header className="detail__hero">
          {poster ? (
            <img className="detail__poster" src={poster} alt="" loading="eager" />
          ) : (
            <div className="detail__poster detail__poster--fallback" aria-hidden="true">
              {title.charAt(0)}
            </div>
          )}

          <div className="detail__head">
            <p className="detail__eyebrow">
              {kind}
              {inLibrary && <span className="detail__badge">In library</span>}
            </p>
            <h2 id={titleId} className="detail__title">
              {title}
              {year && <span className="detail__year"> {year}</span>}
            </h2>
            {metaStrip.length > 0 && (
              <p className="detail__meta-strip">
                {metaStrip.map((piece, i) => (
                  <span key={i} className="detail__meta-piece">
                    {i > 0 && <span className="detail__meta-sep" aria-hidden="true">·</span>}
                    <span>{piece}</span>
                  </span>
                ))}
              </p>
            )}
            {rating && <p className="detail__rating">{rating}</p>}
            {genres && genres.length > 0 && (
              <ul className="detail__genres">
                {genres.map((g) => (
                  <li key={g} className="detail__genre">{g}</li>
                ))}
              </ul>
            )}
          </div>
        </header>

        <div className="detail__body">
          {overview && (
            <section className="detail__section">
              <h3 className="detail__section-title">Plot</h3>
              <p id={overviewId} className="detail__overview">{overview}</p>
            </section>
          )}

          {meta.length > 0 && (
            <section className="detail__section">
              <h3 className="detail__section-title">Details</h3>
              <dl className="detail__meta-list">
                {meta.map((row) => (
                  <div key={row.label} className="detail__meta-row">
                    <dt className="detail__meta-key">{row.label}</dt>
                    <dd className="detail__meta-val">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>

        <footer className="detail__actions">
          <button
            type="button"
            className="detail__btn detail__btn--secondary"
            onClick={onClose}
          >
            Close
          </button>
          {!inLibrary && onAdd && (
            <button
              type="button"
              className="detail__btn detail__btn--primary"
              onClick={onAdd}
            >
              Add to library
            </button>
          )}
          {inLibrary && canRemove && onRemove && (
            <button
              type="button"
              className="detail__btn detail__btn--danger"
              onClick={onRemove}
            >
              Remove from library
            </button>
          )}
        </footer>
      </article>
    </dialog>
  )
}
