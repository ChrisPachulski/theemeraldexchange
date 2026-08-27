// Ownership seal.
//
// The first proven administrator login (ADMIN_SUBS or legacy ADMINS) writes a
// one-way ownership marker into the existing server_state KV table. It is
// audit provenance only; authorization is always the members allowlist plus
// ADMIN_SUBS. A fresh install bootstraps its owner by listing a provider sub
// in ADMIN_SUBS — there is no in-band claim ceremony.

import { serverDb } from './serverDb.js'
import { parseSub } from './sub.js'

const TOKEN_HASH_KEY = 'setup_token_hash'
const CLAIMED_KEY = 'setup_claimed_by'

function getState(key: string): string | null {
  const row = serverDb()
    .raw.prepare(`SELECT value FROM server_state WHERE key = ?`)
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

function setStateOnce(key: string, value: string): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO server_state (key, value, ts) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(key, value)
}

/**
 * Persist the one-way ownership marker and burn any legacy claim-token hash.
 * Callers must already have verified the provider identity and effective admin
 * authority. Configured-admin login invokes it after shared authZ and before
 * minting a cookie or bearer token. The first proven identity is preserved.
 */
export function sealVerifiedAdminOwnership(sub: string): void {
  parseSub(sub)
  // Reconciliation runs on every protected request. Once sealed, keep that
  // hot path read-only instead of taking a SQLite write lock for every admin
  // request. The transaction below remains the race-safe first-write boundary.
  if (getState(CLAIMED_KEY) !== null) return
  const db = serverDb().raw
  const tx = db.transaction(() => {
    // Preserve the first proven owner as audit provenance. Later successful
    // administrator logins are idempotent and cannot reopen or rotate setup.
    setStateOnce(CLAIMED_KEY, sub)
    db.prepare(`DELETE FROM server_state WHERE key = ?`).run(TOKEN_HASH_KEY)
  })
  tx.immediate()
}

export function markClaimed(sub: string): void {
  sealVerifiedAdminOwnership(sub)
}
