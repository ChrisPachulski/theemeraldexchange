import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb, type ManagedDb } from './db.js'

describe('openDb', () => {
  const openedDbs: ManagedDb[] = []
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const db of openedDbs.splice(0)) {
      try { db.close() } catch { /* already closed */ }
    }
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  function freshDb(subdir = 'opendb-'): { db: ManagedDb; tmpDir: string; dbPath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), subdir))
    tmpDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'test.db')
    const db = openDb(
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        'migrations',
        'server',
      ),
      dbPath,
      'test',
    )
    openedDbs.push(db)
    return { db, tmpDir, dbPath }
  }

  it('sets busy_timeout to 5000ms', () => {
    const { db } = freshDb()
    const row = db.raw
      .prepare(`PRAGMA busy_timeout`)
      .get() as { timeout: number }
    expect(row.timeout).toBe(5000)
  })

  it('enables WAL journal mode and writes WAL files', () => {
    const { db, dbPath } = freshDb()

    // Trigger a write so SQLite flushes at least the WAL header to disk.
    db.raw.exec(`CREATE TABLE IF NOT EXISTS _wal_probe (x INTEGER)`)
    db.raw.exec(`INSERT INTO _wal_probe VALUES (1)`)
    db.raw.exec(`DROP TABLE _wal_probe`)

    const mode = (db.raw.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }).journal_mode
    expect(mode).toBe('wal')

    // WAL mode writes a -wal sidecar alongside the main DB file.
    const walPath = dbPath + '-wal'
    expect(fs.existsSync(walPath)).toBe(true)
  })

  it('sets synchronous = NORMAL', () => {
    const { db } = freshDb()
    // PRAGMA synchronous returns: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
    const row = db.raw.prepare(`PRAGMA synchronous`).get() as { synchronous: number }
    expect(row.synchronous).toBe(1)
  })

  it('creates the parent directory on first boot (TOCTOU-free)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendb-nested-'))
    tmpDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'a', 'b', 'c', 'nested.db')
    // Parent directories do not exist yet — openDb must create them.
    const db = openDb(
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        'migrations',
        'server',
      ),
      dbPath,
      'test-nested',
    )
    openedDbs.push(db)
    expect(fs.existsSync(dbPath)).toBe(true)
  })

  it('applies server migrations idempotently', () => {
    const { db } = freshDb()
    // openDb already called applyMigrations internally; call again — must not throw.
    db.applyMigrations()
    const tables = (
      db.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>
    ).map(t => t.name)
    expect(tables).toContain('server_state')
    expect(tables).toContain('schema_migrations')
  })
})
