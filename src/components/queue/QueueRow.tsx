import './QueueRow.css'

type Props = {
  filename: string
  category: string
  size: string
  percent: number
  timeLeft: string
  status: string
  /** Action handlers are optional — when omitted (e.g. for non-admin
   *  viewers) the actions cluster is hidden entirely. */
  onPause?: () => void
  onResume?: () => void
  onDelete?: () => void
  paused: boolean
  busy: boolean
}

export function QueueRow({
  filename,
  category,
  size,
  percent,
  timeLeft,
  status,
  onPause,
  onResume,
  onDelete,
  paused,
  busy,
}: Props) {
  const canControl = Boolean(onPause || onResume || onDelete)
  const statusLabel = paused
    ? 'PAUSED'
    : status === 'Downloading'
      ? `${percent.toFixed(0)}%`
      : status.toUpperCase()

  return (
    <article className={`queue-row${paused ? ' queue-row--paused' : ''}`}>
      <div className="queue-row__top">
        <span className="queue-row__name">{filename}</span>
        <span className="queue-row__cat">{category}</span>
        <span className="queue-row__size">{size}</span>
      </div>

      <div className="queue-row__bar">
        <div
          className="queue-row__bar-fill"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>

      <div className="queue-row__bottom">
        <span className="queue-row__status">[ {statusLabel} ]</span>
        <span className="queue-row__eta">
          {timeLeft && timeLeft !== '0:00:00' ? timeLeft : ''}
        </span>
        {canControl && (
          <div className="queue-row__actions">
            {paused
              ? onResume && (
                  <button type="button" className="queue-row__btn" onClick={onResume} disabled={busy}>
                    Resume
                  </button>
                )
              : onPause && (
                  <button type="button" className="queue-row__btn" onClick={onPause} disabled={busy}>
                    Pause
                  </button>
                )}
            {onDelete && (
              <button
                type="button"
                className="queue-row__btn queue-row__btn--danger"
                onClick={onDelete}
                disabled={busy}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
