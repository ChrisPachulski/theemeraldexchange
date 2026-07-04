// Backend env loader. Reads .env.local at boot, validates the required
// keys, and exposes a strongly-typed `env` object the rest of the
// server consumes.
//
// Required (always):
//   PLEX_CLIENT_ID    — stable UUID identifying this app to plex.tv.
//                       Generate once with `crypto.randomUUID()` and keep
//                       it constant. Plex uses it to disambiguate
//                       sessions; rotating it logs everyone out.
//   SESSION_SECRET    — arbitrary-length string fed through SHA-256 to
//                       derive the 32-byte AES-GCM key used to encrypt
//                       session cookies (JWE). Rotating invalidates
//                       every existing session.
//
// Required in production (NODE_ENV=production):
//   ALLOWED_ORIGINS   — comma-separated SPA origins. Used for CORS AND
//                       the Origin-header CSRF gate. Required in prod
//                       because session cookies are SameSite=None for
//                       the Netlify ↔ NAS split — without an allowlist,
//                       the CSRF middleware would fail open.
//
// Optional:
//   ADMINS            — comma-separated Plex usernames that get the
//                       `admin` role. Everyone else who is a member of
//                       the home server is `user`. Empty == no admins.
//   PLEX_SERVER_ID    — machineIdentifier of the home Plex server.
//                       When set, only members of that server can log
//                       in. When unset, any authenticated Plex user is
//                       allowed (useful for first-time setup until you
//                       discover your server ID via /api/me).
//   PORT              — backend listen port (default 3001).
//   NODE_ENV          — 'production' switches cookies to SameSite=None;
//                       Secure for cross-origin Netlify ↔ NAS use, and
//                       enforces ALLOWED_ORIGINS.
//   TRUST_CLIENT_IP_HEADERS
//                     — set to 1 only when the backend is reachable solely
//                       through a trusted proxy/tunnel that owns CF/Forwarded
//                       client IP headers.

import { config as dotenvConfig } from 'dotenv'
import { validateSecretStrength, assertSecretsDistinct } from './services/secrets.js'
import { parseSub } from './services/sub.js'

dotenvConfig({ path: '.env.local' })
dotenvConfig({ path: '.env' })

