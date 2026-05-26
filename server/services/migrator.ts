/**
 * Canonical migration runner — D8b (§7.1, §7.3, §7.4).
 *
 * Schema: schema_migrations(version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)
 *
 * On construction the bootstrap step runs idempotently:
 *   1. If canonical table already exists → no-op.
 *   2. If legacy _migrations(id TEXT) exists (Hono legacy, live iptv.db) → rename + backfill.
 *   3. Otherwise → create fresh table.
 *
 * Per-migration behaviour:
 *   - CRLF→LF normalization before both checksum computation and exec.
 *   - console.info('[migration] applying %s', file) before exec.
 *   - 30-second slow-migration WARN after exec.
 *   - Checksum mismatch on already-applied migration → WARN, continue.
 *   - SQL containing DROP TABLE without a `-- DESTRUCTIVE` comment line → refuse.
 *   - SQL with `-- DESTRUCTIVE` → verify server_state.last_backup_at within last 10 min.
 *
 * Cross-worktree note (D5):
 *   D5 (impl-d5-server-db) will create server.db and expose a Database handle.
 *   Pass that handle as `serverDb` to enable DESTRUCTIVE migration enforcement.
 *   Without it, DESTRUCTIVE migrations are refused with an explanatory error.
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const DESTRUCTIVE_MARKER = '-- DESTRUCTIVE'
const SLOW_MIGRATION_MS = 30_000
const BACKUP_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

/** Normalize line endings to LF before hashing or executing. */
function normalizeLF(sql: string): string {
  return sql.replace(/\r\n/g, '\n')
}

/**
 * SHA-256 of LF-normalized SQL, hex-encoded.
 *
 * Paranoid note: we convert the normalized string to a Buffer via Buffer.from(s, 'utf8')
 * rather than passing a raw string + encoding to createHash.update(). This makes the
 * byte encoding explicit and avoids any ambiguity around unpaired surrogates in JS
 * strings (which Node's 'utf8' encoding would silently replace with U+FFFD, potentially
 * differing from a raw-file read). The SQL files are read with 'utf8' encoding via
 * fs.readFileSync, so by this point the string is already a valid Unicode JS string.
 */
function sha256(sql: string): string {
  return createHash('sha256').update(Buffer.from(normalizeLF(sql), 'utf8')).digest('hex')
}

/**
 * Check whether `server_state.last_backup_at` is within the last 10 minutes.
 * Returns an error string if the check fails, or null if it passes.
 */
function checkRecentBackup(serverDb: Database.Database | undefined): string | null {
  if (!serverDb) {
    return (
      'server.db must be open before running DESTRUCTIVE migrations — ' +
      'check boot order in server/index.ts. ' +
      '(serverDb handle was not passed to applyMigrations; D5 must open server.db first.)'
    )
  }
  let row: { value: string } | undefined
  try {
    row = serverDb
      .prepare(`SELECT value FROM server_state WHERE key = 'last_backup_at'`)
      .get() as { value: string } | undefined
  } catch {
    return (
      'DESTRUCTIVE migration requires server_state.last_backup_at, ' +
      'but server_state table does not exist yet. ' +
      'Run POST /api/admin/backup before applying destructive migrations.'
    )
  }
  if (!row) {
    return (
      'DESTRUCTIVE migration refused: no backup has been taken. ' +
      'Run POST /api/admin/backup within the last 10 minutes before proceeding.'
    )
  }
  const lastBackupAt = new Date(row.value).getTime()
  if (isNaN(lastBackupAt)) {
    return `DESTRUCTIVE migration refused: server_state.last_backup_at is not a valid date: ${row.value}`
  }
  const ageMs = Date.now() - lastBackupAt
  if (ageMs > BACKUP_WINDOW_MS) {
    const ageMin = Math.round(ageMs / 60_000)
    return (
      `DESTRUCTIVE migration refused: last backup was ${ageMin} minutes ago ` +
      `(limit is 10 minutes). Run POST /api/admin/backup and retry.`
    )
  }
  return null
}

/** Bootstrap the migrations tracking table from any legacy shape. */
function bootstrapMigrationsTable(
  db: Database.Database,
  migrationsDir: string,
): void {
  // Check which shape exists.
  const tableInfo = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schema_migrations','_migrations')`)
    .all() as Array<{ name: string }>
  const names = new Set(tableInfo.map(r => r.name))

  if (names.has('schema_migrations')) {
    // Verify it is the canonical shape (first column must be version INTEGER).
    const cols = db.pragma(`table_info(schema_migrations)`) as Array<{ name: string; type: string }>
    const firstCol = cols[0]
    if (firstCol && firstCol.name === 'version') {
      // Already canonical — fast no-op.
      return
    }
    // Unexpected shape — leave it alone and warn; do not corrupt data.
    console.warn(
      '[migration] schema_migrations exists but first column is %s not version; ' +
      'skipping bootstrap — manual intervention may be required',
      firstCol?.name ?? '(unknown)',
    )
    return
  }

  if (names.has('_migrations')) {
    // Legacy Hono shape: _migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)
    // Rename to schema_migrations and backfill version + checksum.
    console.info('[migration] legacy _migrations table detected; upgrading to schema_migrations shape')

    const legacyRows = db
      .prepare(`SELECT id, applied_at FROM _migrations`)
      .all() as Array<{ id: string; applied_at: string }>

    db.exec(`
      CREATE TABLE schema_migrations (
        version    INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT    NOT NULL,
        checksum   TEXT    NOT NULL
      )
    `)

    const insertMig = db.prepare(
      `INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)`,
    )

    for (const row of legacyRows) {
      const version = parseInt(row.id.substring(0, 4), 10)
      if (isNaN(version)) {
        console.warn('[migration] legacy row id %s has non-numeric prefix; skipping backfill', row.id)
        continue
      }
      // Compute checksum from the current file content (best we can do for already-applied rows).
      const filePath = path.join(migrationsDir, row.id)
      let checksum = '(file-not-found)'
      if (fs.existsSync(filePath)) {
        const sql = fs.readFileSync(filePath, 'utf-8')
        checksum = sha256(sql)
      } else {
        console.warn(
          '[migration] legacy row %s: migration file not found at %s; ' +
          'checksum recorded as placeholder',
          row.id,
          filePath,
        )
      }
      insertMig.run(version, row.applied_at, checksum)
    }

    db.exec(`DROP TABLE _migrations`)
    console.info('[migration] upgraded %d legacy migration row(s) to schema_migrations', legacyRows.length)
    return
  }

  // No migrations table exists — create the canonical one.
  db.exec(`
    CREATE TABLE schema_migrations (
      version    INTEGER NOT NULL PRIMARY KEY,
      applied_at TEXT    NOT NULL,
      checksum   TEXT    NOT NULL
    )
  `)
}

