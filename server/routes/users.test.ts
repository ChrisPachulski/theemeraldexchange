// /api/users — admin-only. Merges five Plex sources behind the scenes:
//   - plex.tv /api/v2/user                (owner)
//   - plex.tv /api/users (XML)            (accepted)
//   - plex.tv /api/servers/{id}/shared_servers (XML)
//   - plex.tv /api/home/users (XML)
//   - local PMS /accounts (XML)
//   - plex.tv /api/v2/friends/requested  (pending)
//
// Tests cover gating, the no_plex_token branch, the happy merge, and
// the failure paths (owner /user blowing up → 502; best-effort sources
// erroring → still returns owner + accepted). An old ?debug=1 raw-dump
// branch was removed for leaking upstream Plex account metadata.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { users } from './users.js'
import { createSession } from '../session.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', users)
  return app
}

async function adminCookie(opts: { withPlexToken?: boolean } = {}) {
  const t = await createSession({
    sub: '1',
    username: 'admin-user',
    role: 'admin',
    plexAuthToken: opts.withPlexToken === false ? undefined : 'plex-owner-token',
  })
  return `eex.session=${t}`
}
async function userCookie() {
  const t = await createSession({ sub: '2', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

type Stub = { status: number; body: string; contentType?: string }
const responses = new Map<string, Stub>()
const errorsByNeedle = new Map<string, Error>()

beforeEach(() => {
  responses.clear()
  errorsByNeedle.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      for (const [needle, err] of errorsByNeedle) {
        if (url.includes(needle)) throw err
      }
      for (const [needle, stub] of responses) {
        if (url.includes(needle)) {
          return new Response(stub.body, {
            status: stub.status,
            headers: { 'Content-Type': stub.contentType ?? 'application/json' },
          })
        }
      }
      return new Response('not stubbed: ' + url, { status: 599 })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

function stubJson(needle: string, body: unknown, status = 200) {
  responses.set(needle, { status, body: JSON.stringify(body), contentType: 'application/json' })
}
function stubXml(needle: string, body: string, status = 200) {
  responses.set(needle, { status, body, contentType: 'application/xml' })
}

const OWNER_BODY = {
  id: 1,
  uuid: 'owner-uuid',
  username: 'admin-user',
  email: 'admin@example.com',
  thumb: 'https://example.com/me.jpg',
}

function stubAllHappy() {
  stubJson('plex.tv/api/v2/user', OWNER_BODY)
  // Two accepted users in the legacy XML feed
  stubXml(
    'plex.tv/api/users',
    `<MediaContainer>
      <User id="10" username="alice" title="Alice" email="alice@example.com" thumb="t" />
      <User id="11" username="bob" title="Bob" email="bob@example.com" />
    </MediaContainer>`,
  )
  // No PLEX_SERVER_ID is set in the test env, so listSharedServerInvitees
  // short-circuits to [] without making a request. Same for home users
  // happy path — we just stub them to empty XML so they parse cleanly.
  stubXml('plex.tv/api/home/users', '<MediaContainer></MediaContainer>')
  stubXml('/accounts?', '<MediaContainer></MediaContainer>')
  // One pending invite
  stubJson('plex.tv/api/v2/friends/requested', [
    { id: 99, username: 'carol', title: 'Carol', email: 'carol@example.com' },
  ])
}

describe('users — gates', () => {
  it('rejects unauthenticated with 401', async () => {
    const r = await appUnderTest().request('/')
    expect(r.status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects user role with 403 admin_only', async () => {
    const r = await appUnderTest().request('/', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'forbidden', reason: 'admin_only' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('admin without plexAuthToken → 409 no_plex_token', async () => {
    const r = await appUnderTest().request('/', {
      headers: { Cookie: await adminCookie({ withPlexToken: false }) },
    })
    expect(r.status).toBe(409)
    const body = (await r.json()) as { error: string; message: string }
    expect(body.error).toBe('no_plex_token')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('users — ?debug=1 no longer exposes a raw dump', () => {
  it('returns the normal merged shape, not a { sources } dump', async () => {
    // The old debug branch leaked raw upstream Plex responses (emails,
    // ids, share permissions). It was removed — the query param should
    // now be inert and return the same shape as `/`.
    stubAllHappy()
    const r = await appUnderTest().request('/?debug=1', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as Record<string, unknown> & {
      users?: Array<{ username: string; relation: string }>
    }
    expect(body).not.toHaveProperty('sources')
    expect(Array.isArray(body.users)).toBe(true)
    expect(body.users?.[0]).toMatchObject({
      username: 'admin-user',
      relation: 'owner',
    })
  })
})

describe('users — happy merge', () => {
  it('returns owner first then merged friends', async () => {
    stubAllHappy()
    const r = await appUnderTest().request('/', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      users: Array<{
        id: number
        username: string
        role: 'admin' | 'user'
        relation: 'owner' | 'friend'
        status: 'accepted' | 'pending'
      }>
    }
    expect(body.users[0]).toMatchObject({
      id: 1,
      username: 'admin-user',
      relation: 'owner',
      status: 'accepted',
      role: 'admin', // matches ADMINS env var
    })
    const others = body.users.slice(1)
    const usernames = others.map((u) => u.username).sort()
    expect(usernames).toEqual(['alice', 'bob', 'carol'])
    const carol = others.find((u) => u.username === 'carol')
    expect(carol?.status).toBe('pending')
    expect(carol?.relation).toBe('friend')
    expect(others.every((u) => u.role === 'user')).toBe(true)
  })

  it('best-effort sources errors are tolerated; owner + accepted still returned', async () => {
    stubJson('plex.tv/api/v2/user', OWNER_BODY)
    stubXml(
      'plex.tv/api/users',
      `<MediaContainer><User id="10" username="alice" title="Alice" /></MediaContainer>`,
    )
    // Force each best-effort source to throw — the route should swallow
    // and still produce { users: [owner, alice] }.
    errorsByNeedle.set('plex.tv/api/home/users', new Error('home blew up'))
    errorsByNeedle.set('/accounts?', new Error('pms refused'))
    errorsByNeedle.set('plex.tv/api/v2/friends/requested', new Error('pending broke'))
    const r = await appUnderTest().request('/', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { users: Array<{ username: string }> }
    expect(body.users[0].username).toBe('admin-user')
    expect(body.users.find((u) => u.username === 'alice')).toBeTruthy()
  })

  it('hard failure on /api/users (not best-effort) → 502 plex_lookup_failed', async () => {
    // /api/v2/user failing is treated as fatal — listAcceptedUsers throws
    // and the try/catch wraps it in a 502.
    stubJson('plex.tv/api/v2/user', { error: 'down' }, 500)
    const r = await appUnderTest().request('/', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('plex_lookup_failed')
  })
})
