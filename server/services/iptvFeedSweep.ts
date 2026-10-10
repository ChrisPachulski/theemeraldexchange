// Idle feed checks: while nobody is streaming, check every channel the
// household's guide shows (plus recently watched and favorite channels) before
// anyone tunes it, so a stream carrying the wrong channel is caught ahead of time
// instead of during a viewer's first seconds on it.
//
// The guide's channel set is what the app last asked /epg/grid for (categories
// + row limit, rememberGuideScope). Channels go watched/favorite first, then in
// guide order; each is checked once per verdict lifetime (iptvFeedChecks). Only
// channels with another stream of their listing are checked (others can never
// be confirmed). A run checks channels back to back with a gap, and stops the
// moment a viewer or recording needs the provider.

import type Database from 'better-sqlite3'
import { env } from '../env.js'
import { createLogger } from './logger.js'
import { credsFromEnv } from './xtream.js'
import { channelIsDeadFeed, liveUpstreamCount, spawnAuxUpstream, UPSTREAM_USER_AGENT } from './iptvRemux.js'
import { effectiveOf, feedCheckIsFresh, feedOverrides, getFeedCheck, listedEpgSql } from './iptvFeedChecks.js'
import { checkFeedStandalone, feedCheckIo, runExclusiveFeedCheck, type FeedCheckIo } from './iptvFeedVerify.js'

const log = createLogger('iptv-feed-check')

const HISTORY_DAYS = 30
const GUIDE_SCOPE_KEY = 'feed_check_guide_scope'
const DEFAULT_GUIDE_LIMIT = 500
/** Keep clear of a recording about to start: it would preempt a capture anyway. */
const DVR_LEAD_MS = 3 * 60_000

export interface GuideScope {
  categoryIds: number[]
  limit: number
}

/** Remember the guide the app shows (an /epg/grid request with categories and
 *  hasEpg). Written only when it changes. */
export function rememberGuideScope(db: Database.Database, categoryIds: number[], limit: number | undefined): void {
  const value = JSON.stringify({ categoryIds: [...categoryIds].sort((a, b) => a - b), limit: limit ?? DEFAULT_GUIDE_LIMIT })
  const row = db.prepare('SELECT value FROM iptv_sync_state WHERE key = ?').get(GUIDE_SCOPE_KEY) as { value: string } | undefined
  if (row?.value === value) return
  db.prepare(`
    INSERT INTO iptv_sync_state (key, value, ts) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts
  `).run(GUIDE_SCOPE_KEY, value, new Date().toISOString())
}

function guideScope(db: Database.Database): GuideScope | null {
  const row = db.prepare('SELECT value FROM iptv_sync_state WHERE key = ?').get(GUIDE_SCOPE_KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const scope = JSON.parse(row.value) as GuideScope
    return Array.isArray(scope.categoryIds) && scope.categoryIds.length ? scope : null
  } catch {
    return null
  }
}

/** Live channels in sweep order: watched in the last HISTORY_DAYS or favorited
 *  (most recent first), then the guide's channels in guide order. */
function sweepOrder(db: Database.Database, now: number): number[] {
  const since = new Date(now - HISTORY_DAYS * 24 * 3600_000).toISOString()
  const watched = (db.prepare(`
    SELECT item_id, MAX(ts) AS ts FROM (
      SELECT item_id, watched_at AS ts FROM iptv_watch_history WHERE kind = 'live' AND watched_at >= ?
      UNION ALL
      SELECT item_id, added_ts AS ts FROM iptv_favorites WHERE kind = 'live'
    ) GROUP BY item_id ORDER BY ts DESC LIMIT 200
  `).all(since) as Array<{ item_id: string }>)
    .filter((r) => /^\d+$/.test(r.item_id))
    .map((r) => Number(r.item_id))
  const scope = guideScope(db)
  const guide = scope
    ? (db.prepare(`
        SELECT stream_id FROM channels
        WHERE category_id IN (${scope.categoryIds.map(() => '?').join(',')})
          AND EXISTS (SELECT 1 FROM epg_programs p WHERE p.channel_id = ${listedEpgSql()} AND p.stop_utc > ?)
        ORDER BY num, name, stream_id LIMIT ?
      `).all(...scope.categoryIds, new Date(now).toISOString(), scope.limit) as Array<{ stream_id: number }>)
        .map((r) => r.stream_id)
    : []
  return [...new Set([...watched, ...guide])]
}

