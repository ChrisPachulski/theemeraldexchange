import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Fresh server.db per test run so the route-level inserts don't leak.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-devices-test-'))
process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')

const { mintDeviceToken, _resetDeviceKeyForTests, revokeDeviceToken } = await import(
  '../session.js'
)
const { closeServerDb, serverDb } = await import('../services/serverDb.js')
const { app } = await import('../app.js')

const SAMPLE: Parameters<typeof mintDeviceToken>[0] = {
  sub: 'plex:11111',
  role: 'user',
  auth_mode: 'plex',
  device_id: '01HABCDEFGHJKMNPQRSTVWXYZ0',
  device_name: 'Living Room Apple TV',
  device_platform: 'tvos',
  server_id: '01HXYZ01234567890ABCDEFGHJ',
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Origin: 'https://theemeraldexchange.com',
  }
}

describe('GET /api/devices/self', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
    // Wipe the DB between tests; the migrator re-applies on next access.
    const db = serverDb().raw
    db.exec(
      'DELETE FROM device_token_revocations; DELETE FROM device_tokens; DELETE FROM members;',
    )
  })

  afterEach(() => {
    closeServerDb()
  })

  it('rejects a Bearer token whose member was revoked — closes the 180-day access window', async () => {
    const token = await mintDeviceToken(SAMPLE)
    // First request succeeds: an un-bootstrapped install lets the allowlist
    // fall open, so a freshly-paired device works.
    const ok = await app.request('/api/devices/self', { headers: bearerHeaders(token) })
    expect(ok.status).toBe(200)
    // Operator revokes the member via the allowlist.
    serverDb()
      .raw.prepare(
        `INSERT INTO members (sub, display_name, role, auth_mode, joined_at, revoked_at)
         VALUES (?, 'Revoked User', 'user', 'plex', datetime('now'), datetime('now'))`,
      )
      .run(SAMPLE.sub)
    // The very NEXT Bearer request is denied — not honored until the 180-day
    // token TTL — and the token is cascade-revoked so it stays dead.
    const denied = await app.request('/api/devices/self', { headers: bearerHeaders(token) })
    expect(denied.status).toBe(401)
    const rev = serverDb()
      .raw.prepare('SELECT COUNT(*) AS n FROM device_token_revocations')
      .get() as { n: number }
    expect(rev.n).toBeGreaterThan(0)
  })

  it('lists devices owned by the caller and excludes other subs', async () => {
    const token = await mintDeviceToken(SAMPLE)
    await mintDeviceToken({
      ...SAMPLE,
      sub: 'plex:99999',
      device_id: '01HOTHERDEVICEOTHERDEVICE0',
      device_name: "Other user's TV",
    })

    const res = await app.request('/api/devices/self', { headers: bearerHeaders(token) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { devices: Array<{ device_name: string }> }
    expect(body.devices).toHaveLength(1)
    expect(body.devices[0].device_name).toBe('Living Room Apple TV')
  })

  it('excludes revoked devices from /self listing', async () => {
    const tokenA = await mintDeviceToken(SAMPLE)
    const tokenB = await mintDeviceToken({
      ...SAMPLE,
      device_id: '01HSECONDDEVICESECONDDEVIC',
      device_name: 'iPhone',
    })
    // Revoke A.
    const claimsA = await (await import('../session.js')).verifyDeviceToken(tokenA)
    expect(claimsA).not.toBeNull()
    revokeDeviceToken(claimsA!.jti, 'test')

    const res = await app.request('/api/devices/self', { headers: bearerHeaders(tokenB) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { devices: Array<{ device_name: string }> }
    expect(body.devices.map((d) => d.device_name)).toEqual(['iPhone'])
  })
})

describe('DELETE /api/devices/self/:jti', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
    const db = serverDb().raw
    db.exec('DELETE FROM device_token_revocations; DELETE FROM device_tokens;')
  })
  afterEach(() => closeServerDb())

  it('revokes my own device by jti', async () => {
    const token = await mintDeviceToken(SAMPLE)
    const claims = await (await import('../session.js')).verifyDeviceToken(token)
    expect(claims).not.toBeNull()

    const res = await app.request(`/api/devices/self/${claims!.jti}`, {
      method: 'DELETE',
      headers: bearerHeaders(token),
    })
    expect(res.status).toBe(200)

    // After revoke the verify path returns null (next request is 401).
    const again = await (await import('../session.js')).verifyDeviceToken(token)
    expect(again).toBeNull()
  })

  it('returns 404 when revoking a jti that belongs to another sub', async () => {
    const myToken = await mintDeviceToken(SAMPLE)
    const theirToken = await mintDeviceToken({
      ...SAMPLE,
      sub: 'plex:99999',
      device_id: '01HOTHERDEVICEOTHERDEVICE0',
      device_name: "Their TV",
    })
    const theirClaims = await (await import('../session.js')).verifyDeviceToken(theirToken)
    expect(theirClaims).not.toBeNull()

    const res = await app.request(`/api/devices/self/${theirClaims!.jti}`, {
      method: 'DELETE',
      headers: bearerHeaders(myToken),
    })
    expect(res.status).toBe(404)

    // Their token still verifies — ownership check blocked the revoke.
    const stillOk = await (await import('../session.js')).verifyDeviceToken(theirToken)
    expect(stillOk).not.toBeNull()
  })
})

