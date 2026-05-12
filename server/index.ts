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
// Anything that calls plex.tv blocks for a network round trip; Hono on
// node serves these on the libuv event loop just fine for our load.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { env } from './env.js'
import { auth, me } from './auth.js'
import { sonarr } from './routes/sonarr.js'
import { radarr } from './routes/radarr.js'
import { sab } from './routes/sab.js'
import { tmdb } from './routes/tmdb.js'
import { users } from './routes/users.js'
import { plexAdmin } from './routes/plex-admin.js'
import { notifications } from './routes/notifications.js'

const app = new Hono()

app.use('*', logger())

// CORS — only matters in prod, where SPA is on a different origin.
// In dev, Vite proxies /api/* so requests are same-origin and CORS
// preflight is skipped entirely.
if (env.allowedOrigins.length > 0) {
  app.use(
    '*',
    cors({
      origin: env.allowedOrigins,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    }),
  )
}

app.get('/api/health', (c) => c.json({ ok: true }))

// Public-ish (auth-free) endpoint exposing the configured limits so the
// SPA can surface them in tooltips without each modal having to know
// the env. Numeric values only — no secrets.
app.get('/api/limits', (c) =>
  c.json({
    minFreeGb: env.minFreeBytes / (1024 * 1024 * 1024),
    maxMovieGb: env.maxMovieGb,
    maxTvGbPerEpisode: env.maxTvGbPerEpisode,
  }),
)

app.route('/api/auth', auth)
app.route('/api/me', me)
app.route('/api/sonarr', sonarr)
app.route('/api/radarr', radarr)
app.route('/api/sab', sab)
app.route('/api/tmdb', tmdb)
app.route('/api/users', users)
app.route('/api/plex', plexAdmin)
app.route('/api/notifications', notifications)

serve(
  { fetch: app.fetch, port: env.port },
  (info) => {
    console.log(`backend listening on http://localhost:${info.port}`)
  },
)
