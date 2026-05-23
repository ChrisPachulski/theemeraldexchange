// requireSafeOrigin guards state-changing requests. Cookies are
// SameSite=None in prod (Netlify ↔ NAS split) so browsers attach them
// to cross-origin POST/PUT/PATCH/DELETE; the Origin header is the only
// reliable way to distinguish trusted SPA tabs from attacker pages.
//
// These tests cover all the branches that matter:
//   - safe methods (GET/HEAD) bypass the gate
//   - unconfigured + dev → pass through
//   - unconfigured + prod → fail closed (defense-in-depth; env.ts
//     normally refuses to boot here, but the middleware shouldn't
//     fail open even if that gate is bypassed)
//   - allowlist + matching Origin → pass
//   - allowlist + missing/wrong Origin → 403

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Hono } from 'hono'

// We mock the env module so we can simulate "env.ts was bypassed
// somehow, what does the middleware do" — including the prod + empty
// allowlist case that env.ts itself refuses to boot in.
async function buildApp(opts: {
  allowedOrigins: string[]
  isProd: boolean
}) {
  vi.resetModules()
  vi.doMock('../env.js', () => ({
    env: { allowedOrigins: opts.allowedOrigins, isProd: opts.isProd },
  }))
  const { requireSafeOrigin } = await import('./csrf.js')
  const app = new Hono()
  app.use('*', requireSafeOrigin)
  app.all('/echo', (c) => c.json({ ok: true }))
  return app
}

afterEach(() => {
  vi.doUnmock('../env.js')
  vi.resetModules()
})

describe('requireSafeOrigin — safe methods bypass the gate', () => {
  it.each(['GET', 'HEAD'])('lets %s through with no Origin in prod', async (method) => {
    const app = await buildApp({ allowedOrigins: ['https://app.example'], isProd: true })
    const r = await app.request('/echo', { method })
    expect(r.status).toBe(200)
  })

  it('lets GET through even when Origin is hostile', async () => {
    const app = await buildApp({ allowedOrigins: ['https://app.example'], isProd: true })
    const r = await app.request('/echo', {
      method: 'GET',
      headers: { Origin: 'https://attacker.example' },
    })
    expect(r.status).toBe(200)
  })
})

describe('requireSafeOrigin — unconfigured allowlist', () => {
  it('dev (isProd:false) passes through state-changing requests', async () => {
    const app = await buildApp({ allowedOrigins: [], isProd: false })
    const r = await app.request('/echo', { method: 'POST' })
    expect(r.status).toBe(200)
  })

  it('prod with empty allowlist fails closed (defense in depth)', async () => {
    // env.ts would normally throw at boot here. The middleware is the
    // second line of defense — if anything bypasses that check, we
    // must NOT serve state-changing requests with no Origin gate.
    const app = await buildApp({ allowedOrigins: [], isProd: true })
    const r = await app.request('/echo', { method: 'POST' })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({
      error: 'forbidden',
      reason: 'csrf_misconfigured',
    })
  })
})

describe('requireSafeOrigin — allowlist enforcement', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects %s with mismatched Origin (403 bad_origin)',
    async (method) => {
      const app = await buildApp({ allowedOrigins: ['https://app.example'], isProd: true })
      const r = await app.request('/echo', {
        method,
        headers: { Origin: 'https://attacker.example' },
      })
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({
        error: 'forbidden',
        reason: 'bad_origin',
      })
    },
  )

  it('rejects POST with no Origin header at all', async () => {
    // A same-origin POST normally sets Origin too (browsers do this
    // for all non-GET fetches). An attacker forging a request from
    // a non-browser context might omit it — fail closed.
    const app = await buildApp({ allowedOrigins: ['https://app.example'], isProd: true })
    const r = await app.request('/echo', { method: 'POST' })
    expect(r.status).toBe(403)
  })

  it('allows POST when Origin matches one of the allowed origins', async () => {
    const app = await buildApp({
      allowedOrigins: ['https://app.example', 'https://staging.example'],
      isProd: true,
    })
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { Origin: 'https://staging.example' },
    })
    expect(r.status).toBe(200)
  })
})
