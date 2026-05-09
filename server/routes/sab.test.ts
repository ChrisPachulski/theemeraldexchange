// SAB is the trickiest router because permissioning is per-query-param
// (mode + name). Specifically:
//  - mode=queue, no name      → read, both roles
//  - mode=history             → read, both roles
//  - mode=queue, name=pause   → admin only
//  - mode=queue, name=resume  → admin only
//  - mode=queue, name=delete  → admin only
//  - anything else            → 404
//
// A regression in the dispatch logic (e.g. allowing name=foo through)
// would mean undeclared SAB actions could be triggered by users.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { sab } from './sab.js'
import { createSession } from '../session.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', sab)
  return app
}

async function adminCookie() {
  const t = await createSession({ sub: '1', username: 'admin-user', role: 'admin' })
  return `eex.session=${t}`
}
async function userCookie() {
  const t = await createSession({ sub: '2', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('sab reads (any authed role)', () => {
  it('user can fetch the queue', async () => {
    const r = await appUnderTest().request('/api?mode=queue', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
  })

  it('user can fetch history', async () => {
    const r = await appUnderTest().request('/api?mode=history&limit=5', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
  })

  it('rejects unauthenticated', async () => {
    const r = await appUnderTest().request('/api?mode=queue')
    expect(r.status).toBe(401)
  })
})

describe('sab mutations (admin only)', () => {
  it.each(['pause', 'resume', 'delete'])(
    'rejects user role for name=%s with 403 admin_only',
    async (name) => {
      const r = await appUnderTest().request(`/api?mode=queue&name=${name}&value=foo`, {
        headers: { Cookie: await userCookie() },
      })
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({
        error: 'forbidden',
        reason: 'admin_only',
      })
      // Critically: never reached SAB
      expect(globalThis.fetch).not.toHaveBeenCalled()
    },
  )

  it.each(['pause', 'resume', 'delete'])(
    'allows admin role for name=%s',
    async (name) => {
      const r = await appUnderTest().request(`/api?mode=queue&name=${name}&value=foo`, {
        headers: { Cookie: await adminCookie() },
      })
      expect(r.status).toBe(200)
    },
  )

  it('rejects mode=queue+name=delete without value with 400', async () => {
    const r = await appUnderTest().request(`/api?mode=queue&name=delete`, {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
  })
})

describe('sab undeclared modes / names', () => {
  it('returns 404 for an unknown mode', async () => {
    const r = await appUnderTest().request(`/api?mode=shutdown`, {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown name on mode=queue', async () => {
    // This is the exact attack vector we're testing — does name=foo
    // sneak through into a forwarded SAB call?
    const r = await appUnderTest().request(`/api?mode=queue&name=foo&value=x`, {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns 404 for a non-/api path', async () => {
    const r = await appUnderTest().request(`/something-else`, {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
  })
})
