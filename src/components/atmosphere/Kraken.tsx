import './Kraken.css'

// Live-action kraken: AI-rendered classic kraken (massive cephalopod head,
// tentacles, glowing eyes, stormy seas), played as a native HTML loop.
// The Pixabay source is authored to be cycle-clean, so the browser's own
// seamless-loop boundary is good enough — no opacity crossfade needed,
// which avoids the global brightness shimmer two-video stacking caused.
//
// Source: Pixabay video #333401 (CC0).

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
