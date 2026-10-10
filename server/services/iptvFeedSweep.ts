// Idle feed checks: while nobody is streaming, check the live channels this
// household watches (recent history and favorites) before anyone tunes them, so
// a stream carrying the wrong channel is caught ahead of time instead of during
// a viewer's first minute. One channel per run, only when every upstream slot is
// free, and it gives up between comparisons the moment a viewer appears.

import type Database from 'better-sqlite3'
import { env } from '../env.js'
import { createLogger } from './logger.js'
import { credsFromEnv } from './xtream.js'
import { channelIsDeadFeed, liveUpstreamCount, spawnAuxUpstream, UPSTREAM_USER_AGENT } from './iptvRemux.js'
import { feedCheckIsFresh, getFeedCheck, listedEpgId } from './iptvFeedChecks.js'
import { checkFeedStandalone, feedCheckIo, runExclusiveFeedCheck, type FeedCheckOutcome } from './iptvFeedVerify.js'

const log = createLogger('iptv-feed-check')

const HISTORY_DAYS = 30

/** The household's next live channel due a check: watched in the last
 *  HISTORY_DAYS or favorited, most recent first, with a guide listing and no
 *  fresh verdict. Null when every one is fresh. */
export function nextSweepChannel(db: Database.Database, now = Date.now()): number | null {
  const since = new Date(now - HISTORY_DAYS * 24 * 3600_000).toISOString()
  const rows = db.prepare(`
    SELECT item_id, MAX(ts) AS ts FROM (
      SELECT item_id, watched_at AS ts FROM iptv_watch_history WHERE kind = 'live' AND watched_at >= ?
      UNION ALL
      SELECT item_id, added_ts AS ts FROM iptv_favorites WHERE kind = 'live'
    ) GROUP BY item_id ORDER BY ts DESC LIMIT 200
  `).all(since) as Array<{ item_id: string }>
  for (const { item_id } of rows) {
    if (!/^\d+$/.test(item_id)) continue
    const id = Number(item_id)
    if (!listedEpgId(db, id)) continue
    const check = getFeedCheck(db, id)
    if (check && feedCheckIsFresh(check, now)) continue
    return id
  }
  return null
}

export async function runFeedCheckSweep(db: Database.Database): Promise<FeedCheckOutcome | null> {
  if (!env.IPTV_FEED_CHECK || !env.XTREAM_HOST) return null
  if (liveUpstreamCount() > 0) return null
  const streamId = nextSweepChannel(db)
  if (streamId == null) return null
  const creds = credsFromEnv()
  const upstreamUrlFor = (sid: string): string =>
    `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${sid}.ts`
  const io = feedCheckIo(db, upstreamUrlFor, {
    spawnUpstream: spawnAuxUpstream,
    isDead: channelIsDeadFeed,
    userAgent: UPSTREAM_USER_AGENT,
  })
  log.info('idle feed check', { streamId })
  // Between comparisons our own captures have exited, so any upstream in use is
  // a viewer or a recording: stop.
  return runExclusiveFeedCheck(() => checkFeedStandalone(io, streamId, () => liveUpstreamCount() === 0))
}
