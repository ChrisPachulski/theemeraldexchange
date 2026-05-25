import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import { epgChannelWindow, epgGrid, epgNow } from './iptvEpgQuery.js'

describe('epg queries', () => {
  let db: IptvDb

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
    const fetchedAt = '2026-05-24T12:00:00Z'

    db.stmts.upsertChannel.run({
      stream_id: 10,
      num: 1,
      name: 'C1',
      stream_icon: null,
      epg_channel_id: 'c1',
      category_id: 1,
      is_adult: 0,
      tv_archive: 1,
      tv_archive_duration: 7,
      added_ts: null,
      fetched_at: fetchedAt,
    })
    db.stmts.upsertChannel.run({
      stream_id: 20,
      num: 2,
      name: 'C2',
      stream_icon: null,
      epg_channel_id: 'c2',
      category_id: 2,
      is_adult: 0,
      tv_archive: 0,
      tv_archive_duration: null,
      added_ts: null,
      fetched_at: fetchedAt,
    })
    db.stmts.upsertChannel.run({
      stream_id: 30,
      num: 3,
      name: 'No EPG',
      stream_icon: null,
      epg_channel_id: null,
      category_id: 1,
      is_adult: 0,
      tv_archive: 0,
      tv_archive_duration: null,
      added_ts: null,
      fetched_at: fetchedAt,
    })

    db.stmts.upsertEpg.run({
      channel_id: 'c1',
      start_utc: '2026-05-24T11:00:00Z',
      stop_utc: '2026-05-24T11:30:00Z',
      title: 'Past',
      description: null,
    })
    db.stmts.upsertEpg.run({
      channel_id: 'c1',
      start_utc: '2026-05-24T11:30:00Z',
      stop_utc: '2026-05-24T12:30:00Z',
      title: 'Now',
      description: 'Current show',
    })
    db.stmts.upsertEpg.run({
      channel_id: 'c1',
      start_utc: '2026-05-24T12:30:00Z',
      stop_utc: '2026-05-24T13:00:00Z',
      title: 'Next',
      description: null,
    })
    db.stmts.upsertEpg.run({
      channel_id: 'c2',
      start_utc: '2026-05-24T12:00:00Z',
      stop_utc: '2026-05-24T13:00:00Z',
      title: 'Other Channel',
      description: null,
    })
  })

  afterEach(() => {
    db.close()
  })

  it('epgNow returns current and next programmes for each channel', () => {
    const rows = epgNow(db, [10, 30], new Date('2026-05-24T12:00:00Z'))

    expect(rows).toEqual([
      expect.objectContaining({
        channel_stream_id: 10,
        current: expect.objectContaining({ title: 'Now' }),
        next: expect.objectContaining({ title: 'Next' }),
      }),
      { channel_stream_id: 30, current: null, next: null },
    ])
  })

  it('epgChannelWindow returns programmes overlapping the requested range', () => {
    const rows = epgChannelWindow(db, 10, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z')

    expect(rows.map((row) => row.title)).toEqual(['Past', 'Now', 'Next'])
  })

  it('epgGrid maps channels with programmes', () => {
    const rows = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z')

    expect(rows[0]).toEqual(expect.objectContaining({
      stream_id: 10,
      name: 'C1',
      tv_archive: 1,
      tv_archive_duration: 7,
    }))
    expect(rows[0].programmes.map((row) => row.title)).toEqual(['Past', 'Now', 'Next'])
  })

  it('epgGrid can filter by category', () => {
    const rows = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z', 2)

    expect(rows).toHaveLength(1)
    expect(rows[0].stream_id).toBe(20)
    expect(rows[0].programmes.map((row) => row.title)).toEqual(['Other Channel'])
  })
})
