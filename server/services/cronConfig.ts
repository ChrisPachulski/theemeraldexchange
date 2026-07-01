// Shared cron-expression validation for schedulers that accept a cron
// string from env (DB_BACKUP_CRON, TOKEN_SWEEP_CRON, IPTV_SYNC_CRON): fall
// back to a default and log when the configured value doesn't parse.

import cron from 'node-cron'

export function resolveCronExpr(
  label: string,
  envVar: string,
  cronExpr: string,
  defaultExpr: string,
): string {
  if (cron.validate(cronExpr)) return cronExpr
  console.error(`[${label}] invalid ${envVar} ${JSON.stringify(cronExpr)}; using ${defaultExpr}`)
  return defaultExpr
}
