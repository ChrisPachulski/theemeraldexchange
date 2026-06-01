// session.deviceToken.test.ts — regression guard for the nbf/exp time-window
// enforcement INSIDE verifyDeviceToken (the verify chokepoint).
//
// The crate's deviceTokenDecrypt validates aud/iss/kid only — it does NOT
// enforce the JWE's own nbf/exp claims. Historically the only nbf/exp check
// lived in the tryBearerAuth middleware, so any caller using verifyDeviceToken
// directly got ZERO time-window enforcement (a §3.5 / defense-in-depth hole).
//
// These tests exercise verifyDeviceToken DIRECTLY (not via middleware) so the
// regression guard sits on the function the survivor names. Each negative case
// is constructed so ONLY the new JWE-claim guard — not the DB row's stored
// expires_at — can produce the null (see case 3 and case 4).

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env bootstrap MUST happen before importing session.js — verifyDeviceToken
// reads the serverDb singleton (SERVER_DB_PATH) and getDeviceKey reads
// DEVICE_TOKEN_SECRET; memberStatus short-circuits the ADMIN_SUBS entry so no
// members seeding is needed.
process.env.SERVER_DB_PATH = join(mkdtempSync(join(tmpdir(), 'eex-devtoken-')), 'server.db')
process.env.ADMIN_SUBS = 'plex:12345'
process.env.DEVICE_TOKEN_SECRET ||= 'test-device-token-secret-at-least-32-bytes-long'
process.env.SESSION_SECRET ||= 'test-session-secret-at-least-32-bytes-long-xx'

const { mintDeviceToken, verifyDeviceToken, _resetDeviceKeyForTests } = await import('./session.js')
const { serverDb, closeServerDb } = await import('./services/serverDb.js')

const SAMPLE_INPUT = {
  sub: 'plex:12345',
  role: 'user' as const,
  auth_mode: 'plex' as const,
  device_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  device_name: 'Test Apple TV',
  device_platform: 'tvos',
  server_id: 'server-test-0001',
}

describe('verifyDeviceToken — nbf/exp JWE time-window enforcement', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    closeServerDb()
  })

  it('case 1 — happy path: a freshly minted token verifies non-null', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()
    expect(claims!.sub).toBe('plex:12345')
    expect(claims!.role).toBe('user')
    expect(claims!.auth_mode).toBe('plex')
    expect(claims!.jti).toBeTruthy()
  })

  it('case 2 — exp enforced: a token past exp returns null', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()
    const exp = claims!.exp

    vi.useFakeTimers()
    vi.setSystemTime(new Date((exp + 60) * 1000))
    expect(await verifyDeviceToken(token)).toBeNull()
  })

  it('case 3 — nbf enforced: not-yet-valid token returns null; within-skew accepted', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()
    const nbf = claims!.nbf

    vi.useFakeTimers()
    // 60s before nbf — beyond the 30s skew. The DB row check
    // (expires_at > datetime('now')) still PASSES here (expiry is far
    // future), so ONLY the new nbf guard can produce the null.
    vi.setSystemTime(new Date((nbf - 60) * 1000))
    expect(await verifyDeviceToken(token)).toBeNull()

    // 10s before nbf — within the 30s skew → accepted.
    vi.setSystemTime(new Date((nbf - 10) * 1000))
    expect(await verifyDeviceToken(token)).not.toBeNull()
  })

  it('case 4 — exp guard is independent of the DB row (isolation proof)', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()
    const { exp, jti } = claims!

    // Push the DB row's stored expires_at 10 years out so the row check
    // CANNOT be what rejects the token — only the JWE exp claim can.
    const farFuture = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString()
    serverDb()
      .raw.prepare('UPDATE device_tokens SET expires_at = ? WHERE jti = ?')
      .run(farFuture, jti)

    vi.useFakeTimers()
    vi.setSystemTime(new Date((exp + 60) * 1000))
    expect(await verifyDeviceToken(token)).toBeNull()
  })

  it('case 5 — within-skew acceptance for exp: a still-valid token is accepted', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()
    const exp = claims!.exp

    vi.useFakeTimers()
    vi.setSystemTime(new Date((exp - 60) * 1000))
    expect(await verifyDeviceToken(token)).not.toBeNull()
  })
})

afterAll(() => {
  delete process.env.ADMIN_SUBS
  delete process.env.SERVER_DB_PATH
  delete process.env.DEVICE_TOKEN_SECRET
  delete process.env.SESSION_SECRET
})
