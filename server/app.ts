// App wiring, separated from the listener so tests can mount the
// fully-configured Hono instance without binding a port. index.ts
// imports `app` and calls serve(); test files import `app` and call
// `app.request(...)`.

import * as Sentry from '@sentry/node'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { env } from './env.js'
import { serverDb } from './services/serverDb.js'
import { requireSafeOrigin } from './middleware/csrf.js'
import { auth, me } from './auth.js'
import { sonarr } from './routes/sonarr.js'
import { radarr } from './routes/radarr.js'
import { sab } from './routes/sab.js'
import { tmdb } from './routes/tmdb.js'
import { iptv } from './routes/iptv.js'
import { dvr } from './routes/dvr.js'
import { users } from './routes/users.js'
import { plexAdmin } from './routes/plex-admin.js'
import { plexLinks } from './routes/plex-links.js'
import { notifications } from './routes/notifications.js'
import { grabs } from './routes/grabs.js'
import { suggestions } from './routes/suggestions.js'
import { settings } from './routes/settings.js'
import { feedback } from './routes/feedback.js'
import { watchlist } from './routes/watchlist.js'
import { syncplay } from './routes/syncplay.js'
import { policy, adminPolicy } from './routes/policy.js'
import { usage } from './routes/usage.js'
import { recommenderEvents } from './routes/recommenderEvents.js'
import { telemetry } from './routes/telemetry.js'
import { device } from './routes/device.js'
import { media } from './routes/media.js'
import { transcode } from './routes/transcode.js'
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
  // LOW-29: tag the exception with the request id so a Glitchtip event can be
  // tied back to the matching `[<id>]` log line (and the client's X-Request-Id).
  Sentry.captureException(err, { tags: { request_id: c.get('requestId') } })
  console.error('[app] unhandled error:', err instanceof Error ? err.stack ?? err.message : err)
  return c.json({ error: 'internal' }, 500)
})

// LOW-29: assign a correlation id to every request (or honor an inbound
// X-Request-Id), exposed to handlers via c.get('requestId') and echoed in the
// X-Request-Id response header. Must run before the logger so the id is logged.
app.use('*', requestId())

// MED-18: stream/segment/playlist auth is token-in-URL (`?t=`, `?u=`, `?token=`),
// so any logger that prints the query string would write live bearer tokens into
// stdout/container logs. Redact those query values. Exported pure for test.
const TOKEN_QUERY_RE = /([?&](?:t|u|token)=)[^&\s]+/gi
export function redactStreamTokens(line: string): string {
  return line.replace(TOKEN_QUERY_RE, '$1[redacted]')
}

// Request logger: method + redacted path + status + elapsed + request id. Custom
// (not hono/logger) so the log line carries the correlation id (LOW-29) that ties
// it to telemetry, and so the token redaction (MED-18) is applied to the path.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  const path = redactStreamTokens(url.pathname + url.search)
  const rid = c.get('requestId')
  const start = Date.now()
  console.log(`<-- ${c.req.method} ${path} [${rid}]`)
  await next()
  console.log(`--> ${c.req.method} ${path} ${c.res.status} ${Date.now() - start}ms [${rid}]`)
})

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

// Liveness/readiness gate trusted by the docker healthcheck AND cloudflared's
// `depends_on: service_healthy`. A bare {ok:true} kept the tunnel routing live
// traffic to a backend whose server.db was locked/corrupt — every API route
// 500s but docker never restarts and cloudflared never fails over. Probe the
// one critical LOCAL dependency (server.db) cheaply and 503 on failure. Do NOT
// block on remote sidecars (recommender/IPTV) so a sidecar outage can't take
// the public tunnel down with it.
app.get('/api/health', (c) => {
  try {
    serverDb().raw.prepare('SELECT 1').get()
    return c.json({ ok: true })
  } catch (e) {
    console.error('[health] server.db probe failed:', e instanceof Error ? e.message : e)
    return c.json({ ok: false, reason: 'db_unavailable' }, 503)
  }
})

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
    // True when the media proxy is mounted AND a music root is configured
    // (MUSIC_LIBRARY_PATHS). The SPA gates its Music tab on this — browse
    // (/api/media/music/*) and audio playback ride the same proxy, so both
    // facts are required. Public boolean — no secret leakage.
    musicEnabled: env.useMediaCore && env.musicRootsConfigured,
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
// DVR (M6 phase 1) records IPTV live channels, so it requires IPTV mounted and
// is off by default until the phase-2 recorder ships (see routes/dvr.ts).
if (env.DVR_ENABLED && !env.IPTV_DISABLED) {
  app.route('/api/dvr', dvr)
}
app.route('/api/users', users)
// Admin-only per-user policy management (parental controls + section
// scoping), mounted beside the admin user listing. Distinct subpaths
// (/policies, /:sub/policy) so it coexists with `users` on this prefix.
app.route('/api/users', adminPolicy)
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
// Per-user settings (admin-free, sub-scoped) — currently the server-side
// encrypted BYO Anthropic key that replaced SPA-localStorage storage.
app.route('/api/settings', settings)
app.route('/api/feedback', feedback)
// Per-user watchlist (admin-free, sub-scoped) — each member's private
// "want to watch" list. Always-on, so no /api/limits capability flag.
app.route('/api/watchlist', watchlist)
// SyncPlay watch-together groups: shared transport state (play/pause/seek)
// that member clients poll to stay in lockstep. In-memory, ephemeral.
app.route('/api/syncplay', syncplay)
// Per-user policy read (admin-free, sub-scoped) — the caller's own
// parental-control/section policy. Always-on, so no /api/limits flag.
app.route('/api/policy', policy)
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
  // HLS playback for non-direct-play files: media-core hands the client a
  // transcoder session whose manifest/segment URLs are served back through
  // this proxy. Gated on the same flag as /api/media — without media-core
  // there is nothing to hand off.
  app.route('/api/transcode', transcode)
}
