import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { sonarr, type Episode } from '../../lib/api/sonarr'
import { radarr } from '../../lib/api/radarr'
import type { ArrRelease, ArrHistoryRecord } from '../../lib/api/arrAdvanced'
import { useConfirm } from '../confirm/useConfirm'
import { useSonarrProfiles, useSonarrRootFolders } from '../../lib/hooks/useSonarrLibrary'
import { useRadarrProfiles, useRadarrRootFolders } from '../../lib/hooks/useRadarrLibrary'
import './ArrAdvancedPanel.css'

// Admin-only Advanced power-user actions for an in-library Sonarr series or
// Radarr movie. One component drives both apps via a small adapter so the TV
// and movie surfaces stay in lockstep; the only app-specific difference is
// the TV-only "Manage episodes" section. Contract: S1–S7 / R1–R6.
//
// Every async sub-surface (release browser, history, rename) renders explicit
// loading / empty / error states. Over-cap grabs require a confirm. The
// parent (DetailModal) owns the open/closed reveal; this component owns the
// queries, mutations, and per-action toasts.

type Kind = 'tv' | 'movie'

type Props = {
  kind: Kind
  /** The in-library item id (series id / movie id). */
  itemId: number
  /** Current monitored flag, for the monitoring toggle + edit defaults. */
  monitored: boolean
  /** Current quality profile + root folder, for the edit pickers' defaults. */
  qualityProfileId?: number
  rootFolderPath?: string
  /** TV only: the episode list already loaded by the detail modal, reused for
   *  the Manage-episodes section. */
  episodes?: Episode[]
  /** Surface a one-line status message to the host (rendered as a toast). */
  onToast: (message: string) => void
}

const COMMAND_NAMES = {
  tv: { refresh: 'RefreshSeries', search: 'SeriesSearch', rename: 'RenameFiles' },
  movie: { refresh: 'RefreshMovie', search: 'MoviesSearch', rename: 'RenameMovie' },
} as const

export function ArrAdvancedPanel(props: Props) {
  const { kind, itemId, onToast } = props
  const qc = useQueryClient()
  const confirm = useConfirm()
  const libraryKey = kind === 'tv' ? ['sonarr', 'series'] : ['radarr', 'movie']

  // --- Fire-and-forget commands (refresh & scan, search monitored). -------
  const command = useMutation({
    mutationFn: (body: Parameters<typeof sonarr.command>[0] | Parameters<typeof radarr.command>[0]) =>
      kind === 'tv'
        ? sonarr.command(body as Parameters<typeof sonarr.command>[0])
        : radarr.command(body as Parameters<typeof radarr.command>[0]),
    onError: (e) => onToast(e instanceof Error ? e.message : String(e)),
  })

  const refreshAndScan = () => {
    const name = COMMAND_NAMES[kind].refresh
    const body =
      kind === 'tv' ? { name, seriesId: itemId } : { name, movieIds: [itemId] }
    command.mutate(body as never, { onSuccess: () => onToast('Refreshing & scanning…') })
  }

  const searchMonitored = () => {
    const name = COMMAND_NAMES[kind].search
    const body =
      kind === 'tv' ? { name, seriesId: itemId } : { name, movieIds: [itemId] }
    command.mutate(body as never, { onSuccess: () => onToast('Searching monitored…') })
  }

  return (
    <div className="arr-adv">
      <div className="arr-adv__row">
        <button
          type="button"
          className="arr-adv__btn"
          onClick={refreshAndScan}
          disabled={command.isPending}
        >
          Refresh &amp; scan
        </button>
        <button
          type="button"
          className="arr-adv__btn"
          onClick={searchMonitored}
          disabled={command.isPending}
        >
          Search monitored
        </button>
      </div>

      <MonitoringSection {...props} libraryKey={libraryKey} />
      <InteractiveSearchSection {...props} confirm={confirm} />
      <RenameSection {...props} qc={qc} />
      {kind === 'tv' && <ManageEpisodesSection {...props} qc={qc} />}
      <HistorySection kind={kind} itemId={itemId} />
      <EditSection {...props} libraryKey={libraryKey} qc={qc} />
    </div>
  )
}

