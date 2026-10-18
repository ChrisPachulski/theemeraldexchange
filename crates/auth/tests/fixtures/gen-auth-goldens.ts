// Writes auth-goldens.json from the untouched TS auth (server/session.ts,
// middleware/auth.ts, the /api/me router) under fixed test secrets:
//   - cookies:      session cookies minted by TS/jose, with verifySession's verdict
//   - rust_minted:  rust-minted-cookies.json run through verifySession (rollback safety)
//   - set_cookie:   setSessionCookie's header per deployment posture, http and https
//   - seed/scenarios/final: a server.db seed, requests through requireAuth /
//     requireAdmin / /api/me with their responses, and the device-token state after
// and route-goldens.json from the route modules mounted at app.ts's paths
// (/api/auth/methods, /api/me, /api/auth/device/link, /api/devices,
// /api/admin/{devices,invites,members}) over a seeded server.db, with a local
// iptv stub recording the member-revoke calls. Bodies are the raw response
// text; values that differ per run (codes, tokens, now-stamps) are replaced
// by `"<key>"` per the scenario's `volatile` list, on both sides.
// The Rust tests (session/tests.rs, reconcile/tests.rs, route_goldens.rs)
// replay all of it. Each posture runs in a child process because env.ts reads
// its settings at import.
// Run from the repo root while the TS auth exists (it goes at step 3):
//   cargo test -p auth -- --ignored write_rust_minted_cookies
//   npx tsx crates/auth/tests/fixtures/gen-auth-goldens.ts
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const here = path.dirname(self)
const server = path.join(here, '../../../../server')

const SECRETS = {
  SESSION_SECRET: 'auth-goldens-session-secret-0123456789abcdef',
  STREAM_TOKEN_SECRET: 'auth-goldens-stream-secret-0123456789abcdef',
  DEVICE_TOKEN_SECRET: 'auth-goldens-device-secret-0123456789abcdef',
  INTERNAL_PRINCIPAL_SECRET: 'auth-goldens-internal-secret-0123456789abcdef',
}
const OWNER = 'workos:user_01E4ZCR3C56J083X43JQXF3JK5' // ADMIN_SUBS, no members row
const MEMBER = 'apple:000001.0123456789abcdef0123456789abcdef.0001'
const DB_ADMIN = 'google:1234567890'
const DEMOTED = 'google:999'
const REVOKED = 'apple:000002.0123456789abcdef0123456789abcdef.0002'
const STRANGER = 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV' // no row, not in ADMIN_SUBS

const POSTURES: Record<string, Record<string, string>> = {
  dev_split: { SERVE_SPA: '0' },
  prod_split: { SERVE_SPA: '0', NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://app.example' },
  dev_same_origin: { SERVE_SPA: '1' },
  prod_same_origin: { SERVE_SPA: '1', NODE_ENV: 'production' },
}

type Json = Record<string, unknown>

function runChild(posture: string, vars: Record<string, string>): Json {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-goldens-'))
  const file = path.join(dir, 'out.json')
  execFileSync(process.execPath, [...process.execArgv, self], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...SECRETS,
      ADMIN_SUBS: OWNER,
      SERVER_DB_PATH: path.join(dir, 'server.db'),
      GOLDEN_POSTURE: posture,
      GOLDEN_OUT: file,
      ...vars,
    },
  })
  const child = JSON.parse(fs.readFileSync(file, 'utf8')) as Json
  fs.rmSync(dir, { recursive: true, force: true })
  return child
}

/** The same replacement route_goldens.rs applies to the Rust bodies. */
function normalize(text: string, volatile: string[]): string {
  let out = text
  if (volatile.includes('code')) {
    const code = /"code":"([^"]*)"/.exec(out)?.[1]
    if (code) out = out.split(code).join('<code>')
  }
  for (const key of volatile) out = out.replace(new RegExp(`"${key}":"[^"]*"`, 'g'), `"${key}":"<${key}>"`)
  return out
}