function required(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

function csv(name: string): string[] {
  const v = process.env[name]
  if (!v) return []
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

// docker-compose's ${VAR:-} expansion produces empty strings for unset
// vars rather than dropping them. The default-with-`??` operator only
// triggers on null/undefined, so an empty env var would shadow the
// NAS fallbacks below. Treat empty as missing.
function opt(name: string): string | undefined {
  const v = process.env[name]
  if (v === undefined) return undefined
  const trimmed = v.trim()
  return trimmed === '' ? undefined : trimmed
}

// Parse an optional positive-number env var. Fail closed at boot on a
// typo (e.g. MIN_FREE_GB="abc") rather than letting Number(...) return
// NaN — `freeSpace < NaN` is always false, which would silently disable
// the disk-space safety gate in the Sonarr/Radarr add paths.
function positiveNumber(name: string, defaultValue: number): number {
  const raw = opt(name)
  if (raw === undefined) return defaultValue
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid env var ${name}: expected a positive finite number, got ${JSON.stringify(raw)}`,
    )
  }
  return n
}

function positiveInt(name: string, defaultValue: number): number {
  const n = positiveNumber(name, defaultValue)
  if (!Number.isInteger(n)) {
    throw new Error(
      `Invalid env var ${name}: expected a positive integer, got ${JSON.stringify(process.env[name])}`,
    )
  }
  return n
}

const NAS_HOST = 'theemeraldexchange.local'
const GB = 1024 * 1024 * 1024

const isProd = process.env.NODE_ENV === 'production'
const allowedOrigins = csv('ALLOWED_ORIGINS')
// In prod, session cookies are SameSite=None for the Netlify ↔ NAS
// split, which means the CSRF middleware relies on the Origin header
// matching this list to distinguish trusted SPA tabs from attacker
// pages. An empty list would fail open, so require it explicitly.
if (isProd && allowedOrigins.length === 0) {
  throw new Error(
    'Missing required env var in production: ALLOWED_ORIGINS ' +
      '(comma-separated SPA origins, needed for CSRF defense with SameSite=None cookies)',
  )
}

// PLEX_CLIENT_ID — stable UUID identifying this app to plex.tv. Optional
// since Phase 0 (plan 006): unset means Plex login is simply not
// configured on this install (self-host without a Plex account); the
// Plex auth routes 503 with plex_not_configured instead of the server
// refusing to boot. opt() trims, which is load-bearing for the plex.tv
// PIN flow (see the note on the env object below).
const plexClientId = opt('PLEX_CLIENT_ID') ?? null

// PLEX_SERVER_ID is the machineIdentifier of the home Plex server.
// When set, only members of that server can sign in. When unset, the
// auth flow accepts any authenticated Plex user — that's the
// first-time-bootstrap mode so the operator can discover the server id
// via /api/me's discoveredServers payload. In production, leaving it
// blank silently turns the invitation-only app into "any Plex user can
// sign in," so we hard-fail unless the operator explicitly opts in
// via ALLOW_UNSCOPED_PLEX_LOGIN=1 (intended only for the brief
// first-deploy window). Only enforced when Plex login is configured at
// all (PLEX_CLIENT_ID set) — a Plex-free install has no Plex sign-in
// path to scope.
const plexServerId = opt('PLEX_SERVER_ID') ?? null
const allowUnscopedPlexLogin = process.env.ALLOW_UNSCOPED_PLEX_LOGIN === '1'
if (isProd && plexClientId && !plexServerId && !allowUnscopedPlexLogin) {
  throw new Error(
    'Missing required env var in production: PLEX_SERVER_ID ' +
      '(your home Plex server\'s machineIdentifier — required to scope ' +
      'sign-ins to your household). Set it now, or set ' +
      'ALLOW_UNSCOPED_PLEX_LOGIN=1 explicitly to opt into the ' +
      'first-deploy bootstrap mode that accepts ANY Plex user. ' +
      'Discover the id via the SPA\'s first login (discoveredServers) ' +
      'and remove the escape hatch immediately.',
  )
}

const useLocalRecommender = process.env.USE_LOCAL_RECOMMENDER === '1'
const useMediaCore = process.env.USE_MEDIA_CORE === '1'
// Music capability signal. media-core scans audio only when MUSIC_LIBRARY_PATHS
// is set, so that one env var is the single source of truth for "music is
// configured" — no separate flag to drift. The backend must be given the same
// value as media-core (they share the config) so /api/limits can honestly gate
// the SPA's music tab. Empty/unset → music disabled (the M3-only posture).
const musicRootsConfigured = Boolean((opt('MUSIC_LIBRARY_PATHS') ?? '').trim())
const trustClientIpHeaders = process.env.TRUST_CLIENT_IP_HEADERS === '1'
const recommenderEventSecret = opt('RECOMMENDER_EVENT_SECRET') ?? null
if (useLocalRecommender && !recommenderEventSecret) {
  throw new Error(
    'Missing required env var when USE_LOCAL_RECOMMENDER=1: RECOMMENDER_EVENT_SECRET',
  )
}
// *arr / SAB integrations — optional since Phase 0 (plan 006). Unset key
// means the integration is not configured: the service helpers throw
// NotConfiguredError, which app.onError maps to a typed 503 (mirroring
// tmdb_not_configured) instead of the server refusing to boot.
const sonarrApiKey = opt('SONARR_API_KEY') ?? null
const radarrApiKey = opt('RADARR_API_KEY') ?? null
const sabApiKey = opt('SAB_API_KEY') ?? null

const defaultRootFolderPath = opt('DEFAULT_ROOT_FOLDER_PATH') ?? null
const defaultSonarrRootFolderPath = opt('DEFAULT_SONARR_ROOT_FOLDER_PATH') ?? defaultRootFolderPath
const defaultRadarrRootFolderPath = opt('DEFAULT_RADARR_ROOT_FOLDER_PATH') ?? defaultRootFolderPath
// Root-folder paths guard non-admin adds, so they only matter for an *arr
// that is actually configured — a request-less install shouldn't fail boot
// over them.
if (isProd && ((sonarrApiKey && !defaultSonarrRootFolderPath) || (radarrApiKey && !defaultRadarrRootFolderPath))) {
  throw new Error(
    'Missing required env var in production: DEFAULT_SONARR_ROOT_FOLDER_PATH ' +
      'and/or DEFAULT_RADARR_ROOT_FOLDER_PATH (exact upstream root folder paths for non-admin adds)',
  )
}

// SESSION_SECRET is fed through SHA-256 to derive the A256GCM key that
// encrypts session cookies, which carry the user's Plex auth token. A
// short or guessable secret turns the cookie's confidentiality into a
// game of "can the attacker brute-force the prod key." `required` only
// rejects empty, so in prod a value like `changeme` boots happily.
// Enforce the same minimum the operator docs already prescribe (≥32
// bytes — "openssl rand -base64 48") and reject the common placeholder
// strings.
const SESSION_SECRET_MIN_LEN = 32
const SESSION_SECRET_PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'placeholder',
  'secret',
  'password',
  'test',
  'test-secret',
  'replaceme',
  'replace-me',
  'replace_me',
  'your-secret-here',
  'session-secret',
])
// Reject weak/placeholder secrets in production. Placeholder check runs
// first so `changeme` is rejected for BEING a placeholder (clearer error)
// rather than merely for being short. `note` appends secret-specific stakes
// to each message; same policy applies to every prod secret added later.
function assertProdSecret(
  name: string,
  value: string | null | undefined,
  note: { placeholder?: string; short?: string } = {},
): void {
  if (!isProd || !value) return
  if (SESSION_SECRET_PLACEHOLDERS.has(value.toLowerCase())) {
    throw new Error(
      `${name} looks like a placeholder value. Generate a real secret with ` +
        `\`openssl rand -base64 48\` and redeploy.${note.placeholder ?? ''}`,
    )
  }
  if (value.length < SESSION_SECRET_MIN_LEN) {
    throw new Error(
      `${name} is too short for production (${value.length} chars). Use at least ` +
        `${SESSION_SECRET_MIN_LEN} bytes — generate one with \`openssl rand -base64 48\`.${note.short ?? ''}`,
    )
  }
}

