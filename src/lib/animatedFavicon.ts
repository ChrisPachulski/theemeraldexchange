// Animated 3-emerald favicon. Spins up a hidden GemScene rendering to an
// offscreen 64x64 canvas, blits the result into a square favicon canvas with
// a rounded backdrop, and pumps the data URL into <link rel="icon"> at 14fps.
// Pauses when the tab is hidden so it doesn't burn CPU in the background.
//
// Static SVG fallback lives at /brand/mark-3em.svg — index.html still points
// the icon link at that file, so no-JS contexts (RSS, bots, social previews)
// get the 2D version. This module hijacks the link once the scene is rendering.

import { GemScene } from './gemScene'

const FAVICON_SIZE = 64
const FPS = 14
const BG = '#0a1612'

function getFaviconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  return link
}

function paintRoundedBackdrop(ctx: CanvasRenderingContext2D, size: number) {
  const r = Math.round(size * 0.17)
  // Build the rounded-square path once, used for fill and clip.
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(r, 0)
    ctx.lineTo(size - r, 0)
    ctx.quadraticCurveTo(size, 0, size, r)
    ctx.lineTo(size, size - r)
    ctx.quadraticCurveTo(size, size, size - r, size)
    ctx.lineTo(r, size)
    ctx.quadraticCurveTo(0, size, 0, size - r)
    ctx.lineTo(0, r)
    ctx.quadraticCurveTo(0, 0, r, 0)
    ctx.closePath()
  }
  // Base dark fill
  path()
  ctx.fillStyle = BG
  ctx.fill()
  // Emerald halo behind the gems — pushes a green tint into the corners so
  // even after the browser's 16x16 downsample, the favicon reads as "green
  // glow", not "dark square with imperceptible specks".
  path()
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.55)
  grad.addColorStop(0, 'rgba(31,158,122,0.55)')
  grad.addColorStop(0.7, 'rgba(20,80,60,0.25)')
  grad.addColorStop(1, 'rgba(10,22,18,0)')
  ctx.fillStyle = grad
  ctx.fill()
}

/**
 * Boot the animated favicon. Safe to call once on app start.
 */
export function mountAnimatedFavicon(): void {
  if (typeof window === 'undefined') return
  if ((window as unknown as { __teeFaviconMounted?: boolean }).__teeFaviconMounted) return
  ;(window as unknown as { __teeFaviconMounted?: boolean }).__teeFaviconMounted = true

  // WebGL canvas — kept off-DOM and rendered at 3:1 so the three gems all fit.
  // We crop the centre band into a square favicon below.
  const renderCanvas = document.createElement('canvas')
  const renderW = 384
  const renderH = 128
  renderCanvas.width = renderW
  renderCanvas.height = renderH

  let scene: GemScene
  try {
    scene = new GemScene({
      canvas: renderCanvas,
      width: renderW,
      height: renderH,
      pixelRatio: 1, // favicon is tiny — extra DPI here is wasted
      fov: 35,       // wider FOV + closer camera so the 3 gems fill the
                     // favicon frame instead of sitting 70% wide with margin
    })
    // Camera much closer than the hero default (5.2). At 2.6 the gems span
    // ~98% of the width with the camera dipped slightly to show more of the
    // crown — at 16x16 they're at least distinguishable instead of three
    // indistinct green dots.
    scene.camera.position.set(0, 0.25, 2.6)
    scene.camera.lookAt(0, -0.05, 0)
    // Crank exposure heavily so the highlights survive the 6x downsample
    // browsers do when rendering at 16x16. The result looks "too bright" at
    // 64x64 but reads correctly at favicon scale.
    scene.renderer.toneMappingExposure = 1.85
  } catch (err) {
    // WebGL unavailable (headless, old hardware, blocked) — leave the static
    // SVG fallback alone and bail. No favicon downgrade.
    console.warn('[favicon] WebGL init failed; static SVG fallback stays', err)
    return
  }

  const faviconCanvas = document.createElement('canvas')
  faviconCanvas.width = FAVICON_SIZE
  faviconCanvas.height = FAVICON_SIZE
  const maybeCtx = faviconCanvas.getContext('2d')
  if (!maybeCtx) return
  const fctx: CanvasRenderingContext2D = maybeCtx

  const link = getFaviconLink()
  // The link currently points at the static SVG fallback. Once we start
  // pumping PNG frames the browser will use the PNG instead. We don't strip
  // the SVG-fallback href so a JS-disabled refresh still shows the brand mark.
  link.type = 'image/png'

  const tickMs = 1000 / FPS
  let lastTick = 0
  let rafId = 0
  let startedAt = 0

  function pump(now: number) {
    if (document.hidden) return
    if (!startedAt) startedAt = now
    if (now - lastTick >= tickMs) {
      const t = (now - startedAt) / 1000
      scene.renderAt(t)

      // Blit centre-cropped band of the 3:1 WebGL canvas into the square favicon
      // with a rounded dark backdrop.
      fctx.clearRect(0, 0, FAVICON_SIZE, FAVICON_SIZE)
      paintRoundedBackdrop(fctx, FAVICON_SIZE)
      const bandH = Math.round(FAVICON_SIZE / 3)
      const bandY = Math.round((FAVICON_SIZE - bandH) / 2)
      fctx.drawImage(renderCanvas, 0, 0, renderW, renderH, 0, bandY, FAVICON_SIZE, bandH)

      link.href = faviconCanvas.toDataURL('image/png')
      lastTick = now
    }
    rafId = requestAnimationFrame(pump)
  }

  function startLoop() {
    cancelAnimationFrame(rafId)
    lastTick = 0
    startedAt = 0
    rafId = requestAnimationFrame(pump)
  }

  startLoop()

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) startLoop()
  })
}
