// src/components/tabs/VodTab.tsx
import { type KeyboardEvent, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { iptvApi, type StreamGrant, type VodDto } from '../../lib/api/iptv'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvVod } from '../../lib/hooks/useIptvVod'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function VodTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [playing, setPlaying] = useState<{ grant: StreamGrant; title: string } | null>(null)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('vod')
  const list = useIptvVod({ q: debounced, categoryId, limit: 100 })

  const playVod = async (vod: VodDto) => {
    const grant = await iptvApi.grantVod(vod.stream_id.toString())
    setPlaying({ grant, title: vod.name })
  }

  const handleCardKeyDown = (event: KeyboardEvent, vod: VodDto) => {
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
        {(list.data?.items ?? []).map((v) => (
          <li
            key={v.stream_id}
            className="iptv-poster-card"
            role="button"
            tabIndex={0}
            onClick={() => void playVod(v)}
            onKeyDown={(event) => handleCardKeyDown(event, v)}
          >
            {v.stream_icon
              ? <img src={v.stream_icon} alt="" className="iptv-poster-card__img" loading="lazy" />
              : <div className="iptv-poster-card__img iptv-poster-card__img--placeholder" aria-hidden />}
            <div className="iptv-poster-card__name" title={v.name}>{v.name}</div>
            {v.year ? <div className="iptv-poster-card__year">{v.year}</div> : null}
          </li>
        ))}
      </ul>

      {playing && (
        <div className="iptv-player-modal" role="dialog" aria-modal="true" aria-label={playing.title}>
          <div className="iptv-player-modal__header">
            <h2>{playing.title}</h2>
            <button className="iptv-player-modal__close" type="button" onClick={() => setPlaying(null)} aria-label="Close player">
              ×
            </button>
          </div>
          <IptvPlayer grant={playing.grant} autoPlay />
        </div>
      )}
    </section>
  )
}
