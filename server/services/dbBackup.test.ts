import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

// Finding 14-4: the scheduled backup must (1) produce a VACUUM INTO snapshot
// file for each server-owned DB and (2) stamp server_state.last_backup_at so
// the DESTRUCTIVE-migration gate sees a fresh backup.
//
// env.ts is a process-wide singleton frozen at first import, and serverDb() is
// a cached handle — so we cannot reliably re-point them from this test if some
// other test already imported them. Instead we vi.resetModules() and set the
// DB paths on process.env BEFORE importing env/serverDb/dbBackup inside an
// isolated module graph, then exercise the real code path end to end.

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbackup-test-'))
  vi.resetModules()
  process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')
  process.env.IPTV_DB_PATH = path.join(tmpDir, 'iptv.db')
  process.env.DB_BACKUP_DIR = path.join(tmpDir, 'backups')
  process.env.DB_BACKUP_KEEP = '3'
  // env.ts requires these at load; provide test values so the import succeeds.
  process.env.PLEX_CLIENT_ID ||= 'test-plex-client-id'
  process.env.SESSION_SECRET ||= 'x'.repeat(40)
  process.env.STREAM_TOKEN_SECRET ||= 'y'.repeat(40)
  process.env.SONARR_API_KEY ||= 'sonarr-key'
  process.env.RADARR_API_KEY ||= 'radarr-key'
  process.env.SAB_API_KEY ||= 'sab-key'

  // Pre-seed a minimal iptv.db so the backup has a second file to snapshot.
  const iptv = new Database(process.env.IPTV_DB_PATH)
  iptv.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);')
  iptv.close()
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SERVER_DB_PATH
  delete process.env.IPTV_DB_PATH
  delete process.env.DB_BACKUP_DIR
  delete process.env.DB_BACKUP_KEEP
  vi.resetModules()
})

describe('runScheduledBackup (finding 14-4)', () => {
  it('writes VACUUM INTO snapshots for both DBs and stamps last_backup_at', async () => {
    const { serverDb } = await import('./serverDb.js')
    const { runScheduledBackup } = await import('./dbBackup.js')

    // Force server.db open + migrate so server_state exists before the stamp.
    // serverDb() runs the hardened migrator on first open.
    const sdb = serverDb()
    const hasServerState = sdb.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='server_state'`)
      .get() as { name: string } | undefined
    expect(hasServerState?.name).toBe('server_state')

    const before = Date.now()
    const result = runScheduledBackup()

    // Two snapshot files exist on disk and are non-empty.
    expect(result.files.length).toBe(2)
    for (const f of result.files) {
      expect(fs.existsSync(f)).toBe(true)
      expect(fs.statSync(f).size).toBeGreaterThan(0)
    }
    const names = fs.readdirSync(result.dir)
    expect(names.some((n) => n.startsWith('server-') && n.endsWith('.db'))).toBe(true)
    expect(names.some((n) => n.startsWith('iptv-') && n.endsWith('.db'))).toBe(true)

    // A snapshot is itself a valid SQLite DB carrying the source schema.
    const serverSnap = result.files.find((f) => path.basename(f).startsWith('server-'))!
    const snap = new Database(serverSnap, { readonly: true })
    const tables = snap
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>
    snap.close()
    expect(tables.some((t) => t.name === 'server_state')).toBe(true)

    // last_backup_at was stamped within the DESTRUCTIVE gate's freshness window.
    const row = sdb.raw
      .prepare(`SELECT value FROM server_state WHERE key = 'last_backup_at'`)
      .get() as { value: string } | undefined
    expect(row).toBeDefined()
    const stamped = new Date(row!.value).getTime()
    expect(stamped).toBeGreaterThanOrEqual(before - 1000)
    expect(Date.now() - stamped).toBeLessThan(10 * 60 * 1000)
  })

  it('prunes snapshots beyond DB_BACKUP_KEEP', async () => {
    const { runScheduledBackup } = await import('./dbBackup.js')
    const backupsDir = path.join(tmpDir, 'backups')
    // Start from a clean slate so the prior test's snapshot doesn't perturb the
    // count, then take 6 passes with clearly-distinct (minute-apart) stamps.
    fs.rmSync(backupsDir, { recursive: true, force: true })
    const base = Date.parse('2026-01-01T00:00:00Z')
    for (let i = 0; i < 6; i++) {
      runScheduledBackup(new Date(base + i * 60_000))
    }
    const names = fs.readdirSync(backupsDir)
    const serverSnaps = names.filter((n) => n.startsWith('server-') && n.endsWith('.db'))
    // 6 passes, retention 3 → exactly 3 kept (the 3 newest).
    expect(serverSnaps.length).toBe(3)
  })
})
