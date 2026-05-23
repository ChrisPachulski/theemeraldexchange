// End-to-end CSRF tests against the fully-wired app (server/app.ts).
// The middleware unit tests (middleware/csrf.test.ts) prove the gate
// behavior in isolation; this file proves it's actually applied at
// the prod app composition layer — i.e. that nothing in the route-
// mount sequence accidentally bypasses or short-circuits it.
//
// The matrix:
//   - safe GETs (e.g. /api/health, /api/me, /api/sab/api?mode=queue)
//     pass through with any/no Origin.
//   - state-changing requests (POST/PUT/PATCH/DELETE) require an
//     Origin from env.allowedOrigins. Bad/missing → 403 bad_origin.
//   - this includes /api/auth/logout, SAB mutation routes,
//     Sonarr/Radarr DELETE, feedback POST/DELETE, rejections POST/DELETE.
//
// Routes that hit upstream services (Sonarr, Radarr, plex.tv, etc.)
// get a global fetch stub so the test doesn't accidentally call them.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { Hono } from 'hono'

const ALLOWED = 'https://app.example.test'
const HOSTILE = 'https://attacker.example.test'

let app: Hono

beforeAll(async () => {
  vi.resetModules()
  // Build a complete env stand-in so we don't have to importActual (which
  // can recurse with vi.doMock'd specifier). The shape mirrors env.ts.
  const GB = 1024 * 1024 * 1024
  vi.doMock('./env.js', () => ({
    env: {
      plexClientId: 'test-client',
      sessionSecret: process.env.SESSION_SECRET ?? 'test-secret',
      admins: [],
      plexServerId: null,
      port: 3001,
      isProd: true,
      allowedOrigins: [ALLOWED],
      plexServerUrl: 'http://upstream-plex.test',
      sonarrUrl: 'http://upstream-sonarr.test',
      sonarrApiKey: 'k',
      radarrUrl: 'http://upstream-radarr.test',
      radarrApiKey: 'k',
      sabUrl: 'http://upstream-sab.test',
      sabApiKey: 'k',
      minFreeBytes: 100 * GB,
      maxMovieBytes: 10 * GB,
      maxMovieGb: 10,
      maxTvBytesPerEpisode: 5 * GB,
      maxTvGbPerEpisode: 5,
      rejectionsPath: './data/rejections.json',
      userFeedbackPath: './data/user-feedback.json',
      usageLogPath: './data/usage.jsonl',
      grabLogPath: './data/grabs.jsonl',
      tmdbApiKey: null,
      useLocalRecommender: false,
      recommenderUrl: 'http://recommender:8000',
    },
  }))
  const mod = await import('./app.js')
  app = mod.app
})

afterAll(() => {
  vi.doUnmock('./env.js')
  vi.resetModules()
})

