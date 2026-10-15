import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openIptvDb } from './iptvDb.js'
import type { EpgProgrammeRow } from './iptvEpg.js'
import type { SyncResult } from './iptvSync.js'

vi.mock('./xtream.js', () => ({
  credsFromEnv: vi.fn(() => ({ host: 'https://p', username: 'u', password: 'p' })),
  fetchCategories: vi.fn(async (kind: string) =>
    kind === 'live'
      ? [{ category_id: 1, name: 'News', parent_id: 0 }]
      : kind === 'vod'
        ? [{ category_id: 2, name: 'Action', parent_id: 0 }]
        : [{ category_id: 3, name: 'Drama', parent_id: 0 }],
  ),
  fetchLiveStreams: vi.fn(async (fetched: string) => [
    { stream_id: 10, num: 1, name: 'C', stream_icon: null, epg_channel_id: 'c.1',
      category_id: 1, is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
      added_ts: null, fetched_at: fetched },
  ]),
  fetchVodStreams: vi.fn(async (fetched: string) => [
    { stream_id: 20, name: 'M', stream_icon: null, rating: 7, category_id: 2,
      container_extension: 'mp4', added_ts: null, tmdb_id: 603, year: 1999,
      plot: null, director: null, cast_csv: null, fetched_at: fetched },
  ]),
  fetchSeriesList: vi.fn(async (fetched: string) => [
    { series_id: 30, name: 'S', cover: null, plot: null, rating: null,
      category_id: 3, tmdb_id: 1399, last_modified: null, fetched_at: fetched },
  ]),
  fetchSeriesInfo: vi.fn(async (seriesId: number) => [
    { episode_id: '101', series_id: seriesId, season: 1, episode_num: 1,
      title: 'Pilot', container_extension: 'mp4', added_ts: null,
      plot: null, duration_secs: 1200 },
  ]),
}))
vi.mock('../env.js', () => ({
  env: {
    XTREAM_HOST: 'https://p', XTREAM_USERNAME: 'u', XTREAM_PASSWORD: 'p',
    IPTV_LIST_TIMEOUT_MS: 30000, IPTV_DB_PATH: '',
    IPTV_SYNC_CRON: '0 */6 * * *',
  },
}))
vi.mock('./iptvEpg.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./iptvEpg.js')>(),
  fetchAndStreamEpg: vi.fn(async (onRow: (r: EpgProgrammeRow) => void) => {
    onRow({ channel_id: 'c.1', start_utc: '2026-05-24T10:00:00.000Z', stop_utc: '2026-05-24T10:30:00.000Z', title: 'P1', description: null })
    onRow({ channel_id: 'c.1', start_utc: '2026-05-24T10:30:00.000Z', stop_utc: '2026-05-24T11:00:00.000Z', title: 'P2', description: null })
  }),
}))
vi.mock('./iptvEpgExternal.js', () => ({
  ingestAllExternalEpg: vi.fn(async () => []),
}))

import { deriveWestFeedEpg, syncOnce } from './iptvSync.js'
import { fetchAndStreamEpg } from './iptvEpg.js'
import { fetchLiveStreams } from './xtream.js'
import { ingestAllExternalEpg } from './iptvEpgExternal.js'

describe('iptv sync orchestrator', () => {
  let dbFile: string
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-05-24T12:00:00.000Z'), toFake: ['Date'] })
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'))
    dbFile = path.join(tmp, 'iptv.db')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('an ancient provider schedule cannot claim a channel and block its current external fallback', async () => {
    const db = openIptvDb(dbFile)
    vi.mocked(fetchLiveStreams).mockResolvedValueOnce([{
      stream_id: 10, num: 1, name: 'US: ESPN', stream_icon: null, epg_channel_id: 'espn.us',
      category_id: 1, is_adult: 0, tv_archive: 0, tv_archive_duration: null,
      added_ts: null, fetched_at: '2026-05-24T12:00:00.000Z',
    }])
    vi.mocked(fetchAndStreamEpg).mockImplementationOnce(async onRow => {
      onRow({ channel_id: 'espn.us', start_utc: '2026-05-20T12:00:00.000Z',
        stop_utc: '2026-05-20T13:00:00.000Z', title: 'Ancient', description: null })
    })
    const external = await vi.importActual<typeof import('./iptvEpgExternal.js')>('./iptvEpgExternal.js')
    const xml = '<tv><channel id="external.espn"><display-name>ESPN</display-name></channel><programme channel="external.espn" start="20260524120000 +0000" stop="20260524130000 +0000"><title>Current external game</title></programme></tv>'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(xml)))
    vi.mocked(ingestAllExternalEpg).mockImplementationOnce(async target => [
      await external.ingestExternalEpg(target, 'https://epg.example/feed.xml'),
    ])
    try {
      await syncOnce(db)
      expect(db.raw.prepare('SELECT epg_resolved_id FROM channels WHERE stream_id = 10').get())
        .toEqual({ epg_resolved_id: 'external.espn' })
      expect(db.raw.prepare('SELECT title FROM epg_programs').all()).toEqual([{ title: 'Current external game' }])
    } finally {
      db.close()
    }
  })

  it('populates catalog + epg under one mutex', async () => {
    const db = openIptvDb(dbFile)
    const result = await syncOnce(db)
    expect(result.channels).toBe(1)
    expect(result.vod).toBe(1)
    expect(result.series).toBe(1)
    expect(result.episodes).toBe(1)
    expect(result.epg).toBe(2)
    expect(result.categories).toBe(3)
    const ts = db.stmts.getSyncState.get('last_sync') as { value: string; ts: string } | undefined
    expect(ts?.value).toBe('ok')
    db.close()
  }, 5000)

  it('refuses overlapping runs (returns busy)', async () => {
    const db = openIptvDb(dbFile)
    const a = syncOnce(db)
    const b = syncOnce(db)
    const [ra, rb] = await Promise.all([a, b])
    const busy = [ra, rb].filter((r) => r.busy === true)
    const ok = [ra, rb].filter((r) => r.busy !== true) as Array<Extract<SyncResult, { busy?: false }>>
    expect(busy.length).toBe(1)
    expect(ok.length).toBe(1)
    // the winner must have done real work, proving the mutex serialized rather than no-op'd
    expect(ok[0].channels).toBe(1)
    db.close()
  }, 5000)

  it('stores error state when sync fails', async () => {
    const { fetchLiveStreams } = await import('./xtream.js')
    vi.mocked(fetchLiveStreams).mockRejectedValueOnce(new Error('fetch_live_failed'))

    const db = openIptvDb(dbFile)
    await expect(syncOnce(db)).rejects.toThrow('fetch_live_failed')

    // Verify error state was saved
    const ts = db.stmts.getSyncState.get('last_sync') as { value: string; ts: string } | undefined
    expect(ts?.value).toContain('error:')
    expect(ts?.value).toContain('fetch_live_failed')
    db.close()

    // Restore mock
    vi.mocked(fetchLiveStreams).mockResolvedValue([
      { stream_id: 10, num: 1, name: 'C', stream_icon: null, epg_channel_id: 'c.1',
        category_id: 1, is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
        added_ts: null, fetched_at: '2026-05-24T00:00:00Z' },
    ])
  })
})

