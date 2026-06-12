import { useEffect, useRef } from 'react'
import type { GemScene } from '../../lib/gemScene'
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
    // Skip the WebGL boot under browser automation (Playwright sets
    // navigator.webdriver). Headless Chromium on CI has no GPU and no
    // software-WebGL fallback since Chromium 137, so every GemScene
    // mount throws; the repeated failed context creations crash the
    // GPU process and take the page down mid-test. Real users never
    // have webdriver set, so production is unaffected — the canvas
    // still renders with its aria-label as a graceful fallback.
    if (typeof navigator !== 'undefined' && navigator.webdriver) return

    // three.js is ~600KB and only the brand mark uses it, so GemScene lives in
    // its own lazy chunk pulled in here after mount. The <canvas> below already
    // renders (blank, with its aria-label) as the pre-boot frame — identical to
    // the WebGL-unavailable fallback — so deferring the scene boot is invisible.
    // `cancelled` guards the unmount-before-import-resolves race: if the effect
    // tears down before the chunk lands we never construct a scene, and `scene`
    // / `teardown` stay null so the cleanup below is a no-op.
    let cancelled = false
    let scene: GemScene | null = null
    let teardown: (() => void) | null = null

    void import('../../lib/gemScene')
      .then(({ GemScene: GemSceneCtor }) => {
        if (cancelled) return
        try {
          scene = new GemSceneCtor({
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
        const activeScene = scene
        const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
        const syncMotion = () => {
          if (reducedMotionQuery.matches) {
            activeScene.stop()
            activeScene.renderAt(0)
          } else if (document.hidden) {
            activeScene.stop()
          } else {
            activeScene.start()
          }
        }
        syncMotion()
        document.addEventListener('visibilitychange', syncMotion)
        reducedMotionQuery.addEventListener('change', syncMotion)
        teardown = () => {
          document.removeEventListener('visibilitychange', syncMotion)
          reducedMotionQuery.removeEventListener('change', syncMotion)
        }
      })
      .catch((err) => {
        console.warn('[EmeraldMark] gem scene chunk failed to load', err)
      })

    return () => {
      cancelled = true
      teardown?.()
      scene?.dispose()
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
