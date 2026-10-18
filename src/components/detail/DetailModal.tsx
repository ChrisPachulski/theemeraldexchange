import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RatingPiece } from '../../lib/api/ratings'
import { RatingChips } from '../search/RatingChips'
import { castCharacter, TMDB_IMAGE_BASE, type CastMember, type RelatedItem, type TmdbVideo } from '../../lib/api/tmdb'
import { useDialogDismiss } from '../../lib/useDialogDismiss'
import { ExtrasRows, TitleActions, TrailerDialog, type DetailExtrasRef } from './DetailExtras'
import { PersonDialog } from './PersonDialog'
import './DetailModal.css'

// Plex-style title page in a sheet: a backdrop hero with the plot and the
// play / add actions, then seasons and episodes (TV), cast (TMDB), extras,
// the Sonarr / Radarr details, and the admin's manage actions last.

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
  /** Sonarr synopsis, clamped to two lines. */
  overview?: string
  /** Downloaded locally: the row becomes a button that plays it. */
  onPlay?: () => void
  /** Local playback finished. */
  watched?: boolean
  /** Local playback in progress (0..1): a resume bar under the row. */
  progress?: number | null
  /** Episode still (Sonarr's screenshot), 16:9. */
  still?: string
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
  /** Episodes watched to the end, when the show plays locally; drives the
   *  "N unwatched" count. */
  watchedCount?: number
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
  /** Makes each genre pill a button: the tab closes the detail and filters
   *  its library to that genre. */
  onGenreClick?: (genre: string) => void
  /** Plot / summary text. */
  overview?: string
  /** Detail key/value rows for the metadata block. */
  meta: DetailMeta[]
  /** Score chips (icon + value), same as MediaCard. */
  rating?: RatingPiece[]
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
  /** Admin-only discover-time action: add the title transiently (monitored,
   *  auto-grab off) and drop into the interactive release browser. When
   *  provided alongside a not-in-library item, the footer gains a primary
   *  "Find release" button next to Add. */
  onFindRelease?: () => void
  /** Triggered when the user clicks 'Remove from library'. */
  onRemove?: () => void
  /** TV-only: per-season rows for the library view. */
  seasons?: SeasonRow[]
  /** Click to opt-in to a currently-unmonitored season. Admin only. */
  onAddSeason?: (seasonNumber: number) => void
  /** seasonNumber currently in-flight (UI disables that row's button). */
  addingSeason?: number | null
  /** Season the browser opens on (the resume target's, else the last
   *  watched); also opens the Seasons section. */
  defaultSeason?: number | null
  /** Movie-only: trigger a manual upgrade search. Admin + in-library. */
  onUpgrade?: () => void
  /** Whether the upgrade mutation is in flight (disables the button). */
  upgrading?: boolean
  /** When the title exists in the local media-core library, the footer gains a
   *  primary "Play Direct here" button that streams it in-browser (direct-play
   *  or transcoded HLS). */
  onPlayDirect?: () => void
  /** Label for the direct-play button (e.g. "Resume · 42 min left" for a
   *  movie, "Resume S1E2" for a show). Defaults to "Play Direct here". */
  playDirectLabel?: string
  /** In library but nothing exists to play yet (unreleased title, or
   *  released but not downloaded). Rendered as a non-interactive status
   *  note in the footer where a play button would otherwise sit — callers
   *  are expected to suppress onPlayDirect alongside setting it. */
  unavailableNote?: string | null
  /** Admin-only "Advanced" power-user actions surface (Sonarr/Radarr). When
   *  provided, the footer gains an "Advanced" toggle that reveals this node
   *  as a body section. The caller (a tab) owns all the queries/mutations/
   *  loading-empty-error states inside it; DetailModal only hosts it and
   *  manages the open/closed reveal so the panel doesn't crowd the default
   *  view. Pass undefined for non-admins / out-of-library items to hide it. */
  advanced?: ReactNode
  /** Force the Advanced surface open without a footer-toggle click. The
   *  discover-time Find-release flow sets it so the auto-added item drops
   *  straight into the release browser. Only forces open on the rising edge;
   *  the user can still hide it afterward. */
  autoShowAdvanced?: boolean
  /** The title's TMDB identity: turns on the Trailer / Watchlist / Like /
   *  Dislike actions and the Trailers & extras and More like this rows. */
  extras?: DetailExtrasRef
  /** A More like this pick; the tab opens it like a strip pick. */
  onPickRelated?: (item: RelatedItem) => void
  /** The More like this card whose lookup is in flight. */
  relatedPendingId?: number | null
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
  onGenreClick,
  overview,
  meta,
  rating,
  cast,
  castLoading,
  inLibrary,
  canRemove,
  onAdd,
  onFindRelease,
  onRemove,
  seasons,
  onAddSeason,
  addingSeason,
  defaultSeason,
  onUpgrade,
  upgrading,
  onPlayDirect,
  playDirectLabel,
  unavailableNote,
  advanced,
  autoShowAdvanced,
  extras,
  onPickRelated,
  relatedPendingId,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const advancedRef = useRef<HTMLElement>(null)
  // Dialogs over the detail: a trailer, or a cast member's page.
  const [trailer, setTrailer] = useState<TmdbVideo | null>(null)
  const [person, setPerson] = useState<CastMember | null>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  // Advanced surface is collapsed by default so it never crowds the normal
  // detail view; the footer button reveals it. Reset to collapsed whenever
  // the modal closes (so a fresh title doesn't inherit the prior open state)
  // using the adjust-state-during-render pattern the rest of this codebase
  // uses for derived resets (see Toast.tsx) — an effect here trips the
  // set-state-in-effect lint and causes a needless cascading render.
  const [showAdvanced, setShowAdvanced] = useState(autoShowAdvanced === true)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open && showAdvanced) setShowAdvanced(false)
    if (!open) {
      setTrailer(null)
      setPerson(null)
    }
  }
  // Force the panel open on autoShowAdvanced's rising edge (the Find-release
  // flow), tracking the prior value so we don't override a later manual hide.
  const [wasAutoShow, setWasAutoShow] = useState(autoShowAdvanced === true)
  if (wasAutoShow !== (autoShowAdvanced === true)) {
    setWasAutoShow(autoShowAdvanced === true)
    if (autoShowAdvanced && !showAdvanced) setShowAdvanced(true)
  }

  // useDialogDismiss owns showModal()/close() + the deferred unmount so the
  // exit transition can play. We keep the open->focus side effect here.
  const rendered = useDialogDismiss(open, dialogRef)

  useEffect(() => {
    if (!open) return
    // Focus the close button so screen readers announce the modal but the
    // user doesn't accidentally trigger Add/Remove on Enter. This effect is
    // declared after useDialogDismiss, so the hook's showModal() has already
    // run by the time we focus.
    closeBtnRef.current?.focus()
  }, [open])

  // A More like this pick or a filmography credit swaps the title in place:
  // start the new one from the top.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [title])

  // The Advanced panel opens at the foot of the page: bring it into view.
  useEffect(() => {
    if (showAdvanced) advancedRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [showAdvanced])

  if (!rendered) return null

  const titleId = 'detail-title'
  const overviewId = 'detail-overview'
  const shownSeasons = (seasons ?? [])
    .filter((s) => s.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
  const manage = advanced || (inLibrary && onUpgrade) || (inLibrary && canRemove && onRemove)

  return (
    <dialog
      ref={dialogRef}
      className="detail"
      aria-labelledby={titleId}
      aria-describedby={overview ? overviewId : undefined}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose() }}
    >
      <article className="detail__panel detail__panel--page">
        <button
          ref={closeBtnRef}
          type="button"
          className="detail__close"
          onClick={onClose}
          aria-label="Close detail view"
        >
          {'×'}
        </button>

        {/* One scroller for hero and body, like Plex's title page: the hero
            scrolls away instead of pinning a short window between it and a
            footer. */}
        <div ref={bodyRef} className="detail__scroll">
          {backdrop && (
            <div
              className="detail__backdrop"
              style={{ backgroundImage: `url(${backdrop})` }}
              aria-hidden="true"
            />
          )}

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
              <h2 id={titleId} className="detail__title">{title}</h2>
              {(year || metaStrip.length > 0) && (
                <p className="detail__meta-strip">
                  {[...(year ? [String(year)] : []), ...metaStrip].map((piece, i) => (
                    <span key={i} className="detail__meta-piece">
                      {i > 0 && <span className="detail__meta-sep" aria-hidden="true">·</span>}
                      <span>{piece}</span>
                    </span>
                  ))}
                </p>
              )}
              {rating && rating.length > 0 && <RatingChips pieces={rating} size="lg" />}
              {genres && genres.length > 0 && (
                <ul className="detail__genres">
                  {genres.map((g) =>
                    onGenreClick ? (
                      <li key={g}>
                        <button type="button" className="detail__genre" onClick={() => onGenreClick(g)}>
                          {g}
                        </button>
                      </li>
                    ) : (
                      <li key={g} className="detail__genre">{g}</li>
                    ),
                  )}
                </ul>
              )}

              <div className="detail__play-row">
                {!inLibrary && onFindRelease && (
                  <button
                    type="button"
                    className="detail__btn detail__btn--primary"
                    onClick={onFindRelease}
                    title="Add this title and browse releases to grab one by hand"
                  >
                    Find release
                  </button>
                )}
                {!inLibrary && onAdd && (
                  <button
                    type="button"
                    className={`detail__btn ${onFindRelease ? 'detail__btn--secondary' : 'detail__btn--primary'}`}
                    onClick={onAdd}
                  >
                    Add to library
                  </button>
                )}
                {inLibrary && unavailableNote && (
                  <span className="detail__btn detail__btn--note" role="status">
                    {unavailableNote}
                  </span>
                )}
                {onPlayDirect && (
                  <button
                    type="button"
                    className="detail__btn detail__btn--primary detail__btn--play"
                    onClick={onPlayDirect}
                  >
                    {playDirectLabel ?? 'Play Direct here'}
                  </button>
                )}
              </div>

              {extras && <TitleActions extras={extras} title={title} poster={poster} onTrailer={setTrailer} />}

              {overview && <p id={overviewId} className="detail__overview">{overview}</p>}
            </div>
          </header>

          <div className="detail__body">
            {inLibrary && shownSeasons.length > 0 && (
              <SeasonBrowser
                key={title}
                seasons={shownSeasons}
                defaultSeason={defaultSeason}
                onAddSeason={onAddSeason}
                addingSeason={addingSeason}
              />
            )}

            {(castLoading || (cast && cast.length > 0)) && (
              <section className="detail__section">
                <h3 className="detail__section-title">Cast</h3>
                {castLoading ? (
                  <ul className="detail__cast detail__cast--people" aria-busy="true">
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                      <li key={i} className="detail__cast-card detail__cast-card--skeleton">
                        <div className="detail__cast-photo" />
                        <div className="detail__cast-name detail__cast-name--skeleton" />
                        <div className="detail__cast-role detail__cast-role--skeleton" />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="detail__cast detail__cast--people">
                    {cast!.slice(0, 20).map((member) => {
                      const role = castCharacter(member)
                      return (
                        <li key={member.id} className="detail__cast-card">
                          <button type="button" className="detail__cast-link" onClick={() => setPerson(member)}>
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
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )}

            {extras && (
              <ExtrasRows
                extras={extras}
                onPlayVideo={setTrailer}
                onPickRelated={onPickRelated}
                relatedPendingId={relatedPendingId}
              />
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

            {manage && (
              <section className="detail__manage" aria-label="Manage">
                {advanced && (
                  <button
                    type="button"
                    className="detail__btn detail__btn--secondary"
                    onClick={() => setShowAdvanced((v) => !v)}
                    aria-expanded={showAdvanced}
                  >
                    {showAdvanced ? 'Hide advanced' : 'Advanced'}
                  </button>
                )}
                {inLibrary && onUpgrade && (
                  <button
                    type="button"
                    className="detail__btn detail__btn--secondary"
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
                    className="detail__btn detail__btn--quiet-danger"
                    onClick={onRemove}
                  >
                    Remove from library
                  </button>
                )}
              </section>
            )}

            {advanced && showAdvanced && (
              <section ref={advancedRef} className="detail__section detail__advanced" aria-label="Advanced actions">
                <h3 className="detail__section-title">Advanced</h3>
                {advanced}
              </section>
            )}
          </div>
        </div>
      </article>
      <TrailerDialog video={trailer} onClose={() => setTrailer(null)} />
      <PersonDialog member={person} onClose={() => setPerson(null)} />
    </dialog>
  )
}

// Seasons as a tab row over the picked season's episodes (Plex's season page,
// inline). Opens on the resume target's season, else the first with files.
function SeasonBrowser({
  seasons,
  defaultSeason,
  onAddSeason,
  addingSeason,
}: {
  seasons: SeasonRow[]
  defaultSeason?: number | null
  onAddSeason?: (seasonNumber: number) => void
  addingSeason?: number | null
}) {
  const [picked, setPicked] = useState<number | null>(null)
  const [now] = useState(Date.now)
  const current =
    seasons.find((s) => s.seasonNumber === (picked ?? defaultSeason)) ??
    seasons.find((s) => s.episodeFileCount > 0) ??
    seasons[0]
  const total = (s: SeasonRow) => Math.max(s.totalEpisodeCount || s.episodeCount, s.episodeFileCount)
  const unwatched = (s: SeasonRow) => (s.watchedCount == null ? null : Math.max(0, total(s) - s.watchedCount))

  const aired = current.episodeCount > 0
  const complete = aired && current.episodeFileCount >= current.episodeCount
  // Not monitored with aired episodes → 'Add' (opt in + grab); monitored but
  // missing aired episodes → 'Get missing' (re-run the cap-aware search).
  // Same backend route: the monitor flip is a no-op when already monitored.
  const canTrigger = aired && !complete && onAddSeason
  const isAdding = addingSeason === current.seasonNumber
  const left = unwatched(current)
  // Apple's season card: downloaded of total, then what is left to watch
  // when the show plays locally.
  const status = !aired
    ? 'Upcoming'
    : `${current.episodeFileCount} of ${total(current)} downloaded${
        left == null ? '' : left ? ` · ${left} unwatched` : ' · All watched'
      }`
  const airDate = fmtAirDate(current.airDate)

  return (
    <section className="detail__section" aria-labelledby="detail-seasons">
      <h3 id="detail-seasons" className="detail__section-title">
        {seasons.length} {seasons.length === 1 ? 'Season' : 'Seasons'}
      </h3>
      <div className="detail__season-tabs" role="tablist" aria-label="Seasons">
        {seasons.map((s) => {
          const n = unwatched(s)
          return (
            <button
              key={s.seasonNumber}
              type="button"
              role="tab"
              aria-selected={s === current}
              className="detail__season-tab"
              onClick={() => setPicked(s.seasonNumber)}
            >
              <span className="detail__season-num">Season {s.seasonNumber}</span>
              <span className="detail__season-air">
                {s.episodeCount > 0 ? `${total(s)} episodes` : 'Upcoming'}
              </span>
              {n != null && n > 0 && n < total(s) && (
                <span className="detail__season-left" aria-label={`${n} unwatched`}>{n}</span>
              )}
            </button>
          )
        })}
      </div>

      <div role="tabpanel" className="detail__season-panel" aria-label={`Season ${current.seasonNumber}`}>
        <p className="detail__season-status">
          {airDate && <span>{airDate}</span>}
          <span>{status}</span>
          {canTrigger && (
            <button
              type="button"
              className="detail__season-add"
              onClick={() => onAddSeason(current.seasonNumber)}
              disabled={isAdding}
              aria-busy={isAdding}
            >
              {isAdding ? 'Searching…' : current.monitored ? 'Get missing' : 'Add'}
            </button>
          )}
        </p>
        {current.episodes && current.episodes.length > 0 && (
          <ol className="detail__episodes">
            {current.episodes
              .slice()
              .sort((a, b) => a.episodeNumber - b.episodeNumber)
              .map((ep) => {
                const future = ep.airDate ? new Date(ep.airDate).getTime() > now : false
                const className = `detail__episode${future ? ' detail__episode--future' : ''}${ep.hasFile ? ' detail__episode--ready' : ''}`
                const row = (
                  <>
                    <span className="detail__episode-thumb">
                      {ep.still ? (
                        <img src={ep.still} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="detail__episode-thumb-num" aria-hidden="true">{ep.episodeNumber}</span>
                      )}
                      {ep.progress != null && (
                        <span className="detail__episode-progress" aria-hidden="true">
                          <span style={{ width: `${Math.round(ep.progress * 100)}%` }} />
                        </span>
                      )}
                    </span>
                    <span className="detail__episode-text">
                      <span className="detail__episode-line">
                        <span className="detail__episode-num">E{ep.episodeNumber}</span>
                        <span className="detail__episode-air">{fmtAirDate(ep.airDate) ?? '—'}</span>
                        {ep.watched && <span className="detail__episode-tag">Watched</span>}
                      </span>
                      <span className="detail__episode-title">{ep.title}</span>
                      {ep.overview && <span className="detail__episode-overview">{ep.overview}</span>}
                    </span>
                  </>
                )
                return ep.onPlay ? (
                  <li key={ep.episodeNumber}>
                    <button type="button" className={`${className} detail__episode--play`} onClick={ep.onPlay}>
                      {row}
                    </button>
                  </li>
                ) : (
                  <li key={ep.episodeNumber} className={className}>
                    {row}
                  </li>
                )
              })}
          </ol>
        )}
      </div>
    </section>
  )
}