if (!process.env.GOLDEN_POSTURE) {
  const out: Json = {
    session_secret: SECRETS.SESSION_SECRET,
    device_token_secret: SECRETS.DEVICE_TOKEN_SECRET,
    admin_subs: [OWNER],
    set_cookie: {},
  }
  for (const [posture, vars] of Object.entries(POSTURES)) {
    const child = runChild(posture, vars)
    ;(out.set_cookie as Json)[posture] = child.set_cookie
    if (posture === 'dev_split') Object.assign(out, { ...child, set_cookie: out.set_cookie })
  }
  fs.writeFileSync(path.join(here, 'auth-goldens.json'), JSON.stringify(out, null, 2) + '\n')
  const routes = runChild('routes', { SERVE_SPA: '0', ALLOWED_ORIGINS: 'https://app.example' })
  fs.writeFileSync(path.join(here, 'route-goldens.json'), JSON.stringify(routes, null, 2) + '\n')
} else if (process.env.GOLDEN_POSTURE === 'routes') {
  await routeGoldens()
} else {
  const { Hono } = await import('hono')
  const { EncryptJWT } = await import('jose')
  const session = await import(path.join(server, 'session.js'))
  const { deriveKey, INFO_SESSION } = await import(path.join(server, 'services/keyDerivation.js'))
  const result: Json = {}

  const login = new Hono()
  login.get('/login', async (c) => {
    await session.setSessionCookie(c, { sub: MEMBER, username: 'Mom', role: 'user' })
    return c.json({ ok: true })
  })
  const setCookie: Json = {}
  for (const scheme of ['http', 'https']) {
    const r = await login.request(`${scheme}://localhost/login`)
    setCookie[scheme] = r.headers.get('set-cookie')!.replace(/^eex\.session=[^;]+/, 'eex.session=<token>')
  }
  result.set_cookie = setCookie

  if (process.env.GOLDEN_POSTURE === 'dev_split') {
    const now = Math.floor(Date.now() / 1000)
    result.minted_at = now
    const key = deriveKey(SECRETS.SESSION_SECRET, INFO_SESSION)
    const valid = { sub: MEMBER, username: 'Mom', role: 'user', auth_mode: 'apple' }
    const hdr = { alg: 'dir', enc: 'A256GCM' }
    const jwe = (claims: Json, opts: { header?: Json; exp?: number | false; nbf?: number; k?: Uint8Array } = {}) => {
      const b = new EncryptJWT(claims).setProtectedHeader(opts.header ?? hdr).setIssuedAt()
      if (opts.exp !== false) b.setExpirationTime(opts.exp ?? now + 3600)
      if (opts.nbf !== undefined) b.setNotBefore(opts.nbf)
      return b.encrypt(opts.k ?? key)
    }
    const cookies: Array<[string, string]> = [
      ['ts apple user, auth_mode backfilled', await session.createSession({ sub: MEMBER, username: 'Mom', role: 'user' })],
      ['ts workos admin', await session.createSession({ sub: OWNER, username: 'Owner', role: 'admin', auth_mode: 'workos' })],
      ['ts google user', await session.createSession({ sub: DB_ADMIN, username: 'G', role: 'user' })],
      ['ts local user', await session.createSession({ sub: STRANGER, username: 'L', role: 'user' })],
      ['ts plex session', await session.createSession({ sub: 'plex:42', username: 'P', role: 'user' })],
      ['header with kid session-v1', await jwe(valid, { header: { ...hdr, kid: 'session-v1' } })],
      ['no auth_mode', await jwe({ sub: MEMBER, username: 'Mom', role: 'user' })],
      ['unknown auth_mode', await jwe({ ...valid, auth_mode: 'magic' })],
      ['bare sub', await jwe({ ...valid, sub: '42' })],
      ['malformed apple sub', await jwe({ ...valid, sub: 'apple:xyz' })],
      ['unknown role', await jwe({ ...valid, role: 'superadmin' })],
      ['missing username', await jwe({ sub: MEMBER, role: 'user', auth_mode: 'apple' })],
      ['null username', await jwe({ ...valid, username: null })],
      ['missing sub', await jwe({ username: 'Mom', role: 'user', auth_mode: 'apple' })],
      ['non-string sub', await jwe({ ...valid, sub: 42 })],
      ['expired', await jwe(valid, { exp: now - 60 })],
      ['exp equals now', await jwe(valid, { exp: now })],
      ['nbf in the future', await jwe(valid, { nbf: now + 3600 })],
      ['non-numeric exp', await jwe({ ...valid, exp: 'soon' }, { exp: false })],
      ['no exp', await jwe(valid, { exp: false })],
      ['wrong key', await jwe(valid, { k: deriveKey('a-different-secret-0123456789abcdef', INFO_SESSION) })],
      ['garbage', 'a.b.c.d.e'],
    ]
    result.cookies = await Promise.all(
      cookies.map(async ([name, token]) => ({ name, token, ts: await session.verifySession(token) })),
    )

    const rustFile = path.join(here, 'rust-minted-cookies.json')
    const rust = JSON.parse(fs.readFileSync(rustFile, 'utf8')) as Array<Json & { token: string }>
    result.rust_minted = await Promise.all(rust.map(async (r) => ({ ...r, ts: await session.verifySession(r.token) })))

    const { serverDb, ensureServerId } = await import(path.join(server, 'services/serverDb.js'))
    const db = serverDb().raw
    const member = db.prepare(
      `INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, '2026-10-01T00:00:00.000Z', ?)`,
    )
    member.run(MEMBER, 'Mom', 'user', 'apple', null)
    member.run(DB_ADMIN, 'G', 'admin', 'google', null)
    member.run(DEMOTED, 'D', 'user', 'google', null)
    member.run(REVOKED, 'R', 'user', 'apple', '2026-10-02T00:00:00.000Z')
    const serverId = ensureServerId()
    const device = (sub: string, authMode: string, role: string, name: string, id: string) =>
      session.mintDeviceToken({
        sub, role, auth_mode: authMode, device_id: id, device_platform: 'tvos', device_name: name, server_id: serverId,
      })
    const memberDevice = await device(MEMBER, 'apple', 'user', 'Living Room Apple TV', '01HABCDEFGHJKMNPQRSTVWXYZ0')
    const ownerDevice = await device(OWNER, 'workos', 'admin', 'Owner iPad', '01HABCDEFGHJKMNPQRSTVWXYZ1')
    const revokedDevice = await device(REVOKED, 'apple', 'user', 'Revoked TV', '01HABCDEFGHJKMNPQRSTVWXYZ2')
    await device(REVOKED, 'apple', 'user', 'Revoked Phone', '01HABCDEFGHJKMNPQRSTVWXYZ3')
    const strangerDevice = await device(STRANGER, 'local', 'user', 'Stranger TV', '01HABCDEFGHJKMNPQRSTVWXYZ4')
    // A member token whose claimed role is admin: the live role must win.
    const liarDevice = await device(MEMBER, 'apple', 'admin', 'Kids iPad', '01HABCDEFGHJKMNPQRSTVWXYZ5')
    result.seed = {
      members: db.prepare('SELECT * FROM members ORDER BY sub').all(),
      device_tokens: db.prepare('SELECT * FROM device_tokens ORDER BY jti').all(),
    }

    const cookie = async (sub: string, role: string) =>
      `eex.session=${await session.createSession({ sub, username: `cookie ${sub.split(':')[0]}`, role })}`
    const memberCookie = await cookie(MEMBER, 'user')

    const { requireAuth, requireAdmin } = await import(path.join(server, 'middleware/auth.js'))
    const { me } = await import(path.join(server, 'auth.js'))
    const app = new Hono()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono context typed by middleware Env
    const echo = (c: any) => {
      const s = c.get('session')
      return c.json({ user: { sub: s.sub, username: s.username, role: s.role, auth_mode: s.auth_mode } })
    }
    app.get('/needs-auth', requireAuth, echo)
    app.get('/needs-admin', requireAdmin, echo)
    app.route('/api/me', me)

    const scenarios: Array<[string, string, Record<string, string>]> = [
      ['no credentials', '/needs-auth', {}],
      ['no credentials on an admin route is 401, not 403', '/needs-admin', {}],
      ['garbage cookie', '/needs-auth', { Cookie: 'eex.session=garbage' }],
      ['member cookie', '/needs-auth', { Cookie: memberCookie }],
      ['member cookie among other cookies', '/needs-auth', { Cookie: `theme=dark; ${memberCookie}; x=1` }],
      ['member cookie on an admin route', '/needs-admin', { Cookie: memberCookie }],
      ['owner cookie (ADMIN_SUBS) on an admin route', '/needs-admin', { Cookie: await cookie(OWNER, 'user') }],
      ['DB-admin cookie on an admin route', '/needs-admin', { Cookie: await cookie(DB_ADMIN, 'user') }],
      ['demoted admin cookie on /api/me', '/api/me', { Cookie: await cookie(DEMOTED, 'admin') }],
      ['member /api/me', '/api/me', { Cookie: memberCookie }],
      ['/api/me without a cookie', '/api/me', {}],
      ['revoked member bearer cascades', '/needs-auth', { Authorization: `Bearer ${revokedDevice}` }],
      ['revoked member cookie on /api/me', '/api/me', { Cookie: await cookie(REVOKED, 'user') }],
      ['non-member bearer cascades', '/needs-auth', { Authorization: `Bearer ${strangerDevice}` }],
      ['non-member cookie', '/needs-auth', { Cookie: await cookie(STRANGER, 'admin') }],
      ['member bearer with X-App-Version', '/needs-auth', { Authorization: `Bearer ${memberDevice}`, 'X-App-Version': '1.2.3' }],
      ['member bearer on an admin route', '/needs-admin', { Authorization: `Bearer ${memberDevice}` }],
      ['admin-claim member bearer on an admin route', '/needs-admin', { Authorization: `Bearer ${liarDevice}` }],
      ['owner bearer on an admin route', '/needs-admin', { Authorization: `Bearer ${ownerDevice}` }],
      ['invalid bearer never falls back to a valid cookie', '/needs-auth', { Authorization: 'Bearer garbage.not.a.jwe', Cookie: memberCookie }],
      ['whitespace-only bearer', '/needs-auth', { Authorization: 'Bearer    ', Cookie: memberCookie }],
      ['non-Bearer scheme falls back to the cookie', '/needs-auth', { Authorization: 'Basic abc', Cookie: memberCookie }],
      ['revoked device token stays rejected', '/needs-auth', { Authorization: `Bearer ${revokedDevice}` }],
    ]
    const ran = []
    for (const [name, p, headers] of scenarios) {
      const r = await app.request(p, { headers })
      ran.push({ name, path: p, headers, status: r.status, body: await r.json(), set_cookie: r.headers.get('set-cookie') })
    }
    result.scenarios = ran
    result.final = {
      revocations: db.prepare('SELECT jti, reason FROM device_token_revocations ORDER BY jti').all(),
      device_tokens: db
        .prepare('SELECT jti, last_seen_version, last_seen_at IS NOT NULL AS seen FROM device_tokens ORDER BY jti')
        .all(),
    }
  }
  fs.writeFileSync(process.env.GOLDEN_OUT!, JSON.stringify(result))
}

