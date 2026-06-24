// requireAuth + requireAdmin are run on every protected route. A
// regression here is a security bug, so the tests explicitly hit:
//  - no cookie at all
//  - tampered cookie
//  - valid user cookie against an admin-only route
//  - valid admin cookie against an admin-only route

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from './auth.js'
import { createSession } from '../session.js'

function appWithRoutes() {
  const app = new Hono<Env>()
  app.get('/needs-auth', requireAuth, (c) => {
    const s = c.get('session')
    return c.json({ user: s.username, role: s.role })
  })
  app.get('/needs-admin', requireAdmin, (c) => {
    const s = c.get('session')
    return c.json({ user: s.username })
  })
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

describe('requireAuth', () => {
  it('rejects requests with no cookie', async () => {
    const app = appWithRoutes()
    const r = await app.request('/needs-auth')
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: 'unauthenticated' })
  })

  it('rejects requests with an invalid cookie', async () => {
    const app = appWithRoutes()
    const r = await app.request('/needs-auth', {
      headers: { Cookie: 'eex.session=garbage' },
    })
    expect(r.status).toBe(401)
  })

  it('passes a valid user cookie through and exposes session via c.get', async () => {
    const app = appWithRoutes()
    const r = await app.request('/needs-auth', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ user: 'guest', role: 'user' })
  })
})

describe('requireAdmin', () => {
  it('rejects no cookie with 401 (not 403)', async () => {
    const app = appWithRoutes()
    const r = await app.request('/needs-admin')
    expect(r.status).toBe(401)
  })

  it('rejects user role with 403 admin_only', async () => {
    const app = appWithRoutes()
    const r = await app.request('/needs-admin', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({
      error: 'forbidden',
      reason: 'admin_only',
    })
  })

  it('lets admin role through', async () => {
    const app = appWithRoutes()
    const r = await app.request('/needs-admin', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ user: 'admin-user' })
  })
})
