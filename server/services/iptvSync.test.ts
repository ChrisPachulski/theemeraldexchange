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
    expect(deriveWestFeedEpg(db, new Set())).toMatchObject({ channels: 1, programmes: 2 })
    expect(titles('showtimewest.us')).toEqual([
      { start_utc: '2026-10-15T03:00:00.000Z', title: 'V for Vendetta' },
      { start_utc: '2026-10-15T05:15:00.000Z', title: 'Patriot Games' },
    ])
    // Idempotent, and it follows a later East change on the next sync.
    db.stmts.upsertEpg.run({
      channel_id: 'showtime.us', start_utc: '2026-10-15T02:15:00.000Z', stop_utc: '2026-10-15T04:15:00.000Z',
      title: 'Sleeping Dogs', description: null,
    })
    expect(deriveWestFeedEpg(db, new Set()).channels).toBe(1)
    expect(titles('showtimewest.us')).toHaveLength(2)
    expect(titles('showtimewest.us')[1]).toMatchObject({ title: 'Sleeping Dogs' })
  })

  it('keeps going after the East source ages out ahead of its copy', () => {
    const { db, titles } = westDb()
    deriveWestFeedEpg(db, new Set())
    db.raw.prepare("DELETE FROM epg_programs WHERE channel_id = 'showtime.us' AND title = 'V for Vendetta'").run()
    expect(deriveWestFeedEpg(db, new Set()).channels).toBe(1)
    expect(titles('showtimewest.us')).toHaveLength(2)
  })

  it('replaces its earlier copy when an East programme moves', () => {
    const { db, titles } = westDb()
    deriveWestFeedEpg(db, new Set())
    db.raw.prepare("UPDATE epg_programs SET start_utc = '2026-10-15T02:30:00.000Z' WHERE channel_id = 'showtime.us' AND title = 'Patriot Games'").run()
    deriveWestFeedEpg(db, new Set())
    expect(titles('showtimewest.us')).toEqual([
      { start_utc: '2026-10-15T03:00:00.000Z', title: 'V for Vendetta' },
      { start_utc: '2026-10-15T05:30:00.000Z', title: 'Patriot Games' },
    ])
  })

  it('leaves a West feed with its own listings alone', () => {
    const { db, programme, titles } = westDb()
    programme('showtimewest.us', '2026-10-15T03:30:00.000Z', '2026-10-15T05:00:00.000Z', 'Real West Listing')
    expect(deriveWestFeedEpg(db, new Set())).toEqual({ channels: 0, programmes: 0, ids: ['showtimewest.us'] })
    expect(titles('showtimewest.us')).toEqual([{ start_utc: '2026-10-15T03:30:00.000Z', title: 'Real West Listing' }])
  })

  it('leaves a West feed the provider delivered alone', () => {
    const { db, programme, titles } = westDb()
    programme('showtimewest.us', '2026-10-15T03:30:00.000Z', '2026-10-15T05:00:00.000Z', 'Real West Listing')
    expect(deriveWestFeedEpg(db, new Set(['showtimewest.us']))).toEqual({ channels: 0, programmes: 0, ids: [] })
    expect(titles('showtimewest.us')).toEqual([{ start_utc: '2026-10-15T03:30:00.000Z', title: 'Real West Listing' }])
  })
})