describe('DELETE /api/devices/self (logout-everywhere)', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
    const db = serverDb().raw
    db.exec('DELETE FROM device_token_revocations; DELETE FROM device_tokens;')
  })
  afterEach(() => closeServerDb())

  it('revokes every device for the caller and reports the count', async () => {
    const token = await mintDeviceToken(SAMPLE)
    await mintDeviceToken({
      ...SAMPLE,
      device_id: '01HSECONDDEVICESECONDDEVIC',
      device_name: 'iPhone',
    })
    await mintDeviceToken({
      ...SAMPLE,
      device_id: '01HTHIRDDEVICETHIRDDEVICE0',
      device_name: 'iPad',
    })

    const res = await app.request('/api/devices/self', {
      method: 'DELETE',
      headers: bearerHeaders(token),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { revoked_count: number }
    expect(body.revoked_count).toBe(3)
  })
})

describe('PATCH /api/devices/self/:jti/name', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
    const db = serverDb().raw
    db.exec('DELETE FROM device_token_revocations; DELETE FROM device_tokens;')
  })
  afterEach(() => closeServerDb())

  it('renames my device', async () => {
    const token = await mintDeviceToken(SAMPLE)
    const claims = await (await import('../session.js')).verifyDeviceToken(token)
    expect(claims).not.toBeNull()

    const res = await app.request(`/api/devices/self/${claims!.jti}/name`, {
      method: 'PATCH',
      headers: { ...bearerHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: 'Bedroom Apple TV' }),
    })
    expect(res.status).toBe(200)

    const row = serverDb()
      .raw.prepare(`SELECT device_name FROM device_tokens WHERE jti = ?`)
      .get(claims!.jti) as { device_name: string }
    expect(row.device_name).toBe('Bedroom Apple TV')
  })

  it('rejects empty name', async () => {
    const token = await mintDeviceToken(SAMPLE)
    const claims = await (await import('../session.js')).verifyDeviceToken(token)
    const res = await app.request(`/api/devices/self/${claims!.jti}/name`, {
      method: 'PATCH',
      headers: { ...bearerHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for someone else\'s jti', async () => {
    const myToken = await mintDeviceToken(SAMPLE)
    const theirToken = await mintDeviceToken({
      ...SAMPLE,
      sub: 'plex:99999',
      device_id: '01HOTHERDEVICEOTHERDEVICE0',
      device_name: 'Their TV',
    })
    const theirClaims = await (await import('../session.js')).verifyDeviceToken(theirToken)

    const res = await app.request(`/api/devices/self/${theirClaims!.jti}/name`, {
      method: 'PATCH',
      headers: { ...bearerHeaders(myToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: 'Hijacked' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/devices/self — unauthenticated', () => {
  it('returns 401 with no Bearer token', async () => {
    const res = await app.request('/api/devices/self', {
      headers: { Origin: 'https://theemeraldexchange.com' },
    })
    expect(res.status).toBe(401)
  })
})
