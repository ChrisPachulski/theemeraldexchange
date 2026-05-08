import { useEffect, useRef } from 'react'
import './Beacon.css'

// The lure. A live-action emerald gem rotating in dark cavern (Pixabay
// video #89251, CC0), pinned top-right — the prize the kraken in the
// background is reaching for.
//
// The video carries a real alpha channel (VP9 + yuva420p, ffmpeg lumakey
// keyed out the dark cavern at encode time). No mix-blend-mode tricks,
// no rectangular frame to mask away — only the gem's actual silhouette
// sits on the kraken scene below.
//
// Two <video> elements run the same clip 10s out of phase; triangle-wave
// opacity animations sum to 1 at every t, so the loop boundary of one is
// always covered by the other's mid-clip.

const LOOP_S = 20.83
const OFFSET_S = LOOP_S / 2

export function Beacon() {
  const aRef = useRef<HTMLVideoElement>(null)
  const bRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const a = aRef.current
    const b = bRef.current
    if (!a || !b) return
    let started = false
    const start = () => {
      if (started) return
      started = true
      a.play().catch(() => {})
      b.currentTime = OFFSET_S
      b.play().catch(() => {})
    }
    let aReady = a.readyState >= 2
    let bReady = b.readyState >= 2
    const tryStart = () => { if (aReady && bReady) start() }
    if (!aReady) a.addEventListener('loadeddata', () => { aReady = true; tryStart() }, { once: true })
    if (!bReady) b.addEventListener('loadeddata', () => { bReady = true; tryStart() }, { once: true })
    if (aReady && bReady) start()
  }, [])

  return (
    <div className="beacon" aria-hidden="true">
      <video ref={aRef} className="beacon__video beacon__video--a" loop muted playsInline autoPlay preload="auto" poster="/gem-poster.png">
        <source src="/gem.webm" type="video/webm" />
      </video>
      <video ref={bRef} className="beacon__video beacon__video--b" loop muted playsInline autoPlay preload="auto">
        <source src="/gem.webm" type="video/webm" />
      </video>
    </div>
  )
}
