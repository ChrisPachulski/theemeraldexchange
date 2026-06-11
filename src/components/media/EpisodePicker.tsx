import { useMediaEpisodes } from '../../lib/hooks/useMediaLibrary'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import type { MediaEpisode } from '../../lib/api/media'
import './EpisodePicker.css'

/** Format an episode label like "Show — S02E05 · Title". The em dash here is
 *  a SEPARATOR between data fields (show vs episode code), not prose copy —
 *  DESIGN.md's em-dash law governs sentence punctuation; this is the same
 *  glyph-as-delimiter idiom as the stat-table '—' placeholders. */
function episodeLabel(showTitle: string, ep: MediaEpisode): string {
  const code = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`
  return ep.title ? `${showTitle} — ${code} · ${ep.title}` : `${showTitle} — ${code}`
}

type Props = {
  /** media-core show id (NOT a TMDB/Sonarr id). */
  showId: number
  showTitle: string
  onClose: () => void
  onPlay: (ep: MediaEpisode, label: string) => void
}

/**
 * Episode picker overlay. Reuses the shared .iptv-player-modal chrome; lists a
 * media-core show's episodes and plays the chosen one. Used by the Media tab and
 * the TV-show detail modal's "Watch episodes" action.
 */
export function EpisodePicker({ showId, showTitle, onClose, onPlay }: Props) {
  const episodes = useMediaEpisodes(showId)
  // Plain-div dialog: useModalA11y supplies the focus trap, Escape-to-close,
  // and focus restoration that aria-modal="true" promises (LiveTab pattern).
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  return (
    <div
      ref={modalRef}
      className="iptv-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${showTitle} episodes`}
      tabIndex={-1}
    >
      <div className="iptv-player-modal__header">
        <h2>{showTitle}</h2>
        <button
          className="iptv-player-modal__close"
          type="button"
          onClick={onClose}
          aria-label="Close episode list"
        >
          ×
        </button>
      </div>
      {episodes.isPending && <p className="iptv-tab__status">Loading episodes…</p>}
      {episodes.error && (
        <p className="iptv-tab__status iptv-tab__status--error">Couldn't load episodes.</p>
      )}
      {episodes.data && episodes.data.items.length === 0 && (
        <p className="iptv-tab__status">No episodes scanned for this show.</p>
      )}
      {episodes.data && episodes.data.items.length > 0 && (
        <ul className="media-episode-list">
          {episodes.data.items.map((ep) => (
            <li key={ep.id}>
              <button
                type="button"
                className="media-episode-list__item"
                onClick={() => onPlay(ep, episodeLabel(showTitle, ep))}
              >
                <span className="media-episode-list__code">
                  S{String(ep.season).padStart(2, '0')}E{String(ep.episode).padStart(2, '0')}
                </span>
                <span className="media-episode-list__title">{ep.title ?? 'Untitled'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default EpisodePicker
