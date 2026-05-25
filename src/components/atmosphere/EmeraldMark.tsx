import { useEffect, useRef } from 'react'
import { GemScene } from '../../lib/gemScene'
import './EmeraldMark.css'

interface EmeraldMarkProps {
  /** rendered CSS width in px; height auto-derives from aspect ratio. */
  width?: number
  /**
   * 'single' = one centred 3D gem (square aspect). Matches the existing
   *            inline-SVG glyph used next to "Watch" — the universal brand
   *            mark wherever a small emerald belongs.
   * 'row'    = three gems in a row (3:1). Kept for the rare layout where a
   *            horizontal brand mark is wanted; not used in current UI.
   */
  variant?: 'single' | 'row'
  className?: string
}

// Live brand mark. Boots a Three.js GemScene on a canvas the size of the
// requested CSS box, animates a slow rotation, and tears itself down on
// unmount. One canvas per placement — if many instances appear on one page,
// factor the renderer into a shared singleton later.
export function EmeraldMark({ width = 64, variant = 'single', className }: EmeraldMarkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const aspect = variant === 'row' ? 3 : 1
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
        gemCount: variant === 'single' ? 1 : 3,
        fov: variant === 'single' ? 30 : 22,
      })
    } catch (err) {
      console.warn('[EmeraldMark] WebGL init failed', err)
      return
    }
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const syncMotion = () => {
      if (reducedMotionQuery.matches) {
        scene.stop()
        scene.renderAt(0)
      } else if (document.hidden) {
        scene.stop()
      } else {
        scene.start()
      }
    }
    syncMotion()
    document.addEventListener('visibilitychange', syncMotion)
    reducedMotionQuery.addEventListener('change', syncMotion)
    return () => {
      document.removeEventListener('visibilitychange', syncMotion)
      reducedMotionQuery.removeEventListener('change', syncMotion)
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
