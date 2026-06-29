// src/components/tabs/EpgGuide.tsx
//
// Classic TV-guide grid: channels down the left (sticky), a scrollable time
// axis across the top (sticky), programme blocks sized by duration, and a live
// "now" line. Scoped to channels that actually carry EPG (this provider only
// has guide data for ~800 of 50k channels — see 0005_lowercase_epg_id), so the
// grid isn't a wall of empty rows. Search + category come from the parent.
//
// Rows are vertically windowed (only the on-screen slice is mounted) so the
// grid stays smooth across the full has-EPG set (~11.5k channels).
import { useEffect, useMemo, useRef, useState } from 'react'
import { type EpgGridDto, type EpgProgrammeDto } from '../../lib/api/iptv'
import { useIptvEpgGrid } from '../../lib/hooks/useIptvEpg'
import { blockWidth, visibleRowRange } from '../../lib/epgLayout'

export type GuideChannel = {
  id: number
  name: string
  archiveDays: number
  canCatchup: boolean
}

const PX_PER_MIN = 6 // 30 min = 180px, 1h = 360px
const TOTAL_HOURS = 6 // 30 min of history + 5.5h forward
const ROW_H = 56
const HEADER_H = 32
const CHANNEL_COL = 200
const MIN_BLOCK_PX = 40
const OVERSCAN = 4
const BUCKET_MS = 30 * 60_000
// Cap the channel set fetched for the grid. The curated default (US + sports) is
// well under this, but a single big category could be large; the grid is
// virtualized client-side, so a generous cap is plenty (mirrors the Apple app's
// CatalogStore.guideChannelLimit).
const GUIDE_CHANNEL_LIMIT = 500

const trackWidth = TOTAL_HOURS * 60 * PX_PER_MIN

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function formatTick(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
}

function programmeDurationMin(p: EpgProgrammeDto): number {
  const start = new Date(p.start_utc).getTime()
  const stop = new Date(p.stop_utc).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return 1
  return Math.max(1, Math.round((stop - start) / 60_000))
}

const ms = (iso: string): number => new Date(iso).getTime()

// The programme airing right now on a channel (for the detail pane when a whole
// channel row, rather than a single block, is hovered).
function currentProgramme(row: EpgGridDto, nowMs: number): EpgProgrammeDto | null {
  return (
    row.programmes.find((p) => {
      const s = ms(p.start_utc)
      const e = ms(p.stop_utc)
      return Number.isFinite(s) && Number.isFinite(e) && s <= nowMs && e > nowMs
    }) ?? null
  )
}

// The next programme to start after a given one (for the pane's "NEXT" line).
function nextProgramme(row: EpgGridDto, afterIso: string): EpgProgrammeDto | null {
  const after = ms(afterIso)
  let best: EpgProgrammeDto | null = null
  let bestMs = Infinity
  for (const p of row.programmes) {
    const s = ms(p.start_utc)
    if (Number.isFinite(s) && s > after && s < bestMs) {
      best = p
      bestMs = s
    }
  }
  return best
}

// How far into a live programme we are now, 0..1 (null if not yet started/bad data).
function progressFraction(p: EpgProgrammeDto, nowMs: number): number | null {
  const s = ms(p.start_utc)
  const e = ms(p.stop_utc)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null
  return clamp((nowMs - s) / (e - s), 0, 1)
}

type ActiveCell = { streamId: number; progIndex: number | null }

