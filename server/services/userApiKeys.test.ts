import { describe, it, expect, beforeEach } from 'vitest'
import {
  API_KEY_MAX_LEN,
  decryptApiKey,
  deleteUserApiKey,
  encryptApiKey,
  getUserApiKey,
  getUserApiKeyInfo,
  isPlausibleAnthropicKey,
  setUserApiKey,
} from './userApiKeys.js'
import { serverDb } from './serverDb.js'

// Per-worker SERVER_DB_PATH isolation comes from vitest.setup.ts; rows are
// wiped between tests so this file can share a worker with the route tests.

const SUB = 'plex:301'
const KEY = 'sk-ant-api03-roundtrip-test-key-AAAA'

beforeEach(() => {
  serverDb().raw.exec('DELETE FROM user_api_keys;')
})

describe('userApiKeys — crypto round-trip', () => {
  it('encrypt → decrypt returns the original key', () => {
    const ct = encryptApiKey(SUB, KEY)
    expect(decryptApiKey(SUB, ct)).toBe(KEY)
  })

  it('ciphertext never contains the plaintext and differs per write (random IV)', () => {
    const a = encryptApiKey(SUB, KEY)
    const b = encryptApiKey(SUB, KEY)
    expect(a).not.toBe(b)
    expect(Buffer.from(a, 'base64').toString('latin1')).not.toContain('sk-ant-')
  })

  it('a row copied between subs fails AAD authentication (returns null)', () => {
    const ct = encryptApiKey(SUB, KEY)
    expect(decryptApiKey('plex:999', ct)).toBeNull()
  })

  it('tampered or garbage ciphertext returns null, never throws', () => {
    const ct = Buffer.from(encryptApiKey(SUB, KEY), 'base64')
    ct[ct.length - 1] ^= 0xff // flip a tag bit
    expect(decryptApiKey(SUB, ct.toString('base64'))).toBeNull()
    expect(decryptApiKey(SUB, 'not-base64-!!')).toBeNull()
    expect(decryptApiKey(SUB, '')).toBeNull()
  })
})

describe('userApiKeys — storage', () => {
  it('set → get round-trips per sub, and subs are isolated', () => {
    setUserApiKey(SUB, KEY)
    setUserApiKey('plex:302', 'sk-ant-api03-other-user-key-BBBB')
    expect(getUserApiKey(SUB)).toBe(KEY)
    expect(getUserApiKey('plex:302')).toBe('sk-ant-api03-other-user-key-BBBB')
    expect(getUserApiKey('plex:303')).toBeNull()
  })

  it('set replaces an existing key', () => {
    setUserApiKey(SUB, KEY)
    setUserApiKey(SUB, 'sk-ant-api03-replacement-key-CCCC')
    expect(getUserApiKey(SUB)).toBe('sk-ant-api03-replacement-key-CCCC')
  })

  it('info exposes only set + last4, never the key', () => {
    setUserApiKey(SUB, KEY)
    const info = getUserApiKeyInfo(SUB)
    expect(info).toEqual({ set: true, last4: KEY.slice(-4) })
    expect(JSON.stringify(info)).not.toContain('sk-ant-')
  })

  it('delete removes the row and reports whether one existed', () => {
    setUserApiKey(SUB, KEY)
    expect(deleteUserApiKey(SUB)).toBe(true)
    expect(deleteUserApiKey(SUB)).toBe(false)
    expect(getUserApiKey(SUB)).toBeNull()
    expect(getUserApiKeyInfo(SUB)).toEqual({ set: false })
  })

  it('an undecryptable stored row reads as "no key" (secret rotation posture)', () => {
    serverDb()
      .raw.prepare(
        `INSERT INTO user_api_keys (sub, ciphertext, updated_at) VALUES (?, ?, datetime('now'))`,
      )
      .run(SUB, Buffer.from('junk-from-an-old-secret').toString('base64'))
    expect(getUserApiKey(SUB)).toBeNull()
    expect(getUserApiKeyInfo(SUB)).toEqual({ set: false })
  })
})

describe('userApiKeys — validation', () => {
  it('accepts a normal sk-ant key and rejects malformed input', () => {
    expect(isPlausibleAnthropicKey(KEY)).toBe(true)
    expect(isPlausibleAnthropicKey('')).toBe(false)
    expect(isPlausibleAnthropicKey('sk-ant-')).toBe(false)
    expect(isPlausibleAnthropicKey('not-a-key')).toBe(false)
    expect(isPlausibleAnthropicKey('sk-ant-with space')).toBe(false)
    expect(isPlausibleAnthropicKey('sk-ant-with\nnewline')).toBe(false)
    expect(isPlausibleAnthropicKey('sk-ant-' + 'x'.repeat(API_KEY_MAX_LEN))).toBe(false)
  })
})
