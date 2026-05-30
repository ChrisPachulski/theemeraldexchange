// server/services/db.ts — shared DB opener.
//
// Both iptv.db and server.db use this. Pass the migrations directory,
// the DB file path, and a human-readable name for log messages.
//
// Migrations are applied EXCLUSIVELY through the hardened migrator
// (./migrator.ts) — there is no second, lightweight runner. The migrator
// computes a sha256 checksum per migration, WARNs on drift when an applied
// migration's file changes, REFUSES a DROP TABLE that lacks the
// `-- DESTRUCTIVE` marker, and gates every `-- DESTRUCTIVE` migration on a
// recent server_state.last_backup_at (§7.1/§7.3/§7.4). server.db is the root
// DB holding server_id + last_backup_at, so it passes ITS OWN handle as the
// serverDb backup-check source.

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { applyMigrations as runMigrations } from './migrator.js'

export interface ManagedDb {
  raw: Database.Database
  /**
   * Re-run the hardened migrator. Idempotent — safe to call repeatedly.
   */
  applyMigrations: () => void
  close: () => void
}

export function openDb(migrationsDir: string, dbPath: string, dbName: string): ManagedDb {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const raw = new Database(dbPath)
  raw.pragma('busy_timeout = 5000')
  raw.pragma('journal_mode = WAL')
  raw.pragma('synchronous = NORMAL')
  raw.pragma('foreign_keys = ON')

  const applyMigrations = (): void => {
    // Route through the hardened migrator. For the root server.db this same
    // handle is also the DESTRUCTIVE backup-check source (it owns
    // server_state.last_backup_at); for any other DB opened via openDb the
    // self-handle simply means destructive migrations are checked against
    // that DB's own server_state if present.
    runMigrations({ migrationsDir, db: raw, serverDb: raw })
    void dbName // retained for call-site symmetry / future per-db logging
  }

  // Apply at construction so callers can prepare statements immediately.
  applyMigrations()

  return { raw, applyMigrations, close: () => raw.close() }
}
