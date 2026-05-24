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

import { config as dotenvConfig } from 'dotenv'

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

// PLEX_SERVER_ID is the machineIdentifier of the home Plex server.
// When set, only members of that server can sign in. When unset, the
// auth flow accepts any authenticated Plex user — that's the
// first-time-bootstrap mode so the operator can discover the server id
// via /api/me's discoveredServers payload. In production, leaving it
// blank silently turns the invitation-only app into "any Plex user can
// sign in," so we hard-fail unless the operator explicitly opts in
// via ALLOW_UNSCOPED_PLEX_LOGIN=1 (intended only for the brief
// first-deploy window).
const plexServerId = opt('PLEX_SERVER_ID') ?? null
const allowUnscopedPlexLogin = process.env.ALLOW_UNSCOPED_PLEX_LOGIN === '1'
if (isProd && !plexServerId && !allowUnscopedPlexLogin) {
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
const recommenderEventSecret = opt('RECOMMENDER_EVENT_SECRET') ?? null
if (useLocalRecommender && !recommenderEventSecret) {
  throw new Error(
    'Missing required env var when USE_LOCAL_RECOMMENDER=1: RECOMMENDER_EVENT_SECRET',
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
const rawSessionSecret = process.env.SESSION_SECRET ?? ''
if (isProd && rawSessionSecret) {
  // Placeholder check first so `changeme` (8 chars) is rejected for
  // BEING a placeholder, not just for being short — a clearer error
  // message and the only way the rule catches its target.
  if (SESSION_SECRET_PLACEHOLDERS.has(rawSessionSecret.toLowerCase())) {
    throw new Error(
      'SESSION_SECRET looks like a placeholder value. ' +
        'Generate a real secret with `openssl rand -base64 48` and ' +
        'redeploy — leaving the placeholder in prod is equivalent to ' +
        'publishing the AES key in the repo.',
    )
  }
  if (rawSessionSecret.length < SESSION_SECRET_MIN_LEN) {
    throw new Error(
      `SESSION_SECRET is too short for production (${rawSessionSecret.length} chars). ` +
        `Use at least ${SESSION_SECRET_MIN_LEN} bytes — generate one with ` +
        `\`openssl rand -base64 48\`. The value is fed through SHA-256 to ` +
        `derive the A256GCM key that encrypts session cookies; a weak ` +
        `secret puts every user's Plex auth token at risk.`,
    )
  }
}

export const env = {
  // .trim() is load-bearing for the plex.tv PIN flow: this value flows
  // into BOTH the X-Plex-Client-Identifier header (server → plex.tv)
  // AND the clientID URL param on the popup auth URL (browser →
  // plex.tv). plex.tv matches them as exact strings when reconciling
  // the authorized PIN; a stray trailing newline (common when copying
  // from a generator into .env) makes the header carry "\n" and the
  // URLSearchParams version carry "%0A", which plex.tv treats as two
  // different clients — the user authorizes one, the server polls the
  // other, and check returns {authToken: null} forever.
  plexClientId: required('PLEX_CLIENT_ID').trim(),
  sessionSecret: required('SESSION_SECRET'),
  admins: csv('ADMINS'),
  plexServerId,
  port: positiveInt('PORT', 3001),
  isProd,
  allowedOrigins,

  // Backing services. URL defaults match the existing NAS deployment;
  // override per-environment via env vars.
  // Local Plex Media Server. Used to enumerate every account that has
  // ever accessed the server (via /accounts), which is the canonical
  // list of "people who actually watch on this server" and what
  // Tautulli's Top Users uses.
  plexServerUrl: opt('PLEX_SERVER_URL') ?? `http://${NAS_HOST}:32400`,

  sonarrUrl: opt('SONARR_URL') ?? `http://${NAS_HOST}:8989/tv`,
  sonarrApiKey: required('SONARR_API_KEY'),
  radarrUrl: opt('RADARR_URL') ?? `http://${NAS_HOST}:7878/movies`,
  radarrApiKey: required('RADARR_API_KEY'),
  sabUrl: opt('SAB_URL') ?? `http://${NAS_HOST}:8080`,
  sabApiKey: required('SAB_API_KEY'),

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
    process.env.RECOMMENDER_URL ??
    (process.env.NODE_ENV === 'production'
      ? 'http://recommender:8000'
      : 'http://localhost:8000'),
  recommenderEventSecret,
} as const
