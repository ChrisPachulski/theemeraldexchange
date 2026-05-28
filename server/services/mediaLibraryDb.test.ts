import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openMediaLibraryDb } from './mediaLibraryDb.js'

// Build a throwaway media.db with the minimal media-core schema and one
// movies row, returning the file path. Caller owns cleanup.
function makeTempMediaDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-db-test-'))
  const file = path.join(dir, 'media.db')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER UNIQUE,
      imdb_id TEXT,
      title TEXT NOT NULL,
      year INTEGER,
      added_at TEXT NOT NULL,
      file_id INTEGER
    );
    INSERT INTO movies (tmdb_id, title, year, added_at, file_id)
    VALUES (603, 'The Matrix', 1999, '2026-01-01', 1);
  `)
  db.close()
  return file
}

const created: string[] = []

afterEach(() => {
  for (const f of created.splice(0)) {
    try {
      fs.rmSync(path.dirname(f), { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

describe('openMediaLibraryDb', () => {
  it('opens an existing media.db read-only and reads rows', () => {
    const file = makeTempMediaDb()
    created.push(file)
    const handle = openMediaLibraryDb(file)
    try {
      const row = handle.raw
        .prepare('SELECT tmdb_id, title, year FROM movies WHERE tmdb_id = ?')
        .get(603) as { tmdb_id: number; title: string; year: number }
      expect(row.tmdb_id).toBe(603)
      expect(row.title).toBe('The Matrix')
      expect(row.year).toBe(1999)
    } finally {
      handle.close()
    }
  })

  it('rejects writes (read-only handle)', () => {
    const file = makeTempMediaDb()
    created.push(file)
    const handle = openMediaLibraryDb(file)
    try {
      expect(() =>
        handle.raw
          .prepare(
            "INSERT INTO movies (tmdb_id, title, year, added_at, file_id) VALUES (1, 'x', 2000, 'now', 1)",
          )
          .run(),
      ).toThrow(/readonly|read-only/i)
    } finally {
      handle.close()
    }
  })

  it('throws when the file does not exist (fileMustExist)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-db-missing-'))
    const missing = path.join(dir, 'nope.db')
    created.push(missing)
    expect(() => openMediaLibraryDb(missing)).toThrow()
    // Confirm we did NOT create the file as a side effect.
    expect(fs.existsSync(missing)).toBe(false)
  })
})
