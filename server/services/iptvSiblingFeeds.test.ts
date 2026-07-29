import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { normalizeChannelName, resolveSiblingFeeds } from './iptvSiblingFeeds.js'

describe('normalizeChannelName', () => {
  it('folds quality/format/backup variants of the same channel to one key', () => {
    const key = normalizeChannelName('Fox Soccer Plus')
    expect(normalizeChannelName('Fox Soccer Plus HD')).toBe(key)
    expect(normalizeChannelName('Fox Soccer Plus FHD')).toBe(key)
    expect(normalizeChannelName('Fox Soccer Plus [Backup]')).toBe(key)
    expect(normalizeChannelName('FOX SOCCER PLUS (1080p)')).toBe(key)
    expect(normalizeChannelName('Fox  Soccer_Plus')).toBe(key)
  })

  it('keeps genuinely different channels distinct', () => {
    expect(normalizeChannelName('Fox Soccer Plus')).not.toBe(normalizeChannelName('Fox Sports 1'))
  })
})

describe('resolveSiblingFeeds', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE channels (
        stream_id INTEGER PRIMARY KEY,
        num INTEGER,
        name TEXT NOT NULL,
        epg_channel_id TEXT
      );
    `)
    const ins = db.prepare('INSERT INTO channels (stream_id, num, name, epg_channel_id) VALUES (?, ?, ?, ?)')
    // Three feeds of the same event: two share an epg id, one only matches by name.
    ins.run(100, 5, 'Fox Soccer Plus', 'foxsoccer.us')
    ins.run(101, 6, 'Fox Soccer Plus HD', 'foxsoccer.us')
    ins.run(102, 4, 'Fox Soccer Plus [Backup]', null) // name-only sibling
    // An unrelated channel that must never be treated as a sibling.
    ins.run(200, 1, 'CNN', 'cnn.us')
  })

  afterEach(() => db.close())

  it('returns the tuned feed first, then its siblings ordered by channel number', () => {
    // Tuned '100' → itself first, then siblings by num: 102 (num 4), 101 (num 6).
    expect(resolveSiblingFeeds(db, '100')).toEqual(['100', '102', '101'])
  })

  it('matches siblings by epg_channel_id OR normalized name', () => {
    const siblings = resolveSiblingFeeds(db, '102') // '102' has no epg id
    expect(siblings[0]).toBe('102')
    expect(siblings.slice(1).sort()).toEqual(['100', '101']) // matched by name
  })

  it('never pulls in an unrelated channel', () => {
    expect(resolveSiblingFeeds(db, '200')).toEqual(['200'])
  })

  it('returns [streamId] for an unknown or non-numeric id', () => {
    expect(resolveSiblingFeeds(db, '999')).toEqual(['999'])
    expect(resolveSiblingFeeds(db, 'abc')).toEqual(['abc'])
  })
})
