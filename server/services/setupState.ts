// First-owner claim state (plan 006 Phase 1).
//
// A fresh install needs a first-owner path even when Apple or Google login
// is configured to fail closed for unlisted identities. This module keeps
// ownership claimability separate from normal-login authZ and secures the
// first passkey registration against the nginx-ui advisory
// (GHSA-mxqh-q9h6-v8pq):
//
//   - secures: while the install is claimable, boot mints a one-time
//     SETUP TOKEN (256-bit, sha256-persisted, plaintext printed to stdout
//     and ${data}/.setup-token 0600). Passkey registration on a claimable
//     install REQUIRES the token — possession of the box's logs/disk is
//     the proof of ownership.
//   - finishes: the claim mints the first member row as role 'admin'
//     (older releases could admit an owner as a row-less 'user', so the
//     allowlist never seeded). Writing the row
//     creates a durable ownership gate and the window is gone for good.
//
// Storage: the existing server_state KV table — no new migration.
// The token is REGENERATED on every boot while claimable (the plaintext
// is never persisted beyond the 0600 file, so a lost token just means
// "restart and read the log again").

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serverDb } from './serverDb.js'
import { hasDurableOwnershipGate } from './membership.js'
import { env } from '../env.js'

const TOKEN_HASH_KEY = 'setup_token_hash'
const CLAIMED_KEY = 'setup_claimed_by'

function sha256Hex(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

function getState(key: string): string | null {
  const row = serverDb()
    .raw.prepare(`SELECT value FROM server_state WHERE key = ?`)
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

function setState(key: string, value: string): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO server_state (key, value, ts) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
    )
    .run(key, value)
}

/**
 * True while the install can still be claimed: no durable ownership gate and
 * no explicit claim marker. Identity-provider configuration alone intentionally
 * does not close this path; a provider client id cannot prove server ownership.
 */
export function isClaimable(): boolean {
  if (hasDurableOwnershipGate()) return false
  return getState(CLAIMED_KEY) === null
}

/**
 * Boot hook: while claimable, mint (or re-mint) the setup token and
 * surface the plaintext to the operator via stdout + a 0600 file next to
 * the server db. No-op once ownership is claimed or durably gated.
 */
export function ensureSetupToken(): void {
  if (!isClaimable()) return
  const token = randomBytes(32).toString('hex')
  setState(TOKEN_HASH_KEY, sha256Hex(token))
  const tokenPath = join(dirname(env.SERVER_DB_PATH), '.setup-token')
  try {
    writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
    chmodSync(tokenPath, 0o600) // writeFileSync mode is ignored if the file existed
  } catch {
    console.warn(
      '[setup] could not write the setup token file; use the one-time token printed below.',
    )
  }
  const configuredProviders: string[] = []
  if (env.plexClientId) configuredProviders.push('plex')
  if (env.appleClientId) configuredProviders.push('apple')
  if ((env.googleClientIds ?? []).length > 0) configuredProviders.push('google')
  if (configuredProviders.length > 0) {
    const verb = configuredProviders.length === 1 ? 'is' : 'are'
    console.warn(
      `[setup] ${configuredProviders.join(' and ')} sign-in ${verb} configured, ` +
        'but this server is still unclaimed. Initial ownership requires a ' +
        'passkey and the one-time setup token.',
    )
  }
  // The banner IS the distribution channel — keep it loud and copyable.
  console.info(
    '\n[setup] ════════════════════════════════════════════════════════════\n' +
      '[setup] This server is unclaimed. To become its owner, open the app\n' +
      '[setup] and register a passkey with this one-time setup token:\n' +
      `[setup]     ${token}\n` +
      `[setup] (also written to ${tokenPath})\n` +
      '[setup] ════════════════════════════════════════════════════════════\n',
  )
}

/** Constant-time token check. Only meaningful while claimable. */
export function verifySetupToken(token: string): boolean {
  if (!isClaimable()) return false
  const storedHash = getState(TOKEN_HASH_KEY)
  if (!storedHash) return false
  const a = Buffer.from(sha256Hex(token), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Record the claim and burn the token. Called inside the claim
 * transaction AFTER the admin member row is written — the members row closes
 * durable setup, and this key stops a second token holder (there is none, but
 * belt-and-braces) from re-claiming.
 */
export function markClaimed(sub: string): void {
  setState(CLAIMED_KEY, sub)
  serverDb().raw.prepare(`DELETE FROM server_state WHERE key = ?`).run(TOKEN_HASH_KEY)
}

// ── claim-source gate ───────────────────────────────────────────────────
//
// The nginx-ui advisory's second recommendation: bind initial setup to
// local access paths. Pure loopback would break the normal "browse from a
// LAN laptop to the NAS" flow (and docker bridge traffic never looks like
// loopback), so the default gate is loopback + private ranges (RFC1918,
// CGNAT/tailnet 100.64/10, IPv6 ULA + link-local). A deliberately
// remote-first install (claiming through a tunnel) sets
// SETUP_ALLOW_REMOTE=1 — the token is still required either way.

const V4_PRIVATE = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 172.16/12
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10 (tailnet)
  /^169\.254\./, // link-local
]

export function isPrivateAddress(addr: string): boolean {
  let ip = addr.trim().toLowerCase()
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  if (ip.startsWith('::ffff:')) ip = ip.slice(7) // v4-mapped v6
  if (ip === '::1') return true // v6 loopback
  if (/^fe80:/.test(ip)) return true // v6 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true // v6 ULA fc00::/7
  return V4_PRIVATE.some((re) => re.test(ip))
}

/** May a claim attempt proceed from this socket address? */
export function claimSourceAllowed(remoteAddr: string | undefined): boolean {
  if (env.setupAllowRemote) return true
  if (!remoteAddr) return false // fail closed when the socket is unreadable
  return isPrivateAddress(remoteAddr)
}
