// Per-user BYO Anthropic API key, encrypted at rest in server.db.
//
// History: the key used to live in SPA localStorage and ride every
// /api/suggestions request as the X-Anthropic-Api-Key header. Plaintext
// localStorage is readable by any same-origin script (one XSS = key
// exfiltration) and survives on shared devices. The key now persists
// server-side, per sub, and the suggestions path reads it when the
// client header is absent (header still wins for back-compat).
//
// Crypto: AES-256-GCM. The data key is HKDF-derived from SESSION_SECRET
// with the dedicated info label 'eex/user-api-key/v1' (keyDerivation.ts)
// so it is domain-separated from session/device/stream keys. Each row is
// base64(iv || ciphertext || tag) with a random 12-byte IV per write, and
// the owning sub is bound as AAD — decrypting user A's row under user B's
// sub fails authentication, so rows cannot be swapped at the storage
// layer.
//
// INVARIANT: the plaintext key must NEVER be logged, included in an error
// message, or returned by any surface other than getUserApiKey() (which
// only the suggestions key-resolution consumes). UI surfaces get the
// masked last-4 fingerprint from getUserApiKeyInfo().

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { deriveKey, INFO_USER_API_KEY } from './keyDerivation.js'
import { env } from '../env.js'
import { serverDb } from './serverDb.js'

const IV_LEN = 12 // AES-GCM standard nonce size
const TAG_LEN = 16

// Validation shared by the route and any future writer. Anthropic keys
// are 'sk-ant-' prefixed; the length cap bounds hostile input without
// assuming Anthropic's exact format stays fixed.
export const API_KEY_PREFIX = 'sk-ant-'
export const API_KEY_MAX_LEN = 512

export function isPlausibleAnthropicKey(key: string): boolean {
  return (
    key.startsWith(API_KEY_PREFIX) &&
    key.length > API_KEY_PREFIX.length &&
    key.length <= API_KEY_MAX_LEN &&
    // single-line, no whitespace — rejects paste accidents that would
    // otherwise be stored verbatim and fail confusingly at call time
    !/\s/.test(key)
  )
}

let cachedDataKey: Buffer | null = null
function dataKey(): Buffer {
  if (!cachedDataKey) cachedDataKey = deriveKey(env.sessionSecret, INFO_USER_API_KEY)
  return cachedDataKey
}

function aad(sub: string): Buffer {
  return Buffer.from(`eex/user-api-key/v1:${sub}`, 'utf8')
}

/** Encrypt a key for `sub`. Exported for tests; not used outside this module
 *  and the test file. */
export function encryptApiKey(sub: string, plaintext: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv)
  cipher.setAAD(aad(sub))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ct, tag]).toString('base64')
}

/** Decrypt `sub`'s row. Returns null on any failure (tampered row, secret
 *  rotation, row copied between subs) — callers treat that as "no key".
 *  Never throws and never logs the payload. */
export function decryptApiKey(sub: string, stored: string): string | null {
  try {
    const raw = Buffer.from(stored, 'base64')
    if (raw.length < IV_LEN + TAG_LEN + 1) return null
    const iv = raw.subarray(0, IV_LEN)
    const tag = raw.subarray(raw.length - TAG_LEN)
    const ct = raw.subarray(IV_LEN, raw.length - TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', dataKey(), iv)
    decipher.setAAD(aad(sub))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** Store (insert or replace) the user's key. Caller validates first. */
export function setUserApiKey(sub: string, key: string): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO user_api_keys (sub, ciphertext, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(sub) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at`,
    )
    .run(sub, encryptApiKey(sub, key))
}

/** The stored plaintext key for `sub`, or null when absent/undecryptable.
 *  ONLY the suggestions key-resolution path may consume this. */
export function getUserApiKey(sub: string): string | null {
  const row = serverDb()
    .raw.prepare('SELECT ciphertext FROM user_api_keys WHERE sub = ?')
    .get(sub) as { ciphertext: string } | undefined
  if (!row) return null
  return decryptApiKey(sub, row.ciphertext)
}

/** Masked, UI-safe view: whether a key is stored plus its last 4 chars.
 *  An undecryptable row (secret rotated, tampered) reports set:false so
 *  the UI prompts for a fresh key instead of showing a phantom one. */
export function getUserApiKeyInfo(sub: string): { set: boolean; last4?: string } {
  const key = getUserApiKey(sub)
  if (!key) return { set: false }
  return { set: true, last4: key.slice(-4) }
}

/** Remove the stored key. Returns true when a row existed. */
export function deleteUserApiKey(sub: string): boolean {
  const r = serverDb().raw.prepare('DELETE FROM user_api_keys WHERE sub = ?').run(sub)
  return r.changes > 0
}
