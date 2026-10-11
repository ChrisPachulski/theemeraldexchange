import { useRef, useState } from 'react'
import type { EpgGridDto, EpgProgrammeDto } from '../../lib/api/iptv'
import { dvrScheduleError, isAlreadyScheduled, type DvrScheduleInput } from '../../lib/api/dvr'
import { useAuth } from '../../lib/auth'
import { useDvrEnabled, useDvrRecordings, useScheduleRecording } from '../../lib/hooks/useDvr'
import { useModalA11y } from '../../lib/hooks/useModalA11y'

const fmtStart = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const fmtStop = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

// A future programme picked in the guide: its details on any device (touch has
// no hover pane), plus Record for admins when the server runs DVR (the Apple
// guide's future-programme sheet, GuideView.swift futureProgrammeSheet).
export function ProgrammeDialog({
  channel,
  programme,
  onClose,
}: {
  channel: Pick<EpgGridDto, 'stream_id' | 'num' | 'name'>
  programme: EpgProgrammeDto
  onClose: () => void
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  const dvrEnabled = useDvrEnabled()
  const { isAdmin } = useAuth()
  const recordings = useDvrRecordings(dvrEnabled && isAdmin)
  const schedule = useScheduleRecording()
  // Synchronous guard: a double click lands before isPending re-renders.
  const inFlight = useRef(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const title = programme.title?.trim() || channel.name
  const input: DvrScheduleInput = {
    channel_stream_id: channel.stream_id,
    channel_name: channel.name,
    title,
    start_utc: programme.start_utc,
    stop_utc: programme.stop_utc,
  }
  const scheduled = done || isAlreadyScheduled(recordings.data ?? [], input)

  const record = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    try {
      await schedule.mutateAsync(input)
      setDone(true)
    } catch (err) {
      setError(dvrScheduleError(err))
    } finally {
      inFlight.current = false
    }
  }

  return (
    <div ref={modalRef} className="iptv-conn-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <div className="iptv-conn-modal__panel">
        <header className="iptv-conn-modal__header">
          <h2>{title}</h2>
          <button type="button" className="iptv-conn-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="dvr-sheet">
          <p className="dvr-sheet__channel">
            {channel.num} · {channel.name}
          </p>
          <p className="dvr-sheet__time">
            {fmtStart.format(new Date(programme.start_utc))}–{fmtStop.format(new Date(programme.stop_utc))}
          </p>
          <p className="dvr-sheet__desc">{programme.description?.trim() || 'No description available.'}</p>
          {dvrEnabled &&
            (!isAdmin ? (
              <p className="dvr-sheet__note">Only a household admin can schedule recordings.</p>
            ) : scheduled ? (
              <>
                <p className="dvr-sheet__note dvr-sheet__note--ok" role="status">Recording scheduled</p>
                <button type="button" className="dvr-sheet__action" disabled>
                  Scheduled
                </button>
              </>
            ) : (
              <button
                type="button"
                className="dvr-sheet__action"
                aria-label={`Record ${title}`}
                disabled={schedule.isPending}
                onClick={() => void record()}
              >
                {schedule.isPending ? 'Scheduling…' : 'Record'}
              </button>
            ))}
          {error && (
            <p className="dvr-sheet__note dvr-sheet__note--error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