beforeEach(() => {
  // Catch-all so any upstream fetch the routes try to make won't reach
  // a real service. Real interactions are unit-tested elsewhere.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ stubbed: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function sessionCookie(role: 'admin' | 'user' = 'admin') {
  // Use the real createSession so the cookie format matches prod.
  const { createSession } = await import('./session.js')
  const token = await createSession({ sub: '1', username: 'user', role })
  return `eex.session=${token}`
}

// --- Safe GETs --------------------------------------------------------

describe('app CSRF — safe GETs pass through', () => {
  it('/api/health works with no Origin', async () => {
    const r = await app.request('/api/health')
    expect(r.status).toBe(200)
  })

  it('/api/health works with a hostile Origin', async () => {
    const r = await app.request('/api/health', {
      headers: { Origin: HOSTILE },
    })
    expect(r.status).toBe(200)
  })

  it('/api/limits works with no Origin', async () => {
    const r = await app.request('/api/limits')
    expect(r.status).toBe(200)
  })

  it('/api/me works with a hostile Origin (and 401s for the right reason)', async () => {
    // No session cookie → 401 unauthenticated, NOT 403 bad_origin. GET
    // never goes through the Origin gate.
    const r = await app.request('/api/me', {
      headers: { Origin: HOSTILE },
    })
    expect(r.status).toBe(401)
  })

  it('/api/sab/api?mode=queue (read) works with a session and hostile Origin', async () => {
    const r = await app.request('/api/sab/api?mode=queue', {
      headers: { Cookie: await sessionCookie('user'), Origin: HOSTILE },
    })
    expect(r.status).toBe(200)
  })
})

// --- State-changing routes with bad Origin should ALL be rejected ----

describe('app CSRF — state-changing routes reject bad Origin', () => {
  const cases: Array<{ label: string; method: string; path: string; body?: string }> = [
    { label: 'POST /api/auth/logout', method: 'POST', path: '/api/auth/logout' },
    { label: 'POST /api/sab/api/queue/foo/pause', method: 'POST', path: '/api/sab/api/queue/foo/pause' },
    { label: 'POST /api/sab/api/queue/foo/resume', method: 'POST', path: '/api/sab/api/queue/foo/resume' },
    { label: 'DELETE /api/sab/api/queue/foo', method: 'DELETE', path: '/api/sab/api/queue/foo' },
    { label: 'DELETE /api/radarr/api/v3/movie/42', method: 'DELETE', path: '/api/radarr/api/v3/movie/42' },
    { label: 'DELETE /api/sonarr/api/v3/series/42', method: 'DELETE', path: '/api/sonarr/api/v3/series/42' },
    {
      label: 'POST /api/feedback',
      method: 'POST',
      path: '/api/feedback',
      body: JSON.stringify({ type: 'movie', tmdbId: 1, signal: 'like' }),
    },
    { label: 'DELETE /api/feedback/movie/1/like', method: 'DELETE', path: '/api/feedback/movie/1/like' },
    {
      label: 'POST /api/rejections',
      method: 'POST',
      path: '/api/rejections',
      body: JSON.stringify({ type: 'movie', tmdbId: 1 }),
    },
    { label: 'DELETE /api/rejections/movie/1', method: 'DELETE', path: '/api/rejections/movie/1' },
  ]

  it.each(cases)('$label rejects HOSTILE Origin with 403 bad_origin', async ({ method, path, body }) => {
    const r = await app.request(path, {
      method,
      headers: {
        Cookie: await sessionCookie('admin'),
        Origin: HOSTILE,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    })
    expect(r.status).toBe(403)
    const json = (await r.json()) as { reason?: string }
    expect(json.reason).toBe('bad_origin')
  })

  it.each(cases)('$label rejects MISSING Origin with 403 bad_origin', async ({ method, path, body }) => {
    // A same-origin browser POST always sets Origin too. Missing Origin
    // means the request didn't come from a browser tab on our SPA —
    // fail closed.
    const r = await app.request(path, {
      method,
      headers: {
        Cookie: await sessionCookie('admin'),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    })
    expect(r.status).toBe(403)
    const json = (await r.json()) as { reason?: string }
    expect(json.reason).toBe('bad_origin')
  })
})

// --- State-changing routes with allowed Origin pass the gate ----

describe('app CSRF — state-changing routes accept allowed Origin', () => {
  it('POST /api/auth/logout with allowed Origin succeeds', async () => {
    // Logout doesn't need a session — it just clears the cookie.
    const r = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Origin: ALLOWED },
    })
    expect(r.status).toBe(200)
  })

  it('DELETE /api/radarr/api/v3/movie/42 with allowed Origin passes the CSRF gate', async () => {
    // Reaches the route handler — upstream Radarr is stubbed.
    const r = await app.request('/api/radarr/api/v3/movie/42', {
      method: 'DELETE',
      headers: {
        Cookie: await sessionCookie('admin'),
        Origin: ALLOWED,
      },
    })
    // Not 403 — the CSRF gate let it through. (Status from the stubbed
    // upstream is 200, which the route forwards as the body.)
    expect(r.status).not.toBe(403)
  })
})
