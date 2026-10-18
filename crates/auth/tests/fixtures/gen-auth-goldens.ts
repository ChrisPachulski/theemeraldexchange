// Writes auth-goldens.json from the TS auth (server/session.ts,
// middleware/auth.ts, the /api/me router) under fixed test secrets:
//   - cookies:      session cookies minted by TS/jose, with verifySession's verdict
//   - rust_minted:  rust-minted-cookies.json run through verifySession (rollback safety)
//   - set_cookie:   setSessionCookie's header per deployment posture, http and https
//   - seed/scenarios/final: a server.db seed, requests through requireAuth /
//     requireAdmin / /api/me with their responses, and the device-token state after
// The Rust tests (session/tests.rs, reconcile/tests.rs) replay all of it. Each
// posture runs in a child process because env.ts reads its settings at import.
// server/ is gone from this branch, so the TS comes from the main checkout
// (EEX_MAIN_CHECKOUT, default ~/theemeraldexchange), which is only read; it
// needs its node_modules and the built contracts-napi binding.
// route-goldens.json is not rewritten here: its generator (this file at
// 25de8f6^) needed the port branch's server/test/iptvStub.ts, which main lacks.
// Run from this repo's root:
//   cargo test -p auth -- --ignored write_rust_minted_cookies
//   npx tsx crates/auth/tests/fixtures/gen-auth-goldens.ts
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const here = path.dirname(self)
const main = process.env.EEX_MAIN_CHECKOUT ?? path.join(os.homedir(), 'theemeraldexchange')
const server = path.join(main, 'server')
// The main checkout's hono, so setSessionCookie gets the Context class it expects.
const honoEntry = path.join(main, 'node_modules/hono/dist/index.js')

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
      EEX_MAIN_CHECKOUT: main,
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
} else {
  const { Hono } = await import(honoEntry)
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
      [
        'ts plex sign-in with a plex token',
        await session.createSession({
          sub: 'plex:42', username: 'P', role: 'user', auth_mode: 'plex', plexAuthToken: 'plex-golden-token',
        }),
      ],
      [
        'ts plex sign-in with a verified server id',
        await session.createSession({
          sub: 'plex:42', username: 'P', role: 'admin', auth_mode: 'plex', plexAuthToken: 'plex-golden-token',
          verifiedPlexServerId: 'golden-machine-id',
        }),
      ],
      ['non-string plexAuthToken', await jwe({ ...valid, sub: 'plex:42', auth_mode: 'plex', plexAuthToken: 42 })],
      ['empty plexAuthToken', await jwe({ ...valid, sub: 'plex:42', auth_mode: 'plex', plexAuthToken: '' })],
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
