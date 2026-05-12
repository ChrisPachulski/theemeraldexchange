import { useEffect, useRef } from 'react'
import { castCharacter, TMDB_IMAGE_BASE, type CastMember } from '../../lib/api/tmdb'
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

function fmtAirDate(raw?: string): string | undefined {
  if (!raw) return undefined
  const d = new Date(raw)
  if (isNaN(d.getTime())) return undefined
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export type SeasonEpisode = {
  episodeNumber: number
  title: string
  airDate?: string
  hasFile?: boolean
}

export type SeasonRow = {
  seasonNumber: number
  monitored: boolean
  /** Aired episodes Sonarr knows about. */
  episodeCount: number
  /** Total scheduled episodes (some may not have aired yet). */
  totalEpisodeCount: number
  /** Episodes already in the library. */
  episodeFileCount: number
  /** Premiere air date for the season (derived from earliest episode). */
  airDate?: string
  /** Per-episode list for the disclosure. */
  episodes?: SeasonEpisode[]
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
  /** Cast members from TMDB. Empty array hides the cast section. */
  cast?: CastMember[]
  /** Whether cast is still loading; renders skeleton placeholders. */
  castLoading?: boolean
  /** Whether the item is in the user's library. */
  inLibrary: boolean
  /** Whether the actor is allowed to remove. */
  canRemove: boolean
  /** Triggered when the user clicks 'Add to library'. */
  onAdd?: () => void
  /** Triggered when the user clicks 'Remove from library'. */
  onRemove?: () => void
  /** TV-only: per-season rows for the library view. */
  seasons?: SeasonRow[]
  /** Click to opt-in to a currently-unmonitored season. Admin only. */
  onAddSeason?: (seasonNumber: number) => void
  /** seasonNumber currently in-flight (UI disables that row's button). */
  addingSeason?: number | null
  /** Movie-only: trigger a manual upgrade search. Admin + in-library. */
  onUpgrade?: () => void
  /** Whether the upgrade mutation is in flight (disables the button). */
  upgrading?: boolean
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
  cast,
  castLoading,
  inLibrary,
  canRemove,
  onAdd,
  onRemove,
  seasons,
  onAddSeason,
  addingSeason,
  onUpgrade,
  upgrading,
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

          {inLibrary && seasons && seasons.length > 0 && (
            <details className="detail__section detail__seasons-disclosure">
              <summary className="detail__cast-summary">
                <span className="detail__section-title detail__cast-summary-title">Seasons</span>
                <span className="detail__cast-count">
                  {seasons.filter((s) => s.seasonNumber > 0).length}
                </span>
                <span className="detail__cast-chevron" aria-hidden="true">›</span>
              </summary>
              <ul className="detail__seasons">
                {seasons
                  .filter((s) => s.seasonNumber > 0)
                  .sort((a, b) => a.seasonNumber - b.seasonNumber)
                  .map((s) => {
                    const aired = s.episodeCount > 0
                    const complete =
                      s.episodeCount > 0 && s.episodeFileCount >= s.episodeCount
                    const canAdd =
                      !s.monitored && aired && !complete && onAddSeason
                    const isAdding = addingSeason === s.seasonNumber
                    const status = s.monitored
                      ? complete
                        ? 'Complete'
                        : `Monitored · ${s.episodeFileCount} of ${s.episodeCount}`
                      : aired
                        ? `Unmonitored · ${s.episodeCount} aired`
                        : 'Upcoming'
                    return (
                      <li key={s.seasonNumber} className="detail__season-item">
                        <details className="detail__season-details">
                          <summary className="detail__season-row">
                            <span className="detail__season-num">Season {s.seasonNumber}</span>
                            <span className="detail__season-air">{fmtAirDate(s.airDate)}</span>
                            <span className="detail__season-status">{status}</span>
                            {canAdd && (
                              <button
                                type="button"
                                className="detail__season-add"
                                onClick={(e) => {
                                  e.preventDefault()
                                  onAddSeason(s.seasonNumber)
                                }}
                                disabled={isAdding}
                                aria-busy={isAdding}
                              >
                                {isAdding ? 'Adding…' : 'Add'}
                              </button>
                            )}
                            <span className="detail__season-chevron" aria-hidden="true">›</span>
                          </summary>
                          {s.episodes && s.episodes.length > 0 && (
                            <ol className="detail__episodes">
                              {s.episodes
                                .slice()
                                .sort((a, b) => a.episodeNumber - b.episodeNumber)
                                .map((ep) => {
                                  const future = ep.airDate
                                    ? new Date(ep.airDate).getTime() > Date.now()
                                    : false
                                  return (
                                    <li
                                      key={ep.episodeNumber}
                                      className={`detail__episode${future ? ' detail__episode--future' : ''}${ep.hasFile ? ' detail__episode--ready' : ''}`}
                                    >
                                      <span className="detail__episode-num">
                                        {String(ep.episodeNumber).padStart(2, '0')}
                                      </span>
                                      <span className="detail__episode-title">{ep.title}</span>
                                      <span className="detail__episode-air">
                                        {fmtAirDate(ep.airDate) ?? '—'}
                                      </span>
                                    </li>
                                  )
                                })}
                            </ol>
                          )}
                        </details>
                      </li>
                    )
                  })}
              </ul>
            </details>
          )}

          <details className="detail__section detail__cast-disclosure">
            <summary className="detail__cast-summary">
              <span className="detail__section-title detail__cast-summary-title">Cast</span>
              {!castLoading && cast && cast.length > 0 && (
                <span className="detail__cast-count">{Math.min(cast.length, 12)}</span>
              )}
              <span className="detail__cast-chevron" aria-hidden="true">›</span>
            </summary>
            {castLoading ? (
              <ul className="detail__cast" aria-busy="true">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <li key={i} className="detail__cast-card detail__cast-card--skeleton">
                    <div className="detail__cast-photo" />
                    <div className="detail__cast-name detail__cast-name--skeleton" />
                    <div className="detail__cast-role detail__cast-role--skeleton" />
                  </li>
                ))}
              </ul>
            ) : cast && cast.length > 0 ? (
              <ul className="detail__cast">
                {cast.slice(0, 12).map((member) => {
                  const role = castCharacter(member)
                  const href = `https://www.themoviedb.org/person/${member.id}`
                  return (
                    <li key={member.id} className="detail__cast-card">
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="detail__cast-link"
                        aria-label={`${member.name} on TMDB`}
                      >
                        {member.profile_path ? (
                          <img
                            className="detail__cast-photo"
                            src={`${TMDB_IMAGE_BASE}${member.profile_path}`}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="detail__cast-photo detail__cast-photo--fallback" aria-hidden="true">
                            {member.name.charAt(0)}
                          </div>
                        )}
                        <p className="detail__cast-name">{member.name}</p>
                        {role && <p className="detail__cast-role">{role}</p>}
                      </a>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="detail__cast-empty">Cast information unavailable.</p>
            )}
          </details>
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
          {inLibrary && onUpgrade && (
            <button
              type="button"
              className="detail__btn detail__btn--primary"
              onClick={onUpgrade}
              disabled={upgrading}
              aria-busy={upgrading}
              title="Search the indexer for a higher-quality release under the size cap and replace if found"
            >
              {upgrading ? 'Searching…' : 'Try for a better version'}
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
