// src/components/tabs/LiveTab.tsx
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import EpgGuide, { type GuideChannel } from './EpgGuide'
import { useQueryClient } from '@tanstack/react-query'
import {
  iptvApi,
  type ChannelDto,
  type EpgGridDto,
  type EpgProgrammeDto,
  type PagedDto,
  type EpgSearchHit,
  type SourceUnavailableError,
  type StreamGrant,
} from '../../lib/api/iptv'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import {
  EPG_SEARCH_MIN_CHARS,
  useIptvEpgChannel,
  useIptvEpgNow,
  useIptvEpgSearch,
} from '../../lib/hooks/useIptvEpg'
import { useIptvLive } from '../../lib/hooks/useIptvLive'
import { useIptvFavoriteSet, useToggleIptvFavorite } from '../../lib/hooks/useIptvFavorites'
import { useReportPosition } from '../../lib/hooks/useIptvHistory'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import { useIntent } from '../../lib/router'
import {
  effectiveGuideCategoryIds,
  formatGuideCategoryNames,
  isAdultCategory,
  readGuideCategoryNames,
  writeGuideCategoryNames,
} from '../../lib/guideCategories'
import type { CategoryDto } from '../../lib/api/iptv'
import { ConcurrencyLimitModal } from '../iptv/ConcurrencyLimitModal'
import { ConnectionsWidget } from '../iptv/ConnectionsWidget'
import { LibrarySearchResults } from '../iptv/LibrarySearchResults'
import { LivePlayerModal, type LivePlaying } from '../iptv/LivePlayerModal'
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

type PlayFailure = {
  message: string
  alternatives: SourceUnavailableError['available_alternatives']
}

