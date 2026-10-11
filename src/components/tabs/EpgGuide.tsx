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
import { ReplayButton } from '../nav/ReplayButton'
import { ProgrammeDialog } from '../iptv/ProgrammeDialog'
import { type EpgGridDto, type EpgProgrammeDto } from '../../lib/api/iptv'
import { useIptvEpgGrid } from '../../lib/hooks/useIptvEpg'
import { blockWidth, visibleRowRange } from '../../lib/epgLayout'
import {
  GUIDE_BUCKET_MS,
  GUIDE_CHANNEL_LIMIT,
  GUIDE_HOURS,
  airingNow,
  filterGuideRows,
  guideWindow,
} from '../../lib/guideRows'

export type GuideChannel = {
  id: number
  name: string
  archiveDays: number
  canCatchup: boolean
}

const PX_PER_MIN = 6 // 30 min = 180px, 1h = 360px
const ROW_H = 56
const HEADER_H = 32
const CHANNEL_COL = 220
const MIN_BLOCK_PX = 40
const OVERSCAN = 4

const trackWidth = GUIDE_HOURS * 60 * PX_PER_MIN

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

const NO_FAVORITES: ReadonlySet<number> = new Set()

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
type FutureSelection = { row: EpgGridDto; programme: EpgProgrammeDto }

