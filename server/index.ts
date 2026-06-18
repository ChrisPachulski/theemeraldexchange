// Hono backend entry point.
//
// Dev:  Vite (port 5173) proxies /api/auth and /api/me to this server
//       on port 3001 — same-origin from the browser's perspective.
//       Existing /api/sonarr|radarr|sab proxies in vite.config.ts are
//       untouched in this phase; they'll move behind this server in
//       the next phase along with permission middleware.
//
// Prod: deployed in the NAS container; SPA on Netlify hits this via
//       https://api.<domain>/ through a Cloudflare Tunnel.
//
// App wiring lives in ./app.ts so tests can mount the full router
// without binding a port. This file only constructs the listener.

import * as Sentry from '@sentry/node'
import { serve } from '@hono/node-server'
import type { ScheduledTask } from 'node-cron'
import { env } from './env.js'
import { app } from './app.js'
import { validateFfmpegOrExit } from './services/ffmpeg.js'
import { piiBreadcrumbScrub, piiScrub } from './services/telemetryPiiScrub.js'
import { registerIptvSchedule } from './services/iptvScheduler.js'
import { registerDbBackupSchedule } from './services/dbBackupScheduler.js'
import { registerTokenSweepSchedule } from './services/tokenSweepScheduler.js'
import { drainRemuxSessions } from './services/iptvRemux.js'
import { iptvDb, closeIptvDb } from './services/iptvDbSingleton.js'
import { startDvrScheduler, type DvrScheduler } from './services/dvrRecorder.js'
import { ensureServerId, closeServerDb } from './services/serverDb.js'
import { createLogger } from './services/logger.js'
import { warnExpiredCompatWindows } from './services/compatWindows.js'

const log = createLogger('boot')
const shutdownLog = createLogger('shutdown')

// Abort immediately if ffmpeg is absent or below the required minimum version.
// §13.4: silent ENOENT at runtime is unacceptable; fail fast at boot instead.
try {
  validateFfmpegOrExit()
} catch {
  process.exit(1)
}

// §15 Telemetry — Sentry-compatible SDK init pointing at the self-hoster's
// Glitchtip instance. The DSN is distributed to client apps at boot via
// GET /api/telemetry/config; the server itself also reports crashes here.
if (env.EEX_TELEMETRY_DSN) {
  Sentry.init({
    dsn: env.EEX_TELEMETRY_DSN,
    environment: env.isProd ? 'production' : 'staging',
    release: env.EEX_RELEASE,
    beforeSend: piiScrub,
    beforeBreadcrumb: piiBreadcrumbScrub,
    integrations: [
      Sentry.onUnhandledRejectionIntegration({ mode: 'warn' }),
    ],
  })
} else {
  log.warn(
    'EEX_TELEMETRY_DSN is not set. Sentry SDK will not be initialized. ' +
      'Telemetry is mandatory in production (§15.1).',
  )
}

// Boot sequence: open server.db, run migrations, generate server_id on
// first boot (INSERT OR IGNORE — safe to call on every subsequent boot).
const serverId = ensureServerId()
log.info('server_id resolved', { serverId })

// Surface any dated backward-compat shim whose removal date has passed —
// expiry becomes a boot log line instead of a manual calendar sweep.
warnExpiredCompatWindows()

// Capture the http.Server handle so graceful shutdown can stop accepting new
// connections and drain in-flight requests (finding 14-2) — the prior code
// discarded this return value and could not close the listener.
const server = serve(
  { fetch: app.fetch, port: env.port },
  (info) => {
    log.info(`backend listening on http://localhost:${info.port}`)
  },
)

// Cron tasks captured so shutdown can stop them before closing the DBs they
// write into (finding 14-2). The DB-backup cron is NOT IPTV-gated (server.db
// durability matters even on IPTV_DISABLED builds, finding 14-4).
const cronTasks: ScheduledTask[] = []
cronTasks.push(registerDbBackupSchedule(env.DB_BACKUP_CRON))
// Hygiene sweep of expired auth rows (device_tokens + webauthn_challenges,
// LOW-9). Not IPTV-gated — server.db grows on every build.
cronTasks.push(registerTokenSweepSchedule(env.TOKEN_SWEEP_CRON))

// IPTV sync is opt-in: only register the cron when all three Xtream creds
// are configured AND the reviewer-insurance gate is not set. Keeps the
// dev server working without mybunny.tv creds, prevents the bootstrap
// sync from spamming /player_api.php on boot, and ensures IPTV_DISABLED
// builds never make outbound IPTV traffic.
if (
  !env.IPTV_DISABLED &&
  env.XTREAM_HOST &&
  env.XTREAM_USERNAME &&
  env.XTREAM_PASSWORD
) {
  void registerIptvSchedule(env.IPTV_SYNC_CRON).then((tasks) => {
    cronTasks.push(...tasks)
  })
}

// DVR (M6) recorder scheduler — ticks the engine that starts/stops ffmpeg
// recordings of IPTV live channels. Off unless DVR_ENABLED (and IPTV mounted).
let dvrScheduler: DvrScheduler | null = null
if (env.DVR_ENABLED && !env.IPTV_DISABLED) {
  dvrScheduler = startDvrScheduler(iptvDb().raw, env.DVR_DIR)
}

let shuttingDown = false

/**
 * Graceful shutdown (finding 14-2). Order matters:
 *   1. Stop cron so no sync/sweep/backup fires mid-teardown and races a DB close.
 *   2. server.close() — stop accepting new connections; the callback fires once
 *      in-flight requests drain. A bounded timer force-exits if a long stream
 *      keeps the listener open past the grace window.
 *   3. drainRemuxSessions() — SIGTERM (then bounded SIGKILL) every ffmpeg child
 *      and wait for exit so none are orphaned and none are still writing the
 *      temp dir when we close DBs.
 *   4. Sentry.close() — flush any queued events (ties to finding 14-0).
 *   5. closeIptvDb() then closeServerDb() — dependents before the root server.db.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const exitCode = signal === 'SIGINT' ? 130 : 143

  // Hard backstop: if anything hangs, force-exit so a deploy never wedges.
  const forceExit = setTimeout(() => {
    shutdownLog.error('grace window exceeded; forcing exit', { signal })
    process.exit(exitCode)
  }, 15_000)
  forceExit.unref?.()

  try {
    for (const task of cronTasks) {
      try {
        task.stop()
      } catch {
        // Task may already be stopped.
      }
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    // Stop the DVR scheduler + SIGTERM any in-flight recordings before the
    // remux drain and the iptv DB close (the recorder writes files + reads that DB).
    dvrScheduler?.stop()

    await drainRemuxSessions()

    try {
      await Sentry.close(2000)
    } catch {
      // Telemetry flush is best-effort; never block shutdown on it.
    }

    closeIptvDb()
    closeServerDb()
  } catch (err) {
    shutdownLog.error('error during graceful shutdown', { error: err })
  } finally {
    clearTimeout(forceExit)
    process.exit(exitCode)
  }
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
