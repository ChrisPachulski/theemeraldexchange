// server/services/iptvScheduler.ts
//
// Registers the recurring IPTV catalog/EPG sync via node-cron and, on
// first boot, kicks off an immediate bootstrap sync when the sync_state
// table has no `last_sync` row (or one older than 7 days). The bootstrap
// run is fire-and-forget — failures land in console.error so the boot
// path stays non-blocking; cron retries every 6h by default.
import cron from 'node-cron'
import { syncOnce } from './iptvSync.js'
import { iptvDb } from './iptvDbSingleton.js'

const DEFAULT_IPTV_SYNC_CRON = '0 */6 * * *'

export async function registerIptvSchedule(cronExpr: string): Promise<void> {
  const db = iptvDb()
  const last = db.stmts.getSyncState.get('last_sync') as { value: string; ts: string } | undefined
  const needsBootstrap = !last || (Date.now() - new Date(last.ts).getTime()) > 7 * 24 * 3600_000
  if (needsBootstrap) {
    void syncOnce(db).catch((err) => console.error('[iptv] bootstrap sync failed:', err))
  }

  const scheduleExpr = cron.validate(cronExpr) ? cronExpr : DEFAULT_IPTV_SYNC_CRON
  if (scheduleExpr !== cronExpr) {
    console.error(`[iptv] invalid IPTV_SYNC_CRON ${JSON.stringify(cronExpr)}; using ${DEFAULT_IPTV_SYNC_CRON}`)
  }

  cron.schedule(scheduleExpr, () => {
    void syncOnce(db).catch((err) => console.error('[iptv] scheduled sync failed:', err))
  })
}
