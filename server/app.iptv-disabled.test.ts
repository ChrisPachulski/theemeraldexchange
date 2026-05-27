import { describe, it, expect } from 'vitest'

// Contract §13.3 reviewer-insurance gate. Boot the server with
// IPTV_DISABLED=1 BEFORE importing app.ts (env is read at module
// load), then assert that every /api/iptv/* path 404s while the rest
// of the surface stays mounted.
//
// This test runs in the normal suite; the CI matrix gets a separate
// `build:no-iptv-server` job per the contract that re-runs the whole
// suite with IPTV_DISABLED=1 set globally — that job's job is to catch
// any other surface that quietly depends on /api/iptv being mounted.
//
// Why a fresh app instance: env.ts and app.ts are evaluated at module
// load. Re-importing in a vitest test triggers cache invalidation
// via vi.resetModules(); we set the env BEFORE the dynamic import so
// the gate reads the new value.

describe('IPTV_DISABLED=1 — reviewer-insurance gate', () => {
  it('serves /api/health but 404s /api/iptv/* when disabled', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()

    process.env.IPTV_DISABLED = '1'
    try {
      const { app } = await import('./app.js')

      // Sanity check: the rest of the app still mounts.
      const health = await app.request('/api/health')
      expect(health.status).toBe(200)

      // The /api/iptv tree is unmounted. Health endpoint inside it is
      // the canonical probe the contract names.
      const iptvHealth = await app.request('/api/iptv/health')
      expect(iptvHealth.status).toBe(404)

      // Catalog routes also gone.
      const live = await app.request('/api/iptv/live')
      expect(live.status).toBe(404)

      // /api/limits reports the gate so the SPA can hide tabs.
      const limits = await app.request('/api/limits')
      expect(limits.status).toBe(200)
      const body = (await limits.json()) as { iptvEnabled: boolean }
      expect(body.iptvEnabled).toBe(false)
    } finally {
      delete process.env.IPTV_DISABLED
      vi.resetModules()
    }
  })

  it('serves /api/iptv/* when IPTV_DISABLED is unset (default-enabled)', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    delete process.env.IPTV_DISABLED

    const { app } = await import('./app.js')

    // /api/iptv/health 401s without auth — but it's mounted, so a
    // 404 here would mean the gate fired when it shouldn't have.
    const iptvHealth = await app.request('/api/iptv/health')
    expect(iptvHealth.status).not.toBe(404)

    const limits = await app.request('/api/limits')
    const body = (await limits.json()) as { iptvEnabled: boolean }
    expect(body.iptvEnabled).toBe(true)
  })
})