const rawSessionSecret = process.env.SESSION_SECRET ?? ''
assertProdSecret('SESSION_SECRET', rawSessionSecret, {
  placeholder:
    ' Leaving the placeholder in prod is equivalent to publishing the AES key in the repo.',
  short:
    ' The value is fed through SHA-256 to derive the A256GCM key that encrypts session' +
    " cookies; a weak secret puts every user's Plex auth token at risk.",
})
assertProdSecret('RECOMMENDER_EVENT_SECRET', recommenderEventSecret)

// STREAM_TOKEN_SECRET is the dedicated signing AND verifying secret for
// IPTV/media stream tokens (§5.4).  Kept separate from SESSION_SECRET so
// a stream-token compromise does not expose session cookies, and so key
// rotation is scoped to the affected token class.  The D2a migration
// fallback (verifier accepting SESSION_SECRET-signed tokens) is removed:
// every verify site is single-key, so SESSION_SECRET can never forge a
// stream token. Future rotations should dual-key OLD vs NEW
// STREAM_TOKEN_SECRET values via verifyStreamTokenDualKey, never
// SESSION_SECRET.
const rawStreamTokenSecret = required('STREAM_TOKEN_SECRET')
validateSecretStrength('STREAM_TOKEN_SECRET', rawStreamTokenSecret, isProd)

// DEVICE_TOKEN_SECRET — IKM for HKDF(secret, 'eex/device-token/v1', 32)
// → AES-256-GCM key for device-token JWE encryption (M2 Apple Bearer
// auth). Required in production once D13 ships (now). Dev tolerates
// absence so localhost development without Apple pairing still boots;
// any code path that mints a device token re-checks and throws.
const rawDeviceTokenSecret = isProd
  ? required('DEVICE_TOKEN_SECRET')
  : process.env.DEVICE_TOKEN_SECRET || ''
if (rawDeviceTokenSecret) {
  validateSecretStrength('DEVICE_TOKEN_SECRET', rawDeviceTokenSecret, isProd)
}

// INTERNAL_PRINCIPAL_SECRET — IKM for HKDF(secret, 'eex/internal-principal/v1', 32)
// → AES-256-GCM key for the JWE the server attaches to every internal
// service call (recommender, future M3 media-core, M4 transcoder). Per
// §4 Hybrid D + Rust-canonical: Hono mints, the receiving service
// verifies. 60-second TTL, no nbf skew. Required in production once any
// internal service is wired; tolerated absent in dev so localhost work
// without the sidecar can still boot — mint paths re-check and throw.
const rawInternalPrincipalSecret = isProd
  ? required('INTERNAL_PRINCIPAL_SECRET')
  : process.env.INTERNAL_PRINCIPAL_SECRET || ''
if (rawInternalPrincipalSecret) {
  validateSecretStrength('INTERNAL_PRINCIPAL_SECRET', rawInternalPrincipalSecret, isProd)
}

// Boot-time pairwise distinctness check (contract §3.1 / §4.2 / §5.4).
// Runs in all environments — not just prod — so a copy-paste mistake
// is caught before it reaches CI.  DEVICE_TOKEN_SECRET and
// INTERNAL_PRINCIPAL_SECRET are checked when present; in dev without
// Apple pairing / sidecar wiring they may be absent.
assertSecretsDistinct({
  SESSION_SECRET: rawSessionSecret,
  STREAM_TOKEN_SECRET: rawStreamTokenSecret,
  DEVICE_TOKEN_SECRET: rawDeviceTokenSecret || null,
  INTERNAL_PRINCIPAL_SECRET: rawInternalPrincipalSecret || null,
})

// EEX_TELEMETRY_DSN — Sentry-compatible DSN for the self-hoster's Glitchtip
// instance. Since Phase 0 (plan 006) telemetry is opt-in: the boot
// requirement only applies when TELEMETRY_ENABLED=1 (the owner's full
// deployment sets it; a basic self-host leaves the whole telemetry
// profile off). With a DSN set, telemetry works regardless of the flag;
// with neither, Sentry.init is never called and captureException is a
// no-op (§15.1 amended by plan 006 / verdict C4).
const telemetryEnabled = process.env.TELEMETRY_ENABLED === '1'
const telemetryDsn = opt('EEX_TELEMETRY_DSN') ?? null
if (isProd && telemetryEnabled && !telemetryDsn) {
  throw new Error(
    'Missing required env var in production when TELEMETRY_ENABLED=1: ' +
      'EEX_TELEMETRY_DSN (Sentry-compatible DSN for your self-hosted ' +
      'Glitchtip project). Create an EEX project in Glitchtip, copy the ' +
      'DSN, and set EEX_TELEMETRY_DSN — or unset TELEMETRY_ENABLED.',
  )
}
if (isProd && !telemetryDsn) {
  console.warn('[env] EEX_TELEMETRY_DSN not set — telemetry disabled for this deployment')
}

