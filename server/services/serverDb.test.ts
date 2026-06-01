import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// serverDb reads env.SERVER_DB_PATH at openDb() time. We mock ../env.js so
// each test controls the path, and reset modules so the module-level `cached`
// singleton starts fresh. We deliberately leave ./db.js and the migrator
// UNMOCKED: serverDb resolves MIGRATIONS_DIR from import.meta.url (the real
// on-disk server/migrations/server/ dir) and the real hardened migrator runs
// at openDb() construction, creating the server_state table. The migrator/db
// do not read env, so a partial env mock is safe.
const hoisted = vi.hoisted(() => ({ serverDbPath: '' }))

vi.mock('../env.js', () => ({
  env: {
    get SERVER_DB_PATH() {
      return hoisted.serverDbPath
    },
  },
}))

const tmpDirs: string[] = []

function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverdb-singleton-'))
  tmpDirs.push(dir)
  // Just the path — openDb mkdirs the parent and creates the file.
  return path.join(dir, 'server.db')
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

describe('serverDb singleton', () => {
  it('caches a single ManagedDb handle across calls', async () => {
    hoisted.serverDbPath = makeTempDbPath()
    const { serverDb, closeServerDb } = await import('./serverDb.js')
    const first = serverDb()
    const second = serverDb()
    expect(second).toBe(first) // cached singleton
    closeServerDb()
  })

  it('ensureServerId returns a stable id that is idempotent across calls', async () => {
    hoisted.serverDbPath = makeTempDbPath()
    const { ensureServerId, closeServerDb } = await import('./serverDb.js')
    const id1 = ensureServerId()
    const id2 = ensureServerId()
    expect(id1).toBe(id2)
    expect(typeof id1).toBe('string')
    expect(id1.length).toBeGreaterThan(0)
    // crypto.randomUUID() shape: 8-4-4-4-12 hex.
    expect(id1).toMatch(/^[0-9a-f-]{36}$/i)
    closeServerDb()
  })

  it('ensureServerId persists the same id across a close + reopen (survives teardown)', async () => {
    hoisted.serverDbPath = makeTempDbPath()
    const { ensureServerId, closeServerDb } = await import('./serverDb.js')
    const id1 = ensureServerId()
    closeServerDb()

    // Reset the module-level singleton but KEEP the same on-disk file so the
    // reopened DB reads the previously-written row. This proves INSERT OR
    // IGNORE never overwrites the existing server_id — the core idempotence
    // guarantee in the function's docstring.
    vi.resetModules()
    const { ensureServerId: ensureServerId2, closeServerDb: close2 } =
      await import('./serverDb.js')
    const id2 = ensureServerId2()
    expect(id2).toBe(id1)
    close2()
  })

  it('closeServerDb is safe to call when nothing is open (no-op)', async () => {
    const { closeServerDb } = await import('./serverDb.js')
    expect(() => closeServerDb()).not.toThrow()
    // Double-close guard: cached is set back to null, so a second call is a no-op.
    expect(() => closeServerDb()).not.toThrow()
  })
})
