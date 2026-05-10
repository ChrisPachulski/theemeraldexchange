import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sab } from '../../lib/api/sab'
import { useDownloadQueue } from '../../lib/hooks/useDownloadQueue'
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
  // The "present" item: whatever SAB is actively downloading right now.
  // Falls back to the first slot when the queue is paused / nothing has
  // started yet so the heading still surfaces the next-up filename
  // instead of the generic placeholder.
  const activeSlot = slots.find((s) => s.status === 'Downloading') ?? slots[0]
  const headingText = idle ? 'Queue is Open.' : (activeSlot?.filename ?? 'Queue is Open.')
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
  const stats = [
    { label: 'Speed',       value: idle ? '—' : fmtSpeed(speedRaw) },
    { label: 'Downloaded',  value: idle ? '—' : fmtSize(downloadedBytes) },
    { label: 'File size',   value: idle ? '—' : (sizeRaw && totalBytes > 0 ? fmtSize(totalBytes) : '—') },
    { label: 'Available',   value: fmtFreeSpace(queue.data?.queue.diskspace1) },
  ]

  return (
    <section className="downloads-tab">
      <div className="downloads-tab__panel">
        <header
          className={`downloads-tab__header${idle ? ' downloads-tab__header--idle' : ''}`}
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
          {isPaused && <p className="downloads-tab__paused">Queue is paused.</p>}

          <ul className="downloads-tab__stats" aria-label="Download statistics">
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
    </section>
  )
}
