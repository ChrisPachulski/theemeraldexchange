import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

// The singleton reads env.MEDIA_DB_PATH at call time. We mock ../env.js
// so each test controls the path, and reset modules so the singleton's
// module-level cache starts fresh.
const hoisted = vi.hoisted(() => ({ mediaDbPath: '/definitely/missing/media.db' }))

vi.mock('../env.js', () => ({
  env: {
    get MEDIA_DB_PATH() {
      return hoisted.mediaDbPath
    },
  },
}))

const tmpDirs: string[] = []

function makeTempMediaDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-singleton-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'media.db')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER UNIQUE,
      title TEXT NOT NULL,
      year INTEGER,
      added_at TEXT NOT NULL,
      file_id INTEGER
    );
    INSERT INTO movies (tmdb_id, title, year, added_at, file_id)
    VALUES (550, 'Fight Club', 1999, 'now', 1);
  `)
  db.close()
  return file
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

describe('mediaLibraryDb singleton', () => {
  it('returns null (graceful degrade) when media.db is missing', async () => {
    hoisted.mediaDbPath = '/definitely/missing/media.db'
    const { mediaLibraryDb } = await import('./mediaLibraryDbSingleton.js')
    expect(mediaLibraryDb()).toBeNull()
  })

  it('returns a working handle when media.db exists and caches it', async () => {
    hoisted.mediaDbPath = makeTempMediaDb()
    const { mediaLibraryDb, closeMediaLibraryDb } = await import(
      './mediaLibraryDbSingleton.js'
    )
    const first = mediaLibraryDb()
    expect(first).not.toBeNull()
    const second = mediaLibraryDb()
    expect(second).toBe(first) // cached singleton
    const row = first!.raw
      .prepare('SELECT title FROM movies WHERE tmdb_id = ?')
      .get(550) as { title: string }
    expect(row.title).toBe('Fight Club')
    closeMediaLibraryDb()
  })
})
