import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openIptvDb, type IptvDb } from './iptvDb.js'

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
