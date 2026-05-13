import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { grabs } from './grabs.js'
import { createSession } from '../session.js'
import { appendGrabEvent, _setGrabLogPathForTests } from '../services/grabLog.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', grabs)
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

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'grabs-route-'))
  _setGrabLogPathForTests(join(tmpRoot, 'grabs.jsonl'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('GET /recent (admin only)', () => {
  it('rejects unauthenticated with 401', async () => {
    const r = await appUnderTest().request('/recent')
    expect(r.status).toBe(401)
  })

  it('rejects non-admin with 403', async () => {
    const r = await appUnderTest().request('/recent', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('returns recent events for admin', async () => {
    await appendGrabEvent({ app: 'sonarr', itemId: 1, type: 'grab_started' })
    await appendGrabEvent({ app: 'radarr', itemId: 2, type: 'no_releases' })
    const r = await appUnderTest().request('/recent', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const events = (await r.json()) as Array<{ type: string }>
    expect(events).toHaveLength(2)
    // newest first
    expect(events[0].type).toBe('no_releases')
  })

  it('clamps limit to the cap', async () => {
    for (let i = 0; i < 5; i++) {
      await appendGrabEvent({ app: 'sonarr', itemId: i, type: 'grab_started' })
    }
    const r = await appUnderTest().request('/recent?limit=99999', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const events = (await r.json()) as unknown[]
    expect(events.length).toBeLessThanOrEqual(200)
  })
})

describe('GET /by-item (any authed role)', () => {
  it('rejects unauthenticated', async () => {
    const r = await appUnderTest().request('/by-item?app=sonarr&itemId=1')
    expect(r.status).toBe(401)
  })

  it('allows non-admin role', async () => {
    await appendGrabEvent({ app: 'sonarr', itemId: 1, type: 'grab_started' })
    const r = await appUnderTest().request('/by-item?app=sonarr&itemId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
  })

  it('400 on missing or bad app', async () => {
    const r1 = await appUnderTest().request('/by-item?itemId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r1.status).toBe(400)

    const r2 = await appUnderTest().request('/by-item?app=plex&itemId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r2.status).toBe(400)
  })

  it('400 on bad itemId', async () => {
    const r = await appUnderTest().request('/by-item?app=sonarr&itemId=NaN', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(400)
  })

  it('filters by app + itemId', async () => {
    await appendGrabEvent({ app: 'sonarr', itemId: 1, type: 'grab_started' })
    await appendGrabEvent({ app: 'sonarr', itemId: 1, type: 'grab_succeeded' })
    await appendGrabEvent({ app: 'radarr', itemId: 1, type: 'grab_started' })
    await appendGrabEvent({ app: 'sonarr', itemId: 2, type: 'grab_started' })

    const r = await appUnderTest().request('/by-item?app=sonarr&itemId=1', {
      headers: { Cookie: await userCookie() },
    })
    const events = (await r.json()) as Array<{ app: string; itemId: number }>
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.app === 'sonarr' && e.itemId === 1)).toBe(true)
  })
})
