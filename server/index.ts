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

serve(
  { fetch: app.fetch, port: env.port },
  (info) => {
    console.log(`backend listening on http://localhost:${info.port}`)
  },
)
