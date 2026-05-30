// App wiring, separated from the listener so tests can mount the
// fully-configured Hono instance without binding a port. index.ts
// imports `app` and calls serve(); test files import `app` and call
// `app.request(...)`.

import * as Sentry from '@sentry/node'
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
import { device } from './routes/device.js'
import { media } from './routes/media.js'
import { devices, adminDevices } from './routes/devices.js'
import { adminInvites, adminMembers } from './routes/adminInvites.js'
import { passkey } from './routes/passkey.js'
import { version } from './routes/version.js'

export const app = new Hono()

// §15 telemetry (finding 14-0): @sentry/node v9 + Hono does NOT auto-instrument
// route handlers — an exception thrown in any /api/* handler would otherwise
// become Hono's default 500 and never reach Glitchtip. Capture every handler
// exception here. The existing piiScrub beforeSend (index.ts) still applies, so
// no PII leaves the box. captureException is a no-op when Sentry.init was never
// called (dev without EEX_TELEMETRY_DSN), so this is safe in every environment.
app.onError((err, c) => {
  Sentry.captureException(err)
  console.error('[app] unhandled error:', err instanceof Error ? err.stack ?? err.message : err)
  return c.json({ error: 'internal' }, 500)
})

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
      // `Authorization` is required for M2 Apple Bearer auth — preflight
      // for any device-token request would 403 without it. `X-App-Version`
      // lets device-authed clients self-report their build for the
      // last_seen_version column on device_tokens (§3.4).
      allowHeaders: [
        'Content-Type',
        'X-Anthropic-Api-Key',
        'Authorization',
        'X-App-Version',
      ],
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
    // Reviewer-insurance §13.3: SPA hides Live/VOD/Series tabs when
    // the server has no /api/iptv surface mounted. Public boolean —
    // no secret leakage (the same flag is implied by the 404 anyway).
    iptvEnabled: !env.IPTV_DISABLED,
    // True when USE_MEDIA_CORE=1 mounted the /api/media proxy (below) —
    // the SPA gates its Media Library tab on this the same way Live is
    // gated on iptvEnabled. Public boolean — the same fact is implied by
    // the /api/media 404 when the proxy is unmounted.
    mediaEnabled: env.useMediaCore,
  }),
)

app.route('/api/auth', auth)
// Apple device-pair flow lives under the same /api/auth tree as the
// Plex cookie flow. M2 PIN-pair: POST /start → POST /poll → device JWE.
app.route('/api/auth/device', device)
// Passkey (WebAuthn) login + registration — the cross-platform, password-free
// identity path. Public (these endpoints ARE the login); self-owned local:
// users gated by the same invite/members allowlist as Plex/Apple.
app.route('/api/auth/passkey', passkey)
app.route('/api/me', me)
// /api/version is public — discovers server_id + auth_modes for Apple
// PIN-pair (Keychain keying + UI gating). Mounted last under /api/v.
app.route('/api/version', version)
// Device management — self routes (auth) + admin routes. Self routes
// scope to session.sub; admin routes cover every paired device.
app.route('/api/devices', devices)
app.route('/api/admin/devices', adminDevices)
// Owner-issued invites + the members allowlist (authZ). Both routers are
// gated by requireAdmin internally (mirroring adminDevices). The members
// allowlist is the single shared authZ gate for BOTH the Plex and Apple
// login paths; these endpoints let the owner mint/list/revoke invites
// and list/add/revoke members.
app.route('/api/admin/invites', adminInvites)
app.route('/api/admin/members', adminMembers)
app.route('/api/sonarr', sonarr)
app.route('/api/radarr', radarr)
app.route('/api/sab', sab)
app.route('/api/tmdb', tmdb)
// Contract §13.3 reviewer-insurance flag: when IPTV_DISABLED is set the
// /api/iptv tree is unmounted. The transitive iptv module imports still
// load (Node ESM is eager), so the better-sqlite3 + node-cron deps are
// not tree-shaken from the bundle — but a runtime request to any
// /api/iptv/* path hits Hono's 404 fallback. App Review judges the
// binary the user installs (the Apple app, gated via Swift compile
// flag) — this env is the server-side counterpart for households that
// never use IPTV.
if (!env.IPTV_DISABLED) {
  app.route('/api/iptv', iptv)
}
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

if (env.useMediaCore) {
  app.route('/api/media', media)
}
