// Cron registration for the scheduled DB backup (finding 14-4).
//
// Kept separate from iptvScheduler so it runs even on IPTV_DISABLED builds —
// server.db durability is NOT IPTV-gated (it holds server_id + device tokens).
// Returns the scheduled task so graceful shutdown can .stop() it (finding 14-2).

import cron, { type ScheduledTask } from 'node-cron'
import { runScheduledBackup } from './dbBackup.js'
import { reportServerEvent } from './serverTelemetry.js'
import { resolveCronExpr } from './cronConfig.js'

const DEFAULT_DB_BACKUP_CRON = '30 3 * * *'

export function registerDbBackupSchedule(cronExpr: string): ScheduledTask {
  const expr = resolveCronExpr('backup', 'DB_BACKUP_CRON', cronExpr, DEFAULT_DB_BACKUP_CRON)
  return cron.schedule(expr, () => {
    try {
      const result = runScheduledBackup()
      console.log(
        `[backup] snapshot ok: ${result.files.length} file(s) in ${result.dir}, stamped ${result.stampedAt}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[backup] scheduled backup failed:', message)
      // A silently-failing backup job is exactly what the mandatory §15
      // telemetry pipeline exists to surface — console-only meant nobody learned
      // the safety net had stopped working until a restore was needed.
      void reportServerEvent({
        level: 'error',
        message: 'scheduled DB backup failed',
        context: { error: message },
      })
    }
  })
}
