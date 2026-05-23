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

export const env = {
  plexClientId: required('PLEX_CLIENT_ID'),
  sessionSecret: required('SESSION_SECRET'),
  admins: csv('ADMINS'),
  plexServerId: opt('PLEX_SERVER_ID') ?? null,
  port: Number(opt('PORT') ?? 3001),
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

  // Minimum free space (bytes) on a Sonarr/Radarr root folder before
  // we'll allow an `add`. Below this, both admins and users get a 507
  // — the user explicitly wanted everyone (including admins) gated.
  minFreeBytes: Number(process.env.MIN_FREE_GB ?? 100) * GB,

  // Hard cap on movie release size at add-time. The dashboard intercepts
  // Radarr's auto-search, fetches available releases ourselves, and
  // grabs the highest-quality one whose size is at or under this cap.
  // Prevents accidental 50 GB 4K HDR rips when someone clicks Add.
  maxMovieBytes: Number(process.env.MAX_MOVIE_SIZE_GB ?? 10) * GB,
  maxMovieGb: Number(process.env.MAX_MOVIE_SIZE_GB ?? 10),

  // Hard cap on TV release size, expressed per episode. A release passes
  // when (size / episodeCount) ≤ this value. Single-episode caps at the
  // full per-episode value; a 10-episode season pack caps at 10× the
  // value. 5 GB/episode blocks 4K HDR while letting 1080p Bluray rips
  // through, matching the curated "Choose Me" profile we run.
  maxTvBytesPerEpisode: Number(process.env.MAX_TV_GB_PER_EPISODE ?? 5) * GB,
  maxTvGbPerEpisode: Number(process.env.MAX_TV_GB_PER_EPISODE ?? 5),

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

  // Optional TMDB v3 API key. When set, the detail modal fetches cast
  // for TV shows (via TVDB→TMDB find) and movies. Without it, the cast
  // section is hidden and the modal still shows everything Sonarr/Radarr
  // expose. Sign up at https://www.themoviedb.org/settings/api to get
  // a free key, then add TMDB_API_KEY=... to .env.local (dev) or
  // .env.production (prod) and redeploy.
  tmdbApiKey: process.env.TMDB_API_KEY ?? null,

  // Local recommender sidecar. When USE_LOCAL_RECOMMENDER=1, /api/suggestions
  // skips Claude entirely and asks the recommender service (Python +
  // sqlite-vec, running in the same compose stack) for ranked picks.
  // Defaults to the docker-compose service hostname in prod; falls back
  // to localhost in dev for hand-run testing.
  useLocalRecommender: process.env.USE_LOCAL_RECOMMENDER === '1',
  recommenderUrl: process.env.RECOMMENDER_URL ?? 'http://recommender:8000',
} as const