// APPLE_CLIENT_ID — the Apple Services ID / app bundle id used as the
// `aud` claim when verifying a Sign in with Apple identity token against
// Apple's JWKS (server/services/appleAuth.ts). SIWA needs no client
// secret for identity-token verification (the JWKS is public), so this
// is the only Apple config the verifier consumes — consistent with the
// "no new credential store" constraint. Optional in dev so a Plex-only
// deploy still boots; required in production only when SIWA is enabled
// via ENABLE_APPLE_SIGN_IN=1 (mirrors the explicit-opt-in pattern used
// for ALLOW_UNSCOPED_PLEX_LOGIN), so forcing it on every Plex-only NAS
// is avoided. The verifier additionally fails closed if this is null.
const appleClientId = opt('APPLE_CLIENT_ID') ?? null
const enableAppleSignIn = process.env.ENABLE_APPLE_SIGN_IN === '1'
if (isProd && enableAppleSignIn && !appleClientId) {
  throw new Error(
    'Missing required env var in production when ENABLE_APPLE_SIGN_IN=1: ' +
      'APPLE_CLIENT_ID (the Apple Services ID / bundle id used as the ' +
      'SIWA identity-token aud). Set it, or unset ENABLE_APPLE_SIGN_IN ' +
      'to run Plex-only.',
  )
}

// GOOGLE_CLIENT_ID — comma-separated Google OAuth client id(s) accepted as
// the `aud` claim when verifying a Google ID token against Google's JWKS
// (server/services/googleAuth.ts). A native iOS sign-in and a web sign-in
// use DIFFERENT client ids but the SAME Google account/`sub`, so the
// verifier accepts any configured id. Like SIWA, identity-token
// verification needs NO client secret (the JWKS is public) — consistent
// with the "no new credential store" constraint. Optional in dev; required
// in production only when Google is enabled via ENABLE_GOOGLE_SIGN_IN=1.
const googleClientIds = csv('GOOGLE_CLIENT_ID')
const enableGoogleSignIn = process.env.ENABLE_GOOGLE_SIGN_IN === '1'
if (isProd && enableGoogleSignIn && googleClientIds.length === 0) {
  throw new Error(
    'Missing required env var in production when ENABLE_GOOGLE_SIGN_IN=1: ' +
      'GOOGLE_CLIENT_ID (comma-separated Google OAuth client id(s) used as ' +
      'the ID-token aud). Set it, or unset ENABLE_GOOGLE_SIGN_IN to run ' +
      'without Google.',
  )
}

// ADMIN_SUBS — comma-separated, namespaced subs (apple:<subject> |
// plex:<id> | google:<sub>) that are admins AND implicitly allowed without
// an invite.
// This is the owner-bootstrap: the operator's own Apple/Plex sub goes
// here so their very first login on a fresh install needs no invite and
// lands them as admin even when their Plex username isn't in ADMINS
// (apple: subs have no stable Plex username). Each entry is validated
// with parseSub at boot so a malformed entry fails closed (throws)
// rather than silently granting nothing. ADMINS (Plex usernames, legacy)
// and ADMIN_SUBS coexist — roleFor keeps reading ADMINS for the cookie
// username path; isAdminSub covers apple: subs.
const adminSubs = csv('ADMIN_SUBS').map((s) => {
  try {
    return parseSub(s).raw
  } catch {
    throw new Error(
      `Invalid entry in ADMIN_SUBS: ${JSON.stringify(s)}. Each entry must ` +
        'be a namespaced sub like "plex:12345" or ' +
        '"apple:000000.<32 hex>.0000".',
    )
  }
})

// ── Passkeys (WebAuthn) ──────────────────────────────────────────────────
// The cross-platform, password-free identity spine. Three knobs:
//   WEBAUTHN_RP_ID    — the Relying Party id: the registrable domain the
//                       passkey is bound to (e.g. "theemeraldexchange.com").
//                       MUST be the origin's host or a parent domain of it.
//                       Defaults to "localhost" for dev.
//   WEBAUTHN_RP_NAME  — human-facing name shown in the OS passkey prompt.
//   WEBAUTHN_ORIGINS  — comma-separated allowed origins (full scheme+host
//                       [+port]) the assertion may come from. Defaults to the
//                       app's CORS allow-list so a typical deploy needs no
//                       extra config; override when the login page lives on a
//                       different origin than the API callers.
const webauthnRpId = (opt('WEBAUTHN_RP_ID') ?? 'localhost').trim()
const webauthnRpName = (opt('WEBAUTHN_RP_NAME') ?? 'The Emerald Exchange').trim()
const webauthnOrigins = (() => {
  const explicit = csv('WEBAUTHN_ORIGINS')
  if (explicit.length > 0) return explicit
  if (allowedOrigins.length > 0) return allowedOrigins
  return ['http://localhost:5173', 'http://localhost:3001']
})()

/** True when Plex OAuth is configured for this installation.
 *
 *  PLEX_CLIENT_ID is optional since Phase 0 (plan 006): a self-host
 *  without a Plex account leaves it unset and the Plex auth routes 503
 *  with plex_not_configured. This helper exists so the device-token mint
 *  path and /api/version can expose which auth providers are active
 *  without re-reading process.env at call time. Read through the exported
 *  env object (like isAppleConfigured) so tests can flip it.
 */
export function isPlexConfigured(): boolean {
  return Boolean(env.plexClientId)
}

