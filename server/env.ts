// Backend env loader. Reads .env.local at boot, validates the required
// keys, and exposes a strongly-typed `env` object the rest of the
// server consumes.
//
// Required:
//   PLEX_CLIENT_ID    — stable UUID identifying this app to plex.tv.
//                       Generate once with `crypto.randomUUID()` and keep
//                       it constant. Plex uses it to disambiguate
//                       sessions; rotating it logs everyone out.
//   SESSION_SECRET    — random 32+ byte string used to HMAC-sign session
//                       cookies. Rotating invalidates all sessions.
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
//                       Secure for cross-origin Netlify ↔ NAS use.
//   ALLOWED_ORIGINS   — comma-separated origins for CORS in production.
//                       Default '*' is fine in dev (Vite proxy makes it
//                       same-origin anyway).

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

const NAS_HOST = 'theemeraldexchange.local'
const GB = 1024 * 1024 * 1024

export const env = {
  plexClientId: required('PLEX_CLIENT_ID'),
  sessionSecret: required('SESSION_SECRET'),
  admins: csv('ADMINS'),
  plexServerId: process.env.PLEX_SERVER_ID ?? null,
  port: Number(process.env.PORT ?? 3001),
  isProd: process.env.NODE_ENV === 'production',
  allowedOrigins: csv('ALLOWED_ORIGINS'),

  // Backing services. URL defaults match the existing NAS deployment;
  // override per-environment via env vars.
  // Local Plex Media Server. Used to enumerate every account that has
  // ever accessed the server (via /accounts), which is the canonical
  // list of "people who actually watch on this server" and what
  // Tautulli's Top Users uses.
  plexServerUrl: process.env.PLEX_SERVER_URL ?? `http://${NAS_HOST}:32400`,

  sonarrUrl: process.env.SONARR_URL ?? `http://${NAS_HOST}:8989/tv`,
  sonarrApiKey: required('SONARR_API_KEY'),
  radarrUrl: process.env.RADARR_URL ?? `http://${NAS_HOST}:7878/movies`,
  radarrApiKey: required('RADARR_API_KEY'),
  sabUrl: process.env.SAB_URL ?? `http://${NAS_HOST}:8080`,
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
} as const
