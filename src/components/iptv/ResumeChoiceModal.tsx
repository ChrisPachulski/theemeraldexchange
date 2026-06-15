import { useModalA11y } from '../../lib/hooks/useModalA11y'
import { ResumePrompt } from '../media/ResumePrompt'

// The resume-or-start-over prompt, in the same dialog chrome the IPTV player
// uses (so focus trapping and Escape behave) but NO grant yet — the slot is
// claimed only after the choice. Mirrors the local-media MediaPlayer's
// prompt-first order via the shared ResumePrompt. Shared by VodTab and
// IptvSeriesTab, which previously held identical copies.
export function ResumeChoiceModal({
  title,
  resumeSecs,
  onResume,
  onStartOver,
  onClose,
}: {
  title: string
  resumeSecs: number
  onResume: () => void
  onStartOver: () => void
  onClose: () => void
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  return (
    <div
      ref={modalRef}
      className="iptv-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div className="iptv-player-modal__header">
        <h2>{title}</h2>
        <button className="iptv-player-modal__close" type="button" onClick={onClose} aria-label="Close player">
          ×
        </button>
      </div>
      <ResumePrompt resumeSecs={resumeSecs} onResume={onResume} onStartOver={onStartOver} />
    </div>
  )
}
