import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { test, expect } from '@playwright/test'

// Real-codec MSE playback gate (playwright project `playback-chrome`).
//
// WHY THIS EXISTS: the grey-box playback bug class (manifest 200, valid
// segment ffprobes, yet the video never advances) lives in the browser's
// MediaSource append path and is INVISIBLE to every server-side check —
// e.g. Chrome rejecting a 6-channel AAC SourceBuffer append killed whole
// fragments while every HTTP exchange looked healthy. This spec plays a
// COMMITTED real H.264+AAC HLS fixture (tests/fixtures/hls, see its
// README for the ffmpeg provenance) through the REAL backend transcode
// proxy (/api/transcode → stub transcoder serving the fixture) in REAL
// Chrome, and fails on any MSE/media error or a stalled clock.
//
// WHY channel:'chrome' (set on the project in playwright.config.ts): the
// bundled open-source Chromium has no proprietary H.264/AAC decoders, so
// this spec would false-negative there — exactly the trap that made an
// earlier "proven" playback fix not actually proven. The project is only
// registered when a branded Chrome install exists; CI provides one via
// `npx playwright install chrome`.

const require = createRequire(import.meta.url)
// Serve the local hls.js build (same dependency the SPA bundles) into the
// page rather than pulling a CDN copy — the gate must not depend on
// network reachability or test a different player version than we ship.
const HLS_JS_SOURCE = readFileSync(require.resolve('hls.js/dist/hls.min.js'), 'utf-8')

type PlaybackProbe = {
  currentTime: number
  fatalErrors: string[]
  mediaErrors: string[]
  videoError: string | null
  usedMse: boolean
}

test('real Chrome plays the H.264+AAC HLS fixture through the backend proxy with zero MSE errors', async ({
  page,
}) => {
  // Real session cookie via the helper-layer test-only login; hls.js's
  // same-origin XHRs then authenticate against the real transcode proxy
  // exactly like the SPA player's segment fetches do.
  const login = await page.request.post('/api/test/login', { data: { role: 'admin' } })
  expect(login.ok()).toBeTruthy()

  // Any same-origin page works as the MSE host; the SPA shell itself is
  // covered by the integration project. The fixture manifest is served by
  // the REAL backend: browser → vite proxy → Hono /api/transcode auth +
  // proxy + manifest handling → stub transcoder → committed fixture.
  await page.goto('/')
  await page.addScriptTag({ content: HLS_JS_SOURCE })

  const probe = await page.evaluate(async (): Promise<PlaybackProbe> => {
    type HlsCtor = new (cfg?: object) => {
      on(event: string, cb: (event: string, data: Record<string, unknown>) => void): void
      loadSource(url: string): void
      attachMedia(el: HTMLVideoElement): void
    }
    const w = window as unknown as { Hls: HlsCtor & { isSupported(): boolean; Events: Record<string, string> } }
    if (!w.Hls.isSupported()) {
      return {
        currentTime: 0,
        fatalErrors: ['Hls.isSupported() === false (no MSE in this browser?)'],
        mediaErrors: [],
        videoError: null,
        usedMse: false,
      }
    }

    const video = document.createElement('video')
    video.muted = true // allow autoplay without a user gesture
    video.playsInline = true
    document.body.appendChild(video)

    const fatalErrors: string[] = []
    const mediaErrors: string[] = []
    const hls = new w.Hls({ enableWorker: false })
    hls.on(w.Hls.Events.ERROR ?? 'hlsError', (_evt, data) => {
      const tag = `${String(data.type)}/${String(data.details)}`
      // Any MEDIA_ERROR (bufferAppendError & friends) is the regression
      // class this gate exists for — record them all, fatal or not,
      // because hls.js "recovers" non-fatally from appends that silently
      // produce the grey box.
      if (String(data.type) === 'mediaError') mediaErrors.push(tag)
      if (data.fatal) fatalErrors.push(tag)
    })

    hls.loadSource('/api/transcode/session/e2e-fixture/index.m3u8')
    hls.attachMedia(video)
    try {
      await video.play()
    } catch (e) {
      fatalErrors.push(`video.play() rejected: ${String(e)}`)
    }

    // Wait for the clock to pass 2s (fixture is 5s long) or time out.
    const deadline = Date.now() + 20_000
    while (video.currentTime <= 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }

    return {
      currentTime: video.currentTime,
      fatalErrors,
      mediaErrors,
      videoError: video.error ? `${video.error.code}: ${video.error.message}` : null,
      usedMse: true,
    }
  })

  expect(probe.usedMse, 'MSE unavailable — wrong browser for this gate').toBe(true)
  expect(probe.videoError, 'HTMLMediaElement error during playback').toBeNull()
  expect(probe.mediaErrors, 'hls.js MEDIA_ERROR events (MSE append failures)').toEqual([])
  expect(probe.fatalErrors, 'fatal hls.js errors').toEqual([])
  // The actual grey-box assertion: the playback clock really advanced.
  expect(probe.currentTime, 'video.currentTime never passed 2s — playback stalled').toBeGreaterThan(2)
})
