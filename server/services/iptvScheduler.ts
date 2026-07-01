// server/services/iptvScheduler.ts
//
// Registers the recurring IPTV catalog/EPG sync via node-cron and, on
// first boot, kicks off an immediate bootstrap sync when the sync_state
// table has no `last_sync` row (or one older than 7 days). The bootstrap
// run is fire-and-forget — failures land in console.error so the boot
// path stays non-blocking; cron retries every 6h by default.
import cron, { type ScheduledTask } from 'node-cron'
import { syncOnce } from './iptvSync.js'
import { iptvDb } from './iptvDbSingleton.js'
import { reportServerEvent } from './serverTelemetry.js'
import { resolveCronExpr } from './cronConfig.js'

// Surface a scheduler failure to the mandatory §15 telemetry pipeline in
// addition to console — a sync/sweep that quietly stops makes the catalog go
// stale with no signal otherwise.
function reportSchedulerFailure(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[iptv] ${message}:`, detail)
  void reportServerEvent({ level: 'error', message: `iptv ${message}`, context: { error: detail } })
}

const DEFAULT_IPTV_SYNC_CRON = '0 */6 * * *'
// Hard-delete tombstoned link rows older than 14 days at 03:00 local time.
const TOMBSTONE_SWEEP_CRON = '0 3 * * *'

/**
 * Register the recurring IPTV jobs and return the scheduled tasks so the
 * caller can .stop() them during graceful shutdown (finding 14-2) — previously
 * the tasks were created and dropped, so a sync could fire mid-shutdown and
 * race closeIptvDb().
 */
export async function registerIptvSchedule(cronExpr: string): Promise<ScheduledTask[]> {
  const db = iptvDb()
  const last = db.stmts.getSyncState.get('last_sync') as { value: string; ts: string } | undefined
  const needsBootstrap = !last || (Date.now() - new Date(last.ts).getTime()) > 7 * 24 * 3600_000
  if (needsBootstrap) {
    void syncOnce(db).catch((err) => reportSchedulerFailure('bootstrap sync failed', err))
  }

  const scheduleExpr = resolveCronExpr('iptv', 'IPTV_SYNC_CRON', cronExpr, DEFAULT_IPTV_SYNC_CRON)

  const syncTask = cron.schedule(scheduleExpr, () => {
    void syncOnce(db).catch((err) => reportSchedulerFailure('scheduled sync failed', err))
  })

  // Nightly sweep: hard-delete link tombstones older than 14 days.
  const sweepTask = cron.schedule(TOMBSTONE_SWEEP_CRON, () => {
    try {
      const result = db.raw.prepare(
        `DELETE FROM iptv_title_link WHERE removed_at < datetime('now', '-14 days')`,
      ).run()
      if (result.changes > 0) {
        console.log(`[iptv] tombstone sweep: removed ${result.changes} stale link row(s)`)
      }
    } catch (err) {
      reportSchedulerFailure('tombstone sweep failed', err)
    }
  })

  return [syncTask, sweepTask]
}
