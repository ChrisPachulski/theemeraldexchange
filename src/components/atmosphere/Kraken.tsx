import { useEffect, useRef } from 'react'
import './Kraken.css'

// Live-action kraken: AI-rendered classic kraken (massive cephalopod head,
// tentacles, glowing eyes, stormy seas), played as a *seamless* loop.
//
// The trick: two stacked <video> elements playing the same 10s source
// 5 seconds out of phase. CSS opacity crossfades them as triangle waves
// summing to 1 — when one video is approaching its loop boundary, the
// other is mid-clip and fully visible. The user never sees the loop cut.
//
// Source: Pixabay video #333401 (CC0).

const LOOP_S = 10
const OFFSET_S = LOOP_S / 2

export function Kraken() {
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
      // Offset B by half the loop length so its loop boundary lands at A's
      // mid-clip and vice versa. The CSS crossfade rides on top of that.
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
    <div className="kraken" aria-hidden="true">
      <video
        ref={aRef}
        className="kraken__video kraken__video--a"
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
        ref={bRef}
        className="kraken__video kraken__video--b"
        loop
        muted
        playsInline
        autoPlay
        preload="auto"
      >
        <source src="/kraken.webm" type="video/webm" />
        <source src="/kraken.mp4" type="video/mp4" />
      </video>
    </div>
  )
}
