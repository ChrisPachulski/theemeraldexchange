import './Kraken.css'

// Atmospheric background layer.
//
// `kraken` variant — Pixabay #333401 (CC0). The Pixabay scene has a warm
//   tan/grey palette so we run a CSS filter stack (saturate/hue-rotate/
//   contrast/brightness) to push it toward the emerald grade and pull
//   bright lightning down. Used on the home page only.
//
// `resting` variant — Runway-generated emerald-radiation loop with the
//   dark purple-charcoal-green grade and emerald gem baked in. No CSS
//   filter; running the home filter on top would over-process it. Used
//   on every non-home tab. The `key` prop on the <video> remounts the
//   element when variant changes so the browser loads the new source.

type Props = { variant?: 'kraken' | 'resting' }

export function Kraken({ variant = 'kraken' }: Props) {
  const poster = variant === 'kraken' ? '/kraken-poster.jpg' : undefined

  return (
    <div className={`kraken kraken--${variant}`} aria-hidden="true">
      <video
        key={variant}
        className="kraken__video"
        loop
        muted
        playsInline
        autoPlay
        preload="auto"
        poster={poster}
      >
        <source src={`/${variant}.webm`} type="video/webm" />
        <source src={`/${variant}.mp4`} type="video/mp4" />
      </video>
    </div>
  )
}