describe('sync EPG ingest', () => {
  type Def = { id: string; names: string[] }
  let db: ReturnType<typeof openIptvDb>
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-15T03:20:00.000Z'), toFake: ['Date'] })
    db = openIptvDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-')), 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const channel = (stream_id: number, name: string, epg_channel_id: string | null, fetched_at = 'x') => ({
    stream_id, num: stream_id, name, stream_icon: null, epg_channel_id, category_id: 1,
    is_adult: 0, tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at,
  })
  const row = (channel_id: string, start: string, stop: string, title: string): EpgProgrammeRow =>
    ({ channel_id, start_utc: `2026-10-15T${start}:00.000Z`, stop_utc: `2026-10-15T${stop}:00.000Z`, title, description: null })
  // One sync against a provider catalog and XMLTV feed.
  const sync = async (channels: Array<[number, string, string | null]>, rows: EpgProgrammeRow[], defs: Def[] = []) => {
    vi.mocked(fetchLiveStreams).mockImplementationOnce(async (fetched) => channels.map(([id, name, tvg]) => channel(id, name, tvg, fetched)))
    vi.mocked(fetchAndStreamEpg).mockImplementationOnce(async (onRow, _host, onDef) => {
      for (const d of defs) onDef?.(d)
      for (const r of rows) onRow(r)
    })
    return syncOnce(db)
  }
  const schedule = (id: string) => db.raw
    .prepare('SELECT substr(start_utc, 12, 5) AS at, title FROM epg_programs WHERE channel_id = ? ORDER BY start_utc').all(id)
  const listed = (streamId: number) => (db.raw
    .prepare('SELECT COALESCE(epg_resolved_id, epg_channel_id) AS id FROM channels WHERE stream_id = ?').get(streamId) as { id: string | null }).id

  it('replaces a rescheduled lineup instead of interleaving it (cinemaxclassics.us, 2026-10-15)', async () => {
    const cinemax: Array<[number, string, string | null]> = [[200163548, 'US: Cinemax Classics', 'cinemaxclassics.us']]
    await sync(cinemax, [
      row('cinemaxclassics.us', '02:39', '04:01', 'Godzilla vs. Megalon'),
      row('cinemaxclassics.us', '04:01', '05:23', 'Godzilla Raids Again'),
      row('showtime.us', '02:15', '04:15', 'Patriot Games'),
    ])
    await sync(cinemax, [
      row('cinemaxclassics.us', '01:56', '03:32', 'Just Friends'),
      row('cinemaxclassics.us', '03:32', '04:58', 'Son of Godzilla'),
      row('cinemaxclassics.us', '04:58', '06:45', 'The Usual Suspects'),
    ])
    expect(schedule('cinemaxclassics.us')).toEqual([
      { at: '01:56', title: 'Just Friends' },
      { at: '03:32', title: 'Son of Godzilla' },
      { at: '04:58', title: 'The Usual Suspects' },
    ])
    // An id this sync did not deliver keeps its schedule.
    expect(schedule('showtime.us')).toEqual([{ at: '02:15', title: 'Patriot Games' }])
  })

  it('a failed fetch leaves every schedule as it was', async () => {
    const cinemax: Array<[number, string, string | null]> = [[200163548, 'US: Cinemax Classics', 'cinemaxclassics.us']]
    await sync(cinemax, [row('cinemaxclassics.us', '01:56', '03:32', 'Just Friends')])
    vi.mocked(fetchAndStreamEpg).mockImplementationOnce(async (onRow) => {
      // More than one write batch arrives before the feed dies.
      for (let i = 0; i < 1_500; i += 1) {
        const at = Date.parse('2026-10-15T02:00:00.000Z') + i * 60_000
        onRow({ channel_id: 'cinemaxclassics.us', start_utc: new Date(at).toISOString(),
          stop_utc: new Date(at + 60_000).toISOString(), title: 'Partial', description: null })
      }
      throw new Error('epg_idle_timeout')
    })
    await expect(syncOnce(db)).rejects.toThrow('epg_idle_timeout')
    expect(schedule('cinemaxclassics.us')).toEqual([{ at: '01:56', title: 'Just Friends' }])
  })

  it('stores no filler, so an id with only filler has no EPG (fox.us, 2026-10-15)', async () => {
    db.stmts.upsertEpg.run(row('fox.us', '00:00', '04:00', 'No Match Today'))
    await sync([[200168129, 'US: FOX 13 Memphis (WHBQ)', 'fox.us']], [
      row('fox.us', '00:00', '04:00', 'No Match Today'),
      row('fox.us', '02:00', '10:00', 'SIGN OFF'),
      row('outdoorchannel.us', '02:05', '06:05', 'Channel Off Air'),
      row('outdoorchannel.us', '03:00', '03:30', 'Guns & Ammo TV'),
    ])
    expect(schedule('fox.us')).toEqual([])
    expect(listed(200168129)).toBe('fox.us')
    expect(db.raw.prepare('SELECT epg_resolved_id FROM channels WHERE stream_id = 200168129').get()).toEqual({ epg_resolved_id: null })
    expect(schedule('outdoorchannel.us')).toEqual([{ at: '03:00', title: 'Guns & Ammo TV' }])
  })

  it('external ingest never replaces a schedule the provider delivered', async () => {
    const external = await vi.importActual<typeof import('./iptvEpgExternal.js')>('./iptvEpgExternal.js')
    const xml = '<tv><channel id="aljazeera.arabic.net"><display-name>Al Jazeera Arabic</display-name></channel>' +
      '<programme channel="aljazeera.arabic.net" start="20261015030000 +0000" stop="20261015040000 +0000"><title>External</title></programme></tv>'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(xml)))
    vi.mocked(ingestAllExternalEpg).mockImplementationOnce(async (target, fed, west) => [
      await external.ingestExternalEpg(target, 'https://epg.example/feed.xml', { fed, west }),
    ])
    await sync([[1, 'US: Al Jazeera Arabic', null]], [row('aljazeera.arabic.net', '03:00', '03:30', 'Provider')])
    expect(schedule('aljazeera.arabic.net')).toEqual([{ at: '03:00', title: 'Provider' }])
    expect(listed(1)).toBe('aljazeera.arabic.net')
  })

  it('drops a stored programme still airing when the rescheduled lineup starts later', async () => {
    const x: Array<[number, string, string | null]> = [[1, 'US: X', 'x.us']]
    await sync(x, [row('x.us', '03:00', '05:00', 'Old movie')])
    await sync(x, [row('x.us', '03:30', '05:30', 'Rescheduled movie')])
    expect(schedule('x.us')).toEqual([{ at: '03:30', title: 'Rescheduled movie' }])
  })

  it('stores a real film called Unknown', async () => {
    const starz: Array<[number, string, string | null]> = [[1, 'US: Starz Encore Suspense', 'starzencoresuspense.us']]
    await sync(starz, [{ ...row('starzencoresuspense.us', '03:00', '04:26', 'Unknown'),
      description: 'When five men awake in a locked warehouse, none of them can remember his identity.' }])
    expect(schedule('starzencoresuspense.us')).toEqual([{ at: '03:00', title: 'Unknown' }])
  })

  it('a real West schedule beats the East copy, this sync and the next', async () => {
    const external = await vi.importActual<typeof import('./iptvEpgExternal.js')>('./iptvEpgExternal.js')
    const xml = (body: string) => new Response('<tv><channel id="showtimewest.us"><display-name>Showtime West</display-name></channel>' + body + '</tv>')
    const results: Array<Awaited<ReturnType<typeof external.ingestExternalEpg>>> = []
    const viaExternal = (body: string) => {
      vi.stubGlobal('fetch', vi.fn(async () => xml(body)))
      vi.mocked(ingestAllExternalEpg).mockImplementationOnce(async (target, fed, west) => {
        results.push(await external.ingestExternalEpg(target, 'https://epg.example/feed.xml', { fed, west }))
        return results.slice(-1)
      })
    }
    const catalog: Array<[number, string, string | null]> = [[5866, 'US Showtime West (S)', 'showtimewest.us'], [200163566, 'US: Showtime', 'showtime.us']]
    const east = [row('showtime.us', '00:00', '02:15', 'V for Vendetta'), row('showtime.us', '02:15', '04:15', 'Patriot Games')]
    viaExternal('<programme channel="showtimewest.us" start="20261015030000 +0000" stop="20261015050000 +0000"><title>Real West</title></programme>')
    await sync(catalog, east)
    expect(results[0]).toMatchObject({ ok: true, programmesStored: 1 })
    expect(schedule('showtimewest.us')).toEqual([{ at: '03:00', title: 'Real West' }])
    // Next sync the source has nothing for it; the stored listing still wins.
    viaExternal('')
    await sync(catalog, east)
    expect(schedule('showtimewest.us')).toEqual([{ at: '03:00', title: 'Real West' }])
    expect(listed(5866)).toBe('showtimewest.us')
  })

  it('lists Showtime West on showtimewest.us with West times (5866, 400124927; 2026-10-14)', async () => {
    db.stmts.upsertChannel.run(channel(5866, 'US Showtime West (S)', 'showtimewest.us'))
    db.raw.prepare("UPDATE channels SET epg_resolved_id = 'showtime2west.us' WHERE stream_id = 5866").run()
    await sync([
      [5866, 'US Showtime West (S)', 'showtimewest.us'],
      [400124927, 'US: SHOWTIME WEST', null],
      [200163566, 'US: Showtime', 'showtime.us'],
    ], [
      row('showtime.us', '00:00', '02:15', 'V for Vendetta'),
      row('showtime.us', '02:15', '04:15', 'Patriot Games'),
      row('showtime2west.us', '03:00', '05:00', 'The Return'),
    ], [
      { id: 'showtime.us', names: ['Showtime'] },
      { id: 'showtime2west.us', names: ['Showtime 2 West'] },
      { id: 'showtimewest.us', names: ['Showtime West'] },
    ])
    expect(listed(5866)).toBe('showtimewest.us')
    expect(listed(400124927)).toBe('showtimewest.us')
    expect(schedule('showtimewest.us')).toEqual([
      { at: '03:00', title: 'V for Vendetta' },
      { at: '05:15', title: 'Patriot Games' },
    ])
  })
})
