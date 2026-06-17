// src/components/tabs/LiveTab.tsx
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import EpgGuide, { type GuideChannel } from './EpgGuide'
import { iptvApi, type ChannelDto, type EpgProgrammeDto, type StreamGrant } from '../../lib/api/iptv'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvEpgChannel, useIptvEpgNow } from '../../lib/hooks/useIptvEpg'
import { useIptvLive } from '../../lib/hooks/useIptvLive'
import { useIptvFavoriteSet, useToggleIptvFavorite } from '../../lib/hooks/useIptvFavorites'
import { useReportPosition } from '../../lib/hooks/useIptvHistory'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import { ConcurrencyLimitModal } from '../iptv/ConcurrencyLimitModal'
import { ConnectionsWidget } from '../iptv/ConnectionsWidget'
import {
  concurrencyPayloadFromError,
  type ConcurrencyLimitPayload,
} from '../iptv/concurrencyLimit'

function epgTitle(title: string | null | undefined): string {
  const trimmed = title?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : '—'
}

function programmeDurationMin(programme: EpgProgrammeDto): number {
  const start = new Date(programme.start_utc).getTime()
  const stop = new Date(programme.stop_utc).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return 1
  return Math.max(1, Math.round((stop - start) / 60_000))
}

function formatGuideTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

