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
// route-goldens.json's `plex` key comes from here too: /api/auth/plex/config,
// /plex/check, /methods and /logout through main's auth router, over a seeded
// server.db, with global fetch answering for plex.tv per scenario (nothing
// leaves the machine). The rest of route-goldens.json is kept as written at
// a2f555b: its generator (this file at 25de8f6^) needed the port branch's
// server/test/iptvStub.ts, which main lacks.
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
const PLEX_ADMIN = 'plex:4242' // ADMIN_SUBS in the plex route goldens, no row

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
  const routesFile = path.join(here, 'route-goldens.json')
  const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8')) as Json
  routes.plex = runChild('plex_routes', {
    SERVE_SPA: '0',
    ALLOWED_ORIGINS: 'https://app.example',
    ADMIN_SUBS: `${OWNER},${PLEX_ADMIN}`,
    PLEX_CLIENT_ID: 'golden-plex-client',
  })
  fs.writeFileSync(routesFile, JSON.stringify(routes, null, 2) + '\n')
} else if (process.env.GOLDEN_POSTURE === 'plex_routes') {
  await plexRouteGoldens()
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

// What the plex.tv stand-in answers for one scenario; route_goldens.rs serves
// the same from a local fake.
type PlexSpec = {
  token?: string | null
  pinStatus?: number
  retryAfter?: string
  user?: Json
  resources?: Json[]
  resourcesStatus?: number
  signoutStatus?: number
}

// Plex route goldens: web PIN sign-in, the Plex-share admission (PLEX_SERVER_ID
// flipped per scenario, as auth.test.ts does), discovery, and logout's plex.tv
// sign-out. Each check uses its own pinId, so no PIN bucket carries over.
async function plexRouteGoldens(): Promise<void> {
  const { createHash } = await import('node:crypto')
  const { Hono } = await import(honoEntry)
  const session = await import(path.join(server, 'session.js'))
  const { env } = await import(path.join(server, 'env.js'))
  const { serverDb } = await import(path.join(server, 'services/serverDb.js'))
  const { auth } = await import(path.join(server, 'auth.js'))

  let spec: PlexSpec = {}
  let calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== 'https://plex.tv') throw new Error(`unexpected fetch to ${url.origin}`)
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}${url.search}`)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname.startsWith('/api/v2/pins/')) {
      if (spec.pinStatus === 429) {
        return new Response('slow down', { status: 429, headers: spec.retryAfter ? { 'Retry-After': spec.retryAfter } : {} })
      }
      return json({ id: 1, code: 'abc', authToken: spec.token ?? null })
    }
    if (url.pathname === '/api/v2/user') return json(spec.user)
    if (url.pathname === '/api/v2/resources') return json(spec.resources ?? [], spec.resourcesStatus ?? 200)
    if (url.pathname === '/api/v2/signout') return new Response(null, { status: spec.signoutStatus ?? 204 })
    return new Response('not stubbed', { status: 599 })
  }) as typeof fetch

  const now = Math.floor(Date.now() / 1000)
  const db = serverDb().raw
  const member = db.prepare(
    `INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at)
     VALUES (?, ?, ?, 'plex', NULL, ?, ?)`,
  )
  member.run('plex:101', 'Member', 'user', '2026-10-04T00:00:00.000Z', null)
  member.run('plex:102', 'Plex Admin Row', 'admin', '2026-10-03T00:00:00.000Z', null)
  member.run('plex:107', 'Kicked', 'user', '2026-10-02T00:00:00.000Z', '2026-10-05T00:00:00.000Z')
  db.prepare(
    `INSERT INTO invites (code_hash, issued_by, label, role, expires_at, max_uses, used_count, created_at, revoked_at)
     VALUES (?, ?, 'Plex friend', 'user', NULL, 1, 0, '2026-10-06T00:00:00.000Z', NULL)`,
  ).run(createHash('sha256').update('golden-plex-invite').digest('hex'), OWNER)
  const dump = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  const result: Json = { minted_at: now, seed: { members: dump('members'), invites: dump('invites') } }

  const app = new Hono()
  app.route('/api/auth', auth)

  const user = (id: number, username: string) => ({
    id, uuid: `uuid-${id}`, username, email: `${username}@example.com`, thumb: null,
  })
  const homeServer = { name: 'Home', clientIdentifier: 'golden-server', owned: false, home: false, provides: 'server' }
  const otherServer = { name: 'Elsewhere', clientIdentifier: 'other-server', owned: true, home: false, provides: 'server,client' }
  const player = { name: 'Some Player', clientIdentifier: 'player-id', owned: false, home: false, provides: 'player' }
  const signedIn = (id: number, username: string, extra: PlexSpec = {}): PlexSpec => ({
    token: `plex-token-${id}`, user: user(id, username), ...extra,
  })
  const pin = (id: number, extra: Json = {}) => JSON.stringify({ pinId: id, ...extra })
  const plexCookie = async (token?: string) =>
    `eex.session=${await session.createSession({
      sub: 'plex:101', username: 'Member', role: 'user', auth_mode: 'plex',
      ...(token ? { plexAuthToken: token } : {}),
    })}`

  // name, method, path, headers, body, PLEX_SERVER_ID set, plex.tv spec
  type Scenario = [string, string, string, Record<string, string>, string | undefined, boolean, PlexSpec]
  const scenarios: Scenario[] = [
    ['plex config', 'GET', '/api/auth/plex/config', {}, undefined, false, {}],
    ['methods with plex configured', 'GET', '/api/auth/methods', {}, undefined, false, {}],
    ['check pending', 'POST', '/api/auth/plex/check', {}, pin(501), false, { token: null }],
    ['check pending (string pinId)', 'POST', '/api/auth/plex/check', {}, '{"pinId":" 502 "}', false, { token: null }],
    ['check empty token is pending', 'POST', '/api/auth/plex/check', {}, pin(503), false, { token: '' }],
    ['check no body', 'POST', '/api/auth/plex/check', {}, undefined, false, {}],
    ['check bad json', 'POST', '/api/auth/plex/check', {}, '{', false, {}],
    ['check pinId foo', 'POST', '/api/auth/plex/check', {}, '{"pinId":"foo"}', false, {}],
    ['check pinId 1.5', 'POST', '/api/auth/plex/check', {}, '{"pinId":1.5}', false, {}],
    ['check pinId empty string', 'POST', '/api/auth/plex/check', {}, '{"pinId":""}', false, {}],
    ['check oversized body', 'POST', '/api/auth/plex/check', {}, pin(504, { padding: 'x'.repeat(1024) }), false, {}],
    ['check plex.tv 429 numeric', 'POST', '/api/auth/plex/check', {}, pin(505), false, { pinStatus: 429, retryAfter: '17' }],
    ['check plex.tv 429 date', 'POST', '/api/auth/plex/check', {}, pin(506), false, { pinStatus: 429, retryAfter: 'Sat, 18 Jul 2026 23:59:59 GMT' }],
    ['check plex.tv 429 malformed', 'POST', '/api/auth/plex/check', {}, pin(507), false, { pinStatus: 429, retryAfter: 'eventually' }],
    ['check plex.tv 429 absent', 'POST', '/api/auth/plex/check', {}, pin(508), false, { pinStatus: 429 }],
    ['member signs in, servers discovered', 'POST', '/api/auth/plex/check', {}, pin(509), false,
      signedIn(101, 'Member', { resources: [homeServer, otherServer, player] })],
    ['member signs in, discovery fails', 'POST', '/api/auth/plex/check', {}, pin(510), false,
      signedIn(101, 'Member', { resourcesStatus: 503 })],
    ['ADMIN_SUBS plex owner signs in', 'POST', '/api/auth/plex/check', {}, pin(511), false, signedIn(4242, 'Owner')],
    ['admin member row signs in', 'POST', '/api/auth/plex/check', {}, pin(512), false, signedIn(102, 'Plex Admin Row')],
    ['stranger without invite', 'POST', '/api/auth/plex/check', {}, pin(513), false, signedIn(103, 'Stranger')],
    ['stranger with a bad invite', 'POST', '/api/auth/plex/check', {}, pin(514, { inviteCode: 'WRONG' }), false, signedIn(103, 'Stranger')],
    ['stranger redeems an invite', 'POST', '/api/auth/plex/check', {}, pin(515, { inviteCode: 'golden-plex-invite' }), false,
      signedIn(103, 'Stranger')],
    ['spent invite', 'POST', '/api/auth/plex/check', {}, pin(516, { inviteCode: 'golden-plex-invite' }), false, signedIn(104, 'Late')],
    ['shared on the home server is admitted', 'POST', '/api/auth/plex/check', {}, pin(517), true,
      signedIn(105, 'Friend', { resources: [homeServer, player] })],
    ['shared friend signs in again', 'POST', '/api/auth/plex/check', {}, pin(518), true, signedIn(105, 'Friend', { resources: [] })],
    ['on another server only', 'POST', '/api/auth/plex/check', {}, pin(519), true,
      signedIn(106, 'Elsewhere', { resources: [otherServer, player] })],
    ['share probe outage fails closed', 'POST', '/api/auth/plex/check', {}, pin(520), true,
      signedIn(108, 'Unlucky', { resourcesStatus: 503 })],
    ['share probe 401 fails closed', 'POST', '/api/auth/plex/check', {}, pin(521), true,
      signedIn(108, 'Unlucky', { resourcesStatus: 401 })],
    ['revoked member still shared', 'POST', '/api/auth/plex/check', {}, pin(522), true,
      signedIn(107, 'Kicked', { resources: [homeServer] })],
    ['member with the server id set', 'POST', '/api/auth/plex/check', {}, pin(523), true, signedIn(101, 'Member')],
    ['logout with a plex token', 'POST', '/api/auth/logout', { Cookie: await plexCookie('golden-logout-token') }, undefined, false, {}],
    ['logout when plex signout fails', 'POST', '/api/auth/logout', { Cookie: await plexCookie('golden-logout-token') }, undefined, false,
      { signoutStatus: 500 }],
    ['logout with a plex cookie and no token', 'POST', '/api/auth/logout', { Cookie: await plexCookie() }, undefined, false, {}],
    ['logout with a garbage cookie', 'POST', '/api/auth/logout', { Cookie: 'eex.session=garbage' }, undefined, false, {}],
  ]
  const envRw = env as { plexServerId: string | null }
  const ran = []
  for (const [label, method, p, headers, body, scoped, plex] of scenarios) {
    spec = plex
    calls = []
    envRw.plexServerId = scoped ? 'golden-server' : null
    const h = body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' }
    const r = await app.request(p, { method, headers: h, body })
    const setCookie = r.headers.get('set-cookie')
    const token = /^eex\.session=([^;]+)/.exec(setCookie ?? '')?.[1]
    const s = token ? await session.verifySession(token) : null
    ran.push({
      name: label, method, path: p, headers: h, body: body ?? null, server_id: scoped, plex,
      status: r.status, text: await r.text(),
      set_cookie: setCookie && token ? setCookie.replace(token, '<token>') : setCookie,
      session: s && { sub: s.sub, username: s.username, role: s.role, auth_mode: s.auth_mode, plexAuthToken: s.plexAuthToken ?? null },
      retry_after: r.headers.get('retry-after'),
      plex_calls: calls,
    })
  }
  result.scenarios = ran
  result.final = {
    members: db.prepare(
      `SELECT sub, display_name, role, auth_mode, invited_by, revoked_at IS NOT NULL AS revoked
         FROM members ORDER BY sub`,
    ).all(),
    invites: db.prepare('SELECT issued_by, used_count FROM invites ORDER BY rowid').all(),
  }
  fs.writeFileSync(process.env.GOLDEN_OUT!, JSON.stringify(result))
}
