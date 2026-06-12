// src/components/tabs/IptvSeriesTab.tsx
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { iptvApi, type SeriesDto, type SeriesEpisodeDto, type StreamGrant } from '../../lib/api/iptv'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvSeries, useIptvSeriesDetail } from '../../lib/hooks/useIptvSeries'
import { useIptvFavoriteSet, useToggleIptvFavorite } from '../../lib/hooks/useIptvFavorites'
import {
  resumePercent,
  resumePosition,
  useIptvHistoryIndex,
  useReportPosition,
} from '../../lib/hooks/useIptvHistory'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import { ResumePrompt } from '../media/ResumePrompt'
import { ConcurrencyLimitModal } from '../iptv/ConcurrencyLimitModal'
import {
  concurrencyPayloadFromError,
  type ConcurrencyLimitPayload,
} from '../iptv/concurrencyLimit'

// Both dialogs below are plain divs (role=dialog/aria-modal), so useModalA11y
// supplies the focus trap, Escape-to-close, and focus restoration that
// aria-modal="true" promises (LiveTab pattern). Each lives in its own
// component so the hook's open/close effect runs when the dialog mounts.

function SeriesDetailModal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  return (
    <div
      ref={modalRef}
      className="iptv-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div className="iptv-player-modal__header">
        <h2>{title}</h2>
        <button
          className="iptv-player-modal__close"
          type="button"
          onClick={onClose}
          aria-label="Close series details"
        >
          ×
        </button>
      </div>
      {children}
    </div>
  )
}

