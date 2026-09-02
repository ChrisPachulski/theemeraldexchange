import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Fresh server.db + iptv.db + JSON stores per run so the deletes are observable.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-account-test-'))
process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')
process.env.IPTV_DB_PATH = path.join(tmpDir, 'iptv.db')
process.env.ADMINS = 'legacy-admin'

const { mintDeviceToken: mintRawDeviceToken, _resetDeviceKeyForTests } = await import('../session.js')
const { closeServerDb, serverDb } = await import('../services/serverDb.js')
const { iptvDb } = await import('../services/iptvDbSingleton.js')
const { env } = await import('../env.js')
const { getAllPolicies, setPolicy, defaultPolicy, _setUserPoliciesPathForTests } = await import('../services/userPolicies.js')
const { getUserFeedback, setLike, _setUserFeedbackPathForTests } = await import('../services/userFeedback.js')
const { getWatchlist, upsertWatchlist, _setUserWatchlistPathForTests } = await import('../services/userWatchlist.js')
const { app } = await import('../app.js')

_setUserPoliciesPathForTests(path.join(tmpDir, 'policies.json'))
_setUserFeedbackPathForTests(path.join(tmpDir, 'feedback.json'))
_setUserWatchlistPathForTests(path.join(tmpDir, 'watchlist.json'))

