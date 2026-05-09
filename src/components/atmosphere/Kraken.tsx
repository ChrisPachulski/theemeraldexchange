import './Kraken.css'

// Live-action kraken: AI-rendered classic kraken (massive cephalopod head,
// tentacles, glowing eyes, stormy seas), played as a native HTML loop.
// The Pixabay source is authored to be cycle-clean, so the browser's own
// seamless-loop boundary is good enough — no opacity crossfade needed,
// which avoids the global brightness shimmer two-video stacking caused.
//
// Source: Pixabay video #333401 (CC0).
//
// Phase 2 (planned, not implemented): tab-driven 3D angle rotation.
//   - Generate alternate-angle videos via scripts/_kraken-gen.mjs by
//     re-running with the front-clip's last frame as promptImage and a
//     prompt describing the desired orbit angle (e.g., "the same creature
//     viewed from a 90-degree lateral angle"). Runway image-to-video
//     preserves identity far better than re-rolling text-to-video.
//   - Tabs map to angles: TV → 0°, Movies → 90°, Downloads → 180°, Watch → 270°.
//   - On tab change, crossfade or play a short orbital transition clip
//     between source and destination angle videos. The current single-
//     video setup is the front-angle anchor for that future fan-out.

export function Kraken() {
  return (
    <div className="kraken" aria-hidden="true">
      <video
        className="kraken__video"
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
    </div>
  )
}
