import { describe, it, expect } from 'vitest'

// Feature-gate test for the USE_MEDIA_CORE mount gate in app.ts. The
// /api/media proxy is mounted only when env.useMediaCore is true, and
// /api/limits reports `mediaEnabled` so the SPA can gate its Media
// Library tab (same contract as the IPTV gate). env.ts reads
// USE_MEDIA_CORE at module load, so set the env BEFORE the dynamic
// import and reset the module cache around each case.

describe('USE_MEDIA_CORE — media proxy mount gate', () => {
  it('404s /api/media/* but reports mediaEnabled:false when unset', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const prev = process.env.USE_MEDIA_CORE
    delete process.env.USE_MEDIA_CORE
    try {
      const { app } = await import('./app.js')

      // Rest of the app still mounts.
      const health = await app.request('/api/health')
      expect(health.status).toBe(200)

      // The /api/media tree is unmounted -> Hono 404 fallback.
      const media = await app.request('/api/media/movies')
      expect(media.status).toBe(404)

      // /api/limits surfaces the gate so the SPA can hide the tab.
      const limits = await app.request('/api/limits')
      expect(limits.status).toBe(200)
      const body = (await limits.json()) as { mediaEnabled: boolean }
      expect(body.mediaEnabled).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.USE_MEDIA_CORE
      else process.env.USE_MEDIA_CORE = prev
      vi.resetModules()
    }
  })

  it('mounts /api/media/* and reports mediaEnabled:true when USE_MEDIA_CORE=1', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const prev = process.env.USE_MEDIA_CORE
    process.env.USE_MEDIA_CORE = '1'
    try {
      const { app } = await import('./app.js')

      // Mounted: a request reaches the proxy router instead of the 404
      // fallback. The handler may 5xx/4xx without a configured upstream,
      // but it must NOT be Hono's unmounted-route 404.
      const media = await app.request('/api/media/movies')
      expect(media.status).not.toBe(404)

      const limits = await app.request('/api/limits')
      const body = (await limits.json()) as { mediaEnabled: boolean }
      expect(body.mediaEnabled).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.USE_MEDIA_CORE
      else process.env.USE_MEDIA_CORE = prev
      vi.resetModules()
    }
  })
})
