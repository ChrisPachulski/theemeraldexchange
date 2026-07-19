import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { usage } from './usage.js'
import { createMemberSession as createSession } from '../test/authFixture.js'
import { _setUsageLogPathForTests, appendUsageEvent } from '../services/usageLog.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', usage)
  return app
}

async function userCookie(sub = 'plex:1') {
  const t = await createSession({ sub, username: `user-${sub}`, role: 'user' })
  return `eex.session=${t}`
}
async function adminCookie() {
  // Username MUST match the vitest test-env ADMINS list — the auth
  // middleware now reconciles the cookie role against env.admins on
  // every request, so a fake admin cookie issued for a non-listed
  // username gets demoted to 'user' and the route returns 403.
  const t = await createSession({ sub: 'plex:99', username: 'admin-user', role: 'admin' })
  return `eex.session=${t}`
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'usage-route-'))
  _setUsageLogPathForTests(join(tmpRoot, 'usage.jsonl'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('usage route — auth gates', () => {
  it('/me rejects unauthed', async () => {
    expect((await appUnderTest().request('/me')).status).toBe(401)
  })

  it('/admin rejects non-admin with 403', async () => {
    const r = await appUnderTest().request('/admin', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('/log rejects non-admin', async () => {
    const r = await appUnderTest().request('/log', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })
})

describe('usage route — /me', () => {
  it('returns zeros for a user with no events', async () => {
    const r = await appUnderTest().request('/me', {
      headers: { Cookie: await userCookie('plex:100') },
    })
    const body = (await r.json()) as { sub: string; calls: number; costCents: number }
    expect(body.sub).toBe('plex:100')
    expect(body.calls).toBe(0)
    expect(body.costCents).toBe(0)
  })

  it('scopes to the caller, not other users', async () => {
    await appendUsageEvent({
      sub: 'plex:100', username: 'alice', type: 'claude_call',
      model: 'claude-haiku-4-5', kind: 'movie', costCents: 1.5,
    })
    await appendUsageEvent({
      sub: 'plex:200', username: 'bob', type: 'claude_call',
      model: 'claude-haiku-4-5', kind: 'movie', costCents: 99,
    })
    const r = await appUnderTest().request('/me', {
      headers: { Cookie: await userCookie('plex:100') },
    })
    const body = (await r.json()) as { sub: string; calls: number; costCents: number }
    expect(body.sub).toBe('plex:100')
    expect(body.calls).toBe(1)
    expect(body.costCents).toBeCloseTo(1.5, 2)
  })
})

describe('usage route — /admin', () => {
  it('returns all users for admin', async () => {
    await appendUsageEvent({ sub: 'plex:100', username: 'alice', type: 'claude_call', model: 'm', kind: 'movie' })
    await appendUsageEvent({ sub: 'plex:200', username: 'bob', type: 'claude_call', model: 'm', kind: 'tv' })
    const r = await appUnderTest().request('/admin', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as Array<{ sub: string }>
    expect(rows.map((r) => r.sub).sort()).toEqual(['plex:100', 'plex:200'])
  })
})

describe('usage route — /log', () => {
  it('returns recent events newest-first for admin', async () => {
    await appendUsageEvent({ sub: 'plex:1', username: 'a', type: 'claude_call', model: 'm', kind: 'movie' })
    await appendUsageEvent({ sub: 'plex:2', username: 'b', type: 'claude_error', model: 'm', kind: 'tv', error: 'boom' })
    const r = await appUnderTest().request('/log', {
      headers: { Cookie: await adminCookie() },
    })
    const rows = (await r.json()) as Array<{ sub: string; type: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0].sub).toBe('plex:2') // newest first
  })
})
