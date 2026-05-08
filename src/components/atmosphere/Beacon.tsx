import './Beacon.css'

// The lure. A real photographic emerald cluster, top-right of the scene —
// the prize the kraken in the background is reaching for.
//
// The image is a black-bg JPG. Composited with mix-blend-mode: screen,
// the black is suppressed entirely and only the gem itself contributes
// light to the scene below. No circle, no badge frame — the gem keeps
// its natural irregular mineral silhouette and a drop-shadow stack
// creates a glow that follows that exact shape, not a disc behind it.
//
// One layer is rendered twice: a heavily-blurred, larger backing copy
// (the chromatic bloom that follows the gem outline) and the sharp
// foreground. Both scale + brighten on the same pulse so the bloom
// breathes with the crystal.

export function Beacon() {
  return (
    <div className="beacon" aria-hidden="true">
      <img className="beacon__bloom" src="/emerald.png" alt="" decoding="async" />
      <img className="beacon__gem"   src="/emerald.png" alt="" decoding="async" />
    </div>
  )
}
