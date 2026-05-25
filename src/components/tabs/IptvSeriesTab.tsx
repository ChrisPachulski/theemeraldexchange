// src/components/tabs/IptvSeriesTab.tsx
import { useState } from 'react'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvSeries } from '../../lib/hooks/useIptvSeries'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function IptvSeriesTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('series')
  const list = useIptvSeries({ q: debounced, categoryId, limit: 100 })

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
        <input className="iptv-tab__search" placeholder="Search series…" value={q} onChange={(e) => setQ(e.target.value)} />
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
        {(list.data?.items ?? []).map((s) => (
          <li key={s.series_id} className="iptv-poster-card">
            {s.cover
              ? <img src={s.cover} alt="" className="iptv-poster-card__img" loading="lazy" />
              : <div className="iptv-poster-card__img iptv-poster-card__img--placeholder" aria-hidden />}
            <div className="iptv-poster-card__name" title={s.name}>{s.name}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}
