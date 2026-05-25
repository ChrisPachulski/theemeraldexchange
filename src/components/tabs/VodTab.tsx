// src/components/tabs/VodTab.tsx
import { useState } from 'react'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvVod } from '../../lib/hooks/useIptvVod'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function VodTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [offset, setOffset] = useState(0)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('vod')
  const limit = 100
  const list = useIptvVod({ q: debounced, categoryId, limit, offset })
  const count = list.data?.items.length ?? 0
  const total = list.data?.total ?? 0
  const pageStart = total > 0 ? offset + 1 : 0
  const pageEnd = Math.min(offset + count, total)

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
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
      </header>
      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      {list.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load movies.</p>}
      <ul className="iptv-poster-grid">
        {(list.data?.items ?? []).map((v) => (
          <li key={v.stream_id} className="iptv-poster-card">
            {v.stream_icon
              ? <img src={v.stream_icon} alt="" className="iptv-poster-card__img" loading="lazy" />
              : <div className="iptv-poster-card__img iptv-poster-card__img--placeholder" aria-hidden />}
            <div className="iptv-poster-card__name" title={v.name}>{v.name}</div>
            {v.year ? <div className="iptv-poster-card__year">{v.year}</div> : null}
          </li>
        ))}
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
    </section>
  )
}
