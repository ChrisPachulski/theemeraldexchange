// Auth flow tests with a fully mocked plex.tv. Specifically asserts:
//  - role assignment from the ADMINS env var
//  - the server-membership gate when PLEX_SERVER_ID is set vs unset
//  - the discoveredServers payload that helps the operator find their
//    machineIdentifier on first run
//  - /api/me round-trip (401 → set cookie → 200)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { auth, me, _resetAuthRateLimitsForTests } from './auth.js'
import { env } from './env.js'
import { createSession } from './session.js'
import {
  _primeSessionGateCache,
  _resetSessionGateCacheForTests,
} from './services/sessionGate.js'

function app() {
  const a = new Hono()
  a.route('/auth', auth)
  a.route('/me', me)
  return a
}

beforeEach(() => {
  // Clean any prior PLEX_SERVER_ID so different tests can flip it on
  // by mutating env directly. (We mutate the const-asserted object via
  // a cast — fine for tests, ugly in prod.)
  ;(env as Record<string, unknown>).plexServerId = null
  // sessionGate's membership cache is module-scoped — clear between
  // tests so the revoked-access tests below don't carry primed state
  // into the next case.
  _resetSessionGateCacheForTests()
  _resetAuthRateLimitsForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubPlex(opts: {
  pinId?: number
  authToken?: string | null
  username?: string
  resources?: Array<{ name: string; clientIdentifier: string; owned: boolean; provides: string }>
}) {
  const {
    pinId = 12345,
    authToken = null,
    username = 'test-user',
    resources = [],
  } = opts
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      if (url.startsWith('https://plex.tv/api/v2/pins/') && url.endsWith(`/${pinId}`) === false) {
        // GET /pins/:id
        return new Response(JSON.stringify({ id: pinId, code: 'abc', authToken }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/v2/pins/' + pinId)) {
        return new Response(JSON.stringify({ id: pinId, code: 'abc', authToken }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/v2/pins')) {
        // POST /pins
        return new Response(JSON.stringify({ id: pinId, code: 'abc', authToken: null }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/v2/user')) {
        return new Response(
          JSON.stringify({
            id: 999,
            uuid: 'uuid-999',
            username,
            email: `${username}@example.com`,
            thumb: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/v2/resources')) {
        return new Response(JSON.stringify(resources), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not stubbed: ' + url, { status: 599 })
    }),
  )
}

describe('POST /auth/plex/pin', () => {
  it('returns pin id, code, and a properly-formatted authUrl', async () => {
    stubPlex({})
    const r = await app().request('/auth/plex/pin', { method: 'POST' })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { pinId: number; code: string; authUrl: string }
    expect(body.pinId).toBe(12345)
    expect(body.code).toBe('abc')
    expect(body.authUrl).toContain('https://app.plex.tv/auth#?')
    expect(body.authUrl).toContain('clientID=' + env.plexClientId)
    expect(body.authUrl).toContain('code=abc')
  })

  it('rate-limits excessive PIN creation by client IP', async () => {
    stubPlex({})
    const headers = { 'x-forwarded-for': '203.0.113.10' }
    for (let i = 0; i < 10; i++) {
      const r = await app().request('/auth/plex/pin', { method: 'POST', headers })
      expect(r.status).toBe(200)
    }
    const r = await app().request('/auth/plex/pin', { method: 'POST', headers })
    expect(r.status).toBe(429)
    expect(await r.json()).toEqual({ error: 'rate_limited' })
  })
})

describe('POST /auth/plex/check', () => {
  it('returns pending while plex.tv hasn\'t set authToken yet', async () => {
    stubPlex({ authToken: null })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'pending' })
  })

  it('allows normal polling but rate-limits excessive PIN checks by client IP', async () => {
    stubPlex({ authToken: null })
    const headers = { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.11' }
    for (let i = 0; i < 60; i++) {
      const r = await app().request('/auth/plex/check', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pinId: 12345 }),
      })
      expect(r.status).toBe(200)
    }
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers,
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(429)
    expect(await r.json()).toEqual({ error: 'rate_limited' })
  })

  it('400s a missing pinId', async () => {
    const r = await app().request('/auth/plex/check', { method: 'POST' })
    expect(r.status).toBe(400)
  })

  it('400s a non-numeric pinId', async () => {
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 'foo' }),
    })
    expect(r.status).toBe(400)
  })

  it('400s a query-string pinId', async () => {
    const r = await app().request('/auth/plex/check?pinId=12345', { method: 'POST' })
    expect(r.status).toBe(400)
  })

  it('promotes ADMINS-listed username to admin role', async () => {
    stubPlex({ authToken: 'real-token', username: 'admin-user' })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      status?: string
      reason?: string
      user: { username: string; role: string }
      discoveredServers?: { name: string; id: string; owned: boolean }[]
    }
    expect(body.status).toBe('authorized')
    expect(body.user.role).toBe('admin')
    expect(r.headers.get('set-cookie')).toContain('eex.session=')
  })

  it('assigns user role to non-listed usernames', async () => {
    stubPlex({ authToken: 'real-token', username: 'random-guest' })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    const body = (await r.json()) as {
      status?: string
      reason?: string
      user: { username: string; role: string }
      discoveredServers?: { name: string; id: string; owned: boolean }[]
    }
    expect(body.user.role).toBe('user')
  })

  it('blocks non-members of PLEX_SERVER_ID with 403', async () => {
    ;(env as Record<string, unknown>).plexServerId = 'home-server-machine-id'
    stubPlex({
      authToken: 'real-token',
      username: 'random-guest',
      resources: [
        // Only some unrelated server, NOT the home server
        {
          name: 'Other Server',
          clientIdentifier: 'some-other-machine-id',
          owned: false,
          provides: 'server',
        },
      ],
    })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ status: 'denied', reason: 'not_a_server_member' })
  })

  it('admits members of PLEX_SERVER_ID', async () => {
    ;(env as Record<string, unknown>).plexServerId = 'home-server-machine-id'
    stubPlex({
      authToken: 'real-token',
      username: 'random-guest',
      resources: [
        {
          name: 'The Home Server',
          clientIdentifier: 'home-server-machine-id',
          owned: false,
          provides: 'server',
        },
      ],
    })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      status?: string
      reason?: string
      user: { username: string; role: string }
      discoveredServers?: { name: string; id: string; owned: boolean }[]
    }
    expect(body.status).toBe('authorized')
  })

  it('returns discoveredServers when PLEX_SERVER_ID is unset (first-run aid)', async () => {
    ;(env as Record<string, unknown>).plexServerId = null
    stubPlex({
      authToken: 'real-token',
      username: 'admin-user',
      resources: [
        { name: 'My NAS', clientIdentifier: 'nas-id', owned: true, provides: 'server' },
        { name: 'Friend\'s', clientIdentifier: 'friend-id', owned: false, provides: 'server' },
        // Non-server resources should be filtered out
        { name: 'Some Player', clientIdentifier: 'player-id', owned: false, provides: 'player' },
      ],
    })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      status?: string
      reason?: string
      user: { username: string; role: string }
      discoveredServers?: { name: string; id: string; owned: boolean }[]
    }
    expect(body.discoveredServers).toEqual([
      { name: 'My NAS', id: 'nas-id', owned: true },
      { name: "Friend's", id: 'friend-id', owned: false },
    ])
  })
})

