// /api/auth/device/link — web-claimed device pairing. Covers the happy path
// end to end (start → claim with a WorkOS cookie session → poll mints a device
// token carrying that identity), plus the guards: wrong device_id, double
// claim, and consumed codes.

import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { deviceLink, generateLinkCode } from './deviceLink.js'
import { createMemberSession } from '../test/authFixture.js'
import { serverDb } from '../services/serverDb.js'
import { verifyDeviceToken } from '../session.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', deviceLink)
  return app
}
const DEVICE = { device_id: 'ulid-tv-1', device_name: 'Living room', device_platform: 'tvos' }
const post = (app: Hono<Env>, path: string, body: unknown, cookie?: string) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) } })

beforeEach(() => {
  serverDb().raw.prepare('DELETE FROM device_link_codes').run()
})

describe('generateLinkCode', () => {
  it('is 8 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) expect(generateLinkCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
  })
})

describe('device link flow', () => {
  it('start → claim (workos session) → poll mints a device token for that member', async () => {
    const app = appUnderTest()
    const start = await post(app, '/start', DEVICE)
    expect(start.status).toBe(200)
    const s = (await start.json()) as { code: string; verify_url: string; interval: number }
    expect(s.verify_url).toContain(`/#/link/${s.code}`)

    const pending = await post(app, '/poll', { code: s.code, device_id: DEVICE.device_id })
    expect(await pending.json()).toEqual({ status: 'pending' })

    const cookie = `eex.session=${await createMemberSession({ sub: 'workos:user_01M12813GMJQQ4DXDWTBRC75G1', username: 'ana', role: 'user', auth_mode: 'workos' })}`
    const claim = await post(app, '/claim', { code: s.code.toLowerCase() }, cookie)
    expect(claim.status).toBe(200)
    expect(await claim.json()).toMatchObject({ ok: true, device_name: 'Living room' })

    const done = await post(app, '/poll', { code: s.code, device_id: DEVICE.device_id })
    const body = (await done.json()) as { status: string; token: string; user: { sub: string; username: string } }
    expect(body.status).toBe('authorized')
    expect(body.user).toMatchObject({ sub: 'workos:user_01M12813GMJQQ4DXDWTBRC75G1', username: 'ana' })
    const claims = await verifyDeviceToken(body.token)
    expect(claims?.sub).toBe('workos:user_01M12813GMJQQ4DXDWTBRC75G1')
    expect(JSON.stringify(claims)).toContain('"workos"')
    expect(JSON.stringify(claims)).toContain(DEVICE.device_id)

    // One-shot: a replayed poll after consumption is denied, as is a second claim.
    expect(await (await post(app, '/poll', { code: s.code, device_id: DEVICE.device_id })).json()).toMatchObject({ status: 'denied' })
    expect((await post(app, '/claim', { code: s.code }, cookie)).status).toBe(409)
  })

  it('poll with another device_id looks like an unknown code', async () => {
    const app = appUnderTest()
    const s = (await (await post(app, '/start', DEVICE)).json()) as { code: string }
    expect(await (await post(app, '/poll', { code: s.code, device_id: 'someone-else' })).json()).toEqual({ status: 'denied', reason: 'unknown_code' })
  })

  it('claim requires a session and a real code', async () => {
    const app = appUnderTest()
    expect((await post(app, '/claim', { code: 'ABCDEFGH' })).status).toBe(401)
    const cookie = `eex.session=${await createMemberSession({ sub: 'plex:9', username: 'p', role: 'user' })}`
    expect((await post(app, '/claim', { code: 'ABCDEFGH' }, cookie)).status).toBe(404)
    expect((await post(app, '/claim', { code: 'nope' }, cookie)).status).toBe(400)
  })
})
