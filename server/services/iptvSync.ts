import {
  credsFromEnv, fetchCategories, fetchLiveStreams, fetchVodStreams,
  fetchSeriesList, fetchSeriesInfo,
} from './xtream.js'
import { fetchAndStreamEpg } from './iptvEpg.js'
import type { IptvDb } from './iptvDb.js'

export interface SyncResult {
  busy?: boolean
  channels: number
  vod: number
  series: number
  episodes: number
  epg: number
  categories: number
  durationMs: number
  startedAt: string
  finishedAt: string
}

let running = false

export async function syncOnce(db: IptvDb): Promise<SyncResult> {
  if (running) {
    return {
      busy: true,
      channels: 0, vod: 0, series: 0, episodes: 0, epg: 0, categories: 0,
      durationMs: 0, startedAt: '', finishedAt: '',
    }
  }
  running = true
  const startedAt = new Date()
  const fetchedAt = startedAt.toISOString()
  let channels = 0, vod = 0, series = 0, episodes = 0, epg = 0, categories = 0

  try {
    const creds = credsFromEnv()

    const [liveCats, vodCats, seriesCats] = await Promise.all([
      fetchCategories('live', creds),
      fetchCategories('vod', creds),
      fetchCategories('series', creds),
    ])
    const writeCats = db.raw.transaction(() => {
      for (const c of liveCats) db.stmts.upsertCategory.run({ ...c, kind: 'live' })
      for (const c of vodCats) db.stmts.upsertCategory.run({ ...c, kind: 'vod' })
      for (const c of seriesCats) db.stmts.upsertCategory.run({ ...c, kind: 'series' })
    })
    writeCats()
    categories = liveCats.length + vodCats.length + seriesCats.length

    const [liveRows, vodRows, seriesRows] = await Promise.all([
      fetchLiveStreams(fetchedAt, creds),
      fetchVodStreams(fetchedAt, creds),
      fetchSeriesList(fetchedAt, creds),
    ])

    const writeChannels = db.raw.transaction((rows: typeof liveRows) => {
      for (const r of rows) db.stmts.upsertChannel.run(r)
    })
    writeChannels(liveRows)
    channels = liveRows.length

    const writeVod = db.raw.transaction((rows: typeof vodRows) => {
      for (const r of rows) db.stmts.upsertVod.run(r)
    })
    writeVod(vodRows)
    vod = vodRows.length

    const writeSeries = db.raw.transaction((rows: typeof seriesRows) => {
      for (const r of rows) db.stmts.upsertSeries.run(r)
    })
    writeSeries(seriesRows)
    series = seriesRows.length

    // Episode expansion — small concurrency cap to spare upstream.
    const CONCURRENCY = 4
    let cursor = 0
    async function worker(): Promise<void> {
      while (cursor < seriesRows.length) {
        const i = cursor++
        const s = seriesRows[i]
        try {
          const eps = await fetchSeriesInfo(s.series_id, creds)
          const writeEps = db.raw.transaction((rows: typeof eps) => {
            for (const r of rows) db.stmts.upsertEpisode.run(r)
          })
          writeEps(eps)
          episodes += eps.length
        } catch (err) {
          console.error(`[iptv-sync] series_info ${s.series_id} failed:`, err)
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

    // Populate the iptv_title_link table for the recommender integration.
    db.raw.transaction(() => {
      db.raw.prepare(`
        INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id)
        SELECT 'vod', stream_id, 'movie', tmdb_id FROM vod WHERE tmdb_id IS NOT NULL
        ON CONFLICT(iptv_kind, iptv_id) DO UPDATE SET tmdb_id = excluded.tmdb_id, tmdb_kind = excluded.tmdb_kind
      `).run()
      db.raw.prepare(`
        INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id)
        SELECT 'series', series_id, 'tv', tmdb_id FROM series WHERE tmdb_id IS NOT NULL
        ON CONFLICT(iptv_kind, iptv_id) DO UPDATE SET tmdb_id = excluded.tmdb_id, tmdb_kind = excluded.tmdb_kind
      `).run()
    })()

    // EPG window — drop stale, store 7-day forward.
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString()
    db.raw.prepare(`DELETE FROM epg_programs WHERE stop_utc < ?`).run(cutoff)

    const horizon = new Date(Date.now() + 7 * 24 * 3600_000).toISOString()
    let batch: Parameters<typeof db.stmts.upsertEpg.run>[0][] = []
    const flushBatch = db.raw.transaction((rows: typeof batch) => {
      for (const r of rows) db.stmts.upsertEpg.run(r)
    })
    await fetchAndStreamEpg((row) => {
      if (row.stop_utc > horizon) return
      batch.push(row)
      epg += 1
      if (batch.length >= 1_000) {
        flushBatch(batch)
        batch = []
      }
    })
    if (batch.length) flushBatch(batch)

    const finishedAt = new Date()
    db.stmts.putSyncState.run({ key: 'last_sync', value: 'ok', ts: finishedAt.toISOString() })
    return {
      channels, vod, series, episodes, epg, categories,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    }
  } catch (err) {
    const finishedAt = new Date()
    db.stmts.putSyncState.run({
      key: 'last_sync',
      value: `error:${err instanceof Error ? err.message : String(err)}`,
      ts: finishedAt.toISOString(),
    })
    throw err
  } finally {
    running = false
  }
}