export default function LiveTab() {
  const [q, setQ] = useState('')
  const [view, setView] = useState<'cards' | 'guide'>('guide')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [offset, setOffset] = useState(0)
  const [playing, setPlaying] = useState<{ grant: StreamGrant; title: string; itemId: string } | null>(null)
  const [guideFor, setGuideFor] = useState<GuideChannel | null>(null)
  const [concurrencyError, setConcurrencyError] = useState<ConcurrencyLimitPayload | null>(null)
  const [pendingPlay, setPendingPlay] = useState<(() => Promise<void>) | null>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('live')
  const limit = 100
  const list = useIptvLive({ q: debounced, categoryId, limit, offset })
  const favs = useIptvFavoriteSet()
  const toggleFavorite = useToggleIptvFavorite()
  const reportPosition = useReportPosition('live', playing?.itemId ?? '')

  // Release the upstream concurrency slot whenever the active channel changes
  // or this tab unmounts. The grant ACQUIRES a slot; nothing released it on
  // exit, so closing a channel left the session "active" until a later grant's
  // 30s lazy sweep — rapid channel-hopping piled up phantom sessions and
  // saturated the provider's connection cap, which then stalled/refused new
  // grants. This cleanup fires for the PREVIOUS sessionId before the next play
  // sets a new one, covering close-button, channel-switch, and navigate-away
  // exits in one place. Best-effort: a failed release just falls back to the
  // server-side sweep/dedup.
  useEffect(() => {
    const sid = playing?.grant.sessionId
    if (!sid) return undefined
    return () => {
      void iptvApi.killSession(sid).catch(() => undefined)
    }
  }, [playing?.grant.sessionId])

  const sortedCats = useMemo(() => (cats.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [cats.data])
  const visibleChannels = useMemo(() => list.data?.items ?? [], [list.data])
  const visibleIds = useMemo(() => visibleChannels.map((c) => c.stream_id), [visibleChannels])
  const nowEpg = useIptvEpgNow(visibleIds)
  const count = visibleChannels.length
  const total = list.data?.total ?? 0
  const pageStart = total > 0 ? offset + 1 : 0
  const pageEnd = Math.min(offset + count, total)
  const epgIndex = useMemo(() => {
    const rows = new Map<number, { current: string; next: string }>()
    for (const row of nowEpg.data ?? []) {
      rows.set(row.channel_stream_id, {
        current: epgTitle(row.current?.title),
        next: epgTitle(row.next?.title),
      })
    }
    return rows
  }, [nowEpg.data])

  const playChannel = async (stream: { stream_id: number; name: string }) => {
    const attempt = async () => {
      const grant = await iptvApi.grantLive(stream.stream_id.toString())
      setPlaying({ grant, title: stream.name, itemId: stream.stream_id.toString() })
    }
    try {
      await attempt()
    } catch (err) {
      const payload = concurrencyPayloadFromError(err)
      if (payload) {
        setConcurrencyError(payload)
        // Stash the attempt so once the user kicks a session, we retry.
        setPendingPlay(() => attempt)
        return
      }
      throw err
    }
  }

  // Shared by the per-channel guide modal and the grid guide. Mirrors
  // playChannel's concurrency handling so a 429 surfaces the kick-a-session
  // modal instead of throwing.
  const playCatchup = async (channel: GuideChannel, programme: EpgProgrammeDto) => {
    const attempt = async () => {
      const grant = await iptvApi.grantCatchup(channel.id, programme.start_utc, programmeDurationMin(programme))
      setPlaying({ grant, title: `${channel.name}: ${epgTitle(programme.title)}`, itemId: String(channel.id) })
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

  const handleCardKeyDown = (event: KeyboardEvent, stream: ChannelDto) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void playChannel(stream)
  }

  return (
    <section className="iptv-tab">
      {view === 'guide' ? (
        <EpgGuide
          categoryId={categoryId}
          q={debounced}
          onPlayLive={(channel) => void playChannel(channel)}
          onPlayCatchup={(channel, programme) => void playCatchup(channel, programme).catch(() => undefined)}
        />
      ) : (
      <>
      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      {list.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load channels.</p>}

      <ul className="iptv-channel-grid">
        {visibleChannels.map((c) => {
          const itemId = c.stream_id.toString()
          const favKey = `live:${itemId}`
          const isFav = favs.has(favKey)
          const epg = epgIndex.get(c.stream_id)

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
              <div className="iptv-channel-card__body">
                <div className="iptv-channel-card__meta">
                  <span className="iptv-channel-card__num">{c.num}</span>
                  <span className="iptv-channel-card__name">{c.name}</span>
                </div>
                <div className="iptv-channel-card__epg">
                  <span><strong>Now:</strong> {epg?.current ?? '—'}</span>
                  <span><strong>Next:</strong> {epg?.next ?? '—'}</span>
                </div>
              </div>
              <button
                className="iptv-channel-card__guide"
                type="button"
                aria-label={`Open guide for ${c.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setGuideFor({
                    id: c.stream_id,
                    name: c.name,
                    archiveDays: Math.max(0, c.tv_archive_duration ?? 7),
                    canCatchup: c.tv_archive === 1,
                  })
                }}
              >
                Guide
              </button>
            </li>
          )
        })}
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
      </>
      )}

      <footer className="iptv-tab__toolbar">
        <div className="iptv-tab__viewtoggle" role="group" aria-label="Channel view">
          <button
            type="button"
            className={view === 'guide' ? 'is-active' : ''}
            aria-pressed={view === 'guide'}
            onClick={() => setView('guide')}
          >
            Guide
          </button>
          <button
            type="button"
            className={view === 'cards' ? 'is-active' : ''}
            aria-pressed={view === 'cards'}
            onClick={() => setView('cards')}
          >
            Channels
          </button>
        </div>
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
        <button type="button" onClick={async () => {
          // LOW-17: no blocking alert(); surface success/failure inline so a
          // failed generatePlaylist() isn't a silent unhandled rejection.
          setExportMsg('Generating…')
          try {
            const { url, expiresAt } = await iptvApi.generatePlaylist()
            await navigator.clipboard.writeText(url).catch(() => undefined)
            setExportMsg(`M3U URL copied to clipboard. Expires ${new Date(expiresAt).toLocaleString()}.`)
          } catch {
            setExportMsg('Could not generate the M3U playlist — try again.')
          }
        }}>Export M3U</button>
        {exportMsg && (
          <span className="iptv-tab__status" role="status">{exportMsg}</span>
        )}
        <ConnectionsWidget />
      </footer>

      {guideFor && (
        <ChannelGuide
          channel={guideFor}
          onClose={() => setGuideFor(null)}
          onPlayCatchup={async (programme) => {
            await playCatchup(guideFor, programme)
            setGuideFor(null)
          }}
        />
      )}

      {playing && (
        <PlayerModal
          playing={playing}
          onClose={() => setPlaying(null)}
          onPositionUpdate={(positionSecs, durationSecs) => reportPosition(positionSecs, durationSecs, false)}
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

// The player modal is a plain div (role=dialog/aria-modal) rather than a
// native <dialog> because it's a full-bleed layout, not a centered panel.
// useModalA11y supplies the focus trap, Escape-to-close, and focus restoration
// that aria-modal="true" promises but a bare div doesn't provide.
function PlayerModal({
  playing,
  onClose,
  onPositionUpdate,
}: {
  playing: { grant: StreamGrant; title: string; itemId: string }
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
      <IptvPlayer grant={playing.grant} autoPlay onPositionUpdate={onPositionUpdate} />
    </div>
  )
}

function ChannelGuide({
  channel,
  onClose,
  onPlayCatchup,
}: {
  channel: GuideChannel
  onClose: () => void
  onPlayCatchup: (programme: EpgProgrammeDto) => Promise<void>
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  const [pendingStart, setPendingStart] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openedAt] = useState(() => Date.now())
  const fromIso = useMemo(
    () => new Date(openedAt - channel.archiveDays * 24 * 3600_000).toISOString(),
    [channel.archiveDays, openedAt],
  )
  const toIso = useMemo(() => new Date(openedAt + 4 * 3600_000).toISOString(), [openedAt])
  const epg = useIptvEpgChannel(channel.id, fromIso, toIso)
  const archiveCutoff = openedAt - channel.archiveDays * 24 * 3600_000

  const handleCatchup = async (programme: EpgProgrammeDto) => {
    setError(null)
    setPendingStart(programme.start_utc)
    try {
      await onPlayCatchup(programme)
    } catch {
      setError('Failed to start catchup.')
    } finally {
      setPendingStart(null)
    }
  }

  return (
    <div
      ref={modalRef}
      className="iptv-guide-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${channel.name} guide`}
      tabIndex={-1}
    >
      <div className="iptv-guide-modal__panel">
        <header className="iptv-guide-modal__header">
          <h2>{channel.name}</h2>
          <button className="iptv-guide-modal__close" type="button" onClick={onClose} aria-label="Close guide">
            ×
          </button>
        </header>

        {epg.isLoading && <p className="iptv-guide-modal__status">Loading guide…</p>}
        {epg.error && <p className="iptv-guide-modal__status iptv-guide-modal__status--error">Failed to load guide.</p>}
        {error && <p className="iptv-guide-modal__status iptv-guide-modal__status--error">{error}</p>}

        {!epg.isLoading && !epg.error && (epg.data ?? []).length === 0 && (
          <p className="iptv-guide-modal__status">No programmes found.</p>
        )}

        <ul className="iptv-guide-list">
          {(epg.data ?? []).map((programme) => {
            const start = new Date(programme.start_utc).getTime()
            const stop = new Date(programme.stop_utc).getTime()
            const isPast = Number.isFinite(stop) && stop <= openedAt
            const isCurrent = Number.isFinite(start) && Number.isFinite(stop) && start <= openedAt && stop > openedAt
            const isFuture = Number.isFinite(start) && start > openedAt
            const inArchive = channel.canCatchup && isPast && start >= archiveCutoff

            return (
              <li className="iptv-guide-list__item" key={`${programme.channel_id}:${programme.start_utc}`}>
                <span className="iptv-guide-list__time">{formatGuideTime(programme.start_utc)}</span>
                <span className="iptv-guide-list__title">{epgTitle(programme.title)}</span>
                {inArchive && (
                  <button
                    className="iptv-guide-list__catchup"
                    type="button"
                    disabled={pendingStart === programme.start_utc}
                    onClick={() => void handleCatchup(programme)}
                  >
                    Catchup
                  </button>
                )}
                {!inArchive && isPast && (
                  <span className="iptv-guide-list__note">{channel.canCatchup ? '(beyond archive)' : '(no archive)'}</span>
                )}
                {isCurrent && <span className="iptv-guide-list__note">(now)</span>}
                {isFuture && <span className="iptv-guide-list__note">(upcoming)</span>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
