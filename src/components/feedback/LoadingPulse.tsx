import { EmeraldMark } from '../atmosphere/EmeraldMark'
import './LoadingPulse.css'

type Props = { children: React.ReactNode }

// Shared loading indicator for non-home tabs. Same 3D gem used everywhere
// else (nav, favicon, walkthrough), pulsing on a 1.8s cycle via CSS opacity
// animation on the .loading-pulse__glyph wrapper. Reduced-motion users
// get a static dim-emerald state via the existing media query.
export function LoadingPulse({ children }: Props) {
  return (
    <div className="loading-pulse" role="status" aria-live="polite">
      <span className="loading-pulse__glyph" aria-hidden="true">
        <EmeraldMark width={24} variant="single" />
      </span>
      <span className="loading-pulse__label">{children}</span>
    </div>
  )
}
