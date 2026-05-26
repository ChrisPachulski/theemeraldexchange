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

import { serve } from '@hono/node-server'
import { env } from './env.js'
import { app } from './app.js'
import { validateFfmpegOrExit } from './services/ffmpeg.js'
import { registerIptvSchedule } from './services/iptvScheduler.js'
import { closeIptvDb } from './services/iptvDbSingleton.js'
import { ensureServerId, closeServerDb } from './services/serverDb.js'

// Abort immediately if ffmpeg is absent or below the required minimum version.
// §13.4: silent ENOENT at runtime is unacceptable; fail fast at boot instead.
try {
  validateFfmpegOrExit()
} catch {
  process.exit(1)
}

// Boot sequence: open server.db, run migrations, generate server_id on
// first boot (INSERT OR IGNORE — safe to call on every subsequent boot).
const serverId = ensureServerId()
console.log(`[boot] server_id: ${serverId}`)

serve(
  { fetch: app.fetch, port: env.port },
  (info) => {
    console.log(`backend listening on http://localhost:${info.port}`)
  },
)

// IPTV sync is opt-in: only register the cron when all three Xtream creds
// are configured. Keeps the dev server working without mybunny.tv creds
// and prevents the bootstrap sync from spamming /player_api.php on boot.
if (env.XTREAM_HOST && env.XTREAM_USERNAME && env.XTREAM_PASSWORD) {
  void registerIptvSchedule(env.IPTV_SYNC_CRON)
}

function shutdown(signal: NodeJS.Signals): void {
  // Close dependent DBs before the root server.db they depend on.
  // Boot order is server.db first (§7.4); shutdown order is the reverse.
  closeIptvDb()
  closeServerDb()
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
