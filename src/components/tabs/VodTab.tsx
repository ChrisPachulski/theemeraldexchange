// src/components/tabs/VodTab.tsx
import { type KeyboardEvent, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { iptvApi, type StreamGrant, type VodDto } from '../../lib/api/iptv'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvVod } from '../../lib/hooks/useIptvVod'
import { useIptvFavoriteSet, useToggleIptvFavorite } from '../../lib/hooks/useIptvFavorites'
import { useIptvHistoryIndex, useReportPosition } from '../../lib/hooks/useIptvHistory'
import { useDebounced } from '../../lib/hooks/useDebounced'

type ResumeRow = {
  position_secs: number
  duration_secs: number | null
  completed: number
}

function resumePercent(row: ResumeRow | undefined): number | null {
  if (!row || row.completed) return null
  if (!row.duration_secs || row.duration_secs <= 0) return 0
  return Math.min(100, Math.max(0, (row.position_secs / row.duration_secs) * 100))
}

function resumePosition(row: ResumeRow | undefined): number | undefined {
  if (!row || row.completed || row.position_secs <= 0) return undefined
  return row.position_secs
}

export default function VodTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [playing, setPlaying] = useState<{
    grant: StreamGrant
    title: string
    itemId: string
    startPositionSecs?: number
  } | null>(null)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('vod')
  const list = useIptvVod({ q: debounced, categoryId, limit: 100 })
  const favs = useIptvFavoriteSet()
  const toggleFavorite = useToggleIptvFavorite()
  const history = useIptvHistoryIndex()
  const reportPosition = useReportPosition('vod', playing?.itemId ?? '')

  const playVod = async (vod: VodDto) => {
    const itemId = vod.stream_id.toString()
    const grant = await iptvApi.grantVod(itemId)
    setPlaying({
      grant,
      title: vod.name,
      itemId,
      startPositionSecs: resumePosition(history.get(`vod:${itemId}`)),
    })
  }

  const handleCardKeyDown = (event: KeyboardEvent, vod: VodDto) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void playVod(vod)
  }

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
        <input className="iptv-tab__search" placeholder="Search movies…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          className="iptv-tab__category"
          value={categoryId ?? ''}
          onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
        </select>
      </header>
      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
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

      {playing && (
        <div className="iptv-player-modal" role="dialog" aria-modal="true" aria-label={playing.title}>
          <div className="iptv-player-modal__header">
            <h2>{playing.title}</h2>
            <button className="iptv-player-modal__close" type="button" onClick={() => setPlaying(null)} aria-label="Close player">
              ×
            </button>
          </div>
          <IptvPlayer
            grant={playing.grant}
            autoPlay
            startPositionSecs={playing.startPositionSecs}
            onPositionUpdate={(positionSecs, durationSecs) => {
              const completed = durationSecs != null && positionSecs >= Math.max(0, durationSecs - 30)
              reportPosition(positionSecs, durationSecs, completed)
            }}
          />
        </div>
      )}
    </section>
  )
}