export default function EpgGuide({
  categoryId,
  categoryIds,
  categoriesLoaded = true,
  q,
  favorites = NO_FAVORITES,
  onToggleFavorite,
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
  // Favorite channel stream ids: pinned to the top of the grid.
  favorites?: ReadonlySet<number>
  onToggleFavorite?: (streamId: number, isFav: boolean) => void
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

  const { anchorMs, startMs: windowStartMs, endMs: windowEndMs, fromIso, toIso } = guideWindow(nowMs)

  // Scoping (curated default, borrowed from the Apple guide):
  //   • Single category picked from the dropdown → just that category.
  //   • Otherwise → the curated set (US + sports by default), so the grid is
  //     relevant and light instead of the full ~12k catalog. An empty curated set
  //     fails closed with a hint rather than loading everything.
  //   • A search query keeps that scope's rows whose channel or any programme
  //     matches (client-side, Apple GuideSearch), unioned with the server's
  //     channel-NAME matches across the whole catalog, so the guide still finds
  //     any scheduled channel by name.
  // Every path restricts to channels that actually carry a schedule (hasEpg) — a
  // guide is about what's on — and is capped at GUIDE_CHANNEL_LIMIT.
  const trimmedQ = q.trim()
  const curated = useMemo(() => categoryIds ?? [], [categoryIds])
  const baseEnabled = categoryId != null || curated.length > 0
  const base = useIptvEpgGrid(fromIso, toIso, {
    ...(categoryId != null ? { categoryId } : { categoryIds: curated }),
    hasEpg: true,
    limit: GUIDE_CHANNEL_LIMIT,
    enabled: baseEnabled,
  })
  const named = useIptvEpgGrid(fromIso, toIso, {
    ...(categoryId != null ? { categoryId } : {}),
    q: trimmedQ,
    hasEpg: true,
    limit: GUIDE_CHANNEL_LIMIT,
    enabled: trimmedQ !== '',
  })
  const queries = [baseEnabled ? base : null, trimmedQ ? named : null].filter((g) => g !== null)
  const rows = useMemo(() => {
    const scoped = baseEnabled ? (base.data ?? []) : []
    if (!trimmedQ) return filterGuideRows(scoped, '', favorites)
    const byName = named.data ?? []
    const seen = new Set(byName.map((r) => r.stream_id))
    const byProgramme = filterGuideRows(scoped, trimmedQ, NO_FAVORITES).filter((r) => !seen.has(r.stream_id))
    return filterGuideRows([...byName, ...byProgramme], '', favorites)
  }, [baseEnabled, base.data, named.data, trimmedQ, favorites])
  const loading = queries.some((g) => g.isLoading)
  const failed = queries.some((g) => g.error)
  const retry = () => {
    for (const g of queries) void g.refetch()
  }

  // Vertical windowing.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)

  // The cell the pointer/keyboard is over — drives the pinned now/next detail
  // pane (the Channels-DVR / Apple-guide pattern) so the cells stay compact and
  // never balloon to reveal a synopsis.
  const [active, setActive] = useState<ActiveCell | null>(null)
  const [future, setFuture] = useState<FutureSelection | null>(null)
  const activeDetail = useMemo(() => {
    if (!active) return null
    const row = rows.find((r) => r.stream_id === active.streamId)
    if (!row) return null
    const prog =
      active.progIndex != null ? row.programmes[active.progIndex] ?? null : airingNow(row, nowMs)
    const live = prog ? ms(prog.start_utc) <= nowMs && ms(prog.stop_utc) > nowMs : false
    return { row, prog, live }
  }, [active, rows, nowMs])
  // The scroll container only mounts AFTER data loads — the loading/empty/error
  // states render a <p> instead, so on first mount scrollRef.current is null.
  // With [] deps this effect ran exactly once (during "Loading…"), bailed on the
  // null ref, and never re-ran — so the scroll listener never attached and the
  // guide stayed frozen on its first ~viewport of rows (looked like "only ~25
  // channels" even though thousands were returned). Re-bind when it mounts.
  const guideReady = rows.length > 0
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
    for (let t = windowStartMs; t <= windowEndMs; t += GUIDE_BUCKET_MS) out.push(t)
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

  if (!baseEnabled && !trimmedQ) {
    if (categoryId == null && !categoriesLoaded) return <p className="iptv-tab__status">Loading guide…</p>
    return (
      <p className="iptv-tab__status">
        No live categories chosen for the guide. Pick some with the Guide categories button below.
      </p>
    )
  }
  if (rows.length === 0) {
    if (loading) return <p className="iptv-tab__status">Loading guide…</p>
    return failed ? (
      <div className="iptv-tab__status iptv-tab__status--error" role="alert">
        <p>Couldn’t load the guide.</p>
        <button type="button" className="iptv-tab__retry" onClick={retry}>Retry</button>
      </div>
    ) : (
      <div className="iptv-tab__status">
        <p>
          {trimmedQ
            ? `No channels or programs match “${trimmedQ}”.`
            : `No guide data for ${categoryId != null ? 'this category' : 'these channels'}.
        Most channels from this provider don’t publish a schedule; try a major network, or switch back to Channels.`}
        </p>
        <button type="button" className="iptv-tab__retry" onClick={retry}>Retry</button>
      </div>
    )
  }

  return (
    <div className="epg-guide-wrap">
      {failed && (
        // A failed refetch keeps the painted rows (Apple's "may be out of date" banner).
        <div className="epg-guide__stale" role="status">
          <span>Guide may be out of date.</span>
          <button type="button" className="iptv-tab__retry" onClick={retry}>Retry</button>
        </div>
      )}
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
              isFav={favorites.has(row.stream_id)}
              onToggleFavorite={onToggleFavorite}
              onPlayLive={onPlayLive}
              onPlayCatchup={onPlayCatchup}
              onSelectFuture={(programme) => setFuture({ row, programme })}
            />
          ))}
          <div style={{ height: bottomPad }} aria-hidden />
        </div>
      </div>
      </div>
      {future && (
        <ProgrammeDialog channel={future.row} programme={future.programme} onClose={() => setFuture(null)} />
      )}
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
    <>
      <ReplayButton inline />
      <button type="button" className="epg-detail__jump" onClick={onJumpToLive}>
        Jump to live
      </button>
    </>
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
  isFav,
  onToggleFavorite,
  onPlayLive,
  onPlayCatchup,
  onSelectFuture,
}: {
  row: EpgGridDto
  windowStartMs: number
  nowMs: number
  active: ActiveCell | null
  onActivate: (cell: ActiveCell) => void
  isFav: boolean
  onToggleFavorite?: (streamId: number, isFav: boolean) => void
  onPlayLive: (channel: { stream_id: number; name: string }) => void
  onPlayCatchup: (channel: GuideChannel, programme: EpgProgrammeDto) => void
  onSelectFuture: (programme: EpgProgrammeDto) => void
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
      {/* Sticky channel cell: a play button plus the favorite star (a button
          can't nest another). */}
      <div
        className={'epg-guide__chan' + (rowActive ? ' epg-guide__chan--active' : '')}
        style={{ width: CHANNEL_COL, height: ROW_H }}
      >
        <button
          type="button"
          className="epg-guide__chan-play"
          onClick={() => onPlayLive({ stream_id: row.stream_id, name: row.name })}
          onMouseEnter={() => onActivate({ streamId: row.stream_id, progIndex: null })}
          onFocus={() => onActivate({ streamId: row.stream_id, progIndex: null })}
          title={`Watch ${row.name} live`}
        >
          {row.stream_icon && <img className="epg-guide__chan-logo" src={row.stream_icon} alt="" loading="lazy" />}
          <span className="epg-guide__chan-num">{row.num}</span>
          <span className="epg-guide__chan-name">{row.name}</span>
          {channel.canCatchup && (
            <span className="epg-guide__chan-catchup" role="img" aria-label="Catch-up available" title="Catch-up available">
              ⟲
            </span>
          )}
        </button>
        {onToggleFavorite && (
          <button
            type="button"
            className={'epg-guide__chan-fav' + (isFav ? ' epg-guide__chan-fav--on' : '')}
            aria-label={isFav ? `Unfavorite ${row.name}` : `Favorite ${row.name}`}
            aria-pressed={isFav}
            onClick={() => onToggleFavorite(row.stream_id, isFav)}
          >
            {isFav ? '★' : '☆'}
          </button>
        )}
      </div>

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
          const isFuture = start > nowMs
          const canCatchup = channel.canCatchup && isPast && start >= archiveCutoff
          // A future block opens its details (and Record): touch has no hover pane.
          const interactive = isLive || canCatchup || isFuture

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
              // already no-ops unless live/catch-up/future.
              aria-disabled={!interactive}
              title={`${p.title ?? 'Programme'} · ${programmeDurationMin(p)} min${canCatchup ? ' · catch up' : ''}${isFuture ? ' · details' : ''}`}
              onMouseEnter={() => onActivate({ streamId: row.stream_id, progIndex: i })}
              onFocus={() => onActivate({ streamId: row.stream_id, progIndex: i })}
              onClick={() => {
                if (isLive) onPlayLive({ stream_id: row.stream_id, name: row.name })
                else if (canCatchup) onPlayCatchup(channel, p)
                else if (isFuture) onSelectFuture(p)
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
