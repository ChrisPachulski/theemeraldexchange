import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Fresh server.db per test run so the route-level inserts don't leak.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-devices-test-'))
process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')
process.env.ADMINS = 'admin-user'

const {
  mintDeviceToken: mintRawDeviceToken,
  _resetDeviceKeyForTests,
  revokeDeviceToken,
} = await import(
  '../session.js'
)
const { closeServerDb, serverDb } = await import('../services/serverDb.js')
const { app } = await import('../app.js')

afterAll(() => {
  delete process.env.ADMINS
  delete process.env.SERVER_DB_PATH
  closeServerDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

type DeviceInput = Parameters<typeof mintRawDeviceToken>[0]

const SAMPLE: DeviceInput = {
  sub: 'plex:11111',
  role: 'user',
  username: 'regular-user',
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

// NOTE on the admin sub: plex subs must be purely numeric (parseSub regex
// `^(0|[1-9][0-9]*)$`). A non-numeric sub like 'plex:admin1' fails
// validation and `memberStatus` returns 'not_member' → 401 before
// requireAdmin's role check ever runs, so we use a valid numeric sub here.
const ADMIN_SAMPLE: DeviceInput = {
  ...SAMPLE,
  role: 'admin',
  username: 'admin-user',
  sub: 'plex:22222',
  device_id: '01HADMINDEVICEADMINDEVICE0',
  device_name: "Admin's Mac",
}

/** Pairing is reachable only after provider authorization, which guarantees
 * an active member row. Keep route fixtures representative of that contract. */
async function mintDeviceToken(input: DeviceInput): Promise<string> {
  serverDb()
    .raw.prepare(
      `INSERT INTO members (sub, display_name, role, auth_mode, joined_at, revoked_at)
       VALUES (?, ?, ?, ?, datetime('now'), NULL)
       ON CONFLICT(sub) DO UPDATE SET
         display_name = excluded.display_name,
         role = excluded.role,
         auth_mode = excluded.auth_mode,
         revoked_at = NULL`,
    )
    .run(input.sub, input.username ?? null, input.role, input.auth_mode)
  return mintRawDeviceToken(input)
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
    // Pairing created an active member, so the first request succeeds.
    const ok = await app.request('/api/devices/self', { headers: bearerHeaders(token) })
    expect(ok.status).toBe(200)
    // Operator revokes the member via the allowlist.
    serverDb()
      .raw.prepare(
        `UPDATE members SET revoked_at = datetime('now') WHERE sub = ?`,
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

  it('rejects a never-member Bearer token even on a fresh install', async () => {
    const token = await mintRawDeviceToken(SAMPLE)
    const denied = await app.request('/api/devices/self', { headers: bearerHeaders(token) })
    expect(denied.status).toBe(401)
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
    expect(body.devices[0]).toMatchObject({ is_current: true })
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

// ---------------------------------------------------------------------------
// Admin device routes (mounted at /api/admin/devices). The Bearer auth path
// recomputes the role from current env policy plus the username stored in the
// device row at pairing time. ADMIN_SAMPLE carries username:'admin-user', which
// matches the deterministic ADMINS env set before module import.
// ---------------------------------------------------------------------------

describe('GET /api/admin/devices', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
    serverDb().raw.exec(
      'DELETE FROM device_token_revocations; DELETE FROM device_tokens; DELETE FROM members;',
    )
  })
  afterEach(() => closeServerDb())

  it('lists devices across ALL subs and includes the sub field', async () => {
    const adminToken = await mintDeviceToken(ADMIN_SAMPLE)
    await mintDeviceToken(SAMPLE)

    const res = await app.request('/api/admin/devices', { headers: bearerHeaders(adminToken) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { devices: Array<{ sub: string; device_name: string }> }
    expect(body.devices).toHaveLength(2)
    expect(body.devices.every((d) => typeof d.sub === 'string')).toBe(true)
    const subs = new Set(body.devices.map((d) => d.sub))
    expect(subs.has('plex:22222')).toBe(true)
    expect(subs.has('plex:11111')).toBe(true)
  })

  it('includes revoked devices in the admin listing', async () => {
    const adminToken = await mintDeviceToken(ADMIN_SAMPLE)
    const sampleToken = await mintDeviceToken(SAMPLE)
    const sampleClaims = await (await import('../session.js')).verifyDeviceToken(sampleToken)
    expect(sampleClaims).not.toBeNull()
    revokeDeviceToken(sampleClaims!.jti, 'test')

    const res = await app.request('/api/admin/devices', { headers: bearerHeaders(adminToken) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      devices: Array<{ device_name: string; revoked: boolean }>
    }
    const sampleDevice = body.devices.find((d) => d.device_name === 'Living Room Apple TV')
    expect(sampleDevice).toBeDefined()
    expect(sampleDevice!.revoked).toBe(true)
  })

  it('rejects a non-admin Bearer with 403', async () => {
    const userToken = await mintDeviceToken(SAMPLE)
    const res = await app.request('/api/admin/devices', { headers: bearerHeaders(userToken) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('admin_only')
  })

  it('rejects unauthenticated with 401', async () => {
    const res = await app.request('/api/admin/devices', {
      headers: { Origin: 'https://theemeraldexchange.com' },
    })
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/admin/devices/:jti', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
    serverDb().raw.exec(
      'DELETE FROM device_token_revocations; DELETE FROM device_tokens; DELETE FROM members;',
    )
  })
  afterEach(() => closeServerDb())

  it('revokes ANY user device by jti', async () => {
    const adminToken = await mintDeviceToken(ADMIN_SAMPLE)
    const sampleToken = await mintDeviceToken(SAMPLE)
    const sampleClaims = await (await import('../session.js')).verifyDeviceToken(sampleToken)
    expect(sampleClaims).not.toBeNull()
    const jti = sampleClaims!.jti

    const res = await app.request(`/api/admin/devices/${jti}`, {
      method: 'DELETE',
      headers: bearerHeaders(adminToken),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { revoked: string }
    expect(body.revoked).toBe(jti)

    // Cascade revoke took effect — the targeted user's token no longer verifies.
    const after = await (await import('../session.js')).verifyDeviceToken(sampleToken)
    expect(after).toBeNull()

    const rev = serverDb()
      .raw.prepare('SELECT reason FROM device_token_revocations WHERE jti = ?')
      .get(jti) as { reason: string } | undefined
    expect(rev?.reason).toBe('admin_revoke')
  })

  it('returns 404 for an unknown jti', async () => {
    const adminToken = await mintDeviceToken(ADMIN_SAMPLE)
    const res = await app.request('/api/admin/devices/01HNONEXISTENTNONEXISTENT0', {
      method: 'DELETE',
      headers: bearerHeaders(adminToken),
    })
    expect(res.status).toBe(404)
  })

  it('rejects a non-admin caller with 403', async () => {
    const userToken = await mintDeviceToken(SAMPLE)
    const targetToken = await mintDeviceToken({
      ...SAMPLE,
      sub: 'plex:99999',
      device_id: '01HOTHERDEVICEOTHERDEVICE0',
      device_name: 'Target TV',
    })
    const targetClaims = await (await import('../session.js')).verifyDeviceToken(targetToken)
    expect(targetClaims).not.toBeNull()

    const res = await app.request(`/api/admin/devices/${targetClaims!.jti}`, {
      method: 'DELETE',
      headers: bearerHeaders(userToken),
    })
    expect(res.status).toBe(403)

    // No revoke happened — the target token still verifies.
    const stillOk = await (await import('../session.js')).verifyDeviceToken(targetToken)
    expect(stillOk).not.toBeNull()
  })
})

describe('PATCH /api/admin/devices/:jti/name', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
    serverDb().raw.exec(
      'DELETE FROM device_token_revocations; DELETE FROM device_tokens; DELETE FROM members;',
    )
  })
  afterEach(() => closeServerDb())

  it('renames ANY user device', async () => {
    const adminToken = await mintDeviceToken(ADMIN_SAMPLE)
    const sampleToken = await mintDeviceToken(SAMPLE)
    const sampleClaims = await (await import('../session.js')).verifyDeviceToken(sampleToken)
    expect(sampleClaims).not.toBeNull()
    const jti = sampleClaims!.jti

    const res = await app.request(`/api/admin/devices/${jti}/name`, {
      method: 'PATCH',
      headers: { ...bearerHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: 'Renamed By Admin' }),
    })
    expect(res.status).toBe(200)

    const row = serverDb()
      .raw.prepare(`SELECT device_name FROM device_tokens WHERE jti = ?`)
      .get(jti) as { device_name: string }
    expect(row.device_name).toBe('Renamed By Admin')
  })

  it('rejects empty name with 400', async () => {
    const adminToken = await mintDeviceToken(ADMIN_SAMPLE)
    const adminClaims = await (await import('../session.js')).verifyDeviceToken(adminToken)
    expect(adminClaims).not.toBeNull()

    const res = await app.request(`/api/admin/devices/${adminClaims!.jti}/name`, {
      method: 'PATCH',
      headers: { ...bearerHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown jti', async () => {
    const adminToken = await mintDeviceToken(ADMIN_SAMPLE)
    const res = await app.request('/api/admin/devices/01HNONEXISTENTNONEXISTENT0/name', {
      method: 'PATCH',
      headers: { ...bearerHeaders(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: 'X' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects a non-admin caller with 403', async () => {
    const userToken = await mintDeviceToken(SAMPLE)
    const userClaims = await (await import('../session.js')).verifyDeviceToken(userToken)
    expect(userClaims).not.toBeNull()

    const res = await app.request(`/api/admin/devices/${userClaims!.jti}/name`, {
      method: 'PATCH',
      headers: { ...bearerHeaders(userToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: 'Should Not Apply' }),
    })
    expect(res.status).toBe(403)
  })
})
