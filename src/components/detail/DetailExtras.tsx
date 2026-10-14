import { useRef, useState } from 'react'
import { TrendingRow } from '../search/TrendingRow'
import type { RelatedItem, TmdbRef, TmdbVideo } from '../../lib/api/tmdb'
import { useRatingGate } from '../../lib/hooks/usePolicy'
import { useRelated, useVideos } from '../../lib/hooks/useTmdbExtras'
import { useFeedback, useSetFeedback } from '../../lib/hooks/useUserFeedback'
import { useToggleWatchlist, useWatchlist } from '../../lib/hooks/useWatchlist'
import { useDialogDismiss } from '../../lib/useDialogDismiss'

// The TMDB-backed parts of a title's detail (Apple ArrDetailScreens hero
// actions + ExtrasSection): Trailer, Watchlist and Like/Dislike under the
// title, and the Trailers & extras and More like this rows in the body.

/** The detail's title for its extras: TmdbRef plus the TMDB id that feedback
 *  keys on (a show's TVDB id can't be rated; Sonarr may not know its TMDB id). */
export type DetailExtrasRef = TmdbRef & { tmdbId?: number | null }

// Line icons for the captioned hero actions (24-unit viewBox, stroke drawn).
const ICONS = {
  trailer: 'M4 5h16v14H4z M10 9l5 3-5 3z',
  watchlist: 'M6 3h12v18l-6-4-6 4z',
  like: 'M7 11v9H4v-9z M7 11l4-8a2 2 0 0 1 3 2l-1 4h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7',
  dislike: 'M17 13V4h3v9z M17 13l-4 8a2 2 0 0 1-3-2l1-4H5a2 2 0 0 1-2-2l2-7a2 2 0 0 1 2-2h10',
}

function ActionIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span className="detail__action-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round">
        <path d={ICONS[name]} />
      </svg>
    </span>
  )
}

export function TitleActions({
  extras,
  title,
  poster,
  onTrailer,
}: {
  extras: DetailExtrasRef
  title: string
  poster?: string
  onTrailer: (video: TmdbVideo) => void
}) {
  const trailer = useVideos(extras).data?.[0]
  const watchlist = useWatchlist()
  const toggle = useToggleWatchlist()
  const onList = watchlist.data?.some((e) => e.kind === extras.kind && e.id === extras.id) ?? false
  const feedback = useFeedback()
  const setFeedback = useSetFeedback(extras.kind)
  const tmdbId = extras.tmdbId && extras.tmdbId > 0 ? extras.tmdbId : null
  const bucket = feedback.data?.[extras.kind]
  const liked = tmdbId !== null && (bucket?.liked.some((e) => e.id === tmdbId) ?? false)
  const disliked = tmdbId !== null && (bucket?.disliked.some((e) => e.id === tmdbId) ?? false)
  // Selecting the active signal clears it; Like and Dislike exclude each other.
  const rate = (signal: 'like' | 'dislike', on: boolean) => {
    if (tmdbId !== null) setFeedback.mutate({ tmdbId, title, signal: on ? null : signal })
  }

  return (
    <div className="detail__hero-actions">
      {trailer && (
        <button type="button" className="detail__action" onClick={() => onTrailer(trailer)}>
          <ActionIcon name="trailer" />
          Trailer
        </button>
      )}
      {/* A server without the watchlist route answers with an error: no toggle. */}
      {!watchlist.error && (
        <button
          type="button"
          className="detail__action"
          aria-pressed={onList}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ kind: extras.kind, id: extras.id, title, posterPath: poster, on: !onList })}
        >
          <ActionIcon name="watchlist" />
          {onList ? 'On watchlist' : 'Watchlist'}
        </button>
      )}
      {tmdbId !== null && (
        <>
          <button
            type="button"
            className="detail__action"
            aria-pressed={liked}
            disabled={!!feedback.error}
            title={feedback.error ? 'Feedback unavailable' : undefined}
            onClick={() => rate('like', liked)}
          >
            <ActionIcon name="like" />
            {liked ? 'Liked' : 'Like'}
          </button>
          <button
            type="button"
            className="detail__action"
            aria-pressed={disliked}
            disabled={!!feedback.error}
            title={feedback.error ? 'Feedback unavailable' : undefined}
            onClick={() => rate('dislike', disliked)}
          >
            <ActionIcon name="dislike" />
            {disliked ? 'Disliked' : 'Dislike'}
          </button>
        </>
      )}
    </div>
  )
}

export function ExtrasRows({
  extras,
  onPlayVideo,
  onPickRelated,
  relatedPendingId,
}: {
  extras: TmdbRef
  onPlayVideo: (video: TmdbVideo) => void
  onPickRelated?: (item: RelatedItem) => void
  relatedPendingId?: number | null
}) {
  const videos = useVideos(extras).data ?? []
  // Related titles carry no certification: withheld under a cap, like the strip.
  const ratingGate = useRatingGate()
  const related = useRelated(extras, !!onPickRelated && !ratingGate.capped).data ?? []
  return (
    <>
      {videos.length > 0 && (
        <section className="detail__section">
          <h3 className="detail__section-title">Trailers &amp; extras</h3>
          <ul className="detail__extras">
            {videos.map((v) => (
              <li key={v.key}>
                <button type="button" className="detail__extra" onClick={() => onPlayVideo(v)} aria-label={`Play ${v.name}`}>
                  <span className="detail__extra-thumb">
                    <img
                      src={`https://img.youtube.com/vi/${encodeURIComponent(v.key)}/hqdefault.jpg`}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                    />
                  </span>
                  <span className="detail__extra-name">{v.name}</span>
                  <span className="detail__extra-type">{v.type}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {onPickRelated && related.length > 0 && (
        <TrendingRow
          items={related}
          onPick={(id) => {
            const item = related.find((r) => r.id === id)
            if (item) onPickRelated(item)
          }}
          pendingId={relatedPendingId}
          label="More like this"
        />
      )}
    </>
  )
}

/** YouTube's privacy-enhanced embed in a dialog over the detail (Apple
 *  TrailerPlayer). The frame only exists while open, so closing stops it. */
export function TrailerDialog({ video, onClose }: { video: TmdbVideo | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const rendered = useDialogDismiss(video !== null, dialogRef)
  // Keep the last name through the exit transition.
  const [name, setName] = useState(video?.name ?? '')
  if (video && video.name !== name) setName(video.name)
  if (!rendered) return null
  return (
    <dialog
      ref={dialogRef}
      className="detail trailer"
      aria-label={`Trailer: ${name}`}
      // React re-dispatches a nested dialog's close/cancel to the detail's own
      // handlers; stop them here or closing the trailer closes the detail too.
      onClose={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onCancel={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <article className="detail__panel trailer__panel">
        <button type="button" className="detail__close" onClick={onClose} aria-label="Close trailer">
          {'×'}
        </button>
        {video && (
          <iframe
            className="trailer__frame"
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.key)}?autoplay=1&rel=0&playsinline=1`}
            title={video.name}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            // YouTube refuses an embed with no Referer (its "Error 153").
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
      </article>
    </dialog>
  )
}
