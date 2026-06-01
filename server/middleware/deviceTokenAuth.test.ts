import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Stand up SERVER_DB_PATH + ADMIN_SUBS BEFORE importing any server module so
// env.ts and the serverDb singleton pick up our tmpdir-backed DB and the
// owner-bootstrap allowlist. memberStatus() short-circuits an ADMIN_SUBS entry
// to 'allowed' before any DB read (server/services/membership.ts), so the
// reconcile pass succeeds for sub 'plex:12345' WITHOUT seeding the members
// table.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-devauth-test-'))
process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')
process.env.ADMIN_SUBS = 'plex:12345'

// Import AFTER setting env so the singletons + env.ts read our values.
const { mintDeviceToken, verifyDeviceToken, _resetDeviceKeyForTests } = await import(
  '../session.js'
)
const { tryBearerAuth, deviceSessionToSession } = await import('./deviceTokenAuth.js')
const { serverDb, closeServerDb } = await import('../services/serverDb.js')

const SAMPLE_INPUT = {
  sub: 'plex:12345',
  role: 'user' as const,
  auth_mode: 'plex' as const,
  device_id: '01HABCDEFGHJKMNPQRSTVWXYZ0',
  device_name: 'Living Room Apple TV',
  device_platform: 'tvos',
  server_id: '01HXYZ01234567890ABCDEFGHJ',
}

/** Minimal Hono Context exposing only c.req.header(name) with a
 *  case-insensitive lookup (tryBearerAuth reads Authorization/authorization
 *  and X-App-Version). */
function ctx(headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return {
    req: { header: (n: string) => lower[n.toLowerCase()] },
  } as unknown as import('hono').Context
}

describe('tryBearerAuth (deviceTokenAuth middleware)', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
  })

  afterEach(() => {
    // Always restore real timers so fake-clock leakage cannot bleed into
    // other test files / cases.
    vi.useRealTimers()
    closeServerDb()
  })

  it('returns null when NO Authorization header is present (caller falls back to cookie)', async () => {
    const result = await tryBearerAuth(ctx({}))
    expect(result).toBe(null)
  })

  it('returns null when the Authorization header does not start with "Bearer "', async () => {
    const result = await tryBearerAuth(ctx({ Authorization: 'Basic abc' }))
    expect(result).toBe(null)
  })

  it('returns invalid_bearer for a "Bearer " header with an empty/whitespace-only token', async () => {
    const result = await tryBearerAuth(ctx({ Authorization: 'Bearer    ' }))
    expect(result).toEqual({ ok: false, reason: 'invalid_bearer' })
  })

  it('returns invalid_bearer for an undecryptable Bearer token', async () => {
    const result = await tryBearerAuth(ctx({ Authorization: 'Bearer garbage.not.a.jwe' }))
    expect(result).toEqual({ ok: false, reason: 'invalid_bearer' })
  })

  it('HAPPY PATH: a freshly minted token authenticates and maps into a Session', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const result = await tryBearerAuth(ctx({ Authorization: 'Bearer ' + token }))

    expect(result).not.toBeNull()
    if (!result || result.ok !== true) throw new Error('expected ok:true result')
    expect(result.ok).toBe(true)
    expect(result.session.sub).toBe('plex:12345')
    // device_name is surfaced as the username (deviceSessionToSession).
    expect(result.session.username).toBe('Living Room Apple TV')
    expect(result.session.role).toBe('user')
    expect(result.session.auth_mode).toBe('plex')
    // Device tokens carry no Plex token.
    expect(result.session.plexAuthToken).toBeUndefined()
  })

  it('threads X-App-Version through reconcile onto the device_tokens row', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const result = await tryBearerAuth(
      ctx({ Authorization: 'Bearer ' + token, 'X-App-Version': '1.2.3' }),
    )

    expect(result).not.toBeNull()
    if (!result || result.ok !== true) throw new Error('expected ok:true result')

    const row = serverDb()
      .raw.prepare('SELECT last_seen_version FROM device_tokens WHERE jti = ?')
      .get(result.claims.jti) as { last_seen_version: string | null } | undefined
    expect(row?.last_seen_version).toBe('1.2.3')
  })

  it('TIME-WINDOW (nbf): rejects a not-yet-valid token outside the 30s skew, accepts within it', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()
    const nbf = claims!.nbf

    // Clock set strictly more than 30s BEFORE nbf → not-yet-valid.
    vi.useFakeTimers()
    vi.setSystemTime(new Date((nbf - 60) * 1000))
    const tooEarly = await tryBearerAuth(ctx({ Authorization: 'Bearer ' + token }))
    expect(tooEarly).toEqual({ ok: false, reason: 'invalid_bearer' })

    // Advance to within the 30s skew window → now valid.
    vi.setSystemTime(new Date((nbf - 10) * 1000))
    const inSkew = await tryBearerAuth(ctx({ Authorization: 'Bearer ' + token }))
    expect(inSkew).not.toBeNull()
    if (!inSkew || inSkew.ok !== true) throw new Error('expected ok:true within nbf skew')
    expect(inSkew.ok).toBe(true)
  })

  it('TIME-WINDOW (exp): rejects a clearly-expired token (more than 5s past exp)', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()
    const exp = claims!.exp

    // Clock set strictly more than 5s AFTER exp → expired. Note: the jose/crate
    // decrypt may also reject within-skew on its own exp check before the
    // explicit guard runs, so we assert only the clearly-expired rejection to
    // avoid fighting the crypto layer.
    vi.useFakeTimers()
    vi.setSystemTime(new Date((exp + 60) * 1000))
    const expired = await tryBearerAuth(ctx({ Authorization: 'Bearer ' + token }))
    expect(expired).toEqual({ ok: false, reason: 'invalid_bearer' })
  })
})

describe('deviceSessionToSession', () => {
  it('maps device_name to username, passes through sub/role/auth_mode, and omits plexAuthToken', () => {
    const reconciled = {
      aud: 'device' as const,
      iss: 'eex' as const,
      sub: 'plex:67890',
      role: 'admin' as const,
      auth_mode: 'apple' as const,
      device_id: '01HABCDEFGHJKMNPQRSTVWXYZ1',
      device_platform: 'ios',
      server_id: '01HXYZ01234567890ABCDEFGHK',
      jti: '01HJTI0000000000000000000A',
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_000_000 + 1000,
      device_name: 'Bedroom iPad',
    }

    const session = deviceSessionToSession(reconciled)

    expect(session.username).toBe('Bedroom iPad')
    expect(session.sub).toBe('plex:67890')
    expect(session.role).toBe('admin')
    expect(session.auth_mode).toBe('apple')
    expect('plexAuthToken' in session).toBe(false)
  })
})
