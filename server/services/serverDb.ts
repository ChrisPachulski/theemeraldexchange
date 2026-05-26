// server/services/serverDb.ts — server.db singleton.
//
// Holds cross-cutting server state (server_id, last_backup_at, etc.)
// that must survive IPTV_DISABLED builds. Deliberately NOT iptv.db.
// See §12.3 and §7.4 of the M1.5 contract.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type ManagedDb } from './db.js'
import { env } from '../env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations', 'server')

let cached: ManagedDb | null = null

export function serverDb(): ManagedDb {
  if (!cached) cached = openDb(MIGRATIONS_DIR, env.SERVER_DB_PATH, 'server')
  return cached
}

export function closeServerDb(): void {
  if (cached) {
    cached.close()
    cached = null
  }
}

/**
 * Ensure a stable server_id exists in server_state.
 *
 * Uses INSERT OR IGNORE so re-running on every boot is safe — the existing
 * row is never touched once written. Returns the server_id string.
 */
export function ensureServerId(): string {
  const db = serverDb()

  db.raw
    .prepare(
      `INSERT OR IGNORE INTO server_state (key, value, ts)
       VALUES ('server_id', ?, datetime('now'))`,
    )
    .run(crypto.randomUUID())

  const row = db.raw
    .prepare(`SELECT value FROM server_state WHERE key = 'server_id'`)
    .get() as { value: string } | undefined

  if (!row) {
    // Should be unreachable — INSERT OR IGNORE guarantees a row exists.
    throw new Error('[serverDb] server_id not found after INSERT OR IGNORE')
  }

  return row.value
}
