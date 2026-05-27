import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Stand up SERVER_DB_PATH BEFORE importing the modules so env.ts and
// serverDb.ts see a fresh tmpdir-backed DB per test run.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-device-test-'))
process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')

// Import AFTER setting env so the singleton picks up our path.
const { mintDeviceToken, verifyDeviceToken, _resetDeviceKeyForTests, revokeDeviceToken } =
  await import('../session.js')
const { closeServerDb } = await import('../services/serverDb.js')

const SAMPLE_INPUT = {
  sub: 'plex:12345',
  role: 'user' as const,
  auth_mode: 'plex' as const,
  device_id: '01HABCDEFGHJKMNPQRSTVWXYZ0',
  device_name: 'Living Room Apple TV',
  device_platform: 'tvos',
  server_id: '01HXYZ01234567890ABCDEFGHJ',
}

describe('mintDeviceToken + verifyDeviceToken', () => {
  beforeEach(() => {
    _resetDeviceKeyForTests()
  })

  afterEach(() => {
    closeServerDb()
  })

  it('mints a JWE that decrypts back to the same claims', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    expect(typeof token).toBe('string')
    // JWE compact form: 5 segments joined by '.'
    expect(token.split('.').length).toBe(5)

    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()
    expect(claims!.aud).toBe('device')
    expect(claims!.iss).toBe('eex')
    expect(claims!.sub).toBe(SAMPLE_INPUT.sub)
    expect(claims!.role).toBe(SAMPLE_INPUT.role)
    expect(claims!.auth_mode).toBe(SAMPLE_INPUT.auth_mode)
    expect(claims!.device_id).toBe(SAMPLE_INPUT.device_id)
    expect(claims!.device_platform).toBe(SAMPLE_INPUT.device_platform)
    expect(claims!.server_id).toBe(SAMPLE_INPUT.server_id)
    expect(typeof claims!.jti).toBe('string')
    expect(claims!.jti.length).toBe(26) // ULID
  })

  it('verifyDeviceToken returns null when the jti row is missing', async () => {
    // Mint a token whose jti will be deleted from device_tokens before verify.
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()

    const { serverDb } = await import('../services/serverDb.js')
    serverDb().raw.prepare('DELETE FROM device_tokens WHERE jti = ?').run(claims!.jti)

    const again = await verifyDeviceToken(token)
    expect(again).toBeNull()
  })

  it('verifyDeviceToken returns null when the jti is revoked', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    const claims = await verifyDeviceToken(token)
    expect(claims).not.toBeNull()

    revokeDeviceToken(claims!.jti, 'test_revoke')

    const again = await verifyDeviceToken(token)
    expect(again).toBeNull()
  })

  it('verifyDeviceToken returns null on tampered ciphertext', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    // Flip a byte in segment 3 (ciphertext)
    const parts = token.split('.')
    parts[3] = parts[3].slice(0, -1) + (parts[3].endsWith('A') ? 'B' : 'A')
    const tampered = parts.join('.')
    const claims = await verifyDeviceToken(tampered)
    expect(claims).toBeNull()
  })

  it('verifyDeviceToken returns null on unknown kid', async () => {
    const token = await mintDeviceToken(SAMPLE_INPUT)
    // Replace the protected header with one carrying a different kid.
    const parts = token.split('.')
    const fakeHeader = Buffer.from(
      JSON.stringify({ alg: 'dir', enc: 'A256GCM', kid: 'device-v99' }),
    ).toString('base64url')
    parts[0] = fakeHeader
    const swapped = parts.join('.')
    const claims = await verifyDeviceToken(swapped)
    expect(claims).toBeNull()
  })
})
