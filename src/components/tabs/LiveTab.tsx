// src/components/tabs/LiveTab.tsx
import { useMemo, useState } from 'react'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvLive } from '../../lib/hooks/useIptvLive'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function LiveTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [offset, setOffset] = useState(0)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('live')
  const limit = 100
  const list = useIptvLive({ q: debounced, categoryId, limit, offset })

  const sortedCats = useMemo(() => (cats.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [cats.data])
  const count = list.data?.items.length ?? 0
  const total = list.data?.total ?? 0
  const pageStart = total > 0 ? offset + 1 : 0
  const pageEnd = Math.min(offset + count, total)

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
        <input
          className="iptv-tab__search"
          placeholder="Search channels…"
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
          {sortedCats.map((c) => (
            <option key={c.category_id} value={c.category_id}>{c.name}</option>
          ))}
        </select>
      </header>

      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      {list.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load channels.</p>}

      <ul className="iptv-channel-grid">
        {(list.data?.items ?? []).map((c) => (
          <li key={c.stream_id} className="iptv-channel-card">
            {c.stream_icon
              ? <img src={c.stream_icon} alt="" className="iptv-channel-card__icon" loading="lazy" />
              : <div className="iptv-channel-card__icon iptv-channel-card__icon--placeholder" aria-hidden />}
            <div className="iptv-channel-card__meta">
              <span className="iptv-channel-card__num">{c.num}</span>
              <span className="iptv-channel-card__name">{c.name}</span>
            </div>
          </li>
        ))}
      </ul>
      {total > limit && (
        <nav className="iptv-tab__pager" aria-label="Channel pages">
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
