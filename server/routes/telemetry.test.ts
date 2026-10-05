// /api/telemetry/config — §15.2 DSN distribution. The route makes NO
// network calls of its own; the only branches are the requireAuth gate
// and the EEX_TELEMETRY_DSN validation ladder (missing → 503,
// unparseable URL → 500, non-http(s) scheme → 500, valid → 200 with
// environment derived from env.isProd and release echoed from
// EEX_RELEASE).
//
// env (server/env.ts) is a plain mutable object literal, so each test
// mutates the three telemetry-relevant fields directly and restores the
// captured originals in afterEach. Leaking any of these into a sibling
// test file has burned this loop before (commit 8d1d418), hence the
// strict restore.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { telemetry } from './telemetry.js'
import { createSession } from '../session.js'
import { env } from '../env.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', telemetry)
  return app
}

// sub '1' (bare-numeric Plex namespace) + admin reconciles cleanly via
// the members allowlist without ever probing plex.tv: createSession does
// not attach a plexAuthToken, so reconcileSession's plex probe branch
// (`!session.plexAuthToken`) is skipped entirely. This mirrors the
// working pattern in notifications.test.ts.
async function authCookie() {
  const t = await createSession({ sub: 'plex:1', username: 'admin-user', role: 'admin' })
  return `eex.session=${t}`
}

const ORIG = {
  dsn: env.EEX_TELEMETRY_DSN,
  dsnInternal: env.EEX_TELEMETRY_DSN_INTERNAL,
  isProd: env.isProd,
  release: env.EEX_RELEASE,
}

afterEach(() => {
  ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = ORIG.dsn
  ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN_INTERNAL = ORIG.dsnInternal
  vi.unstubAllGlobals()
  ;(env as Record<string, unknown>).isProd = ORIG.isProd
  ;(env as Record<string, unknown>).EEX_RELEASE = ORIG.release
})

const VALID_DSN = 'https://abc123def456@glitchtip.example.com/42'

describe('telemetry GET /config — public bootstrap', () => {
  it('returns the non-secret DSN before authentication', async () => {
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = VALID_DSN
    const res = await appUnderTest().request('/config')
    expect(res.status).toBe(200)
    expect((await res.json() as { dsn: string }).dsn).toBe(VALID_DSN)
  })
})

describe('telemetry GET /config — DSN validation ladder', () => {
  it('503 telemetry_not_configured when EEX_TELEMETRY_DSN is null', async () => {
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = null
    const res = await appUnderTest().request('/config', {
      headers: { cookie: await authCookie() },
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('telemetry_not_configured')
    expect(body.detail).toContain('EEX_TELEMETRY_DSN')
  })

  it('503 telemetry_not_configured when EEX_TELEMETRY_DSN is the empty string', async () => {
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = ''
    const res = await appUnderTest().request('/config', {
      headers: { cookie: await authCookie() },
    })
    expect(res.status).toBe(503)
    expect((await res.json() as { error: string }).error).toBe('telemetry_not_configured')
  })

  it('500 telemetry_dsn_invalid when the DSN does not parse as a URL', async () => {
    // A bare token with spaces and stray colons throws in `new URL(...)`.
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = '::::not a url::::'
    const res = await appUnderTest().request('/config', {
      headers: { cookie: await authCookie() },
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('telemetry_dsn_invalid')
    expect(body.detail).toContain('valid URL')
  })

  it('500 telemetry_dsn_invalid when the DSN parses but uses a non-http(s) scheme', async () => {
    // This is the SEPARATE `!['http:','https:'].includes(...)` guard — the
    // value is a well-formed URL (new URL does NOT throw) but the scheme
    // is rejected, with the received scheme echoed in detail.
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = 'ftp://abc123@glitchtip.example.com/42'
    const res = await appUnderTest().request('/config', {
      headers: { cookie: await authCookie() },
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('telemetry_dsn_invalid')
    expect(body.detail).toContain('http or https')
    expect(body.detail).toContain('ftp:')
  })
})

describe('telemetry GET /config — happy paths', () => {
  it('200 with environment=staging when env.isProd is false', async () => {
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = VALID_DSN
    ;(env as Record<string, unknown>).isProd = false
    ;(env as Record<string, unknown>).EEX_RELEASE = 'dev'
    const res = await appUnderTest().request('/config', {
      headers: { cookie: await authCookie() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dsn: string; environment: string; release: string }
    expect(body.dsn).toBe(VALID_DSN)
    expect(body.environment).toBe('staging')
    expect(body.release).toBe('dev')
  })

  it('200 with environment=production when env.isProd is true', async () => {
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = VALID_DSN
    ;(env as Record<string, unknown>).isProd = true
    const res = await appUnderTest().request('/config', {
      headers: { cookie: await authCookie() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dsn: string; environment: string }
    expect(body.dsn).toBe(VALID_DSN)
    expect(body.environment).toBe('production')
  })

  it('echoes env.EEX_RELEASE verbatim in the 200 body', async () => {
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = VALID_DSN
    ;(env as Record<string, unknown>).isProd = false
    ;(env as Record<string, unknown>).EEX_RELEASE = 'test-release-123'
    const res = await appUnderTest().request('/config', {
      headers: { cookie: await authCookie() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { release: string }
    expect(body.release).toBe('test-release-123')
  })

  it('accepts an http: (non-https) DSN — both schemes pass the guard', async () => {
    const httpDsn = 'http://abc123@glitchtip.example.com/42'
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = httpDsn
    ;(env as Record<string, unknown>).isProd = false
    const res = await appUnderTest().request('/config', {
      headers: { cookie: await authCookie() },
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { dsn: string }).dsn).toBe(httpDsn)
  })
})

describe('telemetry POST /tunnel — SPA envelope relay', () => {
  const envelope = (dsn: string) =>
    `${JSON.stringify({ dsn, sent_at: '2026-10-04T00:00:00Z' })}\n{"type":"event"}\n{"message":"boom"}`

  function useDsns() {
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = VALID_DSN
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN_INTERNAL = 'http://abc123def456@glitchtip-internal:8000/42'
  }

  it('forwards an envelope for our DSN to the internal envelope endpoint', async () => {
    useDsns()
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const body = envelope(VALID_DSN)
    const res = await appUnderTest().request('/tunnel', { method: 'POST', body })
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('http://glitchtip-internal:8000/api/42/envelope/')
    expect(init.body).toBe(body)
  })

  it('refuses an envelope addressed to a different DSN', async () => {
    useDsns()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await appUnderTest().request('/tunnel', {
      method: 'POST',
      body: envelope('https://otherkey@evil.example.com/42'),
    })
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body that is not an envelope', async () => {
    useDsns()
    const res = await appUnderTest().request('/tunnel', { method: 'POST', body: 'not json' })
    expect(res.status).toBe(400)
  })

  it('503s when telemetry is not configured', async () => {
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN = null
    ;(env as Record<string, unknown>).EEX_TELEMETRY_DSN_INTERNAL = null
    const res = await appUnderTest().request('/tunnel', { method: 'POST', body: envelope(VALID_DSN) })
    expect(res.status).toBe(503)
  })
})