function PlayerModal({
  playing,
  onClose,
  onPositionUpdate,
}: {
  playing: { grant: StreamGrant; title: string; startPositionSecs?: number }
  onClose: () => void
  onPositionUpdate: (positionSecs: number, durationSecs: number | null) => void
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  return (
    <div
      ref={modalRef}
      className="iptv-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={playing.title}
      tabIndex={-1}
    >
      <div className="iptv-player-modal__header">
        <h2>{playing.title}</h2>
        <button className="iptv-player-modal__close" type="button" onClick={onClose} aria-label="Close player">
          ×
        </button>
      </div>
      <IptvPlayer
        grant={playing.grant}
        autoPlay
        startPositionSecs={playing.startPositionSecs}
        onPositionUpdate={onPositionUpdate}
      />
    </div>
  )
}

// The resume-or-start-over prompt, in the same dialog chrome the player uses
// (so focus trapping and Escape behave) but NO grant yet — the slot is claimed
// only after the choice. Mirrors the local-media MediaPlayer's prompt-first
// order via the shared ResumePrompt.
function ResumeChoiceModal({
  title,
  resumeSecs,
  onResume,
  onStartOver,
  onClose,
}: {
  title: string
  resumeSecs: number
  onResume: () => void
  onStartOver: () => void
  onClose: () => void
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  return (
    <div
      ref={modalRef}
      className="iptv-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div className="iptv-player-modal__header">
        <h2>{title}</h2>
        <button className="iptv-player-modal__close" type="button" onClick={onClose} aria-label="Close player">
          ×
        </button>
      </div>
      <ResumePrompt resumeSecs={resumeSecs} onResume={onResume} onStartOver={onStartOver} />
    </div>
  )
}

export default function IptvSeriesTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [offset, setOffset] = useState(0)
  const [selectedSeriesId, setSelectedSeriesId] = useState<number | null>(null)
  const [selectedSeriesTitle, setSelectedSeriesTitle] = useState('')
  const [playing, setPlaying] = useState<{
    grant: StreamGrant
    title: string
    itemId: string
    startPositionSecs?: number
  } | null>(null)
  const [concurrencyError, setConcurrencyError] = useState<ConcurrencyLimitPayload | null>(null)
  const [pendingPlay, setPendingPlay] = useState<(() => Promise<void>) | null>(null)
  // A saved resume point awaiting the user's resume-or-start-over choice. No
  // grant is minted (no concurrency slot held) while this prompt is on screen.
  const [resumeChoice, setResumeChoice] = useState<{
    episode: SeriesEpisodeDto
    resumeSecs: number
  } | null>(null)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('series')
  const limit = 100
  const list = useIptvSeries({ q: debounced, categoryId, limit, offset })
  const detail = useIptvSeriesDetail(selectedSeriesId)
  const favs = useIptvFavoriteSet()
  const toggleFavorite = useToggleIptvFavorite()
  const history = useIptvHistoryIndex()
  const reportPosition = useReportPosition('series_episode', playing?.itemId ?? '')

  const count = list.data?.items.length ?? 0
  const total = list.data?.total ?? 0
  const pageStart = total > 0 ? offset + 1 : 0
  const pageEnd = Math.min(offset + count, total)

  const selectSeries = (series: SeriesDto) => {
    setSelectedSeriesId(series.series_id)
    setSelectedSeriesTitle(series.name)
  }

  const handleSeriesKeyDown = (event: KeyboardEvent, series: SeriesDto) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectSeries(series)
  }

  // Mint the grant and start playback at the chosen offset. The concurrency
  // slot is claimed HERE — only after the resume choice (or immediately when
  // there's no resume point). The retry re-attempts with the SAME chosen
  // offset, never re-reading history (which may have changed since).
  const startPlayback = async (episode: SeriesEpisodeDto, startPositionSecs: number | undefined) => {
    const itemId = episode.episode_id.toString()
    const attempt = async () => {
      const grant = await iptvApi.grantSeries(itemId)
      setPlaying({
        grant,
        title: episode.title || `Episode ${episode.episode_num}`,
        itemId,
        startPositionSecs,
      })
    }
    try {
      await attempt()
    } catch (err) {
      const payload = concurrencyPayloadFromError(err)
      if (payload) {
        setConcurrencyError(payload)
        setPendingPlay(() => attempt)
        return
      }
      throw err
    }
  }

  const playEpisode = async (episode: SeriesEpisodeDto) => {
    const itemId = episode.episode_id.toString()
    // Prompt resume-or-start-over BEFORE granting (no slot burned while the
    // user reads it). resumePosition returns undefined for completed/0 rows, so
    // those start fresh immediately.
    const resumeSecs = resumePosition(history.get(`series_episode:${itemId}`))
    if (resumeSecs != null) {
      setResumeChoice({ episode, resumeSecs })
      return
    }
    await startPlayback(episode, undefined)
  }

  const handleEpisodeKeyDown = (event: KeyboardEvent, episode: SeriesEpisodeDto) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void playEpisode(episode)
  }

  return (
    <section className="iptv-tab">
      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      {list.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load series.</p>}
      <ul className="iptv-poster-grid">
        {(list.data?.items ?? []).map((s) => {
          const itemId = s.series_id.toString()
          const favKey = `series:${itemId}`
          const isFav = favs.has(favKey)

          return (
            <li
              key={s.series_id}
              className="iptv-poster-card"
              role="button"
              tabIndex={0}
              onClick={() => selectSeries(s)}
              onKeyDown={(event) => handleSeriesKeyDown(event, s)}
            >
              <button
                className={`iptv-fav-toggle ${isFav ? 'iptv-fav-toggle--on' : ''}`}
                type="button"
                aria-label={isFav ? 'Unfavorite' : 'Favorite'}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleFavorite.mutate({ kind: 'series', itemId, currentlyFav: isFav })
                }}
              >
                {isFav ? '★' : '☆'}
              </button>
              {s.cover
                ? <img src={s.cover} alt="" className="iptv-poster-card__img" loading="lazy" />
                : <div className="iptv-poster-card__img iptv-poster-card__img--placeholder" aria-hidden />}
              <div className="iptv-poster-card__name" title={s.name}>{s.name}</div>
            </li>
          )
        })}
      </ul>

      {total > limit && (
        <nav className="iptv-tab__pager" aria-label="Series pages">
          <span className="iptv-tab__page-count">
            {pageStart}-{pageEnd} of {total}
          </span>
          <button type="button" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0 || list.isFetching}>
            Previous
          </button>
          <button type="button" onClick={() => setOffset(offset + limit)} disabled={offset + count >= total || list.isFetching}>
            Next
          </button>
        </nav>
      )}

      <footer className="iptv-tab__toolbar">
        <input
          className="iptv-tab__search"
          placeholder="Search series…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOffset(0)
          }}
        />
        <select
          className="iptv-tab__category"
          value={categoryId ?? ''}
          onChange={(e) => {
            setCategoryId(e.target.value ? Number(e.target.value) : undefined)
            setOffset(0)
          }}
        >
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
        </select>
      </footer>

      {selectedSeriesId != null && (
        <SeriesDetailModal title={selectedSeriesTitle} onClose={() => setSelectedSeriesId(null)}>
          <div className="iptv-series-detail">
            {detail.isLoading && <p className="iptv-tab__status">Loading…</p>}
            {detail.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load episodes.</p>}
            {(detail.data?.seasons ?? []).map((season) => (
              <section className="iptv-series-detail__season" key={season.season}>
                <h3>Season {season.season}</h3>
                <ul className="iptv-series-detail__episodes">
                  {season.episodes.map((episode) => {
                    const pct = resumePercent(history.get(`series_episode:${episode.episode_id}`))

                    return (
                      <li
                        key={episode.episode_id}
                        className="iptv-series-detail__episode"
                        role="button"
                        tabIndex={0}
                        onClick={() => void playEpisode(episode)}
                        onKeyDown={(event) => handleEpisodeKeyDown(event, episode)}
                      >
                        <span>{episode.episode_num}</span>
                        <span>{episode.title || `Episode ${episode.episode_num}`}</span>
                        {pct != null && <div className="iptv-resume-bar" style={{ width: `${pct}%` }} />}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        </SeriesDetailModal>
      )}

      {resumeChoice && (
        <ResumeChoiceModal
          title={resumeChoice.episode.title || `Episode ${resumeChoice.episode.episode_num}`}
          resumeSecs={resumeChoice.resumeSecs}
          onResume={() => {
            const { episode, resumeSecs } = resumeChoice
            setResumeChoice(null)
            void startPlayback(episode, resumeSecs)
          }}
          onStartOver={() => {
            const { episode } = resumeChoice
            setResumeChoice(null)
            void startPlayback(episode, undefined)
          }}
          onClose={() => setResumeChoice(null)}
        />
      )}

      {playing && (
        <PlayerModal
          playing={playing}
          onClose={() => setPlaying(null)}
          onPositionUpdate={(positionSecs, durationSecs) => {
            const completed = durationSecs != null && positionSecs >= Math.max(0, durationSecs - 30)
            reportPosition(positionSecs, durationSecs, completed)
          }}
        />
      )}

      {concurrencyError && (
        <ConcurrencyLimitModal
          payload={concurrencyError}
          onClose={() => {
            setConcurrencyError(null)
            setPendingPlay(null)
          }}
          onAfterKick={() => {
            const retry = pendingPlay
            setConcurrencyError(null)
            setPendingPlay(null)
            if (retry) void retry().catch(() => undefined)
          }}
        />
      )}
    </section>
  )
}
