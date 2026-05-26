// App wiring, separated from the listener so tests can mount the
// fully-configured Hono instance without binding a port. index.ts
// imports `app` and calls serve(); test files import `app` and call
// `app.request(...)`.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { env } from './env.js'
import { requireSafeOrigin } from './middleware/csrf.js'
import { auth, me } from './auth.js'
import { sonarr } from './routes/sonarr.js'
import { radarr } from './routes/radarr.js'
import { sab } from './routes/sab.js'
import { tmdb } from './routes/tmdb.js'
import { iptv } from './routes/iptv.js'
import { users } from './routes/users.js'
import { plexAdmin } from './routes/plex-admin.js'
import { plexLinks } from './routes/plex-links.js'
import { notifications } from './routes/notifications.js'
import { grabs } from './routes/grabs.js'
import { suggestions } from './routes/suggestions.js'
import { feedback } from './routes/feedback.js'
import { usage } from './routes/usage.js'
import { recommenderEvents } from './routes/recommenderEvents.js'
import { telemetry } from './routes/telemetry.js'

export const app = new Hono()

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
      allowHeaders: ['Content-Type', 'X-Anthropic-Api-Key'],
    }),
  )
}

// CSRF gate: reject state-changing requests whose Origin doesn't match
// allowedOrigins. Cookies are SameSite=None in prod so the browser
// attaches them to any cross-origin request — Origin is the only
// reliable distinguisher between "our SPA" and "attacker's page".
app.use('*', requireSafeOrigin)

app.get('/api/health', (c) => c.json({ ok: true }))

// Public-ish (auth-free) endpoint exposing the configured limits so the
// SPA can surface them in tooltips without each modal having to know
// the env. Numeric values only — no secrets.
app.get('/api/limits', (c) =>
  c.json({
    minFreeGb: env.minFreeBytes / (1024 * 1024 * 1024),
    maxMovieGb: env.maxMovieGb,
    maxTvGbPerEpisode: env.maxTvGbPerEpisode,
    // Whether the local recommender is the active personalization
    // engine. When true the SPA's "AI" toggle is inert (every refresh
    // routes through the sidecar regardless), so we hide it instead
    // of leaving a fake setting that does nothing. Public boolean —
    // no secret leakage.
    useLocalRecommender: env.useLocalRecommender,
    // Curated quality-profile name (case-insensitive match) that the
    // server prefers for non-admin adds — see materializeNonAdmin{Movie,
    // Series}Body in routes/{radarr,sonarr}.ts. Surfaced so the admin
    // add modals can prefer the same name on the picker default
    // instead of hardcoding "choose me" client-side and silently
    // disagreeing with the server when the household curates under a
    // different label.
    defaultProfileName: env.defaultProfileName,
  }),
)

app.route('/api/auth', auth)
app.route('/api/me', me)
app.route('/api/sonarr', sonarr)
app.route('/api/radarr', radarr)
app.route('/api/sab', sab)
app.route('/api/tmdb', tmdb)
app.route('/api/iptv', iptv)
app.route('/api/users', users)
// Order matters: plexLinks (auth-only) is mounted BEFORE plexAdmin
// (admin-only). Hono's first-match-wins routing means the admin
// middleware on plexAdmin would otherwise leak onto /library-links and
// /server-id and 403 every household member.
app.route('/api/plex', plexLinks)
app.route('/api/plex', plexAdmin)
app.route('/api/notifications', notifications)
app.route('/api/grabs', grabs)
// /api/rejections is retired (round 13). Direct CRUD bypassed the
// anotherUserDislikes guard in /api/feedback and skipped recommender
// mirroring, so a caller could unblock a household veto while
// another member still had the title disliked. The household
// rejection list is now mutated exclusively through /api/feedback,
// which applies the per-user-signal guards.
app.route('/api/suggestions', suggestions)
app.route('/api/feedback', feedback)
app.route('/api/usage', usage)
// Narrow pass-through for client-side conversion signals (currently
// 'clicked' only) that the SPA fires when a user interacts with a
// suggestion. Added/like/dislike/reject have their own paths above.
app.route('/api/recommender', recommenderEvents)

// §15 telemetry: DSN distribution endpoint. Apps fetch this at boot to
// discover the self-hoster's Glitchtip DSN and initialize their Sentry SDK.
app.route('/api/telemetry', telemetry)