afterAll(() => {
  delete process.env.ADMINS
  delete process.env.SERVER_DB_PATH
  delete process.env.IPTV_DB_PATH
  closeServerDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

type DeviceInput = Parameters<typeof mintRawDeviceToken>[0]

const USER: DeviceInput = {
  sub: 'plex:11111',
  role: 'user',
  username: 'regular-user',
  auth_mode: 'plex',
  device_id: '01HABCDEFGHJKMNPQRSTVWXYZ0',
  device_name: 'Living Room Apple TV',
  device_platform: 'tvos',
  server_id: '01HXYZ01234567890ABCDEFGHJ',
}
const ADMIN: DeviceInput = {
  ...USER,
  sub: 'plex:22222',
  role: 'admin',
  username: 'admin-user',
  device_id: '01HADMINDEVICEADMINDEVICE0',
  device_name: 'Admin iPhone',
  device_platform: 'ios',
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Origin: 'https://theemeraldexchange.com' }
}

/** Pairing implies an active member row; mirror that so requireAuth admits the token. */
async function pair(input: DeviceInput): Promise<string> {
  serverDb()
    .raw.prepare(
      `INSERT INTO members (sub, display_name, role, auth_mode, joined_at, revoked_at)
       VALUES (?, ?, ?, ?, datetime('now'), NULL)
       ON CONFLICT(sub) DO UPDATE SET role = excluded.role, revoked_at = NULL`,
    )
    .run(input.sub, input.username ?? null, input.role, input.auth_mode)
  return mintRawDeviceToken(input)
}

function memberRevokedAt(sub: string): string | null {
  const row = serverDb().raw.prepare(`SELECT revoked_at FROM members WHERE sub = ?`).get(sub) as
    | { revoked_at: string | null }
    | undefined
  return row?.revoked_at ?? null
}

function deleteSelf(token: string) {
  return app.request('/api/account/self', { method: 'DELETE', headers: bearer(token) })
}

describe('DELETE /api/account/self', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
    serverDb().raw.exec(
      'DELETE FROM device_token_revocations; DELETE FROM device_tokens; DELETE FROM invites; DELETE FROM members; DELETE FROM webauthn_credentials; DELETE FROM user_api_keys;',
    )
    iptvDb().raw.exec('DELETE FROM iptv_favorites; DELETE FROM iptv_watch_history;')
    ;(env as Record<string, unknown>).adminSubs = []
  })

  it('401s without a credential and never touches the members table', async () => {
    await pair(USER)
    const r = await app.request('/api/account/self', { method: 'DELETE', headers: { Origin: 'https://theemeraldexchange.com' } })
    expect(r.status).toBe(401)
    expect(memberRevokedAt(USER.sub)).toBeNull()
  })

  it('revokes the member, every device token including the caller, their invites, and their state', async () => {
    const token = await pair(USER)
    const other = await mintRawDeviceToken({ ...USER, device_id: '01HSECONDDEVICESECONDDEV00', device_name: 'iPad' })
    serverDb()
      .raw.prepare(
        `INSERT INTO invites (code_hash, issued_by, label, expires_at, max_uses, used_count, created_at, revoked_at)
         VALUES ('hash-1', ?, 'cousin', NULL, 1, 0, datetime('now'), NULL)`,
      )
      .run(USER.sub)
    serverDb().raw.prepare(`INSERT INTO user_api_keys (sub, ciphertext, updated_at) VALUES (?, 'x', datetime('now'))`).run(USER.sub)
    iptvDb().stmts.addFavorite.run({ sub: USER.sub, kind: 'live', item_id: 7, added_ts: 1 })
    iptvDb().stmts.putHistory.run({ sub: USER.sub, kind: 'vod', item_id: 9, position_secs: 30, duration_secs: 60, watched_at: 1, completed: 0 })
    iptvDb().stmts.addFavorite.run({ sub: ADMIN.sub, kind: 'live', item_id: 7, added_ts: 1 })
    await setPolicy(USER.sub, defaultPolicy())
    await setPolicy(ADMIN.sub, defaultPolicy())
    await setLike(USER.sub, 'movie', 550, 'Fight Club')
    await upsertWatchlist(USER.sub, 'movie', { id: 550, title: 'Fight Club' })
    await upsertWatchlist(ADMIN.sub, 'movie', { id: 551, title: 'Kept' })

    const r = await deleteSelf(token)
    expect(r.status).toBe(204)
    expect(await r.text()).toBe('')

    expect(memberRevokedAt(USER.sub)).not.toBeNull()
    expect((await deleteSelf(token)).status).toBe(401)
    expect((await app.request('/api/devices/self', { headers: bearer(other) })).status).toBe(401)
    const invite = serverDb().raw.prepare(`SELECT revoked_at FROM invites WHERE issued_by = ?`).get(USER.sub) as { revoked_at: string | null }
    expect(invite.revoked_at).not.toBeNull()
    expect(serverDb().raw.prepare(`SELECT COUNT(*) AS n FROM user_api_keys WHERE sub = ?`).get(USER.sub)).toEqual({ n: 0 })
    expect(iptvDb().stmts.getFavorites.all(USER.sub)).toEqual([])
    expect(iptvDb().stmts.getHistory.all(USER.sub, 10)).toEqual([])
    expect(iptvDb().stmts.getFavorites.all(ADMIN.sub)).toHaveLength(1)
    expect(Object.keys(await getAllPolicies())).toEqual([ADMIN.sub])
    expect((await getUserFeedback(USER.sub)).movie.liked).toEqual([])
    expect((await getWatchlist(USER.sub)).movie).toEqual([])
    expect((await getWatchlist(ADMIN.sub)).movie).toHaveLength(1)
  })

  it('409 last_admin for the only administrator, leaving everything intact', async () => {
    const token = await pair(ADMIN)
    const r = await deleteSelf(token)
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'last_admin' })
    expect(memberRevokedAt(ADMIN.sub)).toBeNull()
    expect((await app.request('/api/devices/self', { headers: bearer(token) })).status).toBe(200)
  })

  it('lets an administrator go when another active administrator remains', async () => {
    const token = await pair(ADMIN)
    await pair({ ...ADMIN, sub: 'plex:33333', username: 'second-admin', device_id: '01HTHIRDDEVICETHIRDDEVICE0' })
    expect((await deleteSelf(token)).status).toBe(204)
    expect(memberRevokedAt(ADMIN.sub)).not.toBeNull()
  })

  it('counts an ADMIN_SUBS owner who has never logged in as a remaining administrator', async () => {
    ;(env as Record<string, unknown>).adminSubs = ['apple:000000.0123456789abcdef0123456789abcdef.0000']
    const token = await pair(ADMIN)
    expect((await deleteSelf(token)).status).toBe(204)
  })

  it('refuses an ADMIN_SUBS owner outright: the env would re-admit them', async () => {
    ;(env as Record<string, unknown>).adminSubs = [ADMIN.sub]
    await pair({ ...ADMIN, sub: 'plex:33333', username: 'second-admin', device_id: '01HTHIRDDEVICETHIRDDEVICE0' })
    const token = await pair(ADMIN)
    const r = await deleteSelf(token)
    expect(r.status).toBe(409)
    expect(memberRevokedAt(ADMIN.sub)).toBeNull()
  })

  it('treats a legacy ADMINS username as an administrator for the last-admin rule', async () => {
    const token = await pair({ ...USER, username: 'legacy-admin' })
    const r = await deleteSelf(token)
    expect(r.status).toBe(409)
  })
})
