import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Controllable test doubles. We mock env (to flip useMediaCore) and the
// media-library singleton (to return a real in-memory better-sqlite3
// handle, or null for the graceful-degrade path). The function under test
// is the REAL tagLocalAvailability — no logic is stubbed.
const hoisted = vi.hoisted(() => ({
  useMediaCore: true,
  dbHandle: null as { raw: import('better-sqlite3').Database; close(): void } | null,
}))

vi.mock('../env.js', () => ({
  env: {
    get useMediaCore() {
      return hoisted.useMediaCore
    },
    MEDIA_DB_PATH: ':memory:',
  },
}))

vi.mock('../services/mediaLibraryDbSingleton.js', () => ({
  mediaLibraryDb: () => hoisted.dbHandle,
}))

// Build an in-memory media.db with the media-core movies/shows schema.
function makeDb(opts: {
  movies?: Array<{ tmdb_id: number | null; title: string; year: number | null }>
  shows?: Array<{ tmdb_id: number | null; title: string; year: number | null }>
}): { raw: import('better-sqlite3').Database; close(): void } {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER UNIQUE,
      title TEXT NOT NULL,
      year INTEGER,
      added_at TEXT NOT NULL DEFAULT 'now',
      file_id INTEGER
    );
    CREATE TABLE shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER UNIQUE,
      title TEXT NOT NULL,
      year INTEGER,
      added_at TEXT NOT NULL DEFAULT 'now'
    );
  `)
  const insM = raw.prepare(
    "INSERT INTO movies (tmdb_id, title, year, added_at) VALUES (?, ?, ?, 'now')",
  )
  for (const m of opts.movies ?? []) insM.run(m.tmdb_id, m.title, m.year)
  const insS = raw.prepare(
    "INSERT INTO shows (tmdb_id, title, year, added_at) VALUES (?, ?, ?, 'now')",
  )
  for (const s of opts.shows ?? []) insS.run(s.tmdb_id, s.title, s.year)
  return { raw, close: () => raw.close() }
}

let tagLocalAvailability: typeof import('../services/localAvailability.js').tagLocalAvailability

beforeEach(async () => {
  hoisted.useMediaCore = true
  hoisted.dbHandle = null
  vi.resetModules()
  ;({ tagLocalAvailability } = await import('../services/localAvailability.js'))
})

const item = (
  id: number,
  title: string,
  year?: number,
  available_on?: string[],
) => ({ id, title, posterPath: null, year, available_on })

describe('tagLocalAvailability', () => {
  it('tags by tmdb_id (primary join)', () => {
    hoisted.dbHandle = makeDb({
      movies: [{ tmdb_id: 603, title: 'junk reversed title', year: 1999 }],
    })
    const out = tagLocalAvailability([item(603, 'The Matrix', 1999)], 'movie')
    expect(out[0].available_on).toContain('local')
  })

  it('tags via normalized title + year fallback when tmdb_id is null', () => {
    hoisted.dbHandle = makeDb({
      movies: [{ tmdb_id: null, title: 'The Matrix', year: 1999 }],
    })
    const out = tagLocalAvailability([item(603, 'Matrix', 1999)], 'movie')
    expect(out[0].available_on).toContain('local')
  })

  it('does NOT match on title when the year differs', () => {
    hoisted.dbHandle = makeDb({
      movies: [{ tmdb_id: null, title: 'The Matrix', year: 2003 }],
    })
    const out = tagLocalAvailability([item(603, 'The Matrix', 1999)], 'movie')
    expect(out[0].available_on ?? []).not.toContain('local')
  })

  it('skips fallback for short (<5 char) normalized titles', () => {
    hoisted.dbHandle = makeDb({
      movies: [{ tmdb_id: null, title: 'Up', year: 2009 }],
    })
    const out = tagLocalAvailability([item(999, 'Up', 2009)], 'movie')
    // "up" normalizes to 2 chars -> skipped, no false positive
    expect(out[0].available_on ?? []).not.toContain('local')
  })

  it('preserves an existing iptv tag and adds local (composition)', () => {
    hoisted.dbHandle = makeDb({
      movies: [{ tmdb_id: 603, title: 'x', year: 1999 }],
    })
    const out = tagLocalAvailability(
      [item(603, 'The Matrix', 1999, ['iptv'])],
      'movie',
    )
    expect(out[0].available_on).toEqual(expect.arrayContaining(['iptv', 'local']))
  })

  it('uses the shows table for kind="tv"', () => {
    hoisted.dbHandle = makeDb({
      shows: [{ tmdb_id: 1396, title: 'Breaking Bad', year: 2008 }],
    })
    const out = tagLocalAvailability([item(1396, 'Breaking Bad', 2008)], 'tv')
    expect(out[0].available_on).toContain('local')
  })

  it('returns items unchanged when useMediaCore is off', () => {
    hoisted.useMediaCore = false
    hoisted.dbHandle = makeDb({
      movies: [{ tmdb_id: 603, title: 'The Matrix', year: 1999 }],
    })
    const input = [item(603, 'The Matrix', 1999)]
    const out = tagLocalAvailability(input, 'movie')
    expect(out).toBe(input)
    expect(out[0].available_on ?? []).not.toContain('local')
  })

  it('tolerates a null singleton (missing media.db) without throwing', () => {
    hoisted.dbHandle = null
    const input = [item(603, 'The Matrix', 1999)]
    const out = tagLocalAvailability(input, 'movie')
    expect(out).toBe(input)
  })

  it('never mutates the input array or its items', () => {
    hoisted.dbHandle = makeDb({
      movies: [{ tmdb_id: 603, title: 'x', year: 1999 }],
    })
    const input = [item(603, 'The Matrix', 1999)]
    const out = tagLocalAvailability(input, 'movie')
    expect(input[0].available_on).toBeUndefined() // original untouched
    expect(out).not.toBe(input)
    expect(out[0]).not.toBe(input[0])
  })
})
