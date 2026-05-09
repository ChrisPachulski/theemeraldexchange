import { useNavTransition } from '../../lib/navTransition'
import './ReplayButton.css'

// Bottom-right pill that replays the nav transition clip on demand.
// The clip-played gate is one-shot per browser (localStorage), so most
// of the time this is the only way to see the flourish again.

export function ReplayButton() {
  const { replay } = useNavTransition()
  return (
    <button
      type="button"
      className="replay-btn"
      aria-label="Replay intro clip"
      onClick={replay}
    >
      <svg
        className="replay-btn__icon"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
      >
        <path
          d="M8 3a5 5 0 1 1-3.95 8.05"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d="M8 1.5 L5 3.5 L8 5.5 Z"
          fill="currentColor"
        />
      </svg>
      <span className="replay-btn__label">Replay</span>
    </button>
  )
}
