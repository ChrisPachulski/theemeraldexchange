import './Beacon.css'

// The beacon. Pure CSS light — no video, no image, just stacked radial
// gradients in screen-blend so the glow ADDS to the kraken scene below
// instead of carving a rectangular hole into it. Three layers (atmospheric
// bloom, mid halo, bright core) breathe at different periods so the
// composite pulse looks organic, not metronomic.
export function Beacon() {
  return (
    <div className="beacon" aria-hidden="true">
      <div className="beacon__bloom" />
      <div className="beacon__halo" />
      <div className="beacon__core" />
    </div>
  )
}
