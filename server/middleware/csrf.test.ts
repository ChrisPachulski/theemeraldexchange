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
  middleware?: 'safe' | 'trusted'
}) {
  vi.resetModules()
  vi.doMock('../env.js', () => ({
    env: { allowedOrigins: opts.allowedOrigins, isProd: opts.isProd },
  }))
  const { requireSafeOrigin, requireTrustedOrigin } = await import('./csrf.js')
  const app = new Hono()
  app.use('*', opts.middleware === 'trusted' ? requireTrustedOrigin : requireSafeOrigin)
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

describe('requireSafeOrigin — bearer-only (native app) exemption', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'allows %s with Authorization: Bearer and no Cookie, even with no Origin',
    async (method) => {
      const app = await buildApp({ allowedOrigins: ['https://app.example'], isProd: true })
      const r = await app.request('/echo', {
        method,
        headers: { Authorization: 'Bearer device.jwe.token' },
      })
      expect(r.status).toBe(200)
    },
  )

  it('still gates a bearer request that ALSO carries a Cookie (cookie is the CSRF vector)', async () => {
    const app = await buildApp({ allowedOrigins: ['https://app.example'], isProd: true })
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { Authorization: 'Bearer device.jwe.token', Cookie: 'eex_session=abc' },
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'forbidden', reason: 'bad_origin' })
  })

  it('does not exempt a non-bearer Authorization scheme', async () => {
    const app = await buildApp({ allowedOrigins: ['https://app.example'], isProd: true })
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(r.status).toBe(403)
  })

  it('still rejects a cookieless POST with no Authorization at all', async () => {
    const app = await buildApp({ allowedOrigins: ['https://app.example'], isProd: true })
    const r = await app.request('/echo', { method: 'POST' })
    expect(r.status).toBe(403)
  })
})

describe('requireTrustedOrigin — bearer-only exemption applies to reads too', () => {
  it('allows a bearer-only GET with no Origin (native app suggestions fetch)', async () => {
    const app = await buildApp({
      allowedOrigins: ['https://app.example'],
      isProd: true,
      middleware: 'trusted',
    })
    const r = await app.request('/echo', {
      method: 'GET',
      headers: { Authorization: 'Bearer device.jwe.token' },
    })
    expect(r.status).toBe(200)
  })

  it('still gates a bearer GET that also carries a Cookie', async () => {
    const app = await buildApp({
      allowedOrigins: ['https://app.example'],
      isProd: true,
      middleware: 'trusted',
    })
    const r = await app.request('/echo', {
      method: 'GET',
      headers: { Authorization: 'Bearer device.jwe.token', Cookie: 'eex_session=abc' },
    })
    expect(r.status).toBe(403)
  })
})

// requireTrustedOrigin is the sibling that does NOT bypass GET/HEAD —
// used on the small set of read endpoints with server-side
// side-effects (e.g. the suggestions GET writes recently_shown via
// the local recommender). Without this, a hostile origin could fire
// a credentialed GET and poison a victim's recommendation rotation.
describe('requireTrustedOrigin — gates reads too', () => {
  it.each(['GET', 'HEAD', 'POST'])(
    'rejects %s with hostile Origin (403 bad_origin)',
    async (method) => {
      const app = await buildApp({
        allowedOrigins: ['https://app.example'],
        isProd: true,
        middleware: 'trusted',
      })
      const r = await app.request('/echo', {
        method,
        headers: { Origin: 'https://attacker.example' },
      })
      expect(r.status).toBe(403)
      // HEAD strips the body by spec — only assert reason on methods that
      // return one. The 403 alone proves the gate fired.
      if (method !== 'HEAD') {
        const json = (await r.json()) as { reason?: string }
        expect(json.reason).toBe('bad_origin')
      }
    },
  )

  it('rejects GET with no Origin header at all', async () => {
    const app = await buildApp({
      allowedOrigins: ['https://app.example'],
      isProd: true,
      middleware: 'trusted',
    })
    const r = await app.request('/echo', { method: 'GET' })
    expect(r.status).toBe(403)
  })

  it('allows GET when Origin matches the allowlist', async () => {
    const app = await buildApp({
      allowedOrigins: ['https://app.example'],
      isProd: true,
      middleware: 'trusted',
    })
    const r = await app.request('/echo', {
      method: 'GET',
      headers: { Origin: 'https://app.example' },
    })
    expect(r.status).toBe(200)
  })

  it('dev (isProd:false) with empty allowlist passes GETs through (same as requireSafeOrigin)', async () => {
    // Without this, the Vite dev proxy (same-origin, empty
    // ALLOWED_ORIGINS) would refuse local SPA reads of any
    // requireTrustedOrigin-protected route.
    const app = await buildApp({
      allowedOrigins: [],
      isProd: false,
      middleware: 'trusted',
    })
    const r = await app.request('/echo', { method: 'GET' })
    expect(r.status).toBe(200)
  })
})
