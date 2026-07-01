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

      // /api/transcode rides the same flag — unmounted too.
      const transcode = await app.request('/api/transcode/sessions')
      expect(transcode.status).toBe(404)

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

      // Mounted: a cookieless request reaches the proxy router instead of
      // the 404 fallback — and the router's REAL auth gate rejects it with
      // 401 unauthenticated. Asserting 401 specifically (not just "not 404")
      // pins BOTH facts: the tree is mounted AND it is auth-gated. A 200
      // here would mean requireAuth fell off the media proxy.
      const media = await app.request('/api/media/movies')
      expect(media.status).toBe(401)
      const mediaBody = (await media.json()) as { error?: string }
      expect(mediaBody.error).toBe('unauthenticated')

      // /api/transcode mounts on the same flag, with the same auth contract.
      const transcode = await app.request('/api/transcode/sessions')
      expect(transcode.status).toBe(401)

      const limits = await app.request('/api/limits')
      const body = (await limits.json()) as { mediaEnabled: boolean; musicEnabled: boolean }
      expect(body.mediaEnabled).toBe(true)
      // Music needs BOTH the proxy AND a music root; MUSIC_LIBRARY_PATHS is
      // unset here, so music stays disabled even with the proxy mounted.
      expect(body.musicEnabled).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.USE_MEDIA_CORE
      else process.env.USE_MEDIA_CORE = prev
      vi.resetModules()
    }
  })

  it('reports musicEnabled:true only when USE_MEDIA_CORE=1 AND MUSIC_LIBRARY_PATHS is set', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const prevMedia = process.env.USE_MEDIA_CORE
    const prevMusic = process.env.MUSIC_LIBRARY_PATHS
    process.env.USE_MEDIA_CORE = '1'
    process.env.MUSIC_LIBRARY_PATHS = '/media/Music'
    try {
      const { app } = await import('./app.js')
      const limits = await app.request('/api/limits')
      const body = (await limits.json()) as { mediaEnabled: boolean; musicEnabled: boolean }
      expect(body.mediaEnabled).toBe(true)
      expect(body.musicEnabled).toBe(true)
    } finally {
      if (prevMedia === undefined) delete process.env.USE_MEDIA_CORE
      else process.env.USE_MEDIA_CORE = prevMedia
      if (prevMusic === undefined) delete process.env.MUSIC_LIBRARY_PATHS
      else process.env.MUSIC_LIBRARY_PATHS = prevMusic
      vi.resetModules()
    }
  })

  it('reports musicEnabled:false when a music root is set but the proxy is off', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const prevMedia = process.env.USE_MEDIA_CORE
    const prevMusic = process.env.MUSIC_LIBRARY_PATHS
    delete process.env.USE_MEDIA_CORE
    process.env.MUSIC_LIBRARY_PATHS = '/media/Music'
    try {
      const { app } = await import('./app.js')
      const limits = await app.request('/api/limits')
      const body = (await limits.json()) as { mediaEnabled: boolean; musicEnabled: boolean }
      // No proxy mounted → music unreachable, so the flag must stay false even
      // though a root is configured (both facts are required).
      expect(body.mediaEnabled).toBe(false)
      expect(body.musicEnabled).toBe(false)
    } finally {
      if (prevMedia === undefined) delete process.env.USE_MEDIA_CORE
      else process.env.USE_MEDIA_CORE = prevMedia
      if (prevMusic === undefined) delete process.env.MUSIC_LIBRARY_PATHS
      else process.env.MUSIC_LIBRARY_PATHS = prevMusic
      vi.resetModules()
    }
  })
})
