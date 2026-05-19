import { useEffect, useRef } from 'react'
import { GemScene } from '../../lib/gemScene'
import './EmeraldMark.css'

interface EmeraldMarkProps {
  /** rendered CSS width in px; height auto-derives from aspect ratio. */
  width?: number
  /** 'wide' = 3:1 row of three gems. 'square' = single centre gem (favicon-style framing). */
  variant?: 'wide' | 'square'
  className?: string
}

// Live three-emerald brand mark. Boots a Three.js scene on a canvas the size
// of the requested CSS box, runs the same GemScene as the favicon, and tears
// itself down on unmount. Aim is one canvas per placement — if you need many
// instances on one page, factor the renderer into a shared singleton.
export function EmeraldMark({ width = 240, variant = 'wide', className }: EmeraldMarkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const aspect = variant === 'wide' ? 3 : 1
  const height = Math.round(width / aspect)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let scene: GemScene
    try {
      scene = new GemScene({
        canvas,
        width,
        height,
        fov: variant === 'wide' ? 22 : 35,
      })
      if (variant === 'square') {
        scene.camera.position.set(0, 0.1, 3.0)
        scene.camera.lookAt(0, 0, 0)
      }
    } catch (err) {
      console.warn('[EmeraldMark] WebGL init failed', err)
      return
    }
    scene.start()
    const onVis = () => { document.hidden ? scene.stop() : scene.start() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      scene.dispose()
    }
  }, [width, height, variant])

  return (
    <canvas
      ref={canvasRef}
      className={['emerald-mark', className].filter(Boolean).join(' ')}
      style={{ width: `${width}px`, height: `${height}px` }}
      aria-label="The Emerald Exchange"
      role="img"
    />
  )
}
