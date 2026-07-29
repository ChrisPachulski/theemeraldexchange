import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveLocalWatchedSignal } from './localMediaWatchSignal.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER);
    CREATE TABLE shows (id INTEGER PRIMARY KEY, tmdb_id INTEGER);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, show_id INTEGER);
    CREATE TABLE media_watch_state (
      sub TEXT, media_kind TEXT, media_id INTEGER,
      position_secs INTEGER, duration_secs INTEGER, completed INTEGER
    );
    INSERT INTO movies VALUES (1, 101);
    INSERT INTO shows VALUES (2, 202);
    INSERT INTO episodes VALUES (3, 2);
  `)
})

afterEach(() => db.close())

describe('resolveLocalWatchedSignal', () => {
  it('emits movie watched on the first crossing of 40 percent', () => {
    expect(
      resolveLocalWatchedSignal(db, 'plex:1', {
        media_kind: 'movie', media_id: 1, position_secs: 40, duration_secs: 100, completed: false,
      }),
    ).toEqual({ kind: 'movie', tmdbId: 101 })
  })

  it('maps an episode to its parent show and does not repeat an existing crossing', () => {
    db.prepare(`INSERT INTO media_watch_state VALUES (?, 'episode', 3, 50, 100, 0)`).run('plex:1')
    expect(
      resolveLocalWatchedSignal(db, 'plex:1', {
        media_kind: 'episode', media_id: 3, position_secs: 80, duration_secs: 100, completed: false,
      }),
    ).toBeNull()
  })

  it('ignores under-threshold and titles without a TMDB identity', () => {
    expect(
      resolveLocalWatchedSignal(db, 'plex:1', {
        media_kind: 'movie', media_id: 1, position_secs: 39, duration_secs: 100, completed: false,
      }),
    ).toBeNull()
    db.prepare('INSERT INTO movies VALUES (4, NULL)').run()
    expect(
      resolveLocalWatchedSignal(db, 'plex:1', {
        media_kind: 'movie', media_id: 4, position_secs: 100, duration_secs: 100, completed: true,
      }),
    ).toBeNull()
  })
})
