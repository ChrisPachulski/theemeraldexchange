// server/services/db.ts — shared DB opener with migration infrastructure.
//
// Both iptv.db and server.db use this. Pass the migrations directory,
// the DB file path, and a human-readable name for log messages.

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

export interface ManagedDb {
  raw: Database.Database
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

  const ensureMigrationsTable = (): void => {
    // Bootstrap: normalise whatever legacy shape exists to the canonical one.
    //
    // Three cases in the wild:
    //  (a) schema_migrations(version INTEGER PRIMARY KEY, applied_at, checksum) — canonical, no-op
    //  (b) _migrations(id TEXT PRIMARY KEY, applied_at TEXT) — Hono legacy shape
    //  (c) table does not exist — fresh DB
    //
    // D8b will also handle the Python shape; server.db is always fresh so
    // only (b) and (c) are relevant here in practice.

    const tables = (
      raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('_migrations','schema_migrations')`)
        .all() as Array<{ name: string }>
    ).map(r => r.name)

    if (tables.includes('schema_migrations')) {
      // Check if it's the canonical shape (has a 'version' column).
      const cols = (
        raw.prepare(`PRAGMA table_info(schema_migrations)`).all() as Array<{ name: string }>
      ).map(c => c.name)
      if (cols.includes('version')) {
        // Already canonical — nothing to do.
        return
      }
      // Python legacy shape: schema_migrations(filename TEXT PRIMARY KEY).
      // Rename + backfill. checksum left empty — D8c backfills it properly.
      raw.exec(`
        CREATE TABLE schema_migrations_new (
          version    INTEGER NOT NULL PRIMARY KEY,
          applied_at TEXT    NOT NULL,
          checksum   TEXT    NOT NULL DEFAULT ''
        );
        INSERT INTO schema_migrations_new (version, applied_at, checksum)
          SELECT CAST(substr(filename, 1, 4) AS INTEGER), applied_at, ''
          FROM schema_migrations;
        DROP TABLE schema_migrations;
        ALTER TABLE schema_migrations_new RENAME TO schema_migrations;
      `)
      return
    }

    if (tables.includes('_migrations')) {
      // Hono legacy shape: _migrations(id TEXT PRIMARY KEY, applied_at TEXT).
      raw.exec(`
        CREATE TABLE schema_migrations (
          version    INTEGER NOT NULL PRIMARY KEY,
          applied_at TEXT    NOT NULL,
          checksum   TEXT    NOT NULL DEFAULT ''
        );
        INSERT INTO schema_migrations (version, applied_at, checksum)
          SELECT CAST(substr(id, 1, 4) AS INTEGER), applied_at, ''
          FROM _migrations;
        DROP TABLE _migrations;
      `)
      return
    }

    // Fresh DB — create the canonical table.
    raw.exec(`
      CREATE TABLE schema_migrations (
        version    INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT    NOT NULL,
        checksum   TEXT    NOT NULL
      )
    `)
  }

  const applyMigrations = (): void => {
    ensureMigrationsTable()

    const applied = new Set(
      (
        raw.prepare(`SELECT version FROM schema_migrations`).all() as Array<{ version: number }>
      ).map(r => r.version),
    )

    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()

    const insert = raw.prepare(
      `INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)`,
    )

    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10)
      if (applied.has(version)) continue

      const sqlRaw = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
      // CRLF → LF normalisation (§7.1).
      const sql = sqlRaw.replace(/\r\n/g, '\n')

      console.info('[migration:%s] applying %s', dbName, file)
      const t0 = Date.now()

      raw.exec('BEGIN')
      try {
        raw.exec(sql)
        insert.run(version, new Date().toISOString(), '')
        raw.exec('COMMIT')
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }

      const elapsed = Date.now() - t0
      if (elapsed > 30_000) {
        console.warn(
          '[migration:%s] applying %s took %dms, this may take several minutes',
          dbName,
          file,
          elapsed,
        )
      }
    }
  }

  // Apply at construction so callers can prepare statements immediately.
  applyMigrations()

  return { raw, applyMigrations, close: () => raw.close() }
}
