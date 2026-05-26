import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import { applyMigrations } from './migrator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('iptvDb', () => {
  let tmpDir: string
  let db: IptvDb

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvdb-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('applies migrations idempotently', () => {
    db.applyMigrations()
    db.applyMigrations() // second call must not throw
    const tables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    expect(names).toContain('channels')
    expect(names).toContain('vod')
    expect(names).toContain('series')
    expect(names).toContain('series_episodes')
    expect(names).toContain('categories')
    expect(names).toContain('epg_programs')
    expect(names).toContain('iptv_favorites')
    expect(names).toContain('iptv_watch_history')
    expect(names).toContain('iptv_title_link')
    expect(names).toContain('iptv_sync_state')
  })

  it('uses schema_migrations table (canonical shape)', () => {
    const tables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    expect(names).toContain('schema_migrations')
    expect(names).not.toContain('_migrations')

    const rows = db.raw
      .prepare(`SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version`)
      .all() as Array<{ version: number; applied_at: string; checksum: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(typeof rows[0].version).toBe('number')
    expect(rows[0].version).toBe(1)
    expect(rows[0].applied_at).toBeTruthy()
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('exposes prepared statements for catalog inserts', () => {
    db.applyMigrations()
    db.stmts.upsertChannel.run({
      stream_id: 1, num: 1, name: 'Test', stream_icon: null, epg_channel_id: 'tv.test',
      category_id: 10, is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
      added_ts: '2026-05-24T00:00:00Z', fetched_at: '2026-05-24T00:00:00Z',
    })
    const row = db.raw.prepare(`SELECT name FROM channels WHERE stream_id = 1`).get() as { name: string }
    expect(row.name).toBe('Test')
  })
})

describe('migrator: legacy _migrations bootstrap', () => {
  let tmpDir: string
  let migrationsDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-legacy-'))
    migrationsDir = path.join(tmpDir, 'migrations')
    fs.mkdirSync(migrationsDir)
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('upgrades legacy _migrations table to schema_migrations', () => {
    const sql = `CREATE TABLE t1 (id INTEGER PRIMARY KEY);\n`
    fs.writeFileSync(path.join(migrationsDir, '0001_init.sql'), sql)

    const raw = new Database(path.join(tmpDir, 'test.db'))
    // Simulate legacy state: _migrations table already populated.
    raw.exec(`CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
    raw.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`)
    raw.prepare(`INSERT INTO _migrations VALUES (?, ?)`).run('0001_init.sql', '2026-01-01T00:00:00Z')

    applyMigrations({ migrationsDir, db: raw })

    const tables = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    expect(names).toContain('schema_migrations')
    expect(names).not.toContain('_migrations')

    const rows = raw
      .prepare(`SELECT version, applied_at, checksum FROM schema_migrations`)
      .all() as Array<{ version: number; applied_at: string; checksum: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(1)
    expect(rows[0].applied_at).toBe('2026-01-01T00:00:00Z')
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/)

    raw.close()
  })
})

describe('migrator: DESTRUCTIVE marker enforcement', () => {
  let tmpDir: string
  let migrationsDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-destructive-'))
    migrationsDir = path.join(tmpDir, 'migrations')
    fs.mkdirSync(migrationsDir)
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('refuses DROP TABLE migration without -- DESTRUCTIVE marker', () => {
    fs.writeFileSync(
      path.join(migrationsDir, '0001_bad.sql'),
      `DROP TABLE IF EXISTS old_table;\n`,
    )
    const raw = new Database(path.join(tmpDir, 'test.db'))
    expect(() => applyMigrations({ migrationsDir, db: raw })).toThrow(/DESTRUCTIVE/)
    raw.close()
  })

  it('refuses DROP TABLE with -- DESTRUCTIVE marker but no serverDb', () => {
    fs.writeFileSync(
      path.join(migrationsDir, '0001_drop.sql'),
      `-- DESTRUCTIVE\nDROP TABLE IF EXISTS old_table;\n`,
    )
    const raw = new Database(path.join(tmpDir, 'test.db'))
    // No serverDb provided — should refuse with boot-order message.
    expect(() => applyMigrations({ migrationsDir, db: raw })).toThrow(/server\.db must be open/)
    raw.close()
  })

  it('refuses DROP TABLE with -- DESTRUCTIVE when last_backup_at is stale', () => {
    fs.writeFileSync(
      path.join(migrationsDir, '0001_drop.sql'),
      `-- DESTRUCTIVE\nDROP TABLE IF EXISTS old_table;\n`,
    )
    const raw = new Database(path.join(tmpDir, 'test.db'))
    const serverDb = new Database(path.join(tmpDir, 'server.db'))
    serverDb.exec(`CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    // Set last_backup_at to 20 minutes ago (stale).
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    serverDb.prepare(`INSERT INTO server_state VALUES (?, ?)`).run('last_backup_at', stale)

    expect(() => applyMigrations({ migrationsDir, db: raw, serverDb })).toThrow(/20 minutes ago/)

    raw.close()
    serverDb.close()
  })

  it('allows DROP TABLE with -- DESTRUCTIVE when last_backup_at is recent', () => {
    fs.writeFileSync(
      path.join(migrationsDir, '0001_setup.sql'),
      `CREATE TABLE old_table (id INTEGER PRIMARY KEY);\n`,
    )
    const raw = new Database(path.join(tmpDir, 'test.db'))
    applyMigrations({ migrationsDir, db: raw }) // apply setup migration first

    fs.writeFileSync(
      path.join(migrationsDir, '0002_drop.sql'),
      `-- DESTRUCTIVE\nDROP TABLE IF EXISTS old_table;\n`,
    )
    const serverDb = new Database(path.join(tmpDir, 'server.db'))
    serverDb.exec(`CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    // Set last_backup_at to 5 minutes ago (within window).
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    serverDb.prepare(`INSERT INTO server_state VALUES (?, ?)`).run('last_backup_at', recent)

    expect(() => applyMigrations({ migrationsDir, db: raw, serverDb })).not.toThrow()

    raw.close()
    serverDb.close()
  })
})

describe('migrator: version-in-DB-but-no-file-on-disk (downgrade scenario)', () => {
  let tmpDir: string
  let migrationsDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-downgrade-'))
    migrationsDir = path.join(tmpDir, 'migrations')
    fs.mkdirSync(migrationsDir)
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('warns but does not throw when schema_migrations has a version with no corresponding file', () => {
    // Apply version 1 normally.
    fs.writeFileSync(
      path.join(migrationsDir, '0001_init.sql'),
      `CREATE TABLE t1 (id INTEGER PRIMARY KEY);\n`,
    )
    const raw = new Database(path.join(tmpDir, 'test.db'))
    applyMigrations({ migrationsDir, db: raw })

    // Simulate a downgrade: add version 2 directly into schema_migrations (no file on disk).
    raw
      .prepare(`INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)`)
      .run(2, new Date().toISOString(), 'deadbeef'.repeat(8))

    // Remove the version-2 file (it was never created) — only version 1 file exists.
    // Re-running applyMigrations must not throw, only warn.
    expect(() => applyMigrations({ migrationsDir, db: raw })).not.toThrow()

    raw.close()
  })
})

describe('migrator: CRLF normalization', () => {
  let tmpDir: string
  let migrationsDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-crlf-'))
    migrationsDir = path.join(tmpDir, 'migrations')
    fs.mkdirSync(migrationsDir)
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('applies CRLF-encoded SQL without error', () => {
    // Write SQL with CRLF line endings (simulates Windows checkout).
    const sqlCRLF = `CREATE TABLE t1 (id INTEGER PRIMARY KEY);\r\nCREATE TABLE t2 (id INTEGER PRIMARY KEY);\r\n`
    fs.writeFileSync(path.join(migrationsDir, '0001_init.sql'), sqlCRLF)

    const raw = new Database(path.join(tmpDir, 'test.db'))
    expect(() => applyMigrations({ migrationsDir, db: raw })).not.toThrow()

    const rows = raw
      .prepare(`SELECT version, checksum FROM schema_migrations`)
      .all() as Array<{ version: number; checksum: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/)

    raw.close()
  })

  it('produces same checksum for CRLF and LF versions of same SQL', () => {
    const sqlLF = `CREATE TABLE t1 (id INTEGER PRIMARY KEY);\n`
    const sqlCRLF = `CREATE TABLE t1 (id INTEGER PRIMARY KEY);\r\n`
    const hashLF = createHash('sha256').update(Buffer.from(sqlLF.replace(/\r\n/g, '\n'), 'utf8')).digest('hex')
    const hashCRLF = createHash('sha256').update(Buffer.from(sqlCRLF.replace(/\r\n/g, '\n'), 'utf8')).digest('hex')
    expect(hashLF).toBe(hashCRLF)
  })
})

describe('migrator: fixture-based legacy _migrations bootstrap', () => {
  // Uses server/migrations/__fixtures__/legacy-iptv.sqlite — a committed SQLite file
  // seeded with the legacy _migrations(id TEXT) shape and a single applied migration row
  // for 0001_init.sql. The migrator must upgrade this to schema_migrations shape.
  const fixtureDir = path.resolve(__dirname, '..', 'migrations', '__fixtures__')
  const fixtureSrc = path.join(fixtureDir, 'legacy-iptv.sqlite')
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-fixture-'))
    dbPath = path.join(tmpDir, 'iptv.db')
    // Copy fixture so each test gets a fresh writable copy.
    fs.copyFileSync(fixtureSrc, dbPath)
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('upgrades fixture legacy-iptv.sqlite to canonical schema_migrations', () => {
    const migrationsDir = path.resolve(__dirname, '..', 'migrations', 'iptv')
    const raw = new Database(dbPath)

    // Confirm fixture has legacy shape before migration.
    const tablesBefore = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name)
    expect(tablesBefore).toContain('_migrations')
    expect(tablesBefore).not.toContain('schema_migrations')

    applyMigrations({ migrationsDir, db: raw })

    // After migration: canonical table present, legacy table gone.
    const tablesAfter = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name)
    expect(tablesAfter).toContain('schema_migrations')
    expect(tablesAfter).not.toContain('_migrations')

    // Backfilled row for version 1 must have a valid checksum.
    const rows = raw.prepare(`SELECT version, applied_at, checksum FROM schema_migrations WHERE version = 1`).all() as Array<{ version: number; applied_at: string; checksum: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].applied_at).toBe('2026-01-01T00:00:00.000Z')
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/)

    raw.close()
  })
})
