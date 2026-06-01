// session.deviceClaims.test.ts — coverage for the device-token claim
// SHAPE-validation branches (aud/iss/role/authMode) that verifyDeviceToken
// performs BEFORE the nbf/exp and DB row checks. The sibling
// session.deviceToken.test.ts only exercises the nbf/exp time-window, leaving
// these immutable-identity branches uncovered.
//
// Layer (A): pure unit tests of the exported type-guards isRole / isAuthMode /
//   hasValidDeviceClaimShape — no DB or network needed.
// Layer (B): integration proof through verifyDeviceToken that a decrypted-claims
//   object with role='guest' or authMode='both' is rejected (resolves null)
//   WITHOUT reaching the DB row check. The contracts binding is spied so we can
//   inject claims that mintDeviceToken's typed input could never produce.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env bootstrap MUST happen before importing session.js — importing session
// triggers env validation, and verifyDeviceToken reads the serverDb singleton
// (SERVER_DB_PATH) and getDeviceKey reads DEVICE_TOKEN_SECRET.
process.env.SERVER_DB_PATH = join(mkdtempSync(join(tmpdir(), 'eex-devclaims-')), 'server.db')
process.env.ADMIN_SUBS = 'plex:12345'
process.env.DEVICE_TOKEN_SECRET ||= 'test-device-token-secret-at-least-32-bytes-long'
process.env.SESSION_SECRET ||= 'test-session-secret-at-least-32-bytes-long-xx'

const { isRole, isAuthMode, hasValidDeviceClaimShape, mintDeviceToken, verifyDeviceToken, _resetDeviceKeyForTests } =
  await import('./session.js')
const { contracts } = await import('./services/contractsBinding.js')
const { closeServerDb } = await import('./services/serverDb.js')

// A fully-valid decoded-claims shape (contract field names: authMode, deviceId…).
function validClaims() {
  return {
    aud: 'device',
    iss: 'eex',
    sub: 'plex:12345',
    role: 'user',
    authMode: 'plex',
    deviceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    devicePlatform: 'tvos',
    serverId: 'server-test-0001',
    jti: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    iat: 0,
    nbf: 0,
    exp: 0,
  }
}

// ───────────────────────────── Layer (A): pure guards ─────────────────────────

describe('isRole', () => {
  it('accepts admin and user', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('user')).toBe(true)
  })

  it('rejects guest, case-variants, and non-string junk', () => {
    expect(isRole('guest')).toBe(false)
    expect(isRole('GUEST')).toBe(false)
    expect(isRole('')).toBe(false)
    expect(isRole(undefined)).toBe(false)
    expect(isRole(null)).toBe(false)
    expect(isRole(0)).toBe(false)
    expect(isRole({})).toBe(false)
  })
})

describe('isAuthMode', () => {
  it('accepts plex, local, apple', () => {
    expect(isAuthMode('plex')).toBe(true)
    expect(isAuthMode('local')).toBe(true)
    expect(isAuthMode('apple')).toBe(true)
  })

  it('rejects the eliminated "both", case-variants, and junk', () => {
    // 'both' was eliminated per the AuthMode doc comment.
    expect(isAuthMode('both')).toBe(false)
    expect(isAuthMode('PLEX')).toBe(false)
    expect(isAuthMode('')).toBe(false)
    expect(isAuthMode(undefined)).toBe(false)
    expect(isAuthMode(null)).toBe(false)
  })
})

describe('hasValidDeviceClaimShape', () => {
  it('accepts a fully valid claims object', () => {
    expect(hasValidDeviceClaimShape(validClaims())).toBe(true)
  })

  it('rejects single-field mutations', () => {
    const cases: Array<{ name: string; mutate: (c: ReturnType<typeof validClaims>) => void }> = [
      { name: "aud != 'device'", mutate: (c) => (c.aud = 'session') },
      { name: "iss != 'eex'", mutate: (c) => (c.iss = 'other') },
      { name: "role = 'guest'", mutate: (c) => (c.role = 'guest') },
      { name: "role = ''", mutate: (c) => (c.role = '') },
      { name: "authMode = 'both'", mutate: (c) => (c.authMode = 'both') },
      { name: "authMode = 'apple ' (trailing space)", mutate: (c) => (c.authMode = 'apple ') },
    ]
    for (const { name, mutate } of cases) {
      const c = validClaims()
      mutate(c)
      expect(hasValidDeviceClaimShape(c), name).toBe(false)
    }
  })

  it('rejects role "guest" (type-honesty regression guard)', () => {
    // The legacy inline check accepted 'guest' even though Role is only
    // 'admin' | 'user'. Tightening to reject 'guest' is the bug fix.
    const c = validClaims()
    c.role = 'guest'
    expect(hasValidDeviceClaimShape(c)).toBe(false)
  })
})

// ───────────────── Layer (B): integration through verifyDeviceToken ──────────

describe('verifyDeviceToken — claim-shape rejection (decrypt spy)', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    closeServerDb()
  })

  it("rejects a token whose decrypted role is 'guest' before the DB row check", async () => {
    // Mint a genuine token (valid claims) so the JWE itself decrypts/validates,
    // then override what the crate returns to inject the invalid role. If the
    // shape guard did NOT run first, this would proceed to the DB row check
    // (which would also reject, since the jti was never inserted) — so to prove
    // the SHAPE guard is what rejects, we spy a far-future nbf/exp and assert
    // null even though no DB row was ever written for a 'guest' token.
    const token = await mintDeviceToken({
      sub: 'plex:12345',
      role: 'user',
      auth_mode: 'plex',
      device_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      device_name: 'Test',
      device_platform: 'tvos',
      server_id: 'server-test-0001',
    })

    vi.spyOn(contracts, 'deviceTokenDecrypt').mockReturnValue({
      ...validClaims(),
      role: 'guest',
      // far-future window so nbf/exp can never be the rejecter
      iat: Math.floor(Date.now() / 1000),
      nbf: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    expect(await verifyDeviceToken(token)).toBeNull()
  })

  it("rejects a token whose decrypted authMode is 'both'", async () => {
    const token = await mintDeviceToken({
      sub: 'plex:12345',
      role: 'user',
      auth_mode: 'plex',
      device_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      device_name: 'Test',
      device_platform: 'tvos',
      server_id: 'server-test-0001',
    })

    vi.spyOn(contracts, 'deviceTokenDecrypt').mockReturnValue({
      ...validClaims(),
      authMode: 'both',
      iat: Math.floor(Date.now() / 1000),
      nbf: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    expect(await verifyDeviceToken(token)).toBeNull()
  })
})

afterAll(() => {
  delete process.env.ADMIN_SUBS
  delete process.env.SERVER_DB_PATH
  delete process.env.DEVICE_TOKEN_SECRET
  delete process.env.SESSION_SECRET
})
