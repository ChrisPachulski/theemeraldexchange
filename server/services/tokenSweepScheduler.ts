// Nightly sweep of EXPIRED auth rows from server.db (LOW-9).
//
// device_tokens and webauthn_challenges both carry an ISO-8601 `expires_at`
// (indexed). Nothing bulk-deletes rows past their expiry, so they accumulate
// unboundedly over a server's lifetime. A row past `expires_at` is already
// dead — verifyDeviceToken / challenge lookup reject it — so hard-deleting it is
// safe and purely hygienic. Mirrors the dbBackup / iptv-tombstone scheduler
// pattern (returns the ScheduledTask so shutdown can .stop() it; failures reach
// the §15 telemetry pipeline, never console-only).
//
// NOT swept: webauthn_credentials are PERSISTENT passkeys (no TTL) — deleting
// them would silently de-register a user's authenticator. iptv_playlist_tokens
// live in the IPTV DB and carry their own revocation table.

import cron, { type ScheduledTask } from 'node-cron'
import { serverDb } from './serverDb.js'
import { reportServerEvent } from './serverTelemetry.js'
import { resolveCronExpr } from './cronConfig.js'

const DEFAULT_TOKEN_SWEEP_CRON = '15 3 * * *'

/** Delete expired device_tokens + webauthn_challenges. Exported for test. */
export function sweepExpiredAuthRows(nowIso: string = new Date().toISOString()): {
  deviceTokens: number
  challenges: number
} {
  const db = serverDb().raw
  const deviceTokens = db.prepare(`DELETE FROM device_tokens WHERE expires_at < ?`).run(nowIso)
    .changes
  const challenges = db
    .prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ?`)
    .run(nowIso).changes
  return { deviceTokens, challenges }
}

export function registerTokenSweepSchedule(cronExpr: string): ScheduledTask {
  const expr = resolveCronExpr('token-sweep', 'TOKEN_SWEEP_CRON', cronExpr, DEFAULT_TOKEN_SWEEP_CRON)
  return cron.schedule(expr, () => {
    try {
      const { deviceTokens, challenges } = sweepExpiredAuthRows()
      if (deviceTokens > 0 || challenges > 0) {
        console.log(
          `[token-sweep] removed ${deviceTokens} expired device token(s), ${challenges} expired challenge(s)`,
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[token-sweep] sweep failed:', message)
      void reportServerEvent({
        level: 'error',
        message: 'expired-auth-row sweep failed',
        context: { error: message },
      })
    }
  })
}