// --- Monitoring toggle (whole series/movie). -------------------------------
function MonitoringSection({
  kind,
  itemId,
  monitored,
  onToast,
  libraryKey,
}: Props & { libraryKey: string[] }) {
  const qc = useQueryClient()
  const toggle = useMutation({
    mutationFn: (next: boolean): Promise<unknown> =>
      kind === 'tv'
        ? sonarr.editSeries(itemId, { monitored: next })
        : radarr.editMovie(itemId, { monitored: next }),
    onSuccess: (_data, next) => {
      qc.invalidateQueries({ queryKey: libraryKey })
      onToast(next ? 'Monitoring on' : 'Monitoring off')
    },
    onError: (e) => onToast(e instanceof Error ? e.message : String(e)),
  })
  return (
    <section className="arr-adv__section">
      <h4 className="arr-adv__heading">Monitoring</h4>
      <label className="arr-adv__toggle">
        <input
          type="checkbox"
          checked={monitored}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        <span>{monitored ? 'Monitored' : 'Not monitored'}</span>
      </label>
    </section>
  )
}

// --- Interactive search (release browser). ---------------------------------
type ReleaseFilter = 'all' | 'season-pack' | 'not-season-pack' | 'english'

function InteractiveSearchSection({
  kind,
  itemId,
  episodes,
  onToast,
  confirm,
}: Props & { confirm: ReturnType<typeof useConfirm> }) {
  const [open, setOpen] = useState(false)
  const [season, setSeason] = useState<number | undefined>(undefined)
  const [filter, setFilter] = useState<ReleaseFilter>('all')
  const [regex, setRegex] = useState('')

  // Distinct season numbers (TV) so the admin can scope the search. Sonarr's
  // release search MUST be season-scoped to actually hit the indexer.
  const seasonNumbers = useMemo(() => {
    if (kind !== 'tv' || !episodes) return []
    return [...new Set(episodes.map((e) => e.seasonNumber).filter((n) => n > 0))].sort(
      (a, b) => a - b,
    )
  }, [kind, episodes])

  // Default the TV season to the first available so the first search is scoped.
  const effectiveSeason = kind === 'tv' ? (season ?? seasonNumbers[0]) : undefined

  const releases = useQuery({
    queryKey: ['arr-releases', kind, itemId, effectiveSeason],
    queryFn: () =>
      kind === 'tv'
        ? sonarr.releases(itemId, effectiveSeason)
        : radarr.releases(itemId),
    enabled: open && (kind === 'movie' || effectiveSeason !== undefined),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  const grab = useMutation({
    mutationFn: (r: ArrRelease & { allowOverCap?: boolean }) =>
      kind === 'tv'
        ? sonarr.grabRelease(
            itemId,
            { guid: r.guid, indexerId: r.indexerId, allowOverCap: r.allowOverCap },
            effectiveSeason,
          )
        : radarr.grabRelease(itemId, {
            guid: r.guid,
            indexerId: r.indexerId,
            allowOverCap: r.allowOverCap,
          }),
    onSuccess: (res) => onToast(`Grabbed ${res.title} (${res.sizeGb.toFixed(2)} GB)`),
    onError: (e) => onToast(e instanceof Error ? e.message : String(e)),
  })

  const onGrab = (r: ArrRelease) => {
    if (r.overCap) {
      confirm({
        title: 'Grab over-cap release?',
        body: `${r.title} is ${r.sizeGb.toFixed(2)} GB, above the size cap. Grab it anyway?`,
        confirmLabel: 'Grab anyway',
        onConfirm: async () => {
          await grab.mutateAsync({ ...r, allowOverCap: true })
        },
      })
      return
    }
    grab.mutate(r)
  }

  const filtered = useMemo(() => {
    const rows = releases.data ?? []
    let re: RegExp | null = null
    if (regex.trim()) {
      try {
        re = new RegExp(regex.trim(), 'i')
      } catch {
        re = null // invalid regex → ignore the filter rather than crash
      }
    }
    return rows
      .filter((r) => {
        if (filter === 'season-pack') return r.fullSeason === true
        if (filter === 'not-season-pack') return r.fullSeason !== true
        if (filter === 'english') return r.languages.some((l) => l.toLowerCase() === 'english')
        return true
      })
      .filter((r) => (re ? re.test(r.title) : true))
      .slice()
      .sort((a, b) => b.qualityWeight - a.qualityWeight || b.size - a.size)
  }, [releases.data, filter, regex])

  return (
    <section className="arr-adv__section">
      <h4 className="arr-adv__heading">
        <button
          type="button"
          className="arr-adv__disclosure"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Interactive search {open ? '▾' : '▸'}
        </button>
      </h4>
      {open && (
        <>
          <div className="arr-adv__controls">
            {kind === 'tv' && seasonNumbers.length > 0 && (
              <label className="arr-adv__control">
                <span>Season</span>
                <select
                  value={effectiveSeason ?? ''}
                  onChange={(e) => setSeason(Number(e.target.value))}
                >
                  {seasonNumbers.map((n) => (
                    <option key={n} value={n}>
                      Season {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="arr-adv__chips" role="group" aria-label="Release filters">
              {(
                [
                  ['all', 'All'],
                  ...(kind === 'tv'
                    ? ([
                        ['season-pack', 'Season Pack'],
                        ['not-season-pack', 'Not Season Pack'],
                      ] as const)
                    : []),
                  ['english', 'English'],
                ] as ReadonlyArray<readonly [ReleaseFilter, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`arr-adv__chip${filter === value ? ' arr-adv__chip--on' : ''}`}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="arr-adv__control arr-adv__control--grow">
              <span className="sr-only">Title regex</span>
              <input
                type="text"
                placeholder="Filter titles (regex)…"
                value={regex}
                onChange={(e) => setRegex(e.target.value)}
              />
            </label>
          </div>

          {releases.isPending ? (
            <p className="arr-adv__state" aria-busy="true">
              Searching the indexer…
            </p>
          ) : releases.error ? (
            <p className="arr-adv__state arr-adv__state--error" role="alert">
              {releases.error instanceof Error ? releases.error.message : 'Search failed.'}
            </p>
          ) : filtered.length === 0 ? (
            <p className="arr-adv__state">No releases match.</p>
          ) : (
            <ul className="arr-adv__releases">
              {filtered.map((r) => (
                <li key={`${r.indexerId}:${r.guid}`} className="arr-adv__release">
                  <div className="arr-adv__release-main">
                    <span className="arr-adv__release-title">{r.title}</span>
                    <span className="arr-adv__release-meta">
                      {r.quality} · {r.sizeGb.toFixed(2)} GB
                      {r.overCap && <span className="arr-adv__badge arr-adv__badge--over">over cap</span>}
                      {typeof r.seeders === 'number' && ` · ${r.seeders} seeders`}
                      {r.indexer && ` · ${r.indexer}`}
                    </span>
                    {r.rejected && r.rejections.length > 0 && (
                      <span className="arr-adv__release-rej">{r.rejections.join('; ')}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="arr-adv__btn arr-adv__btn--grab"
                    onClick={() => onGrab(r)}
                    disabled={grab.isPending}
                  >
                    Grab
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

// --- Preview rename → apply. ----------------------------------------------
function RenameSection({
  kind,
  itemId,
  onToast,
  qc,
}: Props & { qc: ReturnType<typeof useQueryClient> }) {
  const [open, setOpen] = useState(false)
  const preview = useQuery({
    queryKey: ['arr-rename', kind, itemId],
    queryFn: () =>
      kind === 'tv' ? sonarr.renamePreview(itemId) : radarr.renamePreview(itemId),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  const apply = useMutation({
    mutationFn: () => {
      const rows = preview.data ?? []
      if (kind === 'tv') {
        const files = rows
          .map((r) => ('episodeFileId' in r ? r.episodeFileId : undefined))
          .filter((n): n is number => typeof n === 'number')
        return sonarr.command({ name: 'RenameFiles', seriesId: itemId, files })
      }
      const files = rows
        .map((r) => ('movieFileId' in r ? r.movieFileId : undefined))
        .filter((n): n is number => typeof n === 'number')
      return radarr.command({ name: 'RenameMovie', movieIds: [itemId], files })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['arr-rename', kind, itemId] })
      onToast('Renaming files…')
    },
    onError: (e) => onToast(e instanceof Error ? e.message : String(e)),
  })

  return (
    <section className="arr-adv__section">
      <h4 className="arr-adv__heading">
        <button
          type="button"
          className="arr-adv__disclosure"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Preview rename {open ? '▾' : '▸'}
        </button>
      </h4>
      {open &&
        (preview.isPending ? (
          <p className="arr-adv__state" aria-busy="true">
            Loading rename preview…
          </p>
        ) : preview.error ? (
          <p className="arr-adv__state arr-adv__state--error" role="alert">
            {preview.error instanceof Error ? preview.error.message : 'Preview failed.'}
          </p>
        ) : (preview.data ?? []).length === 0 ? (
          <p className="arr-adv__state">Nothing to rename.</p>
        ) : (
          <>
            <ul className="arr-adv__rename">
              {(preview.data ?? []).map((row, i) => (
                <li key={i} className="arr-adv__rename-row">
                  <span className="arr-adv__rename-old">{row.existingPath}</span>
                  <span className="arr-adv__rename-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="arr-adv__rename-new">{row.newPath}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="arr-adv__btn"
              onClick={() => apply.mutate()}
              disabled={apply.isPending}
            >
              Apply rename
            </button>
          </>
        ))}
    </section>
  )
}

// --- Manage episodes (TV only). -------------------------------------------
function ManageEpisodesSection({
  itemId,
  episodes,
  onToast,
  qc,
}: Props & { qc: ReturnType<typeof useQueryClient> }) {
  const sorted = useMemo(
    () =>
      (episodes ?? [])
        .slice()
        .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber),
    [episodes],
  )

  const monitor = useMutation({
    mutationFn: ({ ids, next }: { ids: number[]; next: boolean }) =>
      sonarr.monitorEpisodes(ids, next),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['sonarr', 'episodes', itemId] })
      onToast(vars.next ? 'Episode monitored' : 'Episode unmonitored')
    },
    onError: (e) => onToast(e instanceof Error ? e.message : String(e)),
  })

  const search = useMutation({
    mutationFn: (episodeIds: number[]) => sonarr.command({ name: 'EpisodeSearch', episodeIds }),
    onSuccess: () => onToast('Searching for episode…'),
    onError: (e) => onToast(e instanceof Error ? e.message : String(e)),
  })

  if (sorted.length === 0) {
    return (
      <section className="arr-adv__section">
        <h4 className="arr-adv__heading">Manage episodes</h4>
        <p className="arr-adv__state">No episodes loaded.</p>
      </section>
    )
  }

  return (
    <section className="arr-adv__section">
      <h4 className="arr-adv__heading">Manage episodes</h4>
      <ul className="arr-adv__episodes">
        {sorted.map((ep) => (
          <li key={ep.id} className="arr-adv__episode">
            <label className="arr-adv__toggle">
              <input
                type="checkbox"
                checked={ep.monitored}
                disabled={monitor.isPending}
                onChange={(e) => monitor.mutate({ ids: [ep.id], next: e.target.checked })}
              />
              <span>
                S{String(ep.seasonNumber).padStart(2, '0')}E
                {String(ep.episodeNumber).padStart(2, '0')} {ep.title}
              </span>
            </label>
            <button
              type="button"
              className="arr-adv__btn arr-adv__btn--small"
              onClick={() => search.mutate([ep.id])}
              disabled={search.isPending}
            >
              Search
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// --- History. --------------------------------------------------------------
const EVENT_LABEL: Record<string, string> = {
  grabbed: 'Grabbed',
  downloadFolderImported: 'Imported',
  downloadFailed: 'Download failed',
  episodeFileDeleted: 'File deleted',
  movieFileDeleted: 'File deleted',
  downloadIgnored: 'Ignored',
  renamed: 'Renamed',
}

function HistorySection({ kind, itemId }: { kind: Kind; itemId: number }) {
  const [open, setOpen] = useState(false)
  const history = useQuery<ArrHistoryRecord[]>({
    queryKey: ['arr-history', kind, itemId],
    queryFn: () => (kind === 'tv' ? sonarr.history(itemId) : radarr.history(itemId)),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  })

  const fmt = (raw: string) => {
    const d = new Date(raw)
    return isNaN(d.getTime()) ? raw : d.toLocaleString()
  }

  return (
    <section className="arr-adv__section">
      <h4 className="arr-adv__heading">
        <button
          type="button"
          className="arr-adv__disclosure"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          History {open ? '▾' : '▸'}
        </button>
      </h4>
      {open &&
        (history.isPending ? (
          <p className="arr-adv__state" aria-busy="true">
            Loading history…
          </p>
        ) : history.error ? (
          <p className="arr-adv__state arr-adv__state--error" role="alert">
            {history.error instanceof Error ? history.error.message : 'History failed.'}
          </p>
        ) : (history.data ?? []).length === 0 ? (
          <p className="arr-adv__state">No history yet.</p>
        ) : (
          <ul className="arr-adv__history">
            {(history.data ?? []).map((h, i) => (
              <li key={i} className="arr-adv__history-row">
                <span className="arr-adv__history-event">
                  {EVENT_LABEL[h.eventType] ?? h.eventType}
                </span>
                <span className="arr-adv__history-title">{h.sourceTitle}</span>
                <span className="arr-adv__history-date">{fmt(h.date)}</span>
              </li>
            ))}
          </ul>
        ))}
    </section>
  )
}

// --- Edit (quality profile + root folder + monitored). ---------------------
function EditSection({
  kind,
  itemId,
  monitored,
  qualityProfileId,
  rootFolderPath,
  onToast,
  libraryKey,
  qc,
}: Props & { libraryKey: string[]; qc: ReturnType<typeof useQueryClient> }) {
  const [open, setOpen] = useState(false)
  // Reuse the same profile + root-folder pickers the Add modals load.
  const sonarrProfiles = useSonarrProfiles()
  const sonarrFolders = useSonarrRootFolders()
  const radarrProfiles = useRadarrProfiles()
  const radarrFolders = useRadarrRootFolders()
  const profiles = kind === 'tv' ? sonarrProfiles : radarrProfiles
  const folders = kind === 'tv' ? sonarrFolders : radarrFolders

  const [profileChoice, setProfileChoice] = useState<number | null>(null)
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  const [monitorChoice, setMonitorChoice] = useState<boolean>(monitored)
  const profileId = profileChoice ?? qualityProfileId ?? profiles.data?.[0]?.id ?? null
  const folder = folderChoice ?? rootFolderPath ?? folders.data?.[0]?.path ?? null

  const save = useMutation({
    mutationFn: (): Promise<unknown> => {
      const patch = {
        monitored: monitorChoice,
        ...(profileId != null ? { qualityProfileId: profileId } : {}),
        ...(folder != null ? { rootFolderPath: folder } : {}),
      }
      return kind === 'tv' ? sonarr.editSeries(itemId, patch) : radarr.editMovie(itemId, patch)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: libraryKey })
      onToast('Saved')
    },
    onError: (e) => onToast(e instanceof Error ? e.message : String(e)),
  })

  return (
    <section className="arr-adv__section">
      <h4 className="arr-adv__heading">
        <button
          type="button"
          className="arr-adv__disclosure"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Edit {open ? '▾' : '▸'}
        </button>
      </h4>
      {open && (
        <div className="arr-adv__edit">
          <label className="arr-adv__control">
            <span>Quality</span>
            <select
              value={profileId ?? ''}
              disabled={!profiles.data}
              onChange={(e) => setProfileChoice(Number(e.target.value))}
            >
              {profiles.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="arr-adv__control">
            <span>Folder</span>
            <select
              value={folder ?? ''}
              disabled={!folders.data}
              onChange={(e) => setFolderChoice(e.target.value)}
            >
              {folders.data?.map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          </label>
          <label className="arr-adv__toggle">
            <input
              type="checkbox"
              checked={monitorChoice}
              onChange={(e) => setMonitorChoice(e.target.checked)}
            />
            <span>Monitored</span>
          </label>
          <button
            type="button"
            className="arr-adv__btn"
            onClick={() => save.mutate()}
            disabled={save.isPending || profileId == null || folder == null}
            aria-busy={save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </section>
  )
}