/** True when Sign in with Apple is configured (APPLE_CLIENT_ID set).
 *  Surfaced beside isPlexConfigured so /api/version can advertise both
 *  auth_modes to clients, and so the /api/auth/apple route can fail
 *  fast with a clear 503 when SIWA isn't configured rather than
 *  verifying tokens against an empty aud. */
export function isAppleConfigured(): boolean {
  // Read through the exported env object (not the module-scoped const) so
  // the check stays consistent if appleClientId is ever overridden, and
  // so it is exercisable in tests the same way plexServerId is flipped.
  return Boolean(env.appleClientId)
}

/** True when Google sign-in is configured (≥1 GOOGLE_CLIENT_ID set).
 *  Mirrors isAppleConfigured so /api/auth/google can fail fast with a 503
 *  when Google isn't configured rather than verifying tokens against an
 *  empty aud, and so /api/auth/methods can advertise it. Read through the
 *  exported env object so tests can flip env.googleClientIds. */
export function isGoogleConfigured(): boolean {
  return env.googleClientIds.length > 0
}

export const env = {
  // Trimming (done by opt() at the hoisted const above) is load-bearing
  // for the plex.tv PIN flow: this value flows into BOTH the
  // X-Plex-Client-Identifier header (server → plex.tv) AND the clientID
  // URL param on the popup auth URL (browser → plex.tv). plex.tv matches
  // them as exact strings when reconciling the authorized PIN; a stray
  // trailing newline (common when copying from a generator into .env)
  // makes the header carry "\n" and the URLSearchParams version carry
  // "%0A", which plex.tv treats as two different clients — the user
  // authorizes one, the server polls the other, and check returns
  // {authToken: null} forever. null when Plex login is not configured.
  plexClientId,
  sessionSecret: required('SESSION_SECRET'),
  streamTokenSecret: rawStreamTokenSecret,
  /** Empty string in dev when not configured; D13 mint paths assert non-empty. */
  deviceTokenSecret: rawDeviceTokenSecret,
  /** Empty string in dev when not configured; mintInternalPrincipal asserts non-empty. */
  internalPrincipalSecret: rawInternalPrincipalSecret,
  admins: csv('ADMINS'),
  /** Namespaced subs (apple:/plex:) that are admins + implicitly allowed
   *  without an invite (owner bootstrap). parseSub-validated at boot. */
  adminSubs,
  /** SIWA `aud` — Apple Services ID / bundle id. null when unconfigured. */
  appleClientId,
  /** Google ID-token `aud` allow-list — OAuth client id(s). [] when unconfigured. */
  googleClientIds,
  /** WebAuthn Relying Party id (registrable domain the passkey binds to). */
  webauthnRpId,
  /** Human-facing name shown in the OS passkey prompt. */
  webauthnRpName,
  /** Allowed origins a passkey assertion may originate from. */
  webauthnOrigins,
  plexServerId,
  port: positiveInt('PORT', 3001),
  isProd,
  allowedOrigins,
  /** Trust Cloudflare/proxy client IP headers for per-client auth rate limits.
   *  Keep off unless the backend is reachable only through that proxy. */
  trustClientIpHeaders,

  // Backing services. URL defaults match the existing NAS deployment;
  // override per-environment via env vars.
  // Local Plex Media Server. Used to enumerate every account that has
  // ever accessed the server (via /accounts), which is the canonical
  // list of "people who actually watch on this server" and what
  // Tautulli's Top Users uses.
  plexServerUrl: opt('PLEX_SERVER_URL') ?? `http://${NAS_HOST}:32400`,

  sonarrUrl: opt('SONARR_URL') ?? `http://${NAS_HOST}:8989/tv`,
  /** null when Sonarr is not configured — sonarrFetch throws NotConfiguredError. */
  sonarrApiKey,
  radarrUrl: opt('RADARR_URL') ?? `http://${NAS_HOST}:7878/movies`,
  /** null when Radarr is not configured — radarrFetch throws NotConfiguredError. */
  radarrApiKey,
  sabUrl: opt('SAB_URL') ?? `http://${NAS_HOST}:8080`,
  /** null when SAB is not configured — sab helpers throw NotConfiguredError. */
  sabApiKey,

  // Preferred quality-profile name for non-admin adds. The frontend
  // already prefers "Choose Me" by name (AddMovieModal /
  // AddSeriesModal); mirror that on the server so non-admin direct-
  // POSTs land on the same curated profile rather than profiles[0]
  // (which could be the more permissive default Sonarr/Radarr ships).
  //
  // The downstream comparison is `p.name?.toLowerCase() === this`, so
  // we MUST lowercase the env value here too. The published example
  // sets DEFAULT_PROFILE_NAME=Choose Me (capitalized), and without
  // this normalization the comparison would silently fail and fall
  // back to profiles[0] — re-opening the very gap the env var exists
  // to close. Override per-deploy if the household curates under a
  // different name; case doesn't matter.
  defaultProfileName: (opt('DEFAULT_PROFILE_NAME') ?? 'choose me').toLowerCase(),
  defaultSonarrRootFolderPath,
  defaultRadarrRootFolderPath,

  // Minimum free space (bytes) on a Sonarr/Radarr root folder before
  // we'll allow an `add`. Below this, both admins and users get a 507
  // — the user explicitly wanted everyone (including admins) gated.
  // positiveNumber throws at boot on a typo instead of producing NaN,
  // which would make `freeSpace < env.minFreeBytes` always false and
  // silently disable the gate.
  minFreeBytes: positiveNumber('MIN_FREE_GB', 100) * GB,

  // Hard cap on movie release size at add-time. The dashboard intercepts
  // Radarr's auto-search, fetches available releases ourselves, and
  // grabs the highest-quality one whose size is at or under this cap.
  // Prevents accidental 50 GB 4K HDR rips when someone clicks Add.
  maxMovieBytes: positiveNumber('MAX_MOVIE_SIZE_GB', 10) * GB,
  maxMovieGb: positiveNumber('MAX_MOVIE_SIZE_GB', 10),

  // Hard cap on TV release size, expressed per episode. A release passes
  // when (size / episodeCount) ≤ this value. Single-episode caps at the
  // full per-episode value; a 10-episode season pack caps at 10× the
  // value. 5 GB/episode blocks 4K HDR while letting 1080p Bluray rips
  // through, matching the curated "Choose Me" profile we run.
  maxTvBytesPerEpisode: positiveNumber('MAX_TV_GB_PER_EPISODE', 5) * GB,
  maxTvGbPerEpisode: positiveNumber('MAX_TV_GB_PER_EPISODE', 5),

  // Path to the persistent rejection list. Same bind-mount as the grab
  // log so the household's "never suggest this again" decisions survive
  // container restarts.
  rejectionsPath: process.env.REJECTIONS_PATH ?? './data/rejections.json',

  // Per-user feedback store. Keyed by Plex user id (sub). Holds each
  // member's private likes (positive signal to Claude) and their
  // individual disliked ids (used to roll into the household rejection
  // list). Shares the bind-mount with the other data files.
  userFeedbackPath: process.env.USER_FEEDBACK_PATH ?? './data/user-feedback.json',

  // Per-user watchlist store. Keyed by sub; holds each member's private
  // "want to watch" list (movie + tv buckets). Shares the bind-mount with
  // the other per-user JSON data files.
  userWatchlistPath: process.env.USER_WATCHLIST_PATH ?? './data/user-watchlist.json',

  // Per-user policy store (parental controls + section scoping). Keyed by
  // sub; holds each member's max content rating, allowed sections, and
  // kid flag. Shares the bind-mount with the other per-user data files.
  userPoliciesPath: process.env.USER_POLICIES_PATH ?? './data/user-policies.json',

  // Per-Claude-call usage log. JSONL like the grab log; one row per
  // Anthropic call with token counts + estimated cost, keyed by user
  // for the per-user usage view and the admin dashboard.
  usageLogPath: process.env.USAGE_LOG_PATH ?? './data/usage.jsonl',

  // Path to the grab-event JSONL log. In production this is bind-mounted
  // from /mnt/user/appdata/exchange-backend/data on the NAS so events
  // survive container restarts. In dev defaults to ./data/grabs.jsonl
  // (gitignored). The grabLog service auto-creates the parent directory.
  grabLogPath: process.env.GRAB_LOG_PATH ?? './data/grabs.jsonl',

  // Optional TMDB read token. When set, the detail modal fetches cast
  // for TV shows (via TVDB→TMDB find) and movies. Without it, the cast
  // section is hidden and the modal still shows everything Sonarr/Radarr
  // expose. Prefer TMDB_READ_ACCESS_TOKEN so server-side calls can use
  // the Authorization header instead of putting secrets in URLs.
  tmdbReadAccessToken: opt('TMDB_READ_ACCESS_TOKEN') ?? null,
  tmdbApiKey: opt('TMDB_API_KEY') ?? null,

  // Local recommender sidecar. When USE_LOCAL_RECOMMENDER=1, /api/suggestions
  // skips Claude entirely and asks the recommender service (Python +
  // sqlite-vec, running in the same compose stack) for ranked picks.
  //
  // Default URL is environment-conditional:
  //   - prod (NODE_ENV=production): "http://recommender:8000" — the
  //     docker-compose service hostname. The compose file passes
  //     RECOMMENDER_URL explicitly so this default is belt-and-suspenders
  //     for direct `node dist/server.js` boots that bypass compose.
  //   - dev/test: "http://localhost:8000" — matches recommender/README.md
  //     quickstart instructions for hand-running the sidecar. The prior
  //     unconditional "http://recommender:8000" silently called an
  //     unresolvable Docker hostname unless the developer remembered
  //     to set RECOMMENDER_URL.
  useLocalRecommender,
  recommenderUrl:
    opt('RECOMMENDER_URL') ??
    (process.env.NODE_ENV === 'production'
      ? 'http://recommender:8000'
      : 'http://localhost:8000'),
  recommenderEventSecret,
  // Recommender's SQLite DB, named exchange.db in the cross-service contract.
  // Hono does not own or migrate it, but /api/version reports its migration
  // level for Apple/client compatibility checks.
  RECOMMENDER_DB_PATH: process.env.RECOMMENDER_DB_PATH ?? './data/exchange.db',

  useMediaCore,
  musicRootsConfigured,
  mediaCoreUrl:
    opt('MEDIA_CORE_URL') ??
    (process.env.NODE_ENV === 'production'
      ? 'http://media-core:8002'
      : 'http://127.0.0.1:8002'),
  // Transcoder base URL. When a library file cannot direct-play, media-core's
  // /play grant routes the client to the transcoder's HLS session, whose
  // manifest/segment URLs are served back through the backend's /api/transcode
  // proxy (server/routes/transcode.ts). Mirrors media-core's own
  // MEDIA_TRANSCODER_URL so both reach the same service. Only consumed when
  // useMediaCore is on.
  transcoderUrl:
    opt('MEDIA_TRANSCODER_URL') ??
    (process.env.NODE_ENV === 'production'
      ? 'http://transcoder:8003'
      : 'http://127.0.0.1:8003'),
  // Path to media-core's library DB (media.db). The server opens this
  // file READ-ONLY for availability tagging (recommender stamps
  // available_on:['local'] for titles already on disk). media-core owns
  // ALL writes; the server never migrates or mutates it. Default matches
  // the NAS data bind-mount used by iptv.db. In Docker the library mount
  // is read-only for media-core too — this is purely a read seam.
  MEDIA_DB_PATH: process.env.MEDIA_DB_PATH ?? './data/media.db',

  // mybunny.tv / Xtream Codes IPTV integration. Reserved at PF-2;
  // consumed by the IPTV modules added in later PF phases (Xtream client,
  // EPG sync cron, stream-token proxy, recommender export). Empty
  // defaults keep boot working without IPTV configured — downstream
  // modules guard on XTREAM_HOST being set before attempting any
  // upstream calls.
  XTREAM_HOST: process.env.XTREAM_HOST ?? '',
  XTREAM_USERNAME: process.env.XTREAM_USERNAME ?? '',
  XTREAM_PASSWORD: process.env.XTREAM_PASSWORD ?? '',
  // Path to the server identity / cross-cutting state DB. Must be
  // bind-mounted in Docker — losing this on a container restart generates
  // a new server_id and silently revokes all device tokens. Default
  // matches the NAS data bind-mount used by iptv.db and other data files.
  SERVER_DB_PATH: process.env.SERVER_DB_PATH ?? './data/server.db',
  IPTV_DB_PATH: process.env.IPTV_DB_PATH ?? './data/iptv.db',
  // Scheduled DB-snapshot retention dir + count + cadence (finding 14-4).
  // VACUUM INTO snapshots of server.db + iptv.db land here on a cron and on
  // each pass stamp server_state.last_backup_at. Keep this on the SAME
  // bind-mounted volume root as the DBs by default but in a sibling dir so a
  // restore is a simple copy. Default cadence: daily at 03:30 local.
  DB_BACKUP_DIR: process.env.DB_BACKUP_DIR ?? './data/backups',
  DB_BACKUP_KEEP: positiveInt('DB_BACKUP_KEEP', 7),
  DB_BACKUP_CRON: process.env.DB_BACKUP_CRON ?? '30 3 * * *',
  // Nightly sweep of expired device_tokens + webauthn_challenges (LOW-9).
  TOKEN_SWEEP_CRON: process.env.TOKEN_SWEEP_CRON ?? '15 3 * * *',
  IPTV_EPG_PATH: opt('IPTV_EPG_PATH') ?? '/xmltv.php',
  IPTV_MAX_CONCURRENT_STREAMS: positiveInt('IPTV_MAX_CONCURRENT_STREAMS', 4),
  // HARD ceiling on simultaneous live-remux upstream connections to the IPTV
  // provider. The provider plan allows only a few at once and trips an abuse
  // block on excess or rapid churn — once tripped it serves CORRUPT, undecodable
  // video to everyone until it cools down. Enforced inside startRemuxSession
  // (the single point where an upstream connection opens), so NO caller path —
  // grant, a direct manifest poll, a test probe, or a future bug — can exceed
  // it. Set this to your provider's real max simultaneous connections; default 2.
  IPTV_MAX_UPSTREAM_CONNECTIONS: positiveInt('IPTV_MAX_UPSTREAM_CONNECTIONS', 2),
  IPTV_STREAM_TOKEN_TTL_SECS: positiveInt('IPTV_STREAM_TOKEN_TTL_SECS', 300),
  // TTL for LIVE grant tokens (the `live` .ts and `remux` index.m3u8 URLs). A
  // live session is UNBOUNDED and the player re-fetches the SAME tokenized
  // manifest URL forever; the handler re-checks `exp` on every poll, so the
  // short finite-asset TTL above froze live cable after exactly 5 minutes. A
  // live token must outlast a viewing sitting — like MEDIA_STREAM_TOKEN_TTL_SECS
  // for local media. It is rid-bound to one channel + sub and only yields a
  // stream while the upstream session is alive (idle-reaped 30s after the viewer
  // stops), so a long TTL is low-impact. Per-segment remux tokens stay on the
  // short TTL above (re-minted each segment, consumed within the live window).
  IPTV_LIVE_TOKEN_TTL_SECS: positiveInt('IPTV_LIVE_TOKEN_TTL_SECS', 43_200),
  // TTL for local-media playback stream tokens (routes/media.ts). Unlike IPTV's
  // short-lived per-request tokens, a movie token must outlast a whole sitting:
  // the same token is presented on every byte-range (direct play) or HLS
  // segment fetch for the duration of playback. Default 6h covers any film with
  // room for pauses; it scopes one user to one title, so a leak is low-impact.
  MEDIA_STREAM_TOKEN_TTL_SECS: positiveInt('MEDIA_STREAM_TOKEN_TTL_SECS', 21_600),
  IPTV_LIST_TIMEOUT_MS: positiveInt('IPTV_LIST_TIMEOUT_MS', 30_000),
  // Whole-transfer deadline + body cap for proxied HLS MANIFEST fetches
  // (rewriteHlsPlaylist). Manifests are small text files, so a hung or
  // drip-feeding upstream must not pin a request open indefinitely — unlike
  // the live/segment byte paths, which legitimately stream for hours and are
  // bounded by client-abort propagation instead.
  IPTV_MANIFEST_FETCH_TIMEOUT_MS: positiveInt('IPTV_MANIFEST_FETCH_TIMEOUT_MS', 10_000),
  IPTV_MANIFEST_MAX_BYTES: positiveInt('IPTV_MANIFEST_MAX_BYTES', 2 * 1024 * 1024),
  IPTV_SYNC_CRON: process.env.IPTV_SYNC_CRON ?? '0 */6 * * *',
  IPTV_RECOMMENDER_EXPORT_SECRET: opt('IPTV_RECOMMENDER_EXPORT_SECRET') ?? null,
  IPTV_REMUX_TMP_DIR: process.env.IPTV_REMUX_TMP_DIR ?? '/tmp/iptv-remux',
  // Live re-encode safety net (iptvRemux). A channel whose upstream video isn't
  // H.264 — e.g. an HEVC 24/7 feed, which Apple can't play from MPEG-TS HLS — is
  // re-encoded to H.264 so it plays everywhere. Only non-H.264 channels pay this
  // cost and at most IPTV_MAX_UPSTREAM_CONNECTIONS run at once, so the encode
  // load on the Plex-sharing box stays bounded. PRESET trades CPU for quality;
  // THREADS caps cores per encode; MAX_HEIGHT downscales tall sources so the
  // encode holds realtime on a weak CPU.
  IPTV_REENCODE_PRESET: process.env.IPTV_REENCODE_PRESET ?? 'veryfast',
  IPTV_REENCODE_THREADS: positiveInt('IPTV_REENCODE_THREADS', 2),
  IPTV_REENCODE_MAX_HEIGHT: positiveInt('IPTV_REENCODE_MAX_HEIGHT', 1080),
  // Reviewer-insurance gate per contract §13. Set IPTV_DISABLED=1 (or
  // 'true') to build an instance with no IPTV surface — the /api/iptv
  // routes 404 and the IPTV sync cron never registers. The Apple-side
  // equivalent is a Swift Active Compilation Condition (NOT this env);
  // App Review judges the binary's capability, not its runtime config.
  // Server-side default: enabled. Flip to disabled per deploy if the
  // household never uses IPTV or as a fallback insurance build for the
  // App Review submission.
  IPTV_DISABLED: process.env.IPTV_DISABLED === '1' || process.env.IPTV_DISABLED === 'true',
  // DVR (M6). Off by default; when enabled, recordings are written under DVR_DIR
  // and the scheduler ticks the recorder engine.
  DVR_ENABLED: process.env.DVR_ENABLED === '1' || process.env.DVR_ENABLED === 'true',
  DVR_DIR: process.env.DVR_DIR ?? './data/recordings',

  // §15 Telemetry. EEX_TELEMETRY_DSN is the Sentry-compatible DSN for the
  // self-hoster's Glitchtip project. Distributed to clients at boot via
  // GET /api/telemetry/config so crash reports land in the right project.
  EEX_TELEMETRY_DSN: telemetryDsn,

  // Semantic version or git SHA injected at image build time by the
  // container build (docker build --build-arg EEX_RELEASE=$(git describe)).
  // Surfaced in /api/telemetry/config so Glitchtip can group crashes by release.
  EEX_RELEASE: opt('EEX_RELEASE') ?? 'dev',

  // Per-session rate-limit budgets for the *arr / SAB proxies (finding 4-0).
  // Each add/upgrade/search POST triggers a real upstream indexer release
  // search + disk I/O, so an authenticated member (or a leaked session) could
  // loop them to burn the indexer/usenet budget and flood the grab log.
  // Defaults are generous for normal household use but cut off a hammering
  // loop: 12-token burst, refilling 12 tokens per 60s window. Tighten via env
  // per deploy. capacity == burst; refill == sustained per intervalMs.
  arrMutateRateCapacity: positiveInt('ARR_MUTATE_RATE_CAPACITY', 12),
  arrMutateRateRefill: positiveInt('ARR_MUTATE_RATE_REFILL', 12),
  arrMutateRateIntervalMs: positiveInt('ARR_MUTATE_RATE_INTERVAL_MS', 60_000),
} as const
