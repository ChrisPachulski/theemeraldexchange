import { useState } from 'react'
import { dvrApi, dvrPlayError, isPlayable, statusLabel, type DvrRecording } from '../../lib/api/dvr'
import type { StreamGrant } from '../../lib/api/iptv'
import { useAuth } from '../../lib/auth'
import { useConfirm } from '../confirm/useConfirm'
import { useDeleteRecording, useDvrRecordings } from '../../lib/hooks/useDvr'
import { useModalA11y } from '../../lib/hooks/useModalA11y'

const fmtWhen = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const when = (iso: string) => fmtWhen.format(new Date(iso))

// The household's DVR recordings (Apple RecordingsScreen): newest first as the
// server orders them, a detail with Play once completed, and Delete for admins
// (the server enforces it; this hides what would 403).
export function RecordingsPanel({
  onClose,
  onPlay,
}: {
  onClose: () => void
  onPlay: (grant: StreamGrant, recording: DvrRecording) => void
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  const list = useDvrRecordings()
  const remove = useDeleteRecording()
  const confirm = useConfirm()
  const { isAdmin } = useAuth()
  const [openId, setOpenId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [playError, setPlayError] = useState<string | null>(null)
  const recordings = list.data ?? []
  const open = recordings.find((r) => r.id === openId) ?? null

  const play = async (rec: DvrRecording) => {
    if (starting) return
    setStarting(true)
    setPlayError(null)
    try {
      onPlay(await dvrApi.grant(rec.id), rec)
    } catch (err) {
      setPlayError(dvrPlayError(err))
    } finally {
      setStarting(false)
    }
  }

  const askDelete = (rec: DvrRecording) =>
    confirm({
      title: 'Delete this recording?',
      body: `“${rec.title}” will be removed. This can’t be undone.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        setOpenId(null)
        await remove.mutateAsync(rec.id)
      },
    })

  return (
    <div ref={modalRef} className="iptv-conn-modal" role="dialog" aria-modal="true" aria-label="Recordings" tabIndex={-1}>
      <div className="iptv-conn-modal__panel">
        <header className="iptv-conn-modal__header">
          <h2>Recordings</h2>
          <button type="button" className="iptv-conn-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {open ? (
          <div className="dvr-sheet">
            <button type="button" className="dvr-sheet__back" onClick={() => setOpenId(null)}>
              ‹ All recordings
            </button>
            <h3 className="dvr-sheet__title">{open.title}</h3>
            <dl className="dvr-sheet__facts">
              <dt>Channel</dt>
              <dd>{open.channel_name}</dd>
              <dt>Status</dt>
              <dd>{statusLabel(open.status)}</dd>
              <dt>Starts</dt>
              <dd>{when(open.start_utc)}</dd>
              <dt>Ends</dt>
              <dd>{when(open.stop_utc)}</dd>
              {open.error && (
                <>
                  <dt>Error</dt>
                  <dd>{open.error}</dd>
                </>
              )}
            </dl>
            {isPlayable(open) && (
              <button type="button" className="dvr-sheet__action" disabled={starting} onClick={() => void play(open)}>
                {starting ? 'Starting…' : 'Play'}
              </button>
            )}
            {isAdmin && (
              <button type="button" className="dvr-sheet__action dvr-sheet__action--danger" onClick={() => askDelete(open)}>
                Delete
              </button>
            )}
            {playError && (
              <p className="dvr-sheet__note dvr-sheet__note--error" role="alert">
                {playError}
              </p>
            )}
          </div>
        ) : list.isLoading ? (
          <p className="iptv-conn-modal__summary">Loading recordings…</p>
        ) : list.error && !list.data ? (
          <div className="iptv-conn-modal__summary" role="alert">
            <p>Couldn’t load recordings.</p>
            <button type="button" className="iptv-tab__retry" onClick={() => void list.refetch()}>
              Retry
            </button>
          </div>
        ) : recordings.length === 0 ? (
          <p className="iptv-conn-modal__summary">
            No recordings yet. Choose a future programme in the guide and select Record.
          </p>
        ) : (
          <ul className="iptv-conn-modal__list">
            {recordings.map((rec) => (
              <li key={rec.id}>
                <button
                  type="button"
                  className="dvr-row"
                  onClick={() => {
                    setPlayError(null)
                    setOpenId(rec.id)
                  }}
                >
                  <span className="dvr-row__title">{rec.title}</span>
                  <span className="dvr-row__meta">
                    {rec.channel_name} · {statusLabel(rec.status)} · {when(rec.start_utc)}
                  </span>
                  <span className={'dvr-row__badge' + (isPlayable(rec) ? ' dvr-row__badge--ready' : '')}>
                    {isPlayable(rec) ? 'Ready' : statusLabel(rec.status)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
