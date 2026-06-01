import { describe, it, expect, vi, beforeEach } from 'vitest'
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
vi.mock('./iptvEpg.js', () => ({
  fetchAndStreamEpg: vi.fn(async (onRow: (r: EpgProgrammeRow) => void) => {
    onRow({ channel_id: 'c.1', start_utc: '2026-05-24T10:00:00.000Z', stop_utc: '2026-05-24T10:30:00.000Z', title: 'P1', description: null })
    onRow({ channel_id: 'c.1', start_utc: '2026-05-24T10:30:00.000Z', stop_utc: '2026-05-24T11:00:00.000Z', title: 'P2', description: null })
  }),
}))
vi.mock('./iptvEpgExternal.js', () => ({
  ingestAllExternalEpg: vi.fn(async () => []),
}))

import { syncOnce } from './iptvSync.js'

describe('iptv sync orchestrator', () => {
  let dbFile: string
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'))
    dbFile = path.join(tmp, 'iptv.db')
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
})
