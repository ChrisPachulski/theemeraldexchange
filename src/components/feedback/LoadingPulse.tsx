import './LoadingPulse.css'

type Props = { children: React.ReactNode }

// Shared loading indicator for non-home tabs. Lands in the same fixed
// viewport-center position across TV / Movies / Downloads and pulses on
// a 1.8s cycle so it visually rhymes with the emerald in the resting
// background. Reduced-motion users get a static dim-emerald state.
export function LoadingPulse({ children }: Props) {
  return (
    <div className="loading-pulse" role="status" aria-live="polite">
      <span className="loading-pulse__glyph" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path d="M5 2 L11 2 L14 5 L11 14 L5 14 L2 5 Z" fill="currentColor" />
          <path
            d="M2 5 L14 5 M5 2 L8 5 L11 2 M8 5 L8 14"
            stroke="rgba(0,0,0,0.32)"
            strokeWidth="0.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="loading-pulse__label">{children}</span>
    </div>
  )
}
