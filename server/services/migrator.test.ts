import { describe, it, expect, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { applyMigrations } from './migrator.js'

describe('applyMigrations', () => {
  const openedDbs: Database.Database[] = []
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const db of openedDbs.splice(0)) {
      try { db.close() } catch { /* already closed */ }
    }
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  /** Open an in-memory DB tracked for cleanup. */
  function memDb(): Database.Database {
    const db = new Database(':memory:')
    openedDbs.push(db)
    return db
  }

  /** Create a fresh per-test temp migrations dir. */
  function freshDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-'))
    tmpDirs.push(dir)
    return dir
  }

  /** Write a .sql migration file into a dir. */
  function writeMigration(dir: string, name: string, sql: string): string {
    const p = path.join(dir, name)
    fs.writeFileSync(p, sql)
    return p
  }

  /** Empty :memory: db + empty migrations dir. */
  function freshSetup(): { db: Database.Database; dir: string } {
    return { db: memDb(), dir: freshDir() }
  }

  /** Mirror migrator.ts sha256: LF-normalize then sha256 hex. */
  function sha256(sql: string): string {
    return createHash('sha256').update(Buffer.from(sql.replace(/\r\n/g, '\n'), 'utf8')).digest('hex')
  }

  function tableExists(db: Database.Database, name: string): boolean {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) as { name: string } | undefined
    return !!row
  }

  function migrationRows(db: Database.Database): Array<{ version: number; checksum: string }> {
    return db
      .prepare(`SELECT version, checksum FROM schema_migrations ORDER BY version`)
      .all() as Array<{ version: number; checksum: string }>
  }

  // 1. Fresh bootstrap.
  it('bootstraps schema_migrations, applies the migration, and records a hex checksum', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE foo (id INTEGER);')

    applyMigrations({ migrationsDir: dir, db })

    const cols = db.pragma('table_info(schema_migrations)') as Array<{ name: string }>
    expect(cols[0].name).toBe('version')
    expect(tableExists(db, 'foo')).toBe(true)

    const rows = migrationRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(1)
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  // 2. Idempotency — re-run is a no-op (no IF NOT EXISTS, so re-exec would throw).
  it('is idempotent: a second call does not re-execute the migration', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE foo (id INTEGER);')

    applyMigrations({ migrationsDir: dir, db })
    expect(() => applyMigrations({ migrationsDir: dir, db })).not.toThrow()
    expect(migrationRows(db)).toHaveLength(1)
  })

  // 3. Checksum match on already-applied — no mismatch warn.
  it('does not warn when re-running with identical file content', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE foo (id INTEGER);')

    applyMigrations({ migrationsDir: dir, db })
    applyMigrations({ migrationsDir: dir, db })

    const mismatchCalls = warn.mock.calls.filter(c => String(c[0]).includes('checksum mismatch'))
    expect(mismatchCalls).toHaveLength(0)
  })

  // 4. Checksum MISMATCH warning when file edited after apply.
  it('warns on checksum mismatch and does not re-execute the migration', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    const file = path.join(dir, '0001_init.sql')
    fs.writeFileSync(file, 'CREATE TABLE foo (id INTEGER);')

    applyMigrations({ migrationsDir: dir, db })

    // Edit the file content on disk after apply.
    fs.writeFileSync(file, 'CREATE TABLE foo (id INTEGER); -- edited')

    expect(() => applyMigrations({ migrationsDir: dir, db })).not.toThrow()

    const mismatchCalls = warn.mock.calls.filter(c => String(c[0]).includes('checksum mismatch'))
    expect(mismatchCalls.length).toBeGreaterThan(0)
    expect(migrationRows(db)).toHaveLength(1)
  })

  // 5. CRLF normalization — checksum is line-ending-agnostic.
  it('produces an identical checksum for CRLF and LF variants of the same SQL', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const lfSql = 'CREATE TABLE foo (\n  id INTEGER\n);\n'
    const crlfSql = lfSql.replace(/\n/g, '\r\n')

    const dbA = memDb()
    const dirA = freshDir()
    writeMigration(dirA, '0001_init.sql', crlfSql)
    applyMigrations({ migrationsDir: dirA, db: dbA })
    const checksumA = migrationRows(dbA)[0].checksum

    const dbB = memDb()
    const dirB = freshDir()
    writeMigration(dirB, '0001_init.sql', lfSql)
    applyMigrations({ migrationsDir: dirB, db: dbB })
    const checksumB = migrationRows(dbB)[0].checksum

    expect(checksumA).toBe(checksumB)
    expect(checksumA).toBe(sha256(lfSql))
  })

  // 6. DESTRUCTIVE safeguard — DROP TABLE without marker is REFUSED.
  it('refuses a DROP TABLE migration that lacks the -- DESTRUCTIVE marker', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    writeMigration(dir, '0001_drop.sql', 'DROP TABLE foo;')

    expect(() => applyMigrations({ migrationsDir: dir, db })).toThrow(/-- DESTRUCTIVE/)
    expect(() => applyMigrations({ migrationsDir: dir, db })).toThrow(/DROP TABLE/)

    // The version was never recorded — transaction never started for it.
    expect(migrationRows(db)).toHaveLength(0)
  })

  // 7. DESTRUCTIVE with marker but NO serverDb handle.
  it('refuses a DESTRUCTIVE migration when no serverDb handle is provided', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    // Pre-create the table so the SQL would otherwise be valid.
    db.exec('CREATE TABLE foo (id INTEGER);')
    writeMigration(dir, '0001_drop.sql', '-- DESTRUCTIVE\nDROP TABLE foo;')

    expect(() => applyMigrations({ migrationsDir: dir, db })).toThrow(/server\.db must be open/)
    expect(migrationRows(db)).toHaveLength(0)
  })

  // 8. DESTRUCTIVE with serverDb but server_state table missing.
  it('refuses a DESTRUCTIVE migration when server_state table does not exist', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    db.exec('CREATE TABLE foo (id INTEGER);')
    writeMigration(dir, '0001_drop.sql', '-- DESTRUCTIVE\nDROP TABLE foo;')
    const serverDb = memDb() // empty, no server_state

    expect(() => applyMigrations({ migrationsDir: dir, db, serverDb })).toThrow(
      /server_state table does not exist/,
    )
    expect(migrationRows(db)).toHaveLength(0)
  })

  // 9. DESTRUCTIVE with server_state present but NO last_backup_at row.
  it('refuses a DESTRUCTIVE migration when no backup has been taken', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    db.exec('CREATE TABLE foo (id INTEGER);')
    writeMigration(dir, '0001_drop.sql', '-- DESTRUCTIVE\nDROP TABLE foo;')
    const serverDb = memDb()
    serverDb.exec('CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts TEXT NOT NULL);')

    expect(() => applyMigrations({ migrationsDir: dir, db, serverDb })).toThrow(
      /no backup has been taken/,
    )
    expect(migrationRows(db)).toHaveLength(0)
  })

  // 10. DESTRUCTIVE with stale backup.
  it('refuses a DESTRUCTIVE migration when the last backup is older than 10 minutes', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    db.exec('CREATE TABLE foo (id INTEGER);')
    writeMigration(dir, '0001_drop.sql', '-- DESTRUCTIVE\nDROP TABLE foo;')
    const serverDb = memDb()
    serverDb.exec('CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts TEXT NOT NULL);')
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    serverDb
      .prepare('INSERT INTO server_state (key, value, ts) VALUES (?, ?, ?)')
      .run('last_backup_at', stale, stale)

    expect(() => applyMigrations({ migrationsDir: dir, db, serverDb })).toThrow(/minutes ago/)
    expect(migrationRows(db)).toHaveLength(0)
  })

  // 11. DESTRUCTIVE with FRESH backup — happy path.
  it('applies a DESTRUCTIVE migration when a fresh backup exists', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    db.exec('CREATE TABLE foo (id INTEGER);')
    writeMigration(dir, '0001_drop.sql', '-- DESTRUCTIVE\nDROP TABLE foo;')
    const serverDb = memDb()
    serverDb.exec('CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts TEXT NOT NULL);')
    const fresh = new Date().toISOString()
    serverDb
      .prepare('INSERT INTO server_state (key, value, ts) VALUES (?, ?, ?)')
      .run('last_backup_at', fresh, fresh)

    expect(() => applyMigrations({ migrationsDir: dir, db, serverDb })).not.toThrow()
    expect(tableExists(db, 'foo')).toBe(false)
    expect(migrationRows(db).map(r => r.version)).toEqual([1])
  })

  // 12. Invalid last_backup_at date.
  it('refuses a DESTRUCTIVE migration when last_backup_at is not a valid date', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    db.exec('CREATE TABLE foo (id INTEGER);')
    writeMigration(dir, '0001_drop.sql', '-- DESTRUCTIVE\nDROP TABLE foo;')
    const serverDb = memDb()
    serverDb.exec('CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts TEXT NOT NULL);')
    serverDb
      .prepare('INSERT INTO server_state (key, value, ts) VALUES (?, ?, ?)')
      .run('last_backup_at', 'not-a-date', 'not-a-date')

    expect(() => applyMigrations({ migrationsDir: dir, db, serverDb })).toThrow(/not a valid date/)
    expect(migrationRows(db)).toHaveLength(0)
  })

  // 13. Legacy _migrations upgrade path with backfill from file content.
  it('upgrades a legacy _migrations table and backfills the file checksum', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    const sql = 'CREATE TABLE foo (id INTEGER);'
    writeMigration(dir, '0001_init.sql', sql)

    db.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);')
    const iso = new Date().toISOString()
    db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run('0001_init.sql', iso)

    applyMigrations({ migrationsDir: dir, db })

    expect(tableExists(db, '_migrations')).toBe(false)
    const cols = db.pragma('table_info(schema_migrations)') as Array<{ name: string }>
    expect(cols[0].name).toBe('version')

    const rows = migrationRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(1)
    expect(rows[0].checksum).toBe(sha256(sql))
    expect(rows[0].checksum).not.toBe('(file-not-found)')

    const upgradeCalls = info.mock.calls.filter(c => String(c[0]).includes('upgraded'))
    expect(upgradeCalls.length).toBeGreaterThan(0)
  })

  // 14. Legacy backfill when file is missing on disk.
  it('records (file-not-found) for a legacy row whose file is missing, and treats it as a non-mismatch later', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, dir } = freshSetup()

    db.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);')
    const iso = new Date().toISOString()
    db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run('0099_ghost.sql', iso)

    applyMigrations({ migrationsDir: dir, db })

    const ghost = migrationRows(db).find(r => r.version === 99)
    expect(ghost?.checksum).toBe('(file-not-found)')
    const notFoundCalls = warn.mock.calls.filter(c => String(c[0]).includes('migration file not found'))
    expect(notFoundCalls.length).toBeGreaterThan(0)

    // Now a real file with different content appears for version 99.
    // The (file-not-found) guard means NO checksum mismatch warning, even though contents differ.
    writeMigration(dir, '0099_ghost.sql', 'CREATE TABLE ghost (id INTEGER);')
    warn.mockClear()
    applyMigrations({ migrationsDir: dir, db })
    const mismatchCalls = warn.mock.calls.filter(c => String(c[0]).includes('checksum mismatch'))
    expect(mismatchCalls).toHaveLength(0)
  })

  // 15. Legacy row with non-numeric id prefix is skipped.
  it('skips a legacy row whose id has a non-numeric prefix', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, dir } = freshSetup()

    db.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);')
    const iso = new Date().toISOString()
    db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run('bogus_x.sql', iso)

    applyMigrations({ migrationsDir: dir, db })

    const nonNumericCalls = warn.mock.calls.filter(c => String(c[0]).includes('non-numeric prefix'))
    expect(nonNumericCalls.length).toBeGreaterThan(0)
    expect(migrationRows(db)).toHaveLength(0)
  })

  // 16. schema_migrations exists with a non-canonical first column — do not corrupt it.
  it('warns and leaves a non-canonical schema_migrations table intact', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);')
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE foo (id INTEGER);')

    // Bootstrap warns; the downstream SELECT version, checksum throws on the wrong shape.
    expect(() => applyMigrations({ migrationsDir: dir, db })).toThrow()

    const firstColCalls = warn.mock.calls.filter(c => String(c[0]).includes('first column is'))
    expect(firstColCalls.length).toBeGreaterThan(0)

    // Table is left intact in its original shape.
    const cols = db.pragma('table_info(schema_migrations)') as Array<{ name: string }>
    expect(cols[0].name).toBe('id')
  })

  // 17. Forward-compat / downgrade warning — version recorded but no .sql file.
  it('warns about a recorded version with no matching .sql file but still applies others', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    // Canonical table pre-populated with a future version 99 that has no file.
    db.exec(`
      CREATE TABLE schema_migrations (
        version    INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT    NOT NULL,
        checksum   TEXT    NOT NULL
      )
    `)
    const iso = new Date().toISOString()
    db.prepare('INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)')
      .run(99, iso, sha256('whatever'))
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE foo (id INTEGER);')

    expect(() => applyMigrations({ migrationsDir: dir, db })).not.toThrow()

    const downgradeCalls = warn.mock.calls.filter(c =>
      String(c[0]).includes('no matching .sql file'),
    )
    expect(downgradeCalls.length).toBeGreaterThan(0)
    // The downgrade warn references version 99.
    expect(downgradeCalls.some(c => c.includes(99))).toBe(true)

    expect(tableExists(db, 'foo')).toBe(true)
    expect(migrationRows(db).map(r => r.version).sort((a, b) => a - b)).toEqual([1, 99])
  })

  // 18. versionFromFilename non-numeric prefix at apply time.
  it('throws when an enumerated migration file has a non-numeric prefix', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    writeMigration(dir, 'abc_init.sql', 'CREATE TABLE foo (id INTEGER);')

    expect(() => applyMigrations({ migrationsDir: dir, db })).toThrow(/non-numeric prefix/)
  })

  // 19. Rollback on migration failure.
  it('rolls back the transaction and records no row when a migration errors mid-exec', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    writeMigration(dir, '0001_bad.sql', 'CREATE TABLE ok (id INTEGER); INVALID SQL HERE;')

    expect(() => applyMigrations({ migrationsDir: dir, db })).toThrow()
    expect(tableExists(db, 'ok')).toBe(false)
    expect(migrationRows(db)).toHaveLength(0)
  })

  // 20. Multiple migrations apply in sorted version order.
  it('applies migrations in sorted version order regardless of enumeration order', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { db, dir } = freshSetup()
    // Written out of order; 0002 ALTERs the table 0001 created — proves ordering.
    writeMigration(dir, '0002_add_col.sql', 'ALTER TABLE foo ADD COLUMN name TEXT;')
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE foo (id INTEGER);')

    expect(() => applyMigrations({ migrationsDir: dir, db })).not.toThrow()
    expect(migrationRows(db).map(r => r.version)).toEqual([1, 2])

    const cols = db.pragma('table_info(foo)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('name')
  })
})
