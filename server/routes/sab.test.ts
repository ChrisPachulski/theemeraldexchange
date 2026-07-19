// SAB router permissioning + CSRF-safe method shape.
//   GET  /api?mode=queue                       - read, both roles
//   GET  /api?mode=history                     - read, both roles
//   POST /api/queue/:nzoId/pause               - admin only
//   POST /api/queue/:nzoId/resume              - admin only
//   DELETE /api/queue/:nzoId                   - admin only
//
// Reads stay on GET so the SPA can poll without preflight. Mutations
// moved to POST/DELETE so an attacker page can't forge them via
// cross-origin <img>/link tags (browsers won't issue POST/DELETE
// cross-origin without a preflight that our CORS gate blocks).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { sab } from './sab.js'
import { createMemberSession as createSession } from '../test/authFixture.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', sab)
  return app
}

async function adminCookie() {
  const t = await createSession({ sub: 'plex:1', username: 'admin-user', role: 'admin' })
  return `eex.session=${t}`
}
async function userCookie() {
  const t = await createSession({ sub: 'plex:2', username: 'guest', role: 'user' })
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
  const mutations: Array<{ name: string; method: 'POST' | 'DELETE'; path: string }> = [
    { name: 'pause', method: 'POST', path: '/api/queue/foo/pause' },
    { name: 'resume', method: 'POST', path: '/api/queue/foo/resume' },
    { name: 'delete', method: 'DELETE', path: '/api/queue/foo' },
  ]

  it.each(mutations)('rejects user role for $name with 403 admin_only', async ({ method, path }) => {
    const r = await appUnderTest().request(path, {
      method,
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({
      error: 'forbidden',
      reason: 'admin_only',
    })
    // Critically: never reached SAB
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it.each(mutations)('allows admin role for $name', async ({ method, path }) => {
    const r = await appUnderTest().request(path, {
      method,
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
  })

  it('rejects GET on a mutation path (read-only method on mutation route)', async () => {
    const r = await appUnderTest().request('/api/queue/foo/pause', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('sab undeclared modes / names', () => {
  it('returns 404 for an unknown read mode', async () => {
    const r = await appUnderTest().request(`/api?mode=shutdown`, {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects the legacy GET-mutation surface (mode=queue&name=pause)', async () => {
    // This is the exact attack vector — pre-fix, an admin who clicked
    // an attacker's <img src="...?mode=queue&name=pause"> would pause
    // their own queue. Now: mutations require POST/DELETE only.
    const r = await appUnderTest().request(`/api?mode=queue&name=pause&value=x`, {
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
