import {
  credsFromEnv, fetchCategories, fetchLiveStreams, fetchVodStreams,
  fetchSeriesList, fetchSeriesInfo,
} from './xtream.js'
import { fetchAndStreamEpg } from './iptvEpg.js'
import { buildEpgNameIndex, resolveEpgId, type FeedChannelDef } from './iptvEpgResolve.js'
import { ingestAllExternalEpg } from './iptvEpgExternal.js'
import type { IptvDb } from './iptvDb.js'

export type SyncResult =
  | {
      busy: true
      channels?: never
      vod?: never
      series?: never
      episodes?: never
      epg?: never
      categories?: never
      durationMs?: never
      startedAt?: never
      finishedAt?: never
    }
  | {
      busy?: false
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

function pruneCategories(db: IptvDb, kind: 'live' | 'vod' | 'series', ids: number[]): void {
  if (ids.length === 0) {
    db.raw.prepare(`DELETE FROM categories WHERE kind = ?`).run(kind)
    return
  }
  const placeholders = ids.map(() => '?').join(',')
  db.raw.prepare(`DELETE FROM categories WHERE kind = ? AND category_id NOT IN (${placeholders})`).run(kind, ...ids)
}

function reconcileCatalog(
  db: IptvDb,
  fetchedAt: string,
  categoryIds: { live: number[]; vod: number[]; series: number[] },
): void {
  db.raw.prepare(`DELETE FROM channels WHERE fetched_at != ?`).run(fetchedAt)
  db.raw.prepare(`DELETE FROM vod WHERE fetched_at != ?`).run(fetchedAt)
  db.raw.prepare(`DELETE FROM series WHERE fetched_at != ?`).run(fetchedAt)
  // Soft-delete link rows whose parent vod/series was de-listed this sync.
  // Hard deletes are deferred to the nightly sweep (14-day window).
  db.raw.prepare(`
    UPDATE iptv_title_link SET removed_at = datetime('now')
    WHERE removed_at IS NULL
      AND iptv_kind = 'vod'
      AND iptv_id NOT IN (SELECT stream_id FROM vod)
  `).run()
  db.raw.prepare(`
    UPDATE iptv_title_link SET removed_at = datetime('now')
    WHERE removed_at IS NULL
      AND iptv_kind = 'series'
      AND iptv_id NOT IN (SELECT series_id FROM series)
  `).run()
  pruneCategories(db, 'live', categoryIds.live)
  pruneCategories(db, 'vod', categoryIds.vod)
  pruneCategories(db, 'series', categoryIds.series)
}

function assertSyncSawCatalog(args: {
  liveCats: unknown[]
  vodCats: unknown[]
  seriesCats: unknown[]
  liveRows: unknown[]
  vodRows: unknown[]
  seriesRows: unknown[]
}): void {
  if (
    args.liveCats.length === 0 &&
    args.vodCats.length === 0 &&
    args.seriesCats.length === 0 &&
    args.liveRows.length === 0 &&
    args.vodRows.length === 0 &&
    args.seriesRows.length === 0
  ) {
    throw new Error('xtream_empty_response')
  }
}

/**
 * Recompute channels.epg_resolved_id from the freshly-ingested programmes and
 * the feed's channel alias defs. Two-pass per channel: exact tvg-id, then
 * unambiguous normalized-name match against the feed's <display-name> aliases.
 * Runs in a single transaction after EPG ingest.
 */
export function resolveEpgChannels(db: IptvDb, channelDefs: FeedChannelDef[]): { resolved: number } {
  // Feed channels that actually have programmes in the window we kept.
  const feedWithEpg = new Set(
    (db.raw.prepare(`SELECT DISTINCT channel_id FROM epg_programs`).all() as Array<{ channel_id: string }>)
      .map((r) => r.channel_id),
  )
  const index = buildEpgNameIndex(channelDefs, feedWithEpg)

  const channels = db.raw
    .prepare(`SELECT stream_id, name, epg_channel_id FROM channels`)
    .all() as Array<{ stream_id: number; name: string; epg_channel_id: string | null }>

  const update = db.raw.prepare(`UPDATE channels SET epg_resolved_id = ? WHERE stream_id = ?`)
  let resolved = 0
  const apply = db.raw.transaction((rows: typeof channels) => {
    for (const ch of rows) {
      const id = resolveEpgId(ch, index)
      if (id) resolved += 1
      update.run(id, ch.stream_id)
    }
  })
  apply(channels)
  return { resolved }
}

export async function syncOnce(db: IptvDb): Promise<SyncResult> {
  if (running) {
    return { busy: true }
  }
  running = true
  const startedAt = new Date()
  const fetchedAt = startedAt.toISOString()
  let channels: number, vod: number, series: number, categories: number, episodes: number
  let epg = 0

  try {
    const creds = credsFromEnv()

    const [liveCats, vodCats, seriesCats] = await Promise.all([
      fetchCategories('live', creds),
      fetchCategories('vod', creds),
      fetchCategories('series', creds),
    ])
    categories = liveCats.length + vodCats.length + seriesCats.length

    const [liveRows, vodRows, seriesRows] = await Promise.all([
      fetchLiveStreams(fetchedAt, creds),
      fetchVodStreams(fetchedAt, creds),
      fetchSeriesList(fetchedAt, creds),
    ])

    channels = liveRows.length
    vod = vodRows.length
    series = seriesRows.length
    assertSyncSawCatalog({ liveCats, vodCats, seriesCats, liveRows, vodRows, seriesRows })

    // Episode expansion — small concurrency cap to spare upstream.
    const CONCURRENCY = 4
    let cursor = 0
    const episodeRows: Awaited<ReturnType<typeof fetchSeriesInfo>> = []
    async function worker(): Promise<void> {
      while (cursor < seriesRows.length) {
        const i = cursor++
        const s = seriesRows[i]
        try {
          const eps = await fetchSeriesInfo(s.series_id, creds)
          episodeRows.push(...eps)
        } catch (err) {
          console.error(`[iptv-sync] series_info ${s.series_id} failed:`, err)
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    episodes = episodeRows.length

    // Populate the iptv_title_link table for the recommender integration.
    db.raw.transaction(() => {
      for (const c of liveCats) db.stmts.upsertCategory.run({ ...c, kind: 'live' })
      for (const c of vodCats) db.stmts.upsertCategory.run({ ...c, kind: 'vod' })
      for (const c of seriesCats) db.stmts.upsertCategory.run({ ...c, kind: 'series' })
      for (const r of liveRows) db.stmts.upsertChannel.run(r)
      for (const r of vodRows) db.stmts.upsertVod.run(r)
      for (const r of seriesRows) db.stmts.upsertSeries.run(r)
      for (const r of episodeRows) db.stmts.upsertEpisode.run(r)
      reconcileCatalog(db, fetchedAt, {
        live: liveCats.map((c) => c.category_id),
        vod: vodCats.map((c) => c.category_id),
        series: seriesCats.map((c) => c.category_id),
      })
      // Insert/re-activate link rows for all vod present in this sync.
      // removed_at is cleared on conflict so re-listed items resume badge visibility.
      db.raw.prepare(`
        INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id)
        SELECT 'vod', stream_id, 'movie', tmdb_id FROM vod WHERE tmdb_id IS NOT NULL
        ON CONFLICT(iptv_kind, iptv_id) DO UPDATE
          SET tmdb_id = excluded.tmdb_id,
              tmdb_kind = excluded.tmdb_kind,
              removed_at = NULL
      `).run()
      db.raw.prepare(`
        INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id)
        SELECT 'series', series_id, 'tv', tmdb_id FROM series WHERE tmdb_id IS NOT NULL
        ON CONFLICT(iptv_kind, iptv_id) DO UPDATE
          SET tmdb_id = excluded.tmdb_id,
              tmdb_kind = excluded.tmdb_kind,
              removed_at = NULL
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
    let flushError: unknown = null
    // Capture the feed's <channel> alias defs in the same pass so we can
    // name-match catalog channels to feed EPG (see resolveEpgChannels below).
    const channelDefs: FeedChannelDef[] = []
    await fetchAndStreamEpg(
      (row) => {
        if (flushError) return
        if (row.stop_utc > horizon) return
        batch.push(row)
        epg += 1
        if (batch.length >= 1_000) {
          try {
            flushBatch(batch)
          } catch (err) {
            flushError = err
          }
          batch = []
        }
      },
      undefined,
      (def) => {
        channelDefs.push(def)
      },
    )
    if (flushError) throw flushError
    if (batch.length) {
      try {
        flushBatch(batch)
      } catch (err) {
        flushError = err
      }
    }
    if (flushError) throw flushError

    // Resolve each catalog channel to the feed id that actually carries its
    // schedule — exact tvg-id first, then unambiguous name/alias match. Lifts
    // EPG coverage from the ~806 exact-tvg matches to ~12.5k channels.
    resolveEpgChannels(db, channelDefs)

    // Supplement with third-party EPG (iptv-org via epgshare01) for channels the
    // provider's own XMLTV omits — lifts coverage from ~14k toward ~22k. Stores
    // programmes only for channels our catalog matches. Best-effort: a failed
    // external fetch never fails the provider sync.
    try {
      for (const r of await ingestAllExternalEpg(db)) {
        console.log('[iptv-sync] external epg', JSON.stringify(r))
      }
    } catch (err) {
      console.error('[iptv-sync] external epg failed:', err)
    }

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
