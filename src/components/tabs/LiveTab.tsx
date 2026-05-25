// src/components/tabs/LiveTab.tsx
import { type KeyboardEvent, useMemo, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { iptvApi, type ChannelDto, type StreamGrant } from '../../lib/api/iptv'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvLive } from '../../lib/hooks/useIptvLive'
import { useIptvFavoriteSet, useToggleIptvFavorite } from '../../lib/hooks/useIptvFavorites'
import { useReportPosition } from '../../lib/hooks/useIptvHistory'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function LiveTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [playing, setPlaying] = useState<{ grant: StreamGrant; title: string; itemId: string } | null>(null)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('live')
  const list = useIptvLive({ q: debounced, categoryId, limit: 100, offset: 0 })
  const favs = useIptvFavoriteSet()
  const toggleFavorite = useToggleIptvFavorite()
  const reportPosition = useReportPosition('live', playing?.itemId ?? '')

  const sortedCats = useMemo(() => (cats.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [cats.data])

  const playChannel = async (stream: ChannelDto) => {
    const grant = await iptvApi.grantLive(stream.stream_id.toString())
    setPlaying({ grant, title: stream.name, itemId: stream.stream_id.toString() })
  }

  const handleCardKeyDown = (event: KeyboardEvent, stream: ChannelDto) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void playChannel(stream)
  }

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
        <input
          className="iptv-tab__search"
          placeholder="Search channels…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="iptv-tab__category"
          value={categoryId ?? ''}
          onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">All categories</option>
          {sortedCats.map((c) => (
            <option key={c.category_id} value={c.category_id}>{c.name}</option>
          ))}
        </select>
      </header>

      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      {list.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load channels.</p>}

      <ul className="iptv-channel-grid">
        {(list.data?.items ?? []).map((c) => {
          const itemId = c.stream_id.toString()
          const favKey = `live:${itemId}`
          const isFav = favs.has(favKey)

          return (
            <li
              key={c.stream_id}
              className="iptv-channel-card"
              role="button"
              tabIndex={0}
              onClick={() => void playChannel(c)}
              onKeyDown={(event) => handleCardKeyDown(event, c)}
            >
              <button
                className={`iptv-fav-toggle ${isFav ? 'iptv-fav-toggle--on' : ''}`}
                type="button"
                aria-label={isFav ? 'Unfavorite' : 'Favorite'}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleFavorite.mutate({ kind: 'live', itemId, currentlyFav: isFav })
                }}
              >
                {isFav ? '★' : '☆'}
              </button>
              {c.stream_icon
                ? <img src={c.stream_icon} alt="" className="iptv-channel-card__icon" loading="lazy" />
                : <div className="iptv-channel-card__icon iptv-channel-card__icon--placeholder" aria-hidden />}
              <div className="iptv-channel-card__meta">
                <span className="iptv-channel-card__num">{c.num}</span>
                <span className="iptv-channel-card__name">{c.name}</span>
              </div>
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
            onPositionUpdate={(positionSecs, durationSecs) => reportPosition(positionSecs, durationSecs, false)}
          />
        </div>
      )}
    </section>
  )
}