/** The next channel due a check: in sweep order, with another stream of its
 *  listing, and no fresh verdict. Null when every one is fresh. */
export function nextSweepChannel(db: Database.Database, now = Date.now()): number | null {
  const overrides = feedOverrides(db)
  const rows = db.prepare(`SELECT stream_id, ${listedEpgSql()} AS listed FROM channels WHERE COALESCE(${listedEpgSql()}, '') != ''`)
    .all() as Array<{ stream_id: number; listed: string }>
  const epgOf = new Map<number, string>()
  const streamsPerEpg = new Map<string, number>()
  for (const r of rows) {
    const epg = effectiveOf(r.stream_id, r.listed, overrides)
    if (!epg) continue
    epgOf.set(r.stream_id, epg)
    streamsPerEpg.set(epg, (streamsPerEpg.get(epg) ?? 0) + 1)
  }
  for (const id of sweepOrder(db, now)) {
    const epg = epgOf.get(id)
    if (!epg || (streamsPerEpg.get(epg) ?? 0) < 2) continue
    const check = getFeedCheck(db, id)
    if (check && feedCheckIsFresh(check, now)) continue
    return id
  }
  return null
}

function recordingStartsSoon(db: Database.Database, now: number): boolean {
  const row = db.prepare(`
    SELECT 1 FROM dvr_recordings
    WHERE status IN ('scheduled', 'recording') AND start_utc <= ? AND stop_utc > ? LIMIT 1
  `).get(new Date(now + DVR_LEAD_MS).toISOString(), new Date(now).toISOString())
  return row != null
}

/** Nothing is streaming or recording, and no recording is about to start. */
export function sweepIdle(db: Database.Database, now = Date.now()): boolean {
  return liveUpstreamCount() === 0 && !recordingStartsSoon(db, now)
}

let sweeping = false

/** Check due channels back to back while idle: up to `maxChecks`, `gapMs` apart.
 *  Returns how many checks ran. One run at a time. */
export async function runFeedCheckSweep(
  db: Database.Database,
  opts: { maxChecks?: number; gapMs?: number; io?: FeedCheckIo; idle?: () => boolean } = {},
): Promise<number> {
  if (sweeping || !env.IPTV_FEED_CHECK) return 0
  if (!opts.io && !env.XTREAM_HOST) return 0
  const idle = opts.idle ?? (() => sweepIdle(db))
  const io = opts.io ?? productionIo(db)
  const maxChecks = opts.maxChecks ?? 30
  const gapMs = opts.gapMs ?? 20_000
  sweeping = true
  let ran = 0
  try {
    for (; ran < maxChecks; ran++) {
      if (!idle()) break
      const streamId = nextSweepChannel(db)
      if (streamId == null) break
      log.info('idle feed check', { streamId })
      const outcome = await runExclusiveFeedCheck(() => checkFeedStandalone(io, streamId, idle))
      // An on-tune check holds the slot, or a viewer arrived: stop until next run.
      if (outcome == null || outcome.kind === 'aborted') break
      await io.sleep(gapMs)
    }
  } finally {
    sweeping = false
  }
  return ran
}

function productionIo(db: Database.Database): FeedCheckIo {
  const creds = credsFromEnv()
  const upstreamUrlFor = (sid: string): string =>
    `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${sid}.ts`
  return feedCheckIo(db, upstreamUrlFor, {
    spawnUpstream: spawnAuxUpstream,
    isDead: channelIsDeadFeed,
    userAgent: UPSTREAM_USER_AGENT,
  })
}

/** Test seam. */
export function _resetFeedCheckSweepForTests(): void {
  sweeping = false
}
