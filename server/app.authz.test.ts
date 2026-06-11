// App-level authN/authZ regression tests against the fully-wired app
// (server/app.ts), in the style of app.csrf.test.ts. The per-route test
// files mock requireAuth at the module boundary, so a refactor that DROPPED
// an auth gate from a mounted tree would still pass the whole route suite.
// This file is the backstop: a cookieless request to every protected tree
// must be rejected by the REAL middleware with 401 — never 200, and never
// Hono's unmounted-tree 404 (which would mean the tree silently fell off
// the app). Positive controls with a real session cookie prove the 401s
// come from the auth gate, not from a broken route.
//
// Upstream services (media-core, transcoder, SAB, Sonarr, Radarr) are
// stubbed via global fetch so the cookie'd controls never leave the test.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { Hono } from 'hono'

let app: Hono
let prevUseMediaCore: string | undefined

beforeAll(async () => {
  vi.resetModules()
  // Mount the /api/media + /api/transcode trees (gated on USE_MEDIA_CORE,
  // read by env.ts at import time — set BEFORE the dynamic import).
  prevUseMediaCore = process.env.USE_MEDIA_CORE
  process.env.USE_MEDIA_CORE = '1'
  const mod = await import('./app.js')
  app = mod.app
})

afterAll(() => {
  if (prevUseMediaCore === undefined) delete process.env.USE_MEDIA_CORE
  else process.env.USE_MEDIA_CORE = prevUseMediaCore
  vi.resetModules()
})

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ stubbed: true, items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function sessionCookie(role: 'admin' | 'user' = 'user') {
  // Real createSession so the cookie format matches prod. For admin the
  // username must be in the test-env ADMINS list ('admin-user') — the gate
  // recomputes the role from env.admins on every request.
  const { createSession } = await import('./session.js')
  const username = role === 'admin' ? 'admin-user' : 'user'
  const token = await createSession({ sub: '1', username, role })
  return `eex.session=${token}`
}

// --- Cookieless requests must 401 (not 200, not 404) -------------------

describe('app authz — cookieless requests to protected trees are 401', () => {
  const protectedGets: Array<{ label: string; path: string }> = [
    { label: '/api/me', path: '/api/me' },
    { label: '/api/media/movies', path: '/api/media/movies' },
    { label: '/api/media/shows', path: '/api/media/shows' },
    { label: '/api/media/watch', path: '/api/media/watch' },
    { label: '/api/transcode/sessions', path: '/api/transcode/sessions' },
    { label: '/api/sab/api?mode=queue', path: '/api/sab/api?mode=queue' },
    { label: '/api/sonarr/api/v3/series', path: '/api/sonarr/api/v3/series' },
    { label: '/api/radarr/api/v3/movie', path: '/api/radarr/api/v3/movie' },
    { label: '/api/iptv/live', path: '/api/iptv/live' },
    { label: '/api/users (admin tree)', path: '/api/users' },
  ]

  it.each(protectedGets)('GET $label → 401 from the real auth middleware', async ({ path }) => {
    const r = await app.request(path)
    // 404 would mean the tree fell off the app; 200 would mean the gate
    // fell off the tree. Both are regressions this file exists to catch.
    expect(r.status).toBe(401)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('unauthenticated')
  })

  it('POST /api/media/playback/movie/9 without a cookie → 401', async () => {
    // GETs bypass the Origin gate; this POST proves the playback-grant
    // surface itself authenticates (CSRF allows it in the no-allowedOrigins
    // test posture, so the 401 here is the auth gate, not bad_origin).
    const r = await app.request('/api/media/playback/movie/9', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containers: ['mp4'], video_codecs: ['h264'], hdr: false }),
    })
    expect(r.status).toBe(401)
  })
})

// --- Token-authed playback paths fail closed on forged tokens ----------

describe('app authz — forged ?t= stream tokens are rejected, not falling through', () => {
  it('GET /api/transcode/session/abc/index.m3u8?t=forged → 401', async () => {
    const r = await app.request('/api/transcode/session/abc/index.m3u8?t=forged')
    expect(r.status).toBe(401)
  })

  it('GET /api/media/stream/movie/9?t=forged → 401', async () => {
    const r = await app.request('/api/media/stream/movie/9?t=forged')
    expect(r.status).toBe(401)
  })
})

// --- Bearer must not fall through to cookie -----------------------------

describe('app authz — an invalid Bearer never falls back to cookie auth', () => {
  it('GET /api/sab with a garbage Bearer AND a valid cookie → 401 invalid_bearer', async () => {
    // requireAuth tries Bearer FIRST and must NOT fall through to the cookie
    // when the Bearer is present-but-invalid (a freshly-revoked device token
    // must not be rescued by a stolen cookie). /api/me is cookie-only by
    // design, so the pin lives on a requireAuth-gated route.
    const r = await app.request('/api/sab/api?mode=queue', {
      headers: {
        Authorization: 'Bearer not-a-real-device-token',
        Cookie: await sessionCookie('user'),
      },
    })
    expect(r.status).toBe(401)
    const body = (await r.json()) as { reason?: string }
    expect(body.reason).toBe('invalid_bearer')
  })
})

// --- Positive controls: the same paths work WITH a session --------------

describe('app authz — positive controls (the 401s above are the gate, not a broken route)', () => {
  it.each([
    { label: '/api/media/movies', path: '/api/media/movies' },
    { label: '/api/transcode/sessions', path: '/api/transcode/sessions' },
    { label: '/api/sab/api?mode=queue', path: '/api/sab/api?mode=queue' },
  ])('GET $label with a user cookie is not rejected by the gate', async ({ path }) => {
    const r = await app.request(path, {
      headers: { Cookie: await sessionCookie('user') },
    })
    // Upstream is stubbed to 200 — anything but 401/403 means the gate
    // admitted the session and the request reached the route handler.
    expect(r.status).not.toBe(401)
    expect(r.status).not.toBe(403)
  })

  it('GET /api/users with an ADMIN cookie passes both gates', async () => {
    const r = await app.request('/api/users', {
      headers: { Cookie: await sessionCookie('admin') },
    })
    expect(r.status).not.toBe(401)
    expect(r.status).not.toBe(403)
  })

  it('GET /api/users with a USER cookie is 403 admin_only (authZ distinct from authN)', async () => {
    const r = await app.request('/api/users', {
      headers: { Cookie: await sessionCookie('user') },
    })
    expect(r.status).toBe(403)
    const body = (await r.json()) as { reason?: string }
    expect(body.reason).toBe('admin_only')
  })
})