/** Parse the version integer from a migration filename (e.g. "0001_init.sql" → 1). */
function versionFromFilename(filename: string): number {
  const prefix = filename.split('_')[0]
  const v = parseInt(prefix, 10)
  if (isNaN(v)) throw new Error(`Migration filename ${filename} has non-numeric prefix`)
  return v
}

export interface MigratorOptions {
  /** Directory containing .sql migration files (must already exist). */
  migrationsDir: string
  /** Open database handle to migrate. */
  db: Database.Database
  /**
   * Optional handle to server.db for DESTRUCTIVE migration enforcement.
   * If omitted, DESTRUCTIVE migrations will be refused.
   * D5 (impl-d5-server-db) provides this after server.db is open.
   */
  serverDb?: Database.Database
}

/**
 * Apply all unapplied migrations in version order.
 * Runs bootstrap on every call — idempotent if already on canonical shape.
 */
export function applyMigrations(opts: MigratorOptions): void {
  const { migrationsDir, db, serverDb } = opts

  // Bootstrap migrations table (handles legacy shapes).
  bootstrapMigrationsTable(db, migrationsDir)

  // Read already-applied versions.
  const appliedRows = db
    .prepare(`SELECT version, checksum FROM schema_migrations ORDER BY version`)
    .all() as Array<{ version: number; checksum: string }>
  const appliedMap = new Map(appliedRows.map(r => [r.version, r.checksum]))

  // Enumerate migration files.
  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  // Build a set of file-based versions for forward-compat check below.
  const fileVersions = new Set(files.map(f => versionFromFilename(f)))

  // Warn about versions recorded in the DB that have no corresponding file on disk.
  // This occurs when an operator downgrades the app after a migration was applied on a
  // newer version. Do NOT abort boot — warn and skip so the operator can still start.
  for (const [version] of appliedMap) {
    if (!fileVersions.has(version)) {
      console.warn(
        '[migration] version %d is recorded in schema_migrations but no matching .sql file ' +
        'exists in %s — skipping (app may have been downgraded; re-upgrade to re-run)',
        version,
        migrationsDir,
      )
    }
  }

  const insertMig = db.prepare(
    `INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)`,
  )

  for (const file of files) {
    const version = versionFromFilename(file)
    const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
    const sql = normalizeLF(rawSql)
    const checksum = sha256(rawSql) // sha256 normalizes internally

    if (appliedMap.has(version)) {
      // Already applied — verify checksum.
      const stored = appliedMap.get(version)!
      if (stored !== checksum && stored !== '(file-not-found)') {
        console.warn(
          '[migration] checksum mismatch on %d (%s): ' +
          'stored=%s computed=%s — file may have been edited after apply',
          version,
          file,
          stored,
          checksum,
        )
      }
      continue
    }

    // DESTRUCTIVE marker check.
    const hasDropTable = /\bDROP\s+TABLE\b/i.test(sql)
    const hasDestructiveMarker = sql.split('\n').some(line => line.trim() === DESTRUCTIVE_MARKER)

    if (hasDropTable && !hasDestructiveMarker) {
      throw new Error(
        `Migration ${file} contains DROP TABLE but is missing the required '-- DESTRUCTIVE' comment. ` +
        `Add '-- DESTRUCTIVE' on its own line to explicitly mark this migration as destructive.`,
      )
    }

    if (hasDestructiveMarker) {
      const backupErr = checkRecentBackup(serverDb)
      if (backupErr) {
        throw new Error(`Migration ${file}: ${backupErr}`)
      }
    }

    console.info('[migration] applying %s', file)

    const t0 = Date.now()
    db.exec('BEGIN')
    try {
      db.exec(sql)
      insertMig.run(version, new Date().toISOString(), checksum)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    const elapsed = Date.now() - t0

    if (elapsed > SLOW_MIGRATION_MS) {
      const elapsedSec = (elapsed / 1000).toFixed(1)
      console.warn(
        '[migration] %s took %ss — subsequent table-rebuild migrations may also be slow on this hardware',
        file,
        elapsedSec,
      )
    }
  }
}
