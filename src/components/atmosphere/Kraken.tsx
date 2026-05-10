import './Kraken.css'

// Atmospheric background layer.
//
// Both variants are always mounted; only opacity differs. That way a
// route change (kraken ↔ resting) is a 250ms cross-fade instead of a
// React remount that re-loads the video and paints a black gap during
// the gap between unload and first frame paint.
//
// `kraken` variant — Pixabay #333401 (CC0). Warm tan/grey palette so a
//   CSS filter stack pushes it toward the emerald grade. Used on home.
// `resting` variant — Runway-generated emerald-radiation loop with the
//   grade baked in. No CSS filter. Used on every non-home tab.

type Props = { variant?: 'kraken' | 'resting' }

export function Kraken({ variant = 'kraken' }: Props) {
  return (
    <div className={`kraken kraken--${variant}`} aria-hidden="true">
      <video
        className="kraken__video kraken__video--kraken"
        loop
        muted
        playsInline
        autoPlay
        preload="auto"
        poster="/kraken-poster.jpg"
      >
        <source src="/kraken.webm" type="video/webm" />
        <source src="/kraken.mp4" type="video/mp4" />
      </video>
      <video
        className="kraken__video kraken__video--resting"
        loop
        muted
        playsInline
        autoPlay
        preload="auto"
      >
        <source src="/resting.webm" type="video/webm" />
        <source src="/resting.mp4" type="video/mp4" />
      </video>
    </div>
  )
}
