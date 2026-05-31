import type { CSSProperties } from 'react'
import './QueueRow.css'
import { useOptimisticMutation } from '../../lib/useOptimisticMutation'

// Retint the row's text token to the subtle weight while a write is in flight.
// Overriding the inherited --text custom property (rather than `color`) carries
// the muted weight to every token-driven child without a layout-affecting prop.
const PENDING_STYLE = { '--text': 'var(--text-subtle)' } as CSSProperties

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

  // Optimistic pause/resume (spec P0.5). `paused` is the server-truth prop fed
  // by the 3s SAB poll; the tap flips it locally the instant it lands so the
  // PAUSED/% label and the dimmed-row state don't wait a poll cycle. React
  // reverts to the prop if the underlying pause/resume mutation rejects.
  const opt = useOptimisticMutation<boolean, boolean>(paused, (_current, next) => next)
  // `busy` is the parent's isPending gate; `opt.pending` covers the brief
  // window between tap and the mutation settling. Either blocks re-taps.
  const inFlight = busy || opt.pending
  const isPaused = opt.value

  const statusLabel = isPaused
    ? 'PAUSED'
    : status === 'Downloading'
      ? `${percent.toFixed(0)}%`
      : status.toUpperCase()

  const handlePause = onPause && (() => opt.run(true, async () => onPause()))
  const handleResume = onResume && (() => opt.run(false, async () => onResume()))

  return (
    <article
      className={`queue-row${isPaused ? ' queue-row--paused' : ''}`}
      // While the write is in flight, drop the controls to --text-subtle so the
      // row reads as "settling" without a layout shift (token color swap only).
      style={inFlight ? PENDING_STYLE : undefined}
      aria-busy={inFlight || undefined}
    >
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
            {isPaused
              ? handleResume && (
                  <button type="button" className="queue-row__btn" onClick={handleResume} disabled={inFlight}>
                    Resume
                  </button>
                )
              : handlePause && (
                  <button type="button" className="queue-row__btn" onClick={handlePause} disabled={inFlight}>
                    Pause
                  </button>
                )}
            {onDelete && (
              <button
                type="button"
                className="queue-row__btn queue-row__btn--danger"
                onClick={onDelete}
                disabled={inFlight}
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
