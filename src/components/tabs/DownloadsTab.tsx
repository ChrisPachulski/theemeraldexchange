import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sab } from '../../lib/api/sab'
import {
  useDownloadQueue,
  useRadarrQueue,
  useSonarrQueue,
} from '../../lib/hooks/useDownloadQueue'
import { useSonarrLibrary } from '../../lib/hooks/useSonarrLibrary'
import { useRecentlyAdded } from '../../lib/hooks/useRecentlyAdded'
import { GrabActivityPanel } from '../downloads/GrabActivityPanel'
import { useNavTransition } from '../../lib/navTransition'
import { useConfirm } from '../confirm/useConfirm'
import { QueueRow } from '../queue/QueueRow'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { useAuth } from '../../lib/auth'
import './DownloadsTab.css'

// Parse SAB's "5.5 GB" / "1024 MB" / "0" strings into bytes for arithmetic.
// Empty / missing returns 0.
const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
function parseSabSize(raw: string | undefined): number {
  if (!raw) return 0
  const m = raw.trim().match(/^([\d.]+)\s*([A-Z]+)?$/i)
  if (!m) return 0
  const value = parseFloat(m[1])
  const unit = (m[2] ?? 'B').toUpperCase()
  return value * (UNITS[unit] ?? 1)
}

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function fmtSpeed(speedRaw: string | undefined): string {
  // SAB returns speed as a bare number in MB/s (e.g. "5.5" or "0").
  const v = parseFloat(speedRaw ?? '0')
  if (!isFinite(v) || v <= 0) return '—'
  return `${v.toFixed(v < 10 ? 1 : 0)} MB/s`
}

function fmtFreeSpace(gbRaw: string | undefined): string {
  const v = parseFloat(gbRaw ?? '')
  if (!isFinite(v) || v <= 0) return '—'
  // Convert raw GB → bytes → fmtSize so units scale (GB / TB).
  return fmtSize(v * UNITS.GB)
}