export default function EpgGuide({
  categoryId,
  categoryIds,
  categoriesLoaded = true,
  q,
  onPlayLive,
  onPlayCatchup,
}: {
  categoryId?: number
  // Curated category set fed to the default ("All") guide view — US + sports by
  // default, customizable via the Guide-categories picker. Ignored when a single
  // categoryId is picked from the dropdown.
  categoryIds?: number[]
  // Whether the category list has loaded yet — gates the default fetch so we
  // don't pull the entire has-EPG catalog in the window before curation is known.
  categoriesLoaded?: boolean
  q: string
  onPlayLive: (channel: { stream_id: number; name: string }) => void
  onPlayCatchup: (channel: GuideChannel, programme: EpgProgrammeDto) => void
}) {
  // A 30-min bucketed anchor keeps the fetch window (and react-query key) stable
  // for half an hour while the now-line still updates every 30s.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const anchorMs = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS
  const windowStartMs = anchorMs - BUCKET_MS // show the last 30 min
  const windowEndMs = windowStartMs + TOTAL_HOURS * 3600_000
  const fromIso = new Date(windowStartMs).toISOString()
  const toIso = new Date(windowEndMs).toISOString()

  // Scoping (curated default, borrowed from the Apple guide, adapted for the web
  // where the guide IS the only search surface):
  //   • Single category picked from the dropdown → just that category.
  //   • A search query → resolved server-side across the whole catalog, so the
  //     guide still finds ANY scheduled channel (not only the curated set).
  //   • Otherwise ("All", no search) → the curated set (US + sports by default),
  //     so the grid is relevant and light instead of the full ~12k catalog.
  // Every path restricts to channels that actually carry a schedule (hasEpg) — a
  // guide is about what's on — and is capped at GUIDE_CHANNEL_LIMIT.
  const trimmedQ = q.trim()
  const curated = useMemo(() => categoryIds ?? [], [categoryIds])
  const gridOpts =
    categoryId != null
      ? { categoryId, q: trimmedQ || undefined, hasEpg: true, limit: GUIDE_CHANNEL_LIMIT }
      : trimmedQ
        ? { q: trimmedQ, hasEpg: true, limit: GUIDE_CHANNEL_LIMIT }
        : curated.length > 0
          ? { categoryIds: curated, hasEpg: true, limit: GUIDE_CHANNEL_LIMIT }
          : { hasEpg: true, limit: GUIDE_CHANNEL_LIMIT }
  // Only the pure-curated path depends on the category list; wait for it so we
  // curate rather than dump the whole catalog. Once loaded we fetch even if the
  // curated set is empty (graceful fallback to all-has-EPG for a provider with no
  // US/sports categories).
  const pureDefault = categoryId == null && trimmedQ === ''
  const enabled = !pureDefault || curated.length > 0 || categoriesLoaded
  const grid = useIptvEpgGrid(fromIso, toIso, { ...gridOpts, enabled })
  const rows = useMemo(() => grid.data ?? [], [grid.data])

  // Vertical windowing.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)

  // The cell the pointer/keyboard is over — drives the pinned now/next detail
  // pane (the Channels-DVR / Apple-guide pattern) so the cells stay compact and
  // never balloon to reveal a synopsis.
  const [active, setActive] = useState<ActiveCell | null>(null)
  const activeDetail = useMemo(() => {
    if (!active) return null
    const row = rows.find((r) => r.stream_id === active.streamId)
    if (!row) return null
    const prog =
      active.progIndex != null ? row.programmes[active.progIndex] ?? null : currentProgramme(row, nowMs)
    const live = prog ? ms(prog.start_utc) <= nowMs && ms(prog.stop_utc) > nowMs : false
    return { row, prog, live }
  }, [active, rows, nowMs])
  // The scroll container only mounts AFTER data loads — the loading/empty/error
  // states render a <p> instead, so on first mount scrollRef.current is null.
  // With [] deps this effect ran exactly once (during "Loading…"), bailed on the
  // null ref, and never re-ran — so the scroll listener never attached and the
  // guide stayed frozen on its first ~viewport of rows (looked like "only ~25
  // channels" even though thousands were returned). Re-bind when it mounts.
  const guideReady = enabled && !grid.isLoading && !grid.error && rows.length > 0
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onScroll = () => setScrollTop(el.scrollTop)
    const measure = () => setViewportH(el.clientHeight)
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', measure)
    }
  }, [guideReady])

  const scrollBucket = Math.max(0, Math.floor((scrollTop - HEADER_H) / ROW_H))
  const viewportRows = Math.ceil(viewportH / ROW_H) + 1
  // visibleRowRange clamps a stale bucket so a search that shrinks the list can't
  // leave firstVisible past the end (which blanked the grid until you scrolled).
  const { start: firstVisible, end: lastVisible } = visibleRowRange(
    scrollBucket,
    viewportRows,
    rows.length,
    OVERSCAN,
  )
  const visibleRows = rows.slice(firstVisible, lastVisible)

  const ticks = useMemo(() => {
    const out: number[] = []
    for (let t = windowStartMs; t <= windowEndMs; t += BUCKET_MS) out.push(t)
    return out
  }, [windowStartMs, windowEndMs])

  const nowOffsetPx = clamp((nowMs - windowStartMs) / 60_000 * PX_PER_MIN, 0, trackWidth)
  const contentWidth = CHANNEL_COL + trackWidth

  // Re-scroll the track so the now-line sits ~12% from the left (a little history
  // visible). The channel column is sticky, so scrollLeft is measured in track px.
  const jumpToLive = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ left: Math.max(0, nowOffsetPx - el.clientWidth * 0.12), behavior: 'smooth' })
  }
  // Spacer-based windowing: the rows stay in normal flow (so the sticky channel
  // column actually pins against the scroll container — a sticky child of an
  // absolutely-positioned row would resolve against the row, not the viewport),
  // and top/bottom spacers reserve the off-screen height.
  const topPad = firstVisible * ROW_H
  const bottomPad = Math.max(0, (rows.length - lastVisible) * ROW_H)

  if (!enabled || grid.isLoading) {
    return <p className="iptv-tab__status">Loading guide…</p>
  }
  if (grid.error) {
    return <p className="iptv-tab__status iptv-tab__status--error">Failed to load guide.</p>
  }
  if (rows.length === 0) {
    return (
      <p className="iptv-tab__status">
        No guide data for {trimmedQ ? `“${trimmedQ}”` : categoryId != null ? 'this category' : 'these channels'}.
        Most channels from this provider don’t publish a schedule; try a major network, or switch back to Channels.
      </p>
    )
  }

  return (
    <div className="epg-guide-wrap">
      <GuideDetailPane detail={activeDetail} nowMs={nowMs} onJumpToLive={jumpToLive} />
      <div className="epg-guide" ref={scrollRef} role="grid" aria-label="Programme guide">
      <div className="epg-guide__content" style={{ width: contentWidth }}>
        {/* sticky header: top-left corner + scrollable time axis */}
        <div className="epg-guide__header" style={{ height: HEADER_H }}>
          <div className="epg-guide__corner" style={{ width: CHANNEL_COL }}>{rows.length} ch</div>
          <div className="epg-guide__times" style={{ width: trackWidth }}>
            {ticks.map((t) => (
              <span
                key={t}
                className={`epg-guide__tick ${t === anchorMs ? 'epg-guide__tick--hour' : ''}`}
                style={{ left: (t - windowStartMs) / 60_000 * PX_PER_MIN }}
              >
                {formatTick(t)}
              </span>
            ))}
          </div>
        </div>

        <div className="epg-guide__body">
          {/* now line spans all rows; scrolls under the sticky header + channel col */}
          <div
            className="epg-guide__nowline"
            style={{ left: CHANNEL_COL + nowOffsetPx, top: 0, height: rows.length * ROW_H }}
            aria-hidden
          />
          <div style={{ height: topPad }} aria-hidden />
          {visibleRows.map((row) => (
            <GuideRow
              key={row.stream_id}
              row={row}
              windowStartMs={windowStartMs}
              nowMs={nowMs}
              active={active}
              onActivate={setActive}
              onPlayLive={onPlayLive}
              onPlayCatchup={onPlayCatchup}
            />
          ))}
          <div style={{ height: bottomPad }} aria-hidden />
        </div>
      </div>
      </div>
    </div>
  )
}