// Maps a failed grant/play rejection to a user-visible status. Without this a
// non-concurrency grant error (provider down, source_unavailable, policy block,
// tunnel timeout) was rethrown into a void'ed click handler and vanished into
// the unhandledrejection telemetry — the user clicked a channel and nothing
// happened, no player, no error. The server's §9/§12.4 source_unavailable
// contract carries available_alternatives the viewer must be shown as an
// explicit choice; every other ApiError already carries a friendly message
// from throwApiError.
function playFailureFromError(err: unknown): PlayFailure {
  const details =
    (err && typeof err === 'object' ? (err as { details?: Record<string, unknown> }).details : undefined) ?? {}
  if ((details as { reason?: string }).reason === 'source_unavailable') {
    const raw = (details as { available_alternatives?: unknown }).available_alternatives
    const alternatives = Array.isArray(raw)
      ? (raw as SourceUnavailableError['available_alternatives'])
      : []
    return { message: "This channel's source is unavailable right now.", alternatives }
  }
  const message =
    err instanceof Error && err.message
      ? err.message
      : 'Couldn’t start playback. Try again in a moment.'
  return { message, alternatives: [] }
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
  const [view, setView] = useState<'cards' | 'guide' | 'favorites'>('guide')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [offset, setOffset] = useState(0)
  const [playing, setPlaying] = useState<LivePlaying | null>(null)
  const [guideFor, setGuideFor] = useState<(GuideChannel & { untilIso?: string; selectedStart?: string }) | null>(null)
  const [concurrencyError, setConcurrencyError] = useState<ConcurrencyLimitPayload | null>(null)
  const [playError, setPlayError] = useState<PlayFailure | null>(null)
  const [pendingPlay, setPendingPlay] = useState<(() => Promise<void>) | null>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  // Persisted curated guide-category selection (category names). Empty = the
  // US+sports default. Held in state so toggling re-renders the guide immediately.
  const [guideNames, setGuideNames] = useState(() => readGuideCategoryNames())
  const [showGuideCats, setShowGuideCats] = useState(false)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('live')
  const limit = 100
  const list = useIptvLive({ q: debounced, categoryId, limit, offset })
  const favs = useIptvFavoriteSet()
  const toggleFavorite = useToggleIptvFavorite()
  const queryClient = useQueryClient()
  // One grant per tap (Apple's in-flight tune guard): a double click must not
  // mint two upstream sessions on a 2-connection plan. The ref is the guard
  // (synchronous); the state only drives the busy cursor.
  const tuningRef = useRef(false)
  const [tuning, setTuning] = useState(false)
  const guardTune = async (tune: () => Promise<void>) => {
    if (tuningRef.current) return
    tuningRef.current = true
    setTuning(true)
    try {
      await tune()
    } finally {
      tuningRef.current = false
      setTuning(false)
    }
  }
  const reportPosition = useReportPosition('live', playing?.itemId ?? '')
  // Swap a fresh grant into the item still playing (live reconnect, remux escalation).
  const swapGrant = useCallback(
    (itemId: string, grant: StreamGrant) =>
      setPlaying((cur) => (cur && cur.itemId === itemId ? { ...cur, grant } : cur)),
    [],
  )

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

  // Adult categories are never offered in the dropdown or the guide picker
  // (Apple GuideCategories.isAdult); the provider doesn't flag them.
  const sortedCats = useMemo(
    () => (cats.data ?? []).filter((c) => !isAdultCategory(c.name)).sort((a, b) => a.name.localeCompare(b.name)),
    [cats.data],
  )
  // The category set the default ("All") guide loads — curated to US+sports unless
  // the viewer customized it. A single category pick from the dropdown overrides it.
  const guideIds = useMemo(
    () => effectiveGuideCategoryIds(guideNames, cats.data ?? []),
    [guideNames, cats.data],
  )
  const saveGuideNames = (stored: string) => {
    setGuideNames(stored)
    writeGuideCategoryNames(stored)
  }
  const favStreamIds = useMemo(
    () => new Set([...favs].filter((k) => k.startsWith('live:')).map((k) => Number(k.slice('live:'.length)))),
    [favs],
  )
  // A favorite row is just an id and the server has no lookup by id, so names and
  // logos come from any channel page or guide grid already loaded this session
  // (Apple's FavoritesList resolves from one channel page), else "Channel N".
  const favoriteChannels = (): ChannelDto[] => {
    const known = new Map<number, ChannelDto>()
    for (const [, page] of queryClient.getQueriesData<PagedDto<ChannelDto>>({ queryKey: ['iptv', 'live'] })) {
      for (const c of page?.items ?? []) known.set(c.stream_id, c)
    }
    for (const [, rows] of queryClient.getQueriesData<EpgGridDto[]>({ queryKey: ['iptv', 'epg', 'grid'] })) {
      for (const r of rows ?? []) if (!known.has(r.stream_id)) known.set(r.stream_id, { ...r, category_id: null })
    }
    return [...favStreamIds].map(
      (id) =>
        known.get(id) ?? {
          stream_id: id,
          num: 0,
          name: `Channel ${id}`,
          stream_icon: null,
          epg_channel_id: null,
          category_id: null,
          tv_archive: 0,
          tv_archive_duration: null,
        },
    )
  }
  const visibleChannels = view === 'favorites' ? favoriteChannels() : (list.data?.items ?? [])
  const visibleIds = visibleChannels.map((c) => c.stream_id)
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

  const playChannel = (stream: { stream_id: number; name: string }) => guardTune(async () => {
    setPlayError(null)
    const attempt = async () => {
      const grant = await iptvApi.grantLive(stream.stream_id.toString())
      setPlaying({ grant, title: stream.name, itemId: stream.stream_id.toString(), live: true })
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
      // Never rethrow into the void'ed click handler: surface the failure
      // (with source_unavailable alternatives when the server sent them).
      setPlayError(playFailureFromError(err))
    }
  })

  // Home's "On now" row tunes a channel via `#/live/<streamId>`. epg/now carries
  // no channel name, hence the generic player title.
  useIntent('live', true, (ref) => void playChannel({ stream_id: Number(ref), name: 'Live TV' }))

  // Shared by the per-channel guide modal and the grid guide. Mirrors
  // playChannel's concurrency handling so a 429 surfaces the kick-a-session
  // modal instead of throwing.
  const playCatchup = (channel: GuideChannel, programme: EpgProgrammeDto) => guardTune(async () => {
    setPlayError(null)
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
      setPlayError(playFailureFromError(err))
    }
  })

  // A programme hit carries no archive metadata; resolve its real channel so the
  // guide's catch-up rows are right (Apple SearchScreen.openProgram), then open
  // the guide scrolled to the hit.
  const showHitInGuide = async (hit: EpgSearchHit) => {
    const page = await iptvApi.listLive({ q: hit.channelName, limit: 100 }).catch(() => null)
    const c = page?.items.find((ch) => ch.stream_id === hit.streamId)
    setGuideFor({
      id: hit.streamId,
      name: hit.channelName,
      archiveDays: c ? Math.max(0, c.tv_archive_duration ?? 7) : 0,
      canCatchup: c?.tv_archive === 1,
      untilIso: hit.programme.stop_utc,
      selectedStart: hit.programme.start_utc,
    })
  }

  const handleCardKeyDown = (event: KeyboardEvent, stream: ChannelDto) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void playChannel(stream)
  }

  return (
    <section className="iptv-tab" aria-busy={tuning || undefined}>
      {playError && (
        <div className="iptv-tab__status iptv-tab__status--error" role="alert">
          <p>{playError.message}</p>
          {playError.alternatives.length > 0 && (
            <ul className="iptv-tab__alternatives">
              {playError.alternatives.map((alt) => (
                <li key={`${alt.source}:${alt.id}`}>{alt.displayName}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="iptv-tab__status-dismiss"
            onClick={() => setPlayError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      <ProgrammeResults
        q={debounced}
        onPlayLive={(hit) => void playChannel({ stream_id: hit.streamId, name: hit.channelName })}
        onShowInGuide={(hit) => void showHitInGuide(hit)}
      />
      <LibrarySearchResults q={debounced} />
      {view === 'guide' ? (
        <EpgGuide
          categoryId={categoryId}
          categoryIds={guideIds}
          categoriesLoaded={!!cats.data}
          q={debounced}
          favorites={favStreamIds}
          onToggleFavorite={(streamId, isFav) =>
            toggleFavorite.mutate({ kind: 'live', itemId: String(streamId), currentlyFav: isFav })
          }
          onPlayLive={(channel) => void playChannel(channel)}
          onPlayCatchup={(channel, programme) => void playCatchup(channel, programme)}
        />
      ) : (
      <>
      {view === 'cards' && list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      {view === 'cards' && list.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load channels.</p>}
      {view === 'favorites' && visibleChannels.length === 0 && (
        <p className="iptv-tab__status">No favorite channels yet. Star a channel in Channels or the Guide.</p>
      )}

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
                  <span className="iptv-channel-card__num">{c.num || ''}</span>
                  <span className="iptv-channel-card__name">{c.name}</span>
                </div>
                <div className="iptv-channel-card__epg">
                  <span><strong>Now:</strong> {epg?.current ?? '—'}</span>
                  <span><strong>Next:</strong> {epg?.next ?? '—'}</span>
                </div>
                {c.tv_archive === 1 && <span className="iptv-channel-card__catchup">Catch-up</span>}
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

      {view === 'cards' && total > limit && (
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
          <button
            type="button"
            className={view === 'favorites' ? 'is-active' : ''}
            aria-pressed={view === 'favorites'}
            onClick={() => setView('favorites')}
          >
            Favorites
          </button>
        </div>
        <input
          className="iptv-tab__search"
          placeholder="Search channels and programs…"
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
        {view === 'guide' && categoryId === undefined && (
          <button
            type="button"
            className="iptv-tab__guide-cats"
            onClick={() => setShowGuideCats(true)}
            title="Choose which categories the guide shows"
          >
            Guide categories
          </button>
        )}
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

      {showGuideCats && (
        <GuideCategorySettings
          categories={sortedCats}
          allCategories={cats.data ?? []}
          stored={guideNames}
          onChange={saveGuideNames}
          onClose={() => setShowGuideCats(false)}
        />
      )}

      {guideFor && (
        <ChannelGuide
          channel={guideFor}
          untilIso={guideFor.untilIso}
          selectedStart={guideFor.selectedStart}
          onClose={() => setGuideFor(null)}
          onPlayLive={async () => {
            await playChannel({ stream_id: guideFor.id, name: guideFor.name })
            setGuideFor(null)
          }}
          onPlayCatchup={async (programme) => {
            await playCatchup(guideFor, programme)
            setGuideFor(null)
          }}
        />
      )}

      {playing && (
        <LivePlayerModal
          // Not the grant URL: a reconnect swaps grants and must keep its state.
          key={`${playing.itemId}|${playing.title}`}
          playing={playing}
          guideCategoryIds={guideIds}
          favorites={favStreamIds}
          onClose={() => setPlaying(null)}
          onSurf={(channel) => void playChannel(channel)}
          onGrant={swapGrant}
          onEscalate={
            // Live raw-TS channel the browser demuxer can't hold: swap to the
            // server remux (same grant the Apple app uses) once.
            playing.live && playing.grant.delivery === 'mpegts'
              ? () => {
                  void iptvApi.grantLive(playing.itemId, { avplayer: true }).then(
                    (grant) => swapGrant(playing.itemId, grant),
                    (err) => setPlayError(playFailureFromError(err)),
                  )
                }
              : undefined
          }
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
            // A retry that fails after freeing a slot must not strand silently.
            if (retry) void retry().catch((err) => setPlayError(playFailureFromError(err)))
          }}
        />
      )}
    </section>
  )
}

// The Guide-categories picker — a port of the Apple app's SettingsScreen "Guide
// channels" section. Choosing fewer categories means a smaller, faster guide;
// emptying the selection reverts to the US+sports default rather than blanking it.
function GuideCategorySettings({
  categories,
  allCategories,
  stored,
  onChange,
  onClose,
}: {
  categories: CategoryDto[] // display order (sorted by name, adult-free)
  allCategories: CategoryDto[] // catalog order — for a stable stored value
  stored: string
  onChange: (stored: string) => void
  onClose: () => void
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  const selected = new Set(effectiveGuideCategoryIds(stored, allCategories))

  const toggle = (id: number) => {
    const ids = new Set(selected)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    // Stored by name (ids drift on every provider sync), in catalog order.
    onChange(formatGuideCategoryNames(allCategories.filter((c) => ids.has(c.category_id)).map((c) => c.name)))
  }

  return (
    <div
      ref={modalRef}
      className="iptv-guide-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Guide categories"
      tabIndex={-1}
    >
      <div className="iptv-guide-modal__panel">
        <header className="iptv-guide-modal__header">
          <h2>Guide categories</h2>
          <button className="iptv-guide-modal__close" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="iptv-guide-modal__status">
          Categories shown in the guide. Fewer categories means a smaller, faster guide.
          Default: US channels + Sports.
        </p>
        <button type="button" className="iptv-guide-cats__reset" onClick={() => onChange('')}>
          Reset to default (US + Sports)
        </button>

        <ul className="iptv-guide-cats__list">
          {categories.map((cat) => {
            const isOn = selected.has(cat.category_id)
            return (
              <li key={cat.category_id} className="iptv-guide-cats__item">
                <label>
                  <input type="checkbox" checked={isOn} onChange={() => toggle(cat.category_id)} />
                  <span>{cat.name}</span>
                </label>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

function ChannelGuide({
  channel,
  untilIso,
  selectedStart,
  onClose,
  onPlayLive,
  onPlayCatchup,
}: {
  channel: GuideChannel
  // Extends the window past the default 4h so an upcoming search hit is listed.
  untilIso?: string
  // A programme search hit to scroll to and highlight.
  selectedStart?: string
  onClose: () => void
  onPlayLive: () => Promise<void>
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
  const toIso = useMemo(() => {
    const until = untilIso ? new Date(untilIso).getTime() : NaN
    return new Date(Math.max(openedAt + 4 * 3600_000, Number.isFinite(until) ? until : 0)).toISOString()
  }, [openedAt, untilIso])
  const epg = useIptvEpgChannel(channel.id, fromIso, toIso)
  const archiveCutoff = openedAt - channel.archiveDays * 24 * 3600_000
  const selectedMs = selectedStart ? new Date(selectedStart).getTime() : NaN
  const selectedRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'center' })
  }, [epg.data])

  const handlePlay = async (programme: EpgProgrammeDto, play: () => Promise<void>) => {
    setError(null)
    setPendingStart(programme.start_utc)
    try {
      await play()
    } catch {
      setError('Couldn’t start playback.')
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
        {epg.error && (
          // A failed fetch must not read as "no programmes" — offer a real retry.
          <div className="iptv-guide-modal__status iptv-guide-modal__status--error" role="alert">
            <p>Couldn’t load the guide.</p>
            <button type="button" className="iptv-tab__retry" onClick={() => void epg.refetch()}>Retry</button>
          </div>
        )}
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
            const isSelected = start === selectedMs
            const description = programme.description?.trim()

            return (
              <li
                ref={isSelected ? selectedRef : undefined}
                className={'iptv-guide-list__item' + (isSelected ? ' iptv-guide-list__item--selected' : '')}
                key={`${programme.channel_id}:${programme.start_utc}`}
              >
                <span className="iptv-guide-list__time">{formatGuideTime(programme.start_utc)}</span>
                <span className="iptv-guide-list__info">
                  <span className="iptv-guide-list__title">{epgTitle(programme.title)}</span>
                  {description && <span className="iptv-guide-list__desc">{description}</span>}
                </span>
                {isCurrent && (
                  <button
                    className="iptv-guide-list__catchup"
                    type="button"
                    disabled={pendingStart === programme.start_utc}
                    onClick={() => void handlePlay(programme, onPlayLive)}
                  >
                    Watch live
                  </button>
                )}
                {inArchive && (
                  <button
                    className="iptv-guide-list__catchup"
                    type="button"
                    disabled={pendingStart === programme.start_utc}
                    onClick={() => void handlePlay(programme, () => onPlayCatchup(programme))}
                  >
                    Catchup
                  </button>
                )}
                {!inArchive && isPast && (
                  <span className="iptv-guide-list__note">{channel.canCatchup ? '(beyond archive)' : '(no archive)'}</span>
                )}
                {isFuture && <span className="iptv-guide-list__note">(upcoming)</span>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

const PROGRAMME_SEARCH_HOURS = 24
const PROGRAMME_SEARCH_LIMIT = 60
const SEARCH_BUCKET_MS = 5 * 60_000

function isAiring(programme: EpgProgrammeDto, nowMs: number): boolean {
  return new Date(programme.start_utc).getTime() <= nowMs && new Date(programme.stop_utc).getTime() > nowMs
}

function formatClock(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

function formatDayClock(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

// Programme hits for the search box — the Apple Live -> Search "Programs" section.
// Searches title + description across every channel's schedule for the next 24h,
// so typing a team or show finds the channels carrying it. Airing hits tune the
// channel; upcoming ones open that channel's guide.
function ProgrammeResults({
  q,
  onPlayLive,
  onShowInGuide,
}: {
  q: string
  onPlayLive: (hit: EpgSearchHit) => void
  onShowInGuide: (hit: EpgSearchHit) => void
}) {
  // Ticks so LIVE badges age out; the 5-min bucket keeps the query key stable while
  // typing, and programmes that ended inside the bucket are dropped below.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const fromMs = Math.floor(nowMs / SEARCH_BUCKET_MS) * SEARCH_BUCKET_MS
  const fromIso = new Date(fromMs).toISOString()
  const toIso = new Date(fromMs + PROGRAMME_SEARCH_HOURS * 3600_000).toISOString()
  const search = useIptvEpgSearch(q, fromIso, toIso, PROGRAMME_SEARCH_LIMIT)
  const hits = useMemo(() => {
    const live: EpgSearchHit[] = []
    const later: EpgSearchHit[] = []
    for (const hit of search.data?.hits ?? []) {
      if (new Date(hit.programme.stop_utc).getTime() <= nowMs) continue
      ;(isAiring(hit.programme, nowMs) ? live : later).push(hit)
    }
    later.sort((a, b) => a.programme.start_utc.localeCompare(b.programme.start_utc))
    return [...live, ...later]
  }, [search.data, nowMs])

  if (q.trim().length < EPG_SEARCH_MIN_CHARS) return null
  if (search.isLoading) return <p className="iptv-tab__status">Searching programs…</p>
  if (search.error) return <p className="iptv-tab__status iptv-tab__status--error">Program search failed.</p>
  if (hits.length === 0) return null

  const total = search.data?.total ?? hits.length
  return (
    <section className="iptv-prog-results" aria-label="Matching programs">
      <h2 className="iptv-prog-results__head">
        Programs <span>{total > hits.length ? `${hits.length} of ${total}` : hits.length}</span>
      </h2>
      <ul className="iptv-prog-results__list">
        {hits.map((hit) => {
          const airing = isAiring(hit.programme, nowMs)
          return (
            <li key={`${hit.streamId}#${hit.programIndex}`}>
              <button
                type="button"
                className="iptv-prog-results__item"
                onClick={() => (airing ? onPlayLive(hit) : onShowInGuide(hit))}
                title={airing ? `Watch ${hit.channelName} live` : `Show ${hit.channelName} in the guide`}
              >
                <span className="iptv-prog-results__title">{epgTitle(hit.programme.title)}</span>
                <span className="iptv-prog-results__meta">
                  {airing && <strong className="iptv-prog-results__live">LIVE</strong>}
                  <span className="iptv-prog-results__chan">{hit.channelName}</span>
                  <span className="iptv-prog-results__time">
                    {airing
                      ? `until ${formatClock(hit.programme.stop_utc)}`
                      : formatDayClock(hit.programme.start_utc)}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
