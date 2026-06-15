// src/components/tabs/VodTab.tsx
import { type KeyboardEvent, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { iptvApi, type StreamGrant, type VodDto } from '../../lib/api/iptv'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvVod } from '../../lib/hooks/useIptvVod'
import { useIptvFavoriteSet, useToggleIptvFavorite } from '../../lib/hooks/useIptvFavorites'
import {
  resumePercent,
  resumePosition,
  useIptvHistoryIndex,
  useReportPosition,
} from '../../lib/hooks/useIptvHistory'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import { ResumeChoiceModal } from '../iptv/ResumeChoiceModal'
import { ConcurrencyLimitModal } from '../iptv/ConcurrencyLimitModal'
import {
  concurrencyPayloadFromError,
  type ConcurrencyLimitPayload,
} from '../iptv/concurrencyLimit'

// The player dialog is a plain div (role=dialog/aria-modal), so useModalA11y
// supplies the focus trap, Escape-to-close, and focus restoration that
// aria-modal="true" promises (LiveTab pattern). It lives in its own component
// so the hook's open/close effect runs when the dialog mounts.
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

export default function VodTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [offset, setOffset] = useState(0)
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
  const [resumeChoice, setResumeChoice] = useState<{ vod: VodDto; resumeSecs: number } | null>(null)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('vod')
  const limit = 100
  const list = useIptvVod({ q: debounced, categoryId, limit, offset })
  const favs = useIptvFavoriteSet()
  const toggleFavorite = useToggleIptvFavorite()
  const history = useIptvHistoryIndex()
  const reportPosition = useReportPosition('vod', playing?.itemId ?? '')

  const count = list.data?.items.length ?? 0
  const total = list.data?.total ?? 0
  const pageStart = total > 0 ? offset + 1 : 0
  const pageEnd = Math.min(offset + count, total)

  // Mint the grant and start playback at the chosen offset. The concurrency
  // slot is claimed HERE — only after the resume choice (or immediately when
  // there's no resume point). The retry re-attempts with the SAME chosen
  // offset, never re-reading history (which may have changed since).
  const startPlayback = async (vod: VodDto, startPositionSecs: number | undefined) => {
    const itemId = vod.stream_id.toString()
    const attempt = async () => {
      const grant = await iptvApi.grantVod(itemId)
      setPlaying({ grant, title: vod.name, itemId, startPositionSecs })
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

  const playVod = async (vod: VodDto) => {
    const itemId = vod.stream_id.toString()
    // Prompt resume-or-start-over BEFORE granting (no slot burned while the
    // user reads it). resumePosition returns undefined for completed/0 rows, so
    // those start fresh immediately.
    const resumeSecs = resumePosition(history.get(`vod:${itemId}`))
    if (resumeSecs != null) {
      setResumeChoice({ vod, resumeSecs })
      return
    }
    await startPlayback(vod, undefined)
  }

  const handleCardKeyDown = (event: KeyboardEvent, vod: VodDto) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void playVod(vod)
  }

  return (
    <section className="iptv-tab">
      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      {list.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load movies.</p>}
      <ul className="iptv-poster-grid">
        {(list.data?.items ?? []).map((v) => {
          const itemId = v.stream_id.toString()
          const favKey = `vod:${itemId}`
          const isFav = favs.has(favKey)
          const pct = resumePercent(history.get(favKey))

          return (
            <li
              key={v.stream_id}
              className="iptv-poster-card"
              role="button"
              tabIndex={0}
              onClick={() => void playVod(v)}
              onKeyDown={(event) => handleCardKeyDown(event, v)}
            >
              <button
                className={`iptv-fav-toggle ${isFav ? 'iptv-fav-toggle--on' : ''}`}
                type="button"
                aria-label={isFav ? 'Unfavorite' : 'Favorite'}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleFavorite.mutate({ kind: 'vod', itemId, currentlyFav: isFav })
                }}
              >
                {isFav ? '★' : '☆'}
              </button>
              {v.stream_icon
                ? <img src={v.stream_icon} alt="" className="iptv-poster-card__img" loading="lazy" />
                : <div className="iptv-poster-card__img iptv-poster-card__img--placeholder" aria-hidden />}
              {pct != null && <div className="iptv-resume-bar" style={{ width: `${pct}%` }} />}
              <div className="iptv-poster-card__name" title={v.name}>{v.name}</div>
              {v.year ? <div className="iptv-poster-card__year">{v.year}</div> : null}
            </li>
          )
        })}
      </ul>
      {total > limit && (
        <nav className="iptv-tab__pager" aria-label="VOD pages">
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
          placeholder="Search movies…"
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

      {resumeChoice && (
        <ResumeChoiceModal
          title={resumeChoice.vod.name}
          resumeSecs={resumeChoice.resumeSecs}
          onResume={() => {
            const { vod, resumeSecs } = resumeChoice
            setResumeChoice(null)
            void startPlayback(vod, resumeSecs)
          }}
          onStartOver={() => {
            const { vod } = resumeChoice
            setResumeChoice(null)
            void startPlayback(vod, undefined)
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