// Pinned now/next detail above the grid. Mirrors the Apple guide's focus-driven
// pane: hovering a programme (or a channel row) fills it with the show, time,
// live progress, synopsis, and what's NEXT — so the grid cells stay compact.
function GuideDetailPane({
  detail,
  nowMs,
  onJumpToLive,
}: {
  detail: { row: EpgGridDto; prog: EpgProgrammeDto | null; live: boolean } | null
  nowMs: number
  onJumpToLive: () => void
}) {
  const jump = (
    <button type="button" className="epg-detail__jump" onClick={onJumpToLive}>
      Jump to live
    </button>
  )
  if (!detail || !detail.prog) {
    return (
      <div className="epg-detail epg-detail--empty">
        <span className="epg-detail__hint">Hover a programme to see what’s on.</span>
        {jump}
      </div>
    )
  }
  const { row, prog, live } = detail
  const frac = live ? progressFraction(prog, nowMs) : null
  const next = nextProgramme(row, prog.start_utc)
  const startMs = ms(prog.start_utc)
  const stopMs = ms(prog.stop_utc)
  return (
    <div className="epg-detail">
      <div className="epg-detail__head">
        <span className="epg-detail__chan-num">{row.num}</span>
        <span className="epg-detail__chan-name">{row.name}</span>
        {Number.isFinite(startMs) && Number.isFinite(stopMs) && (
          <span className="epg-detail__time">
            {formatTick(startMs)}–{formatTick(stopMs)}
          </span>
        )}
        {live && <span className="epg-detail__live">● LIVE</span>}
        <span className="epg-detail__spacer" />
        {jump}
      </div>
      <div className="epg-detail__title">{prog.title ?? '—'}</div>
      {frac != null && (
        <div className="epg-detail__bar" aria-hidden>
          <span style={{ width: `${Math.round(frac * 100)}%` }} />
        </div>
      )}
      <p className="epg-detail__desc">{prog.description?.trim() || 'No description available.'}</p>
      {next && Number.isFinite(ms(next.start_utc)) && (
        <div className="epg-detail__next">
          <strong>NEXT</strong>
          <span className="epg-detail__next-time">{formatTick(ms(next.start_utc))}</span>
          <span className="epg-detail__next-title">{next.title ?? '—'}</span>
        </div>
      )}
    </div>
  )
}