describe('deriveWestFeedEpg', () => {
  function westDb() {
    const db = openIptvDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'west-')), 'iptv.db'))
    for (const [stream_id, epg_channel_id] of [[200163566, 'showtime.us'], [5866, 'showtimewest.us'], [7, 'hgtvwest.us']] as const) {
      db.stmts.upsertChannel.run({
        stream_id, num: stream_id, name: String(stream_id), stream_icon: null, epg_channel_id, category_id: 1,
        is_adult: 0, tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: '2026-10-15T00:00:00Z',
      })
    }
    const programme = (channel_id: string, start_utc: string, stop_utc: string, title: string): void => {
      db.stmts.upsertEpg.run({ channel_id, start_utc, stop_utc, title, description: null })
    }
    programme('showtime.us', '2026-10-15T00:00:00.000Z', '2026-10-15T02:15:00.000Z', 'V for Vendetta')
    programme('showtime.us', '2026-10-15T02:15:00.000Z', '2026-10-15T04:15:00.000Z', 'Patriot Games')
    const titles = (channel: string) => db.raw
      .prepare('SELECT start_utc, title FROM epg_programs WHERE channel_id = ? ORDER BY start_utc').all(channel)
    return { db, programme, titles }
  }

  it('lists a West feed with no guide as the East schedule three hours later (the 2026-10-14 incident)', () => {
    const { db, titles } = westDb()
    expect(deriveWestFeedEpg(db)).toEqual({ channels: 1, programmes: 2 })
    expect(titles('showtimewest.us')).toEqual([
      { start_utc: '2026-10-15T03:00:00.000Z', title: 'V for Vendetta' },
      { start_utc: '2026-10-15T05:15:00.000Z', title: 'Patriot Games' },
    ])
    // Idempotent, and it follows a later East change on the next sync.
    db.stmts.upsertEpg.run({
      channel_id: 'showtime.us', start_utc: '2026-10-15T02:15:00.000Z', stop_utc: '2026-10-15T04:15:00.000Z',
      title: 'Sleeping Dogs', description: null,
    })
    expect(deriveWestFeedEpg(db).channels).toBe(1)
    expect(titles('showtimewest.us')).toHaveLength(2)
    expect(titles('showtimewest.us')[1]).toMatchObject({ title: 'Sleeping Dogs' })
  })

  it('keeps going after the East source ages out ahead of its copy', () => {
    const { db, titles } = westDb()
    deriveWestFeedEpg(db)
    db.raw.prepare("DELETE FROM epg_programs WHERE channel_id = 'showtime.us' AND title = 'V for Vendetta'").run()
    expect(deriveWestFeedEpg(db).channels).toBe(1)
    expect(titles('showtimewest.us')).toHaveLength(2)
  })

  it('leaves a West feed with its own listings alone', () => {
    const { db, programme, titles } = westDb()
    programme('showtimewest.us', '2026-10-15T03:30:00.000Z', '2026-10-15T05:00:00.000Z', 'Real West Listing')
    expect(deriveWestFeedEpg(db)).toEqual({ channels: 0, programmes: 0 })
    expect(titles('showtimewest.us')).toEqual([{ start_utc: '2026-10-15T03:30:00.000Z', title: 'Real West Listing' }])
  })
})
