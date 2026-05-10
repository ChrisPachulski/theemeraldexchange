import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sab } from '../../lib/api/sab'
import { useDownloadQueue, useDownloadHistory } from '../../lib/hooks/useDownloadQueue'
import { useConfirm } from '../confirm/useConfirm'
import { QueueRow } from '../queue/QueueRow'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { useAuth } from '../../lib/auth'
import './DownloadsTab.css'

export function DownloadsTab() {
  const queue = useDownloadQueue()
  const history = useDownloadHistory(10)
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
  const speed = queue.data?.queue.speed ?? '0'
  const sizeLeft = queue.data?.queue.sizeleft ?? '0'
  const eta = queue.data?.queue.timeleft ?? ''
  const isPaused = queue.data?.queue.paused ?? false

  return (
    <section className="downloads-tab">
      <header className="downloads-tab__header">
        <div>
          <p className="downloads-tab__eyebrow">Downloads</p>
          <h2 className="downloads-tab__summary">
            {slots.length === 0
              ? 'Nothing in flight.'
              : `${slots.length} ${slots.length === 1 ? 'item' : 'items'} downloading. ${speed}/s. ${sizeLeft} left, ${eta}.`}
          </h2>
          {isPaused && <p className="downloads-tab__paused">Queue is paused.</p>}
        </div>
      </header>

      {slots.length > 0 && (
        <div className="downloads-tab__queue">
          {slots.map((slot) => {
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

      {history.data && history.data.history.slots.length > 0 && (
        <section className="downloads-tab__history">
          <p className="downloads-tab__eyebrow">Recently finished</p>
          <ul className="downloads-tab__history-list">
            {history.data.history.slots.slice(0, 10).map((h) => (
              <li key={h.nzo_id} className="downloads-tab__history-row">
                <span className="downloads-tab__history-name">{h.name}</span>
                <span className="downloads-tab__history-cat">{h.category}</span>
                <span
                  className={`downloads-tab__history-status downloads-tab__history-status--${h.status.toLowerCase()}`}
                >
                  {h.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}
