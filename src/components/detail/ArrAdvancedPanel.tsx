import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { sonarr, type Episode } from '../../lib/api/sonarr'
import { radarr } from '../../lib/api/radarr'
import type { ArrRelease, ArrHistoryRecord } from '../../lib/api/arrAdvanced'
import { useConfirm } from '../confirm/useConfirm'
import { useSonarrProfiles, useSonarrRootFolders } from '../../lib/hooks/useSonarrLibrary'
import { useRadarrProfiles, useRadarrRootFolders } from '../../lib/hooks/useRadarrLibrary'
import { useLimits } from '../../lib/hooks/useLimits'
import './ArrAdvancedPanel.css'

// --- Display helpers (humanized per the UX checklist). ---------------------
function humanGb(sizeGb: number): string {
  if (!Number.isFinite(sizeGb)) return '—'
  if (sizeGb >= 1) return `${sizeGb.toFixed(sizeGb >= 10 ? 1 : 2)} GB`
  return `${Math.round(sizeGb * 1000)} MB`
}

function humanAge(hours?: number): string {
  if (hours == null || !Number.isFinite(hours)) return '—'
  if (hours < 1) return '<1h'
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

// Sort columns for the release browser. Default = seeders desc (torrent) or
// quality weight desc — both surface the "best" release first, matching the
// *arr convention the checklist cites.
type SortKey = 'seeders' | 'quality' | 'size' | 'age'
type SortState = { key: SortKey; dir: 'asc' | 'desc' }
type ReleaseFilter = 'all' | 'season-pack' | 'not-season-pack' | 'english'

// Persist the last sort + filter across modal opens (the checklist calls out
// *arr's reset-every-time as a pain point). Module-scoped, per item-kind, so
// it survives DetailModal unmount/remount within a session without a store.
// Accessed via getView/setView functions so components never assign the
// module variable directly (the react-hooks/immutability lint).
type ReleaseView = { sort: SortState; filter: ReleaseFilter; regex: string }
const releaseViews: Record<Kind, ReleaseView> = {
  tv: { sort: { key: 'quality', dir: 'desc' }, filter: 'all', regex: '' },
  movie: { sort: { key: 'seeders', dir: 'desc' }, filter: 'all', regex: '' },
}
function getView(kind: Kind): ReleaseView {
  return releaseViews[kind]
}
function setView(kind: Kind, next: Partial<ReleaseView>): void {
  releaseViews[kind] = { ...releaseViews[kind], ...next }
}

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
      {/* [Update] group — reversible, no confirm needed. */}
      <div className="arr-adv__row" role="group" aria-label="Update">
        <button
          type="button"
          className="arr-adv__btn"
          onClick={refreshAndScan}
          disabled={command.isPending}
          aria-busy={command.isPending}
        >
          Refresh &amp; scan
        </button>
        <button
          type="button"
          className="arr-adv__btn"
          onClick={searchMonitored}
          disabled={command.isPending}
          aria-busy={command.isPending}
        >
          Search monitored
        </button>
      </div>

      <MonitoringSection {...props} libraryKey={libraryKey} />
      <InteractiveSearchSection {...props} confirm={confirm} />
      <RenameSection {...props} qc={qc} confirm={confirm} />
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
// Semantic <table> with sortable header buttons, a VISIBLE rejection column
// (the #1 documented *arr pain point — not hover-only), humanized size/age,
// additive filter chips with an active count + Clear filters + result count,
// persisted sort/filter across opens, skeleton rows while searching, and an
// over-cap "Grab anyway" confirm that states the size-vs-cap specifics.

function InteractiveSearchSection({
  kind,
  itemId,
  episodes,
  onToast,
  confirm,
}: Props & { confirm: ReturnType<typeof useConfirm> }) {
  const [open, setOpen] = useState(false)
  const [season, setSeason] = useState<number | undefined>(undefined)
  // Seed from the persisted view so a reopen keeps the admin's last sort/filter.
  const [filter, setFilter] = useState<ReleaseFilter>(() => getView(kind).filter)
  const [regex, setRegex] = useState(() => getView(kind).regex)
  const [sort, setSort] = useState<SortState>(() => getView(kind).sort)
  const limits = useLimits()
  const capGb = kind === 'tv' ? (limits.data?.maxTvGbPerEpisode ?? 5) : (limits.data?.maxMovieGb ?? 10)
  const capLabel = kind === 'tv' ? `${capGb} GB/episode` : `${capGb} GB`

  // Persist on every change so it survives the modal unmount/remount.
  const setFilterP = (f: ReleaseFilter) => { setFilter(f); setView(kind, { filter: f }) }
  const setRegexP = (r: string) => { setRegex(r); setView(kind, { regex: r }) }
  const setSortP = (key: SortKey) =>
    setSort((prev) => {
      const next: SortState =
        prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
      setView(kind, { sort: next })
      return next
    })

  const seasonNumbers = useMemo(() => {
    if (kind !== 'tv' || !episodes) return []
    return [...new Set(episodes.map((e) => e.seasonNumber).filter((n) => n > 0))].sort((a, b) => a - b)
  }, [kind, episodes])
  const effectiveSeason = kind === 'tv' ? (season ?? seasonNumbers[0]) : undefined

  const releases = useQuery({
    queryKey: ['arr-releases', kind, itemId, effectiveSeason],
    queryFn: () =>
      kind === 'tv' ? sonarr.releases(itemId, effectiveSeason) : radarr.releases(itemId),
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
        : radarr.grabRelease(itemId, { guid: r.guid, indexerId: r.indexerId, allowOverCap: r.allowOverCap }),
    onSuccess: (res) => onToast(`Grabbed ${res.title} (${humanGb(res.sizeGb)})`),
    onError: (e) => onToast(e instanceof Error ? e.message : String(e)),
  })
  // Which row's Grab is in flight — so only that button shows the spinner.
  const [grabbingGuid, setGrabbingGuid] = useState<string | null>(null)

  const doGrab = (r: ArrRelease, allowOverCap: boolean) => {
    setGrabbingGuid(`${r.indexerId}:${r.guid}`)
    grab.mutate(
      { ...r, allowOverCap },
      { onSettled: () => setGrabbingGuid(null) },
    )
  }

  const onGrab = (r: ArrRelease) => {
    if (r.overCap) {
      // State the specifics (checklist): actual size vs the cap, verb+noun CTA.
      confirm({
        title: 'Grab over-cap release?',
        body: `${r.title} is ${humanGb(r.sizeGb)}, over the ${capLabel} size limit. Grab it anyway?`,
        confirmLabel: 'Grab anyway',
        onConfirm: async () => {
          await new Promise<void>((resolve) => {
            setGrabbingGuid(`${r.indexerId}:${r.guid}`)
            grab.mutate(
              { ...r, allowOverCap: true },
              { onSettled: () => { setGrabbingGuid(null); resolve() } },
            )
          })
        },
      })
      return
    }
    doGrab(r, false)
  }

  const regexValid = useMemo(() => {
    if (!regex.trim()) return true
    try { new RegExp(regex.trim(), 'i'); return true } catch { return false }
  }, [regex])

  const filtered = useMemo(() => {
    const rows = releases.data ?? []
    let re: RegExp | null = null
    if (regex.trim()) {
      try { re = new RegExp(regex.trim(), 'i') } catch { re = null }
    }
    const primary = (a: ArrRelease, b: ArrRelease): number => {
      if (sort.key === 'seeders') return (a.seeders ?? -1) - (b.seeders ?? -1)
      if (sort.key === 'quality') return a.qualityWeight - b.qualityWeight
      if (sort.key === 'size') return a.size - b.size
      return (a.ageHours ?? Infinity) - (b.ageHours ?? Infinity)
    }
    const cmp = (a: ArrRelease, b: ArrRelease): number => {
      // Stable secondary key so equal primaries keep "best" first.
      const d = primary(a, b) || a.qualityWeight - b.qualityWeight || a.size - b.size
      return sort.dir === 'desc' ? -d : d
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
      .sort(cmp)
  }, [releases.data, filter, regex, sort])

  const total = releases.data?.length ?? 0
  const activeFilters = (filter !== 'all' ? 1 : 0) + (regex.trim() ? 1 : 0)
  const filterChips: ReadonlyArray<readonly [ReleaseFilter, string]> = [
    ['all', 'All'],
    ...(kind === 'tv'
      ? ([['season-pack', 'Season Pack'], ['not-season-pack', 'Not Season Pack']] as const)
      : []),
    ['english', 'English'],
  ]
  const clearFilters = () => { setFilterP('all'); setRegexP('') }

  const sortHeader = (key: SortKey, label: string, numeric = false) => (
    <th scope="col" className={numeric ? 'arr-adv__th arr-adv__th--num' : 'arr-adv__th'} aria-sort={sort.key === key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="arr-adv__th-btn" onClick={() => setSortP(key)}>
        {label}
        {sort.key === key && <span aria-hidden="true">{sort.dir === 'desc' ? ' ↓' : ' ↑'}</span>}
      </button>
    </th>
  )

  return (
    <section className="arr-adv__section">
      <h4 className="arr-adv__heading">
        <button type="button" className="arr-adv__disclosure" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Interactive search {open ? '▾' : '▸'}
        </button>
      </h4>
      {open && (
        <>
          <div className="arr-adv__controls">
            {kind === 'tv' && seasonNumbers.length > 0 && (
              <label className="arr-adv__control">
                <span>Season</span>
                <select value={effectiveSeason ?? ''} onChange={(e) => setSeason(Number(e.target.value))}>
                  {seasonNumbers.map((n) => (
                    <option key={n} value={n}>Season {n}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="arr-adv__chips" role="group" aria-label="Release filters">
              {filterChips.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`arr-adv__chip${filter === value ? ' arr-adv__chip--on' : ''}`}
                  aria-pressed={filter === value}
                  onClick={() => setFilterP(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="arr-adv__control arr-adv__control--grow">
              <span className="sr-only">Title regex filter</span>
              <input
                type="text"
                placeholder="Filter titles (regex)…"
                value={regex}
                aria-invalid={!regexValid}
                onChange={(e) => setRegexP(e.target.value)}
              />
            </label>
            {activeFilters > 0 && (
              <button type="button" className="arr-adv__btn arr-adv__btn--small" onClick={clearFilters}>
                Clear filters ({activeFilters})
              </button>
            )}
          </div>

          {/* Result count, announced to assistive tech when it changes. */}
          {!releases.isPending && !releases.error && (
            <p className="arr-adv__count" aria-live="polite">
              {filtered.length === total
                ? `${total} release${total === 1 ? '' : 's'}`
                : `${filtered.length} of ${total}`}
              {!regexValid && <span className="arr-adv__count-warn"> · invalid regex ignored</span>}
            </p>
          )}

          {releases.isPending ? (
            <ReleaseSkeleton />
          ) : releases.error ? (
            <div className="arr-adv__state arr-adv__state--error" role="alert">
              <span>{releases.error instanceof Error ? releases.error.message : 'Search failed.'}</span>
              <button type="button" className="arr-adv__btn arr-adv__btn--small" onClick={() => releases.refetch()}>
                Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="arr-adv__state">
              <span>{total === 0 ? 'No releases found.' : 'No releases match the active filters.'}</span>
              {activeFilters > 0 && (
                <button type="button" className="arr-adv__btn arr-adv__btn--small" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="arr-adv__table-wrap">
              <table className="arr-adv__table">
                <thead>
                  <tr>
                    <th scope="col" className="arr-adv__th">Indexer</th>
                    {sortHeader('age', 'Age', true)}
                    <th scope="col" className="arr-adv__th">Title</th>
                    {sortHeader('quality', 'Quality')}
                    <th scope="col" className="arr-adv__th">Lang</th>
                    {sortHeader('size', 'Size', true)}
                    {sortHeader('seeders', 'Peers', true)}
                    <th scope="col" className="arr-adv__th">Status</th>
                    <th scope="col" className="arr-adv__th"><span className="sr-only">Grab</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const id = `${r.indexerId}:${r.guid}`
                    const busy = grabbingGuid === id
                    return (
                      <tr key={id} className={r.rejected ? 'arr-adv__tr arr-adv__tr--rejected' : 'arr-adv__tr'}>
                        <td className="arr-adv__td">{r.indexer ?? '—'}</td>
                        <td className="arr-adv__td arr-adv__td--num">{humanAge(r.ageHours)}</td>
                        <td className="arr-adv__td arr-adv__td--title">
                          <span>{r.title}</span>
                          {r.fullSeason && <span className="arr-adv__tag">Season pack</span>}
                        </td>
                        <td className="arr-adv__td">{r.quality}</td>
                        <td className="arr-adv__td">{r.languages.join(', ') || '—'}</td>
                        <td className="arr-adv__td arr-adv__td--num">
                          {humanGb(r.sizeGb)}
                          {r.overCap && <span className="arr-adv__badge arr-adv__badge--over" title={`Over the ${capLabel} cap`}>Over cap</span>}
                        </td>
                        <td className="arr-adv__td arr-adv__td--num">
                          {typeof r.seeders === 'number' ? r.seeders : '—'}
                        </td>
                        <td className="arr-adv__td arr-adv__td--status">
                          {r.rejected ? (
                            <span className="arr-adv__reject" title={r.rejections.join('; ')}>
                              {r.rejections[0] ?? 'Rejected'}
                              {r.rejections.length > 1 && ` (+${r.rejections.length - 1})`}
                            </span>
                          ) : (
                            <span className="arr-adv__ok">OK</span>
                          )}
                        </td>
                        <td className="arr-adv__td arr-adv__td--action">
                          <button
                            type="button"
                            className="arr-adv__btn arr-adv__btn--grab"
                            onClick={() => onGrab(r)}
                            disabled={grab.isPending}
                            aria-busy={busy}
                            aria-label={r.overCap ? `Grab ${r.title} (over cap)` : `Grab ${r.title}`}
                          >
                            {busy ? '…' : 'Grab'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

// Skeleton rows that mirror the release table columns (checklist: skeletons,
// not a centered spinner, for table-heavy async surfaces).
function ReleaseSkeleton() {
  return (
    <div className="arr-adv__table-wrap" aria-busy="true" aria-label="Searching the indexer">
      <table className="arr-adv__table arr-adv__table--skeleton">
        <tbody>
          {[0, 1, 2, 3, 4].map((i) => (
            <tr key={i} className="arr-adv__tr">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((c) => (
                <td key={c} className="arr-adv__td">
                  <span className="arr-adv__skel" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// A few skeleton list rows for the loading state of list-shaped sections
// (rename, history) — skeletons over spinners per the checklist.
function ListSkeleton({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div className="arr-adv__list-skel" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="arr-adv__skel arr-adv__skel--row" />
      ))}
    </div>
  )
}

// Inline error with a Retry button — distinct from the empty state.
function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="arr-adv__state arr-adv__state--error" role="alert">
      <span>{error instanceof Error ? error.message : 'Something went wrong.'}</span>
      <button type="button" className="arr-adv__btn arr-adv__btn--small" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

// --- Preview rename → apply. ----------------------------------------------
function RenameSection({
  kind,
  itemId,
  onToast,
  qc,
  confirm,
}: Props & { qc: ReturnType<typeof useQueryClient>; confirm: ReturnType<typeof useConfirm> }) {
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

  const rows = preview.data ?? []
  // Apply rename renames files on disk — confirm with a verb+noun CTA
  // (checklist: irreversible/heavy actions get a real-consequence confirm).
  const onApply = () => {
    confirm({
      title: `Rename ${rows.length} file${rows.length === 1 ? '' : 's'}?`,
      body: 'This renames the files on disk to match your naming scheme. Plex re-indexes them afterward.',
      confirmLabel: 'Apply rename',
      cancelLabel: 'Keep current names',
      onConfirm: async () => {
        await apply.mutateAsync()
      },
    })
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
          Preview rename {open ? '▾' : '▸'}
        </button>
      </h4>
      {open &&
        (preview.isPending ? (
          <ListSkeleton label="Loading rename preview" />
        ) : preview.error ? (
          <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
        ) : rows.length === 0 ? (
          <p className="arr-adv__state">Nothing to rename.</p>
        ) : (
          <>
            <ul className="arr-adv__rename">
              {rows.map((row, i) => (
                <li key={i} className="arr-adv__rename-row">
                  <span className="arr-adv__rename-old">{row.existingPath}</span>
                  <span className="arr-adv__rename-arrow" aria-hidden="true">→</span>
                  <span className="arr-adv__rename-new">{row.newPath}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="arr-adv__btn"
              onClick={onApply}
              disabled={apply.isPending}
              aria-busy={apply.isPending}
            >
              {apply.isPending ? 'Applying…' : 'Apply rename'}
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
          <ListSkeleton label="Loading history" />
        ) : history.error ? (
          <ErrorState error={history.error} onRetry={() => history.refetch()} />
        ) : (history.data ?? []).length === 0 ? (
          <p className="arr-adv__state">No history yet.</p>
        ) : (
          <ul className="arr-adv__history">
            {(history.data ?? []).map((h, i) => (
              <li key={i} className="arr-adv__history-row">
                <span className="arr-adv__history-event" data-event={h.eventType}>
                  {EVENT_LABEL[h.eventType] ?? h.eventType}
                </span>
                <span className="arr-adv__history-title">{h.sourceTitle}</span>
                <span className="arr-adv__history-quality">{h.quality}</span>
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
