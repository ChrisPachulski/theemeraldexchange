// Idle feed checks: while nobody is streaming, check every channel the
// household's guide shows (plus recently watched and favorite channels) before
// anyone tunes it, so a stream carrying the wrong channel is caught ahead of time
// instead of during a viewer's first seconds on it.
//
// The guide's channel set is what the app last asked /epg/grid for (categories
// + row limit, rememberGuideScope). Each is checked once per verdict lifetime
// (iptvFeedChecks): never-checked channels and ones whose listing changed go
// first, then the longest unchecked, watched/favorite before guide order on a
// tie. A channel with no other stream of its listing is recorded inconclusive
// without a connection. A run checks channels back to back with a gap after
// each one that dialed, and stops the moment a viewer or recording needs the
// provider. Runs happen only in the overnight window (IPTV_FEED_SWEEP_HOURS_UTC)
// and only after VIEWER_QUIET_MS with no viewer: a gap between two channel hops
// is not idle.

import type Database from 'better-sqlite3'
import { env } from '../env.js'
import { createLogger } from './logger.js'
import { credsFromEnv } from './xtream.js'
import {
  channelIsDeadFeed,
  lastViewerActivityAt,
  liveUpstreamCount,
  noteViewerActivity,
  spawnAuxUpstream,
  UPSTREAM_USER_AGENT,
  viewerUpstreamCount,
} from './iptvRemux.js'
import { feedCheckIsFresh, listedEpgSql, NO_SIBLING_REASON, type FeedCheck } from './iptvFeedChecks.js'
import { checkFeedStandalone, feedCheckIo, runExclusiveFeedCheck, type FeedCheckIo } from './iptvFeedVerify.js'

const log = createLogger('iptv-feed-check')

const HISTORY_DAYS = 30
const GUIDE_SCOPE_KEY = 'feed_check_guide_scope'
const DEFAULT_GUIDE_LIMIT = 500
/** Keep clear of a recording about to start: it would preempt a capture anyway. */
const DVR_LEAD_MS = 3 * 60_000
/** Quiet time after the last viewer activity before the sweep dials. Hopping
 *  channels leaves moments with nothing streaming; a sweep starting in them
 *  adds connections the provider punishes. */
export const VIEWER_QUIET_MS = 30 * 60_000

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

/** The next channel due a check (no fresh verdict for its current listing): a
 *  never-checked or re-listed one first, then the one checked longest ago, in
 *  sweep order on a tie. Null when every one is fresh. */
export function nextSweepChannel(db: Database.Database, now = Date.now()): number | null {
  const listed = new Map((db.prepare(`SELECT stream_id, ${listedEpgSql()} AS listed FROM channels
    WHERE COALESCE(${listedEpgSql()}, '') != ''`).all() as Array<{ stream_id: number; listed: string }>)
    .map((r) => [r.stream_id, r.listed]))
  const checks = new Map((db.prepare('SELECT * FROM channel_feed_checks').all() as FeedCheck[]).map((c) => [c.stream_id, c]))
  let best: { id: number; key: string } | null = null
  for (const id of sweepOrder(db, now)) {
    const epg = listed.get(id)
    if (!epg) continue
    const check = checks.get(id)
    if (check && feedCheckIsFresh(check, epg, now)) continue
    // Nothing is known about what the guide shows on it now: '' sorts first.
    const key = !check || check.listed_epg_id !== epg ? '' : check.checked_at
    if (!best || key < best.key) best = { id, key }
  }
  return best?.id ?? null
}

function recordingStartsSoon(db: Database.Database, now: number): boolean {
  const row = db.prepare(`
    SELECT 1 FROM dvr_recordings
    WHERE status IN ('scheduled', 'recording') AND start_utc <= ? AND stop_utc > ? LIMIT 1
  `).get(new Date(now + DVR_LEAD_MS).toISOString(), new Date(now).toISOString())
  return row != null
}

/** True when `now` falls in a "start-end" UTC hour window (end exclusive,
 *  wrapping midnight when start > end). A malformed window is closed. */
export function sweepWindowOpen(now: number, hours = env.IPTV_FEED_SWEEP_HOURS_UTC): boolean {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(hours)
  if (!m) return false
  const start = Number(m[1])
  const end = Number(m[2])
  if (start > 23 || end > 24 || start === end) return false
  const hour = new Date(now).getUTCHours()
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** Inside the sweep window, nothing streaming or recording, no viewer for
 *  VIEWER_QUIET_MS, and no recording about to start. */
export function sweepIdle(db: Database.Database, now = Date.now()): boolean {
  if (viewerUpstreamCount() > 0) noteViewerActivity(now)
  return liveUpstreamCount() === 0
    && now - lastViewerActivityAt() >= VIEWER_QUIET_MS
    && sweepWindowOpen(now)
    && !recordingStartsSoon(db, now)
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
      // A stream with nothing to compare opened no connection: no gap needed.
      if (outcome.kind !== 'unknown' || outcome.reason !== NO_SIBLING_REASON) await io.sleep(gapMs)
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