describe('GET /me + POST /auth/logout', () => {
  it('returns 401 without a session', async () => {
    const r = await app().request('/me')
    expect(r.status).toBe(401)
  })

  it('returns the user after a successful pin check (round-trip)', async () => {
    stubPlex({ authToken: 'real-token', username: 'admin-user' })
    const r1 = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    const cookie = r1.headers.get('set-cookie')!
    const sessionCookie = cookie.split(';')[0]

    const r2 = await app().request('/me', {
      headers: { Cookie: sessionCookie },
    })
    expect(r2.status).toBe(200)
    const body = (await r2.json()) as { user: { username: string; role: string } }
    expect(body.user.username).toBe('admin-user')
    expect(body.user.role).toBe('admin')
  })

  it('logout clears the cookie', async () => {
    const r = await app().request('/auth/logout', { method: 'POST' })
    expect(r.status).toBe(200)
    const setCookie = r.headers.get('set-cookie') ?? ''
    // deleteCookie sets Max-Age=0
    expect(setCookie.toLowerCase()).toMatch(/max-age=0|expires=/)
  })

  it('/me 401s + clears the cookie when membership has been revoked', async () => {
    // Reads of /api/me used to bypass the reconcile pipeline that every
    // protected route already runs through, so a revoked user could
    // keep the SPA in a signed-in state until they tried a protected
    // action. Now /me runs the same reconcileSession + clearSessionCookie
    // path and surfaces the revoke immediately. Set up: a configured
    // Plex gate, a session whose membership cache says not_member,
    // confirms /me returns 401 with access_revoked AND drops the cookie.
    ;(env as Record<string, unknown>).plexServerId = 'home-machine-id'
    const token = await createSession({
      sub: '777',
      username: 'admin-user',
      role: 'admin',
      plexAuthToken: 'still-valid-but-no-longer-a-member',
    })
    _primeSessionGateCache('777', 'not_member')
    const r = await app().request('/me', {
      headers: { Cookie: `eex.session=${token}` },
    })
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({
      error: 'unauthenticated',
      reason: 'access_revoked',
    })
    const setCookie = (r.headers.get('set-cookie') ?? '').toLowerCase()
    expect(setCookie).toMatch(/eex\.session=/)
    expect(setCookie).toMatch(/max-age=0|expires=/)
  })

  it('/me reflects the recomputed role on the next call after an ADMINS demotion', async () => {
    // Cookie says 'admin' (issued when the user was in ADMINS), then
    // the operator edits ADMINS to drop them. /me must reflect the
    // recomputed 'user' role on the next call rather than echoing the
    // stale role from the cookie.
    const token = await createSession({
      sub: '555',
      username: 'admin-user',
      role: 'admin',
      plexAuthToken: 'token-555',
    })
    // Snapshot, demote, restore at end of test.
    const adminsBefore = env.admins
    ;(env as Record<string, unknown>).admins = []
    try {
      const r = await app().request('/me', {
        headers: { Cookie: `eex.session=${token}` },
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { user: { role: string } }
      expect(body.user.role).toBe('user')
    } finally {
      ;(env as Record<string, unknown>).admins = adminsBefore
    }
  })
})