export function DownloadsTab() {
  const queue = useDownloadQueue()
  const sonarrQueue = useSonarrQueue()
  const radarrQueue = useRadarrQueue()
  const series = useSonarrLibrary()
  const recent = useRecentlyAdded(12)
  const { transitionTo } = useNavTransition()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { isAdmin } = useAuth()

  const pause = useMutation({
    mutationFn: (nzoId: string) => sab.pauseItem(nzoId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sab', 'queue'] }),
  })
  const resume = useMutation({
    mutationFn: (nzoId: string) => sab.resumeItem(nzoId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sab', 'queue'] }),
  })
  const cancel = useMutation({
    mutationFn: (nzoId: string) => sab.deleteItem(nzoId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sab', 'queue'] }),
  })

  if (queue.error) {
    return (
      <section className="downloads-tab">
        <div className="downloads-tab__error">
          <p>Couldn't reach SABnzbd. Check that the dev server has SAB_API_KEY in .env.local.</p>
          <p className="downloads-tab__error-detail">{String(queue.error)}</p>
        </div>
      </section>
    )
  }

  if (queue.isPending) {
    return (
      <section className="downloads-tab">
        <LoadingPulse>Loading queue</LoadingPulse>
      </section>
    )
  }

  const slots = queue.data?.queue.slots ?? []
  const speedRaw = queue.data?.queue.speed
  const sizeRaw = queue.data?.queue.size
  const sizeLeftRaw = queue.data?.queue.sizeleft
  const isPaused = queue.data?.queue.paused ?? false
  const idle = slots.length === 0

  // "Indexer is working" signal — SAB has no active slot, but Sonarr or
  // Radarr have records in their queues (delay/pending/queued states
  // before/between successful grabs). Without this the header flips to
  // "Queue is Open." every time a release fails and gets retried,
  // making the panel look frozen even though things are happening.
  const sonarrPending = (sonarrQueue.data?.records ?? []).filter(
    (r) => (r.status ?? '').toLowerCase() !== 'completed',
  )
  const radarrPending = (radarrQueue.data?.records ?? []).filter(
    (r) => (r.status ?? '').toLowerCase() !== 'completed',
  )
  const pendingCount = sonarrPending.length + radarrPending.length
  const indexerWorking = idle && pendingCount > 0
  // The "present" item: whatever SAB is actively downloading right now.
  // Falls back to the first slot when the queue is paused / nothing has
  // started yet so the heading still surfaces the next-up filename
  // instead of the generic placeholder.
  const activeSlot = slots.find((s) => s.status === 'Downloading') ?? slots[0]
  const headingText = idle
    ? indexerWorking
      ? pendingCount === 1
        ? 'Searching for a release…'
        : `Searching for releases — ${pendingCount} in flight`
      : 'Queue is Open.'
    : (activeSlot?.filename ?? 'Queue is Open.')
  // Active progress + ETA so the header card can render its own bar
  // without the QueueRow doppelganger underneath.
  const activePercent = activeSlot ? Math.min(100, Math.max(0, parseFloat(activeSlot.percentage) || 0)) : 0
  const activeTimeLeft =
    activeSlot && activeSlot.timeleft && activeSlot.timeleft !== '0:00:00'
      ? activeSlot.timeleft
      : null
  // Other items in the queue — everything except the slot already shown
  // in the header. Those still get their own rows.
  const queuedSlots = activeSlot ? slots.filter((s) => s.nzo_id !== activeSlot.nzo_id) : []

  // Stat-box values. When idle, speed/downloaded/size show '—'; available
  // disk space stays populated whenever the SAB host reports it.
  const totalBytes = parseSabSize(sizeRaw)
  const leftBytes = parseSabSize(sizeLeftRaw)
  const downloadedBytes = Math.max(0, totalBytes - leftBytes)

  // Season-cluster math. We join three sources:
  //   - SAB slots (per-NZB bytes + percent complete)
  //   - Sonarr queue (per-episode records mapped to SAB via downloadId)
  //   - Sonarr series library (per-season totalEpisodeCount and
  //     sizeOnDisk for episodes already imported)
  //
  // The previous version only summed what was still in the SAB queue,
  // which made "Season Size" shrink as episodes imported and made
  // Downloaded (queue-wide) inconsistent with Episode/Season (cluster-
  // scoped). With season stats joined in, Season Size is on-disk +
  // in-flight, Episode Size is Season / episodeCount, and Downloaded
  // counts the already-imported bytes plus the in-flight progress.
  const isTv = (activeSlot?.cat ?? '').toLowerCase() === 'tv'
  const sonarrRecords = sonarrQueue.data?.records ?? []
  const activeSonarrCtx = activeSlot
    ? sonarrRecords.find((r) => r.downloadId === activeSlot.nzo_id)
    : undefined
  const seriesId = activeSonarrCtx?.seriesId
  const seasonNumber = activeSonarrCtx?.seasonNumber
  const activeSeries = seriesId !== undefined
    ? series.data?.find((s) => s.id === seriesId)
    : undefined
  const activeSeasonStats = activeSeries?.seasons?.find(
    (s) => s.seasonNumber === seasonNumber,
  )?.statistics

  const clusterRecords =
    seriesId !== undefined && seasonNumber !== undefined
      ? sonarrRecords.filter(
          (r) => r.seriesId === seriesId && r.seasonNumber === seasonNumber,
        )
      : []
  const clusterDownloadIds = new Set(
    clusterRecords.map((r) => r.downloadId).filter((id): id is string => Boolean(id)),
  )
  const clusterSlots = slots.filter((s) => clusterDownloadIds.has(s.nzo_id))
  const inFlightBytes = clusterSlots.reduce((sum, s) => sum + parseSabSize(s.size), 0)
  const inFlightDownloadedBytes = clusterSlots.reduce(
    (sum, s) => sum + parseSabSize(s.size) * ((parseFloat(s.percentage) || 0) / 100),
    0,
  )

  // A season context is when there's a season with > 1 monitored
  // episode behind this download — even if only 1 is currently in
  // SAB's queue (the rest may already be on disk). That's the case
  // when, e.g., 7 of 10 HotD episodes are imported and 3 are still
  // being grabbed: cluster Records = 3, but the season is 10 eps.
  const totalSeasonEps = Math.max(
    activeSeasonStats?.totalEpisodeCount ?? 0,
    clusterRecords.length,
  )
  const isSeasonContext = isTv && totalSeasonEps > 1

  const seasonBytesOnDisk = activeSeasonStats?.sizeOnDisk ?? 0
  const seasonBytes = seasonBytesOnDisk + inFlightBytes
  const episodeBytes = isSeasonContext && totalSeasonEps > 0
    ? seasonBytes / totalSeasonEps
    : activeSlot
      ? parseSabSize(activeSlot.size)
      : 0

  // Active-scope Downloaded: cluster-aware when in a season context,
  // else the active slot's own progress. Falls back to queue-wide
  // only as a last resort (and is masked by idle anyway).
  const slotDownloadedBytes = activeSlot
    ? parseSabSize(activeSlot.size) * ((parseFloat(activeSlot.percentage) || 0) / 100)
    : 0
  const downloadedDisplayBytes = isSeasonContext
    ? seasonBytesOnDisk + inFlightDownloadedBytes
    : activeSlot
      ? slotDownloadedBytes
      : downloadedBytes

  const totalDisplayBytes = isSeasonContext
    ? seasonBytes
    : activeSlot
      ? parseSabSize(activeSlot.size)
      : totalBytes
  const totalLabel = isSeasonContext ? 'Season size' : 'File size'

  const stats = [
    { label: 'Speed',       value: idle ? '—' : fmtSpeed(speedRaw) },
    { label: 'Downloaded',  value: idle ? '—' : (downloadedDisplayBytes > 0 ? fmtSize(downloadedDisplayBytes) : '—') },
    ...(isTv && !idle
      ? [{ label: 'Episode size', value: episodeBytes > 0 ? fmtSize(episodeBytes) : '—' }]
      : []),
    { label: totalLabel,    value: idle ? '—' : (totalDisplayBytes > 0 ? fmtSize(totalDisplayBytes) : '—') },
    { label: 'Available',   value: fmtFreeSpace(queue.data?.queue.diskspace1) },
  ]

  return (
    <section className="downloads-tab">
      <div className="downloads-tab__panel">
        <header
          className={`downloads-tab__header${idle ? ' downloads-tab__header--idle' : ''}${indexerWorking ? ' downloads-tab__header--working' : ''}`}
        >
          {!idle && activeSlot?.cat && (
            <div className="downloads-tab__eyebrow-row">
              <span
                className={`downloads-tab__category downloads-tab__category--${activeSlot.cat.toLowerCase()}`}
              >
                {activeSlot.cat}
              </span>
            </div>
          )}
          <h2
            className={`downloads-tab__summary${idle ? ' downloads-tab__summary--idle' : ' downloads-tab__summary--filename'}`}
            title={idle ? undefined : headingText}
          >
            {headingText}
          </h2>
          {activeSlot && (
            <>
              <div
                className="downloads-tab__progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(activePercent)}
                aria-label={`Downloading ${activeSlot.filename}`}
              >
                <div
                  className="downloads-tab__progress-fill"
                  style={{ width: `${activePercent}%` }}
                />
              </div>
              <p className="downloads-tab__progress-meta">
                <span className="downloads-tab__progress-percent">
                  [ {Math.round(activePercent)}% ]
                </span>
                {activeTimeLeft && (
                  <span className="downloads-tab__progress-eta">{activeTimeLeft}</span>
                )}
              </p>
            </>
          )}
          {indexerWorking && (
            <div
              className="downloads-tab__progress downloads-tab__progress--indeterminate"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Indexer is searching for releases"
            >
              <div className="downloads-tab__progress-shuttle" />
            </div>
          )}
          {isPaused && <p className="downloads-tab__paused">Queue is paused.</p>}

          <ul
            className={`downloads-tab__stats${stats.length === 5 ? ' downloads-tab__stats--five' : ''}`}
            aria-label="Download statistics"
          >
            {stats.map((s) => (
              <li key={s.label} className={`downloads-tab__stat${s.value === '—' ? ' downloads-tab__stat--empty' : ''}`}>
                <span className="downloads-tab__stat-label">{s.label}</span>
                <span className="downloads-tab__stat-value">{s.value}</span>
              </li>
            ))}
          </ul>
        </header>

        {queuedSlots.length > 0 && (
          <div className="downloads-tab__queue">
            {queuedSlots.map((slot) => {
              const percent = parseFloat(slot.percentage) || 0
              const paused = slot.status === 'Paused'
              const busy =
                pause.variables === slot.nzo_id ||
                resume.variables === slot.nzo_id ||
                cancel.variables === slot.nzo_id

              return (
                <QueueRow
                  key={slot.nzo_id}
                  filename={slot.filename}
                  category={slot.cat}
                  size={slot.size}
                  percent={percent}
                  timeLeft={slot.timeleft}
                  status={slot.status}
                  paused={paused}
                  busy={busy}
                  onPause={isAdmin ? () => pause.mutate(slot.nzo_id) : undefined}
                  onResume={isAdmin ? () => resume.mutate(slot.nzo_id) : undefined}
                  onDelete={
                    isAdmin
                      ? () =>
                          confirm({
                            title: `Cancel ${slot.filename}?`,
                            body: 'This stops the download and removes the partial file. The library entry stays.',
                            confirmLabel: 'Cancel download',
                            onConfirm: async () => {
                              await cancel.mutateAsync(slot.nzo_id)
                            },
                          })
                      : undefined
                  }
                />
              )
            })}
          </div>
        )}
      </div>

      {isAdmin && <GrabActivityPanel />}

      {recent.length > 0 && (
        <section className="downloads-tab__recent" aria-label="Recently added to the library">
          <h3 className="downloads-tab__recent-label">Recently added</h3>
          <div className="downloads-tab__recent-row">
            {recent.map((item) => (
              <button
                key={item.key}
                type="button"
                className="downloads-tab__recent-card"
                onClick={() => transitionTo(item.route)}
                title={`${item.title}${item.year ? ` (${item.year})` : ''}`}
              >
                {item.poster ? (
                  <img
                    className="downloads-tab__recent-poster"
                    src={item.poster}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div
                    className="downloads-tab__recent-poster downloads-tab__recent-poster--fallback"
                    aria-hidden="true"
                  >
                    {item.title.charAt(0)}
                  </div>
                )}
                <div className="downloads-tab__recent-caption">
                  <span className="downloads-tab__recent-title">{item.title}</span>
                  <span className="downloads-tab__recent-kind">
                    {item.kind === 'tv' ? 'TV Show' : 'Movie'}
                    {item.year ? ` · ${item.year}` : ''}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  )
}
