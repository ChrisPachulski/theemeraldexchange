import { useEffect, useMemo, useState } from 'react'
import type { EpgGridDto } from '../../lib/api/iptv'
import { useIptvEpgGrid } from '../../lib/hooks/useIptvEpg'
import { GUIDE_CHANNEL_LIMIT, airingNow, filterGuideRows, guideWindow } from '../../lib/guideRows'

// Channel-surf strip over live playback, the Apple QuickGuide: one card per
// curated guide channel with what's on now. It asks for the same window and
// scope as the Guide view, so it normally reads the cached grid and costs no
// fetch. Picking a card tunes that channel in place.
export function MiniGuide({
  categoryIds,
  favorites,
  currentStreamId,
  onPick,
  onClose,
}: {
  categoryIds: number[]
  favorites: ReadonlySet<number>
  currentStreamId: number
  onPick: (row: EpgGridDto) => void
  onClose: () => void
}) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const { fromIso, toIso } = guideWindow(nowMs)
  const grid = useIptvEpgGrid(fromIso, toIso, {
    categoryIds,
    hasEpg: true,
    limit: GUIDE_CHANNEL_LIMIT,
    enabled: categoryIds.length > 0,
  })
  const rows = useMemo(() => filterGuideRows(grid.data ?? [], '', favorites), [grid.data, favorites])
  const retry = (
    <button type="button" className="iptv-tab__retry" onClick={() => void grid.refetch()}>Retry</button>
  )

  return (
    <section className="iptv-mini-guide" aria-label="Channel guide">
      <header className="iptv-mini-guide__head">
        <h3>Guide</h3>
        <button type="button" className="iptv-mini-guide__close" onClick={onClose} aria-label="Close guide">×</button>
      </header>
      {categoryIds.length === 0 ? (
        <p className="iptv-mini-guide__status">No live categories chosen for the guide.</p>
      ) : grid.isLoading ? (
        <p className="iptv-mini-guide__status">Loading guide…</p>
      ) : rows.length === 0 ? (
        <div className="iptv-mini-guide__status">
          <p>{grid.error ? 'Couldn’t load the guide.' : 'No guide data yet.'}</p>
          {retry}
        </div>
      ) : (
        <ul className="iptv-mini-guide__list">
          {rows.map((row) => {
            const current = row.stream_id === currentStreamId
            return (
              <li key={row.stream_id}>
                <button
                  type="button"
                  className={'iptv-mini-guide__card' + (current ? ' iptv-mini-guide__card--current' : '')}
                  aria-current={current || undefined}
                  title={`Switch to ${row.name}`}
                  onClick={() => onPick(row)}
                >
                  <span className="iptv-mini-guide__chan">
                    <span className="iptv-mini-guide__num">{row.num || ''}</span>
                    <span className="iptv-mini-guide__name">{row.name}</span>
                  </span>
                  <span className="iptv-mini-guide__now">{airingNow(row, nowMs)?.title?.trim() || '—'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