// Route goldens: the S6 surface (device link, devices, admin invites and
// members) plus /api/auth/methods and /api/me, over one seeded server.db.
// Only memberTv ever authenticates by Bearer, so the device lists have one
// now-stamped row and no ordering tie; device-link polls (which mint new
// rows) run last, after every list.
async function routeGoldens(): Promise<void> {
  const { createHash } = await import('node:crypto')
  const { Hono } = await import('hono')
  const session = await import(path.join(server, 'session.js'))
  const { serverDb, ensureServerId } = await import(path.join(server, 'services/serverDb.js'))
  const { startIptvStub } = await import(path.join(server, 'test/iptvStub.js'))
  const { auth, me } = await import(path.join(server, 'auth.js'))
  const { deviceLink } = await import(path.join(server, 'routes/deviceLink.js'))
  const { devices, adminDevices } = await import(path.join(server, 'routes/devices.js'))
  const { adminInvites, adminMembers } = await import(path.join(server, 'routes/adminInvites.js'))
  const iptv = await startIptvStub()

  const OTHER = 'google:777'
  const now = Math.floor(Date.now() / 1000)
  const db = serverDb().raw
  const member = db.prepare(
    `INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  member.run(MEMBER, 'Mom', 'user', 'apple', OWNER, '2026-10-04T00:00:00.000Z', null)
  member.run(OTHER, 'Other', 'user', 'google', null, '2026-10-03T00:00:00.000Z', null)
  member.run(DB_ADMIN, 'G', 'admin', 'google', null, '2026-10-02T00:00:00.000Z', null)
  member.run(REVOKED, 'R', 'user', 'apple', null, '2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z')
  const serverId = ensureServerId()

  const device = async (sub: string, authMode: string, role: string, name: string, id: string) => {
    const token = await session.mintDeviceToken({
      sub, role, auth_mode: authMode, device_id: id, device_platform: 'tvos', device_name: name, server_id: serverId,
    })
    const claims = await session.verifyDeviceToken(token)
    return { token, jti: claims!.jti as string }
  }
  const memberTv = await device(MEMBER, 'apple', 'user', 'Living Room Apple TV', '01HABCDEFGHJKMNPQRSTVWXYZ0')
  const memberPhone = await device(MEMBER, 'apple', 'user', 'iPhone', '01HABCDEFGHJKMNPQRSTVWXYZ1')
  const memberOld = await device(MEMBER, 'apple', 'user', 'Old TV', '01HABCDEFGHJKMNPQRSTVWXYZ2')
  const otherTv = await device(OTHER, 'google', 'user', 'Other TV', '01HABCDEFGHJKMNPQRSTVWXYZ3')
  await device(OTHER, 'google', 'user', 'Other iPad', '01HABCDEFGHJKMNPQRSTVWXYZ4')
  const adminMac = await device(DB_ADMIN, 'google', 'admin', "Admin's Mac", '01HABCDEFGHJKMNPQRSTVWXYZ5')
  await device(OWNER, 'workos', 'admin', 'Owner iPad', '01HABCDEFGHJKMNPQRSTVWXYZ6')
  // Distinct issued_at hours in the past, so list order never ties.
  const rows = db.prepare('SELECT jti FROM device_tokens ORDER BY rowid').all() as Array<{ jti: string }>
  rows.forEach((r, i) =>
    db.prepare('UPDATE device_tokens SET issued_at = ? WHERE jti = ?')
      .run(new Date((now - (i + 1) * 3600) * 1000).toISOString(), r.jti),
  )
  session.revokeDeviceToken(memberOld.jti, 'self_revoke')
  db.prepare(`UPDATE device_token_revocations SET revoked_at = '2026-10-06 00:00:00'`).run()

  const hash = (code: string) => createHash('sha256').update(code).digest('hex')
  const invite = db.prepare(
    `INSERT INTO invites (code_hash, issued_by, label, role, expires_at, max_uses, used_count, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const INVITES: Array<[string, string, string | null, string, string | null, number, number, string, string | null]> = [
    ['golden-active', OWNER, 'Grandma', 'user', '2099-01-01T00:00:00.000Z', 1, 0, '2026-10-06T00:00:00.000Z', null],
    ['golden-owner', OWNER, null, 'admin', null, 5, 2, '2026-10-05T00:00:00.000Z', null],
    ['golden-expired', OWNER, 'Late', 'user', '2020-01-01T00:00:00.000Z', 1, 0, '2026-10-04T00:00:00.000Z', null],
    ['golden-spent', DB_ADMIN, 'Used', 'user', '2099-01-01T00:00:00.000Z', 1, 1, '2026-10-03T00:00:00.000Z', null],
    ['golden-revoked', OWNER, 'Gone', 'user', '2099-01-01T00:00:00.000Z', 1, 0, '2026-10-02T00:00:00.000Z', '2026-10-07T00:00:00.000Z'],
    ['golden-by-revoked', REVOKED, 'Orphan', 'user', null, 1, 0, '2026-10-01T00:00:00.000Z', null],
  ]
  for (const [code, ...rest] of INVITES) invite.run(hash(code), ...rest)
  const prefix = (code: string) => hash(code).slice(0, 8)

  const link = db.prepare(
    `INSERT INTO device_link_codes (code, device_id, device_name, device_platform, created_at, expires_at)
     VALUES (?, ?, 'Link TV', 'tvos', ?, ?)`,
  )
  link.run('PEND2345', 'tv-link-1', now, now + 600)
  link.run('BEAR2345', 'tv-link-2', now, now + 600)
  link.run('EXPD2345', 'tv-link-3', now - 700, now - 10)
  link.run('OLDD2345', 'tv-link-4', now - 2000, now - 1300)

  const dump = (table: string, order: string) => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()
  const result: Json = {
    minted_at: now,
    seed: {
      server_state: dump('server_state', 'key'),
      members: dump('members', 'rowid'),
      device_tokens: dump('device_tokens', 'rowid'),
      device_token_revocations: dump('device_token_revocations', 'rowid'),
      invites: dump('invites', 'rowid'),
      device_link_codes: dump('device_link_codes', 'rowid'),
    },
  }

  const cookie = async (sub: string, username: string, role: string) =>
    `eex.session=${await session.createSession({ sub, username, role })}`
  const owner = { Cookie: await cookie(OWNER, 'Owner', 'admin') }
  const mom = { Cookie: await cookie(MEMBER, 'Mom', 'user') }
  const other = { Cookie: await cookie(OTHER, 'Other', 'user') }
  const gAdmin = { Cookie: await cookie(DB_ADMIN, 'G', 'admin') }
  const revoked = { Cookie: await cookie(REVOKED, 'R', 'user') }
  const momTv = { Authorization: `Bearer ${memberTv.token}` }

  const app = new Hono()
  app.route('/api/auth', auth)
  app.route('/api/auth/device/link', deviceLink)
  app.route('/api/me', me)
  app.route('/api/devices', devices)
  app.route('/api/admin/devices', adminDevices)
  app.route('/api/admin/invites', adminInvites)
  app.route('/api/admin/members', adminMembers)

  type Scenario = [string, string, string, Record<string, string>, string?, string[]?]
  const name = (body: string) => JSON.stringify({ device_name: body })
  const poll = (code: string, deviceId: string) => JSON.stringify({ code, device_id: deviceId })
  const scenarios: Scenario[] = [
    ['methods (no plex key in Rust)', 'GET', '/api/auth/methods', {}],
    ['me', 'GET', '/api/me', mom],
    // devices
    ['self list by bearer marks is_current', 'GET', '/api/devices/self', momTv, undefined, ['last_seen_at']],
    ['self list by cookie', 'GET', '/api/devices/self', mom, undefined, ['last_seen_at']],
    ['self list without credentials', 'GET', '/api/devices/self', {}],
    ['self list as a revoked member clears the cookie', 'GET', '/api/devices/self', revoked],
    ['rename own', 'PATCH', `/api/devices/self/${memberPhone.jti}/name`, mom, name('  Kids iPhone ')],
    ['rename own blank', 'PATCH', `/api/devices/self/${memberPhone.jti}/name`, mom, name('   ')],
    ['rename own 129 chars', 'PATCH', `/api/devices/self/${memberPhone.jti}/name`, mom, name('x'.repeat(129))],
    ['rename own non-string', 'PATCH', `/api/devices/self/${memberPhone.jti}/name`, mom, '{"device_name":7}'],
    ['rename own bad json', 'PATCH', `/api/devices/self/${memberPhone.jti}/name`, mom, 'not json'],
    ["rename someone else's", 'PATCH', `/api/devices/self/${otherTv.jti}/name`, mom, name('Hijacked')],
    ["revoke someone else's", 'DELETE', `/api/devices/self/${otherTv.jti}`, mom],
    ['revoke own', 'DELETE', `/api/devices/self/${memberPhone.jti}`, mom],
    ['revoke unknown', 'DELETE', '/api/devices/self/01HNONEXISTENTNONEXISTENT0', mom],
    ['logout everywhere', 'DELETE', '/api/devices/self', other],
    ['admin list', 'GET', '/api/admin/devices', owner, undefined, ['last_seen_at', 'revoked_at']],
    ['admin list as a member', 'GET', '/api/admin/devices', mom],
    ['admin list without credentials', 'GET', '/api/admin/devices', {}],
    ['admin rename', 'PATCH', `/api/admin/devices/${memberTv.jti}/name`, owner, name('Renamed By Admin')],
    ['admin rename unknown', 'PATCH', '/api/admin/devices/01HNONEXISTENTNONEXISTENT0/name', owner, name('X')],
    ['admin rename blank', 'PATCH', `/api/admin/devices/${memberTv.jti}/name`, owner, name('')],
    ['admin revoke as a DB admin', 'DELETE', `/api/admin/devices/${adminMac.jti}`, gAdmin],
    ['admin revoke unknown', 'DELETE', '/api/admin/devices/01HNONEXISTENTNONEXISTENT0', owner],
    ['admin revoke as a member', 'DELETE', `/api/admin/devices/${otherTv.jti}`, mom],
    // invites
    ['invites without credentials', 'GET', '/api/admin/invites', {}],
    ['invites as a member', 'GET', '/api/admin/invites', mom],
    ['invites list', 'GET', '/api/admin/invites', owner],
    ['revoke an invite', 'DELETE', `/api/admin/invites/${prefix('golden-active')}`, owner],
    ['revoke it again', 'DELETE', `/api/admin/invites/${prefix('golden-active')}`, owner],
    ['revoke an unknown prefix', 'DELETE', '/api/admin/invites/deadbeef', owner],
    ['revoke a revoked invite', 'DELETE', `/api/admin/invites/${prefix('golden-revoked')}`, owner],
    ['revoke an upper-case prefix', 'DELETE', `/api/admin/invites/${prefix('golden-spent').toUpperCase()}`, owner],
    ['invites list after revoke', 'GET', '/api/admin/invites', owner, undefined, ['revoked_at']],
    ['issue defaults', 'POST', '/api/admin/invites', owner, '{}', ['code', 'code_hash_prefix', 'expires_at']],
    ['issue full', 'POST', '/api/admin/invites', owner, '{"label":"  Mom\'s iPad  ","expiresInDays":30,"maxUses":3}', ['code', 'code_hash_prefix', 'expires_at']],
    ['issue owner invite without expiry', 'POST', '/api/admin/invites', owner, '{"role":"admin","label":"App Review","expiresInDays":null}', ['code', 'code_hash_prefix']],
    ['issue long label', 'POST', '/api/admin/invites', owner, JSON.stringify({ label: 'x'.repeat(200) }), ['code', 'code_hash_prefix', 'expires_at']],
    ['issue label null, maxUses 2', 'POST', '/api/admin/invites', owner, '{"label":null,"maxUses":2}', ['code', 'code_hash_prefix', 'expires_at']],
    ['issue bad json reads as empty', 'POST', '/api/admin/invites', owner, 'not json', ['code', 'code_hash_prefix', 'expires_at']],
    ['issue label 123', 'POST', '/api/admin/invites', owner, '{"label":123}'],
    ['issue expiresInDays soon', 'POST', '/api/admin/invites', owner, '{"expiresInDays":"soon"}'],
    ['issue maxUses 0', 'POST', '/api/admin/invites', owner, '{"maxUses":0}'],
    ['issue maxUses 1.5', 'POST', '/api/admin/invites', owner, '{"maxUses":1.5}'],
    ['issue role owner', 'POST', '/api/admin/invites', owner, '{"role":"owner"}'],
    ['issue as a member', 'POST', '/api/admin/invites', mom, '{}'],
    // members
    ['members list (synthesized owner)', 'GET', '/api/admin/members', owner],
    ['members as a member', 'GET', '/api/admin/members', mom],
    ['revoke the owner', 'DELETE', `/api/admin/members/${OWNER}`, owner],
    ['a DB admin revokes themselves', 'DELETE', `/api/admin/members/${DB_ADMIN}`, gAdmin],
    ['revoke a member (encoded sub)', 'DELETE', `/api/admin/members/${encodeURIComponent(OTHER)}`, owner],
    ['revoke an already revoked member', 'DELETE', `/api/admin/members/${REVOKED}`, owner],
    ['revoke an unknown member', 'DELETE', '/api/admin/members/google:5', owner],
    ['members list after revoke', 'GET', '/api/admin/members', owner, undefined, ['revoked_at']],
    // device link
    ['link start', 'POST', '/api/auth/device/link/start', {}, '{"device_id":"tv-new","device_name":"Den TV","device_platform":"tvos"}', ['code']],
    ['link start missing fields', 'POST', '/api/auth/device/link/start', {}, '{"device_id":"tv-new"}'],
    ['link start bad json', 'POST', '/api/auth/device/link/start', {}, 'not json'],
    ['link poll pending', 'POST', '/api/auth/device/link/poll', {}, poll('PEND2345', 'tv-link-1')],
    ['link poll wrong device', 'POST', '/api/auth/device/link/poll', {}, poll('PEND2345', 'tv-link-9')],
    ['link poll bad code', 'POST', '/api/auth/device/link/poll', {}, poll('nope', 'tv-link-1')],
    ['link claim without credentials', 'POST', '/api/auth/device/link/claim', {}, '{"code":"PEND2345"}'],
    ['link claim bad code', 'POST', '/api/auth/device/link/claim', mom, '{"code":"nope"}'],
    ['link claim unknown code', 'POST', '/api/auth/device/link/claim', mom, '{"code":"ZZZZ2345"}'],
    ['link claim expired code', 'POST', '/api/auth/device/link/claim', mom, '{"code":"EXPD2345"}'],
    ['link claim (normalized code)', 'POST', '/api/auth/device/link/claim', mom, '{"code":" pend-2345 "}'],
    ['link claim twice', 'POST', '/api/auth/device/link/claim', gAdmin, '{"code":"PEND2345"}'],
    ['link poll authorized', 'POST', '/api/auth/device/link/poll', {}, poll('PEND2345', 'tv-link-1'), ['token']],
    ['link poll after consume', 'POST', '/api/auth/device/link/poll', {}, poll('PEND2345', 'tv-link-1')],
    ['link poll expired', 'POST', '/api/auth/device/link/poll', {}, poll('EXPD2345', 'tv-link-3')],
    ['link claim by bearer', 'POST', '/api/auth/device/link/claim', momTv, '{"code":"BEAR2345"}'],
    ['link poll bearer claim', 'POST', '/api/auth/device/link/poll', {}, poll('BEAR2345', 'tv-link-2'), ['token']],
    ['link claim as a revoked member', 'POST', '/api/auth/device/link/claim', revoked, '{"code":"BEAR2345"}'],
  ]
  const ran = []
  for (const [label, method, p, headers, body, volatile = []] of scenarios) {
    const h = body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' }
    const r = await app.request(p, { method, headers: h, body })
    ran.push({
      name: label, method, path: p, headers: h, body: body ?? null, volatile,
      status: r.status, text: normalize(await r.text(), volatile), set_cookie: r.headers.get('set-cookie'),
    })
  }
  result.scenarios = ran
  result.iptv_calls = iptv.calls.map((c: { method: string; url: string }) => `${c.method} ${c.url}`)
  result.final = {
    members: db.prepare('SELECT sub, revoked_at IS NOT NULL AS revoked FROM members ORDER BY sub').all(),
    invites: db.prepare('SELECT substr(code_hash, 1, 8) AS prefix, revoked_at IS NOT NULL AS revoked FROM invites WHERE rowid <= ? ORDER BY prefix').all(INVITES.length),
    invite_count: (db.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number }).n,
    revocations: db.prepare('SELECT jti, reason FROM device_token_revocations ORDER BY jti').all(),
    device_names: db.prepare('SELECT jti, device_name FROM device_tokens WHERE rowid <= ? ORDER BY jti').all(rows.length),
    device_count: (db.prepare('SELECT COUNT(*) AS n FROM device_tokens').get() as { n: number }).n,
    link_codes: db.prepare(
      `SELECT code, claimed_sub, claimed_username, claimed_role, claimed_auth_mode,
              claimed_at IS NOT NULL AS claimed, consumed_at IS NOT NULL AS consumed
         FROM device_link_codes WHERE code IN ('PEND2345', 'BEAR2345', 'EXPD2345', 'OLDD2345')
        ORDER BY code`,
    ).all(),
    link_code_count: (db.prepare('SELECT COUNT(*) AS n FROM device_link_codes').get() as { n: number }).n,
  }
  await iptv.close()
  fs.writeFileSync(process.env.GOLDEN_OUT!, JSON.stringify(result))
}