function GuideRow({
  row,
  windowStartMs,
  nowMs,
  active,
  onActivate,
  onPlayLive,
  onPlayCatchup,
}: {
  row: EpgGridDto
  windowStartMs: number
  nowMs: number
  active: ActiveCell | null
  onActivate: (cell: ActiveCell) => void
  onPlayLive: (channel: { stream_id: number; name: string }) => void
  onPlayCatchup: (channel: GuideChannel, programme: EpgProgrammeDto) => void
}) {
  const channel: GuideChannel = {
    id: row.stream_id,
    name: row.name,
    archiveDays: Math.max(0, row.tv_archive_duration ?? 7),
    canCatchup: row.tv_archive === 1,
  }
  const archiveCutoff = nowMs - channel.archiveDays * 24 * 3600_000
  const rowActive = active?.streamId === row.stream_id

  return (
    <div className="epg-guide__row" style={{ height: ROW_H, width: CHANNEL_COL + trackWidth }}>
      <button
        type="button"
        className={'epg-guide__chan' + (rowActive ? ' epg-guide__chan--active' : '')}
        style={{ width: CHANNEL_COL, height: ROW_H }}
        onClick={() => onPlayLive({ stream_id: row.stream_id, name: row.name })}
        onMouseEnter={() => onActivate({ streamId: row.stream_id, progIndex: null })}
        onFocus={() => onActivate({ streamId: row.stream_id, progIndex: null })}
        title={`Watch ${row.name} live`}
      >
        <span className="epg-guide__chan-num">{row.num}</span>
        <span className="epg-guide__chan-name">{row.name}</span>
      </button>

      <div className="epg-guide__track" style={{ width: trackWidth, height: ROW_H }}>
        {row.programmes.map((p, i) => {
          const start = new Date(p.start_utc).getTime()
          const stop = new Date(p.stop_utc).getTime()
          if (!Number.isFinite(start) || !Number.isFinite(stop)) return null
          const left = clamp((start - windowStartMs) / 60_000 * PX_PER_MIN, 0, trackWidth)
          const right = clamp((stop - windowStartMs) / 60_000 * PX_PER_MIN, 0, trackWidth)
          if (right <= 0 || left >= trackWidth) return null
          // Bound this block at the next programme's start (track width if last) so
          // a short block padded up to MIN_BLOCK_PX — or a provider's overlapping
          // stop time — never draws on top of its neighbour. Programmes arrive
          // sorted by start (server ORDER BY start_utc).
          const nextStart = new Date(row.programmes[i + 1]?.start_utc ?? '').getTime()
          const nextLeft = Number.isFinite(nextStart)
            ? clamp((nextStart - windowStartMs) / 60_000 * PX_PER_MIN, 0, trackWidth)
            : trackWidth
          const width = blockWidth(left, right, nextLeft, MIN_BLOCK_PX)
          if (width <= 0) return null

          const isLive = start <= nowMs && stop > nowMs
          const isPast = stop <= nowMs
          const canCatchup = channel.canCatchup && isPast && start >= archiveCutoff
          const interactive = isLive || canCatchup

          return (
            <button
              key={`${p.channel_id}:${p.start_utc}`}
              type="button"
              className={
                'epg-guide__prog' +
                (isLive ? ' epg-guide__prog--live' : '') +
                (isPast ? ' epg-guide__prog--past' : '') +
                (interactive ? '' : ' epg-guide__prog--static') +
                (rowActive && active?.progIndex === i ? ' epg-guide__prog--active' : '')
              }
              style={{ left, width }}
              // aria-disabled (not `disabled`) for non-interactive blocks: a truly
              // disabled button fires no hover/focus, which would stop the detail
              // pane from updating when you move over a past programme. onClick
              // already no-ops unless live/catch-up.
              aria-disabled={!interactive}
              title={`${p.title ?? 'Programme'} · ${programmeDurationMin(p)} min${canCatchup ? ' · catch up' : ''}`}
              onMouseEnter={() => onActivate({ streamId: row.stream_id, progIndex: i })}
              onFocus={() => onActivate({ streamId: row.stream_id, progIndex: i })}
              onClick={() => {
                if (isLive) onPlayLive({ stream_id: row.stream_id, name: row.name })
                else if (canCatchup) onPlayCatchup(channel, p)
              }}
            >
              <span className="epg-guide__prog-title">{p.title ?? '—'}</span>
              {canCatchup && <span className="epg-guide__prog-badge">⟲</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
