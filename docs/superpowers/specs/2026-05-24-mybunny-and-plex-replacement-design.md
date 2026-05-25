# mybunny.tv Integration + Plex Replacement Roadmap

## Context

mybunny.tv is the user's IPTV service — a reseller exposing the standard Xtream Codes API (~41k live channels, ~10k VOD, ~31k series with FHD/HD/SD streams + 7-day EPG). The user finds mybunny.tv's own web interface unusable. They want to "utterly replace" it by consuming mybunny's Xtream credentials inside `theemeraldexchange` (their existing self-hosted media dashboard) and, beyond that, replace Plex's *media server* (not its auth) with a self-hosted alternative.

After three explicit overrides of the recommended decomposition, the user asked for a single plan document covering all six milestones. This file is that document.

**Honest scope.** Done seriously, this is a multi-year roadmap — comparable in scope to early Jellyfin. M1 is concrete and ready to plan-phase. M2 is detailed architecture. M3 is architecture with file-level intent. M4 is architecture with the hard parts called out as long poles. M5 and M6 are roadmap entries with key decisions captured so M1's API contract doesn't accidentally lock them out. Each milestone past M1 still warrants its own dedicated `gsd:new-milestone` cycle before execution.

## Scope decisions (audit trail)

Decisions made during this brainstorm, in order. All are locked unless explicitly revisited.

| # | Decision | Rationale |
|---|---|---|
| 1 | Scope = viewer, not reseller | User picked "Just the viewer." Billing stays on mybunny.tv. |
| 2 | Single shared upstream account | One admin Xtream credential serves all Plex-home members. Mirrors how Plex sharing works in this app. |
| 3 | Backend-proxied streams (forced) | Shared-account model is insecure without it — anyone in devtools could exfiltrate the upstream URL. Non-negotiable. |
| 4 | Web viewer + native tvOS + native iOS + external M3U handoff | User picked "Native tvOS app." iOS added during v1 features. M3U handoff added for the existing-IPTV-app fallback. |
| 5 | Full local catalog mirror, 6h refresh, no UI sync indicators | "Tacit and unseen but constant 6 hour windows." |
| 6 | Recommender extends to IPTV | Unified suggestions across Plex + IPTV. |
| 7 | v1 features include catchup TV, per-user favorites/history, multi-audio + subtitles, iOS sibling app | User picked all four. |
| 8 | Full Plex replacement in scope (M3–M5) | User picked it after pushback. Includes transcoder. |
| 9 | Plex stays as auth provider | The dashboard's Plex PIN OAuth is unchanged. Only the *media server* is replaced. |
| 10 | All 6 milestones specced in one document | User overrode the decomposition recommendation. M1 concrete, M2 detailed, M3–M6 architectural. |
| 11 | Transcode host = Apple Silicon → VideoToolbox primary, env-gated nvenc/vaapi/qsv/cpu fallbacks | Confirmed. |
| 12 | M3 *replaces* Plex media server long-term; Plex stays auth-only | Confirmed. |
| 13 | M6 music + photos = "eventually, not blocking" | M6 is a menu picked from when M5 ships. |
| 14 | mybunny concurrency = env-configurable (`IPTV_MAX_CONCURRENT_STREAMS`), default 4 | Adjusted once real upstream cap is known. |
| 15 | TestFlight (not App Store) for native apps | Faster iteration, no review cycle. |
| 16 | Media library mount = NAS path bind-mounted into docker-compose | Pattern reused from existing services. |

## Cross-cutting architecture (survives all 6 milestones)

**Single public ingress.** Hono at `/api/*` is the only surface any client talks to. Web SPA, tvOS, iOS, future Android TV / Roku / Chromecast — they all consume the same backend. No client ever speaks to plex.tv, Xtream upstreams, the recommender, or `media-core` directly.

**Auth.**
- Web continues using Plex PIN OAuth → JWE `eex.session` cookie. Unchanged.
- Native apps reuse the same Plex PIN flow via a new device-flow endpoint pair, receiving a long-lived **device token** (JWE, `aud='device'`, 1-year TTL) instead of a cookie. PIN flow on TV is the standard onboarding pattern (Netflix/Disney+/YouTube all use it).
- `server/middleware/auth.ts` extends to accept either the cookie session OR `Authorization: Bearer <deviceToken>`. The same `sessionGate.reconcileSession` path runs for both — revocation, role assignment, and membership gating stay unchanged.

**Catalog data lives in three SQLite databases on purpose.**

| DB | Owner | Lifecycle | Contents |
|---|---|---|---|
| `/data/exchange.db` (existing) | recommender (FastAPI) | nightly TMDB ingest | TMDB-keyed `titles`, `title_features`, `title_vec` |
| `./data/iptv.db` (new, M1) | Hono | 6h Xtream sync | mybunny catalog mirror + EPG + per-user favorites/history |
| `./data/media.db` (new, M3) | media-core (new Node service) | continuous file-watch scan | local library scan, watch state, capability metadata |

Reasoning: each DB has a different rebuild cost, a different source of truth, and a different process boundary. Forcing them into one DB couples services that need independent rebuilds.

**Recommender extension model.** No recipe forks. Widen the `kind` CHECK on `titles`/`title_features`/`title_vec` to include `'iptv_vod' | 'iptv_series'` (live channels stay out of suggestions). For mybunny items where Xtream exposes `tmdb_id`, *don't* duplicate the TMDB-keyed title — add an `iptv_title_link(iptv_kind, iptv_id, tmdb_kind, tmdb_id)` join in `iptv.db`. After `/api/suggestions` returns ranked `tmdb_id`s, Hono fans out joins against Sonarr/Radarr state, `iptv_title_link`, and (M3+) media-core to tag each result with `available_on: ['plex'] | ['iptv'] | ['local'] | combos`. SPA renders the badge.

**Conventions to reuse, not reinvent.**
- `fetchWithTimeout` from `server/services/upstream.ts` for every upstream call.
- `requireSafeOrigin` CSRF gate stays global; Bearer-token requests skip it naturally (no cookie attached).
- Per-resource route files (`server/routes/iptv.ts`, splitting into `server/routes/iptv/{catalog,epg,stream,favorites,history,admin}.ts` when it exceeds ~600 lines).
- React Query for client fetches (`src/lib/hooks/use*.ts`), `staleTime` tuned per source.
- `apiUrl()` for every fetch.
- Tab additions to `src/components/tabs/`, lazy-load registered in `App.tsx`, route enum extended in `src/lib/router.ts`, added to `TopNav`.

## Milestone 1 — mybunny viewer + backbone (CONCRETE)

### 1.1 Xtream client

**File:** `server/services/xtream.ts`

Single shared upstream account. Credentials in `.env.local`: `XTREAM_HOST`, `XTREAM_USERNAME`, `XTREAM_PASSWORD`. Never exposed to browser or native clients.

Endpoints called (all `GET https://${HOST}/player_api.php?username=…&password=…&action=<x>`):
- `get_account_info` — feeds `/api/iptv/health`; reports days-to-expire and max-connections.
- `get_live_categories`, `get_live_streams[&category_id=N]`
- `get_vod_categories`, `get_vod_streams[&category_id=N]`, `get_vod_info&vod_id=N`
- `get_series_categories`, `get_series[&category_id=N]`, `get_series_info&series_id=N`
- EPG: `xmltv.php?username=…&password=…` (full gzip dump, streamed parse); `get_short_epg&stream_id=N` for on-demand single-channel slice.

Every fetch wrapped in `fetchWithTimeout(url, init, IPTV_LIST_TIMEOUT_MS, 'xtream.<action>')`. New constant `IPTV_LIST_TIMEOUT_MS = 30_000` for bulk list calls (full live list can be ~10 MB JSON).

### 1.2 New SQLite (`./data/iptv.db`)

Hono-owned. New dep: `better-sqlite3` (sync API, single-process backend). Schema below; migrations live in `server/migrations/iptv/000N_*.sql`, applied at boot by a tiny migrator mirroring the recommender's pattern.

```sql
CREATE TABLE channels (
  stream_id INTEGER PRIMARY KEY, num INTEGER, name TEXT NOT NULL, stream_icon TEXT,
  epg_channel_id TEXT, category_id INTEGER, is_adult INTEGER NOT NULL DEFAULT 0,
  tv_archive INTEGER NOT NULL DEFAULT 0, tv_archive_duration INTEGER,
  added_ts TEXT, fetched_at TEXT NOT NULL
);
CREATE INDEX channels_category ON channels(category_id);

CREATE TABLE vod (
  stream_id INTEGER PRIMARY KEY, name TEXT NOT NULL, stream_icon TEXT, rating REAL,
  category_id INTEGER, container_extension TEXT, added_ts TEXT,
  tmdb_id INTEGER, year INTEGER, plot TEXT, director TEXT, cast_csv TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX vod_tmdb ON vod(tmdb_id);
CREATE INDEX vod_category ON vod(category_id);

CREATE TABLE series (
  series_id INTEGER PRIMARY KEY, name TEXT NOT NULL, cover TEXT, plot TEXT, rating REAL,
  category_id INTEGER, tmdb_id INTEGER, last_modified TEXT, fetched_at TEXT NOT NULL
);
CREATE INDEX series_tmdb ON series(tmdb_id);

CREATE TABLE series_episodes (
  episode_id TEXT PRIMARY KEY, series_id INTEGER NOT NULL REFERENCES series(series_id) ON DELETE CASCADE,
  season INTEGER NOT NULL, episode_num INTEGER NOT NULL, title TEXT, container_extension TEXT,
  added_ts TEXT, plot TEXT, duration_secs INTEGER
);
CREATE INDEX series_eps_by_series ON series_episodes(series_id, season, episode_num);

CREATE TABLE categories (
  category_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('live','vod','series')),
  name TEXT NOT NULL, parent_id INTEGER, PRIMARY KEY (kind, category_id)
);

CREATE TABLE epg_programs (
  channel_id TEXT NOT NULL, start_utc TEXT NOT NULL, stop_utc TEXT NOT NULL,
  title TEXT, description TEXT, PRIMARY KEY (channel_id, start_utc)
);
CREATE INDEX epg_window ON epg_programs(channel_id, start_utc, stop_utc);

CREATE TABLE iptv_favorites (
  sub TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('live','vod','series')),
  item_id TEXT NOT NULL, added_ts TEXT NOT NULL, PRIMARY KEY (sub, kind, item_id)
);

CREATE TABLE iptv_watch_history (
  sub TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('live','vod','series_episode')),
  item_id TEXT NOT NULL, position_secs INTEGER NOT NULL DEFAULT 0, duration_secs INTEGER,
  watched_at TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, kind, item_id)
);
CREATE INDEX iptv_hist_recent ON iptv_watch_history(sub, watched_at DESC);

CREATE TABLE iptv_title_link (
  iptv_kind TEXT NOT NULL CHECK (iptv_kind IN ('vod','series')),
  iptv_id INTEGER NOT NULL,
  tmdb_kind TEXT NOT NULL CHECK (tmdb_kind IN ('movie','tv')),
  tmdb_id INTEGER NOT NULL,
  PRIMARY KEY (iptv_kind, iptv_id)
);

CREATE TABLE iptv_sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts TEXT NOT NULL);
```

DB helper: `server/services/iptvDb.ts` exposing prepared statements.

### 1.3 Stream proxy

Two flavors because live MPEG-TS and VOD HLS/MP4 behave differently. Every playable URL is HMAC-signed (token-in-URL), not cookie-gated — because `<video src>` and AVPlayer don't reliably attach cookies.

**Live MPEG-TS proxy:**
```
POST /api/iptv/stream/live/:streamId/grant         → { url: '/api/iptv/stream/live/:streamId.ts?t=<token>', delivery: 'mpegts' }
GET  /api/iptv/stream/live/:streamId.ts?t=<token>  → 200 video/mp2t (streamed)
```
Token = HMAC(SESSION_SECRET, `live|streamId|sub|exp`), 5-min TTL. Upstream `https://${HOST}/live/${USER}/${PASS}/${streamId}.ts` streamed pass-through; **do NOT use `fetchWithTimeout`** here (it buffers) — raw `fetch` with a separate `AbortController` tied to the request lifecycle. Response: `c.body(stream)` with `Content-Type: video/mp2t`.

**VOD / series-episode proxy:**
```
POST /api/iptv/stream/vod/:streamId/grant          → { url, delivery: 'progressive'|'hls', mime, tracks }
GET  /api/iptv/stream/vod/:streamId.:ext?t=<token> → 200/206 (Range honored)
GET  /api/iptv/stream/segment?u=<signed>           → HLS sub-segment proxy
```
Forward `Range` header upstream; pass through 206. For `.m3u8`, parse playlist and rewrite segment URIs to `/api/iptv/stream/segment?u=<signed-upstream-segment-url>`.

**Catchup TV:**
```
POST /api/iptv/stream/catchup/:streamId/grant?startUtc=&durationMin=
GET  /api/iptv/stream/catchup/:streamId/:startUtc/:durationMin.ts?t=<token>
```
Upstream `https://${HOST}/streaming/timeshift.php?…&stream=&start=YYYY-MM-DD:HH-MM&duration=<min>`. Gated on `channels.tv_archive=1` AND `start_utc >= now() - tv_archive_duration days`.

**Concurrency:** in-memory session count per `sub` AND globally; reject grant with HTTP 429 + `{reason:'iptv_concurrency_limit', limit, current}` when global count would exceed `IPTV_MAX_CONCURRENT_STREAMS` (env, default 4). Sessions auto-expire after 30s without heartbeat.

### 1.4 EPG storage & query

Sync downloads `xmltv.php` (gzip), streams the parse (use a SAX-style parser — full XMLTV can be 50+ MB), upserts into `epg_programs`. Rolling window: delete rows where `stop_utc < now - 1 day`, don't store beyond `now + 7 days`. Channel-id mapping: `channels.epg_channel_id` populated from `epg_channel_id` field in `get_live_streams`.

Query endpoints:
```
GET /api/iptv/epg/now?channelIds=1,2,3            → [{channelId, current:{...}, next:{...}}]
GET /api/iptv/epg/channel/:channelId?from=&to=
GET /api/iptv/epg/grid?from=&to=&categoryId=N
```

### 1.5 6-hour sync worker

In-process inside Hono via `node-cron` (new dep), registered at boot in `server/index.ts`. File: `server/services/iptvSync.ts` exposing:
- `bootstrapOnce()` — runs on first boot if `iptv_sync_state.live_last` missing (full pull).
- `runScheduled()` — registered at cron `0 */6 * * *` (00:00, 06:00, 12:00, 18:00 local).

In-process mutex prevents double-run when admin manually triggers during a scheduled run. XMLTV parser uses `setImmediate` chunking to yield event loop.

Admin:
```
POST /api/iptv/admin/sync           # requireAdmin → jobId
GET  /api/iptv/admin/sync/:jobId    # requireAdmin → status
```

### 1.6 Full backend route map

All under `requireAuth`. Admin endpoints additionally require admin role.

```
GET    /api/iptv/health
GET    /api/iptv/categories?kind=live|vod|series
GET    /api/iptv/live?categoryId=&q=&limit=&offset=
GET    /api/iptv/vod?categoryId=&q=&limit=&offset=
GET    /api/iptv/vod/:streamId
GET    /api/iptv/series?categoryId=&q=&limit=&offset=
GET    /api/iptv/series/:seriesId
GET    /api/iptv/epg/now?channelIds=
GET    /api/iptv/epg/channel/:channelId?from=&to=
GET    /api/iptv/epg/grid?from=&to=&categoryId=
POST   /api/iptv/stream/live/:streamId/grant
GET    /api/iptv/stream/live/:streamId.ts?t=
POST   /api/iptv/stream/vod/:streamId/grant
GET    /api/iptv/stream/vod/:streamId.:ext?t=
POST   /api/iptv/stream/series/:episodeId/grant
GET    /api/iptv/stream/series/:episodeId.:ext?t=
POST   /api/iptv/stream/catchup/:streamId/grant?startUtc=&durationMin=
GET    /api/iptv/stream/catchup/:streamId/:startUtc/:durationMin.ts?t=
GET    /api/iptv/stream/segment?u=
GET    /api/iptv/favorites
POST   /api/iptv/favorites
DELETE /api/iptv/favorites/:kind/:itemId
GET    /api/iptv/history?limit=
POST   /api/iptv/history
GET    /api/iptv/export/recommender          # secret-gated, NOT requireAuth — recommender worker pulls
GET    /api/iptv/playlist.m3u                # requireAuth (cookie or Bearer) → signed user-scoped M3U for VLC/iPlayTV/TiviMate
POST   /api/iptv/admin/sync
GET    /api/iptv/admin/sync/:id
```

### 1.7 Frontend

**API client:** `src/lib/api/iptv.ts` — mirrors shape of `src/lib/api/sonarr.ts`.

**Hooks:** `useIptvCategories`, `useIptvLive`, `useIptvVod`, `useIptvSeries`, `useIptvEpgNow`, `useIptvFavorites`, `useIptvHistory` in `src/lib/hooks/`. Mutations follow existing optimistic-update + invalidate pattern.

**New lazy-loaded tabs:**
- `src/components/tabs/LiveTab.tsx` — channel grid with EPG strip (now/next), category filter.
- `src/components/tabs/VodTab.tsx` — poster grid, search, category filter.
- `src/components/tabs/IptvSeriesTab.tsx` — poster grid for IPTV series. (Avoid name collision with TvTab/Sonarr.)

Register in `App.tsx`'s `TABS` map, the `ROUTES` enum in `src/lib/router.ts`, and `TopNav`.

**Player component:** `src/components/player/IptvPlayer.tsx`.
- `hls.js` for HLS (~80 KB gzip).
- `mpegts.js` for raw MPEG-TS live (~80 KB gzip).
- Plain `<video>` for direct mp4.
- Branch on `video.canPlayType('application/vnd.apple.mpegurl')` and use native Safari HLS when available (saves battery on Macs/iOS).
- Engine selected from grant response's `delivery` field.
- Track selection (audio/subs) via a `<select>` per track type in player overlay; hls.js exposes `audioTracks`/`subtitleTracks`, mpegts.js exposes PMT-declared tracks via `onMetadata`.
- Position reported to `/api/iptv/history` on `timeupdate` (debounced 5s).

### 1.8 Recommender extension (M1 phase 8)

**Migration `recommender/migrations/0004_iptv_kinds.sql`:**
```sql
-- Widen kind CHECK on titles + title_features + title_vec.
-- SQLite requires table rebuild for CHECK alter.
ALTER TABLE titles RENAME TO titles_old;
CREATE TABLE titles (
  -- existing columns,
  kind TEXT NOT NULL CHECK (kind IN ('movie','tv','iptv_vod','iptv_series'))
);
INSERT INTO titles SELECT * FROM titles_old;
DROP TABLE titles_old;
-- Repeat for title_features, title_genres, title_vec.
```

**New worker:** `recommender/workers/iptv_ingest.py` — pulls from `GET /api/iptv/export/recommender` (secret-gated), upserts mybunny VOD/series into `titles` under their new kinds, runs through existing `featurize.py` for embeddings (text source: title + plot + cast + director).

**Unified suggestions:** after recommender returns ranked items, Hono joins to `iptv_title_link` (in iptv.db) and Sonarr/Radarr state, tags each result with `available_on: string[]`. SPA renders badges.

### 1.9 M1 execution phases

| Phase | Scope |
|---|---|
| 1 | DB + service skeleton: schema, migrations, `iptvDb.ts`, env vars, Xtream client w/ `get_account_info` smoke test |
| 2 | Catalog sync: bootstrap full pull, 6h cron, EPG XMLTV streamed parse, admin endpoints |
| 3 | Catalog read APIs + tabs: categories, live grid, VOD grid, IPTV series. No player; cards open detail modals |
| 4 | Stream proxy + grants: live MPEG-TS pass-through for web/`<video>`/mpegts.js clients, VOD direct file, HLS playlist rewrite. Token issuance, concurrency limiter |
| 4b | Remux-to-HLS path for AVPlayer clients (`?client=avplayer` on grant). ffmpeg-per-session `-c copy -f hls`, sliding 8-segment window, killed on disconnect. Ships in M1 to unblock M2 without rework |
| 5 | Player: IptvPlayer component, hls.js / mpegts.js wiring, track selection, position reporting → history |
| 6 | Favorites + history: per-user dots on cards, resume playback from history |
| 7 | Catchup TV: EPG grid → click past program → catchup grant + player |
| 7b | External M3U handoff: `GET /api/iptv/playlist.m3u?t=<deviceToken-issued>` returns a signed user-scoped M3U pointing every channel at this server's stream-grant URLs (not raw mybunny). Lets you load the playlist in VLC / iPlayTV / TiviMate on any device |
| 8 | Recommender integration: migration, link table, unified suggestions tagging |

## Milestone 2 — tvOS + iOS native apps for mybunny

### 2.1 Project layout

New sibling repo `theemeraldexchange-apple/` — keep Xcode artifacts (DerivedData, build settings, schemes) out of the web repo.

```
theemeraldexchange-apple/
├── Package.swift                          # SPM workspace
├── EmeraldKit/                            # shared Swift package (the SDK)
│   ├── Sources/EmeraldKit/
│   │   ├── API/                           # URLSession client, error types
│   │   ├── Models/                        # Codable mirrors of Hono response types
│   │   ├── Auth/                          # Device-token flow, Keychain storage
│   │   ├── Player/                        # AVPlayer wrapper, grant resolver
│   │   └── State/                         # Observable stores (Favorites, History)
│   └── Tests/EmeraldKitTests/
├── EmeraldTV/                             # tvOS target
│   └── Sources/                           # FocusableGrid, Now Playing, Guide
├── EmeraldiOS/                            # iOS target
│   └── Sources/                           # Compact + regular size class views
└── EmeraldApp.xcodeproj
```

EmeraldKit is platform-agnostic SwiftUI + Combine/Observation. Per-platform targets are thin (navigation chrome, focus engine, player overlay). Aim 80%+ shared. Don't share the navigation root — tvOS and iOS navigation idioms diverge enough that the abstraction tax exceeds dup cost.

**Library choices.**
- HTTP: URLSession + async/await. No Alamofire.
- JSON: hand-written `EmeraldClient` (~25 endpoints — not worth wiring OpenAPI codegen).
- Player: AVPlayer everywhere it works (see §2.3 for the MPEG-TS problem).
- Persistence: SwiftData for local history/favorites cache + image cache. Server is source of truth.
- Image loading: AsyncImage for v1; consider Nuke if perf bites.

### 2.2 Auth flow on tvOS / iOS

Device flow built on top of the existing Plex PIN flow.

```
App launch (no stored device token):
  1. POST /api/auth/device/start                 → {pinId, code:"ABCD", verificationUrl:"plex.tv/link"}
  2. Show: "Visit plex.tv/link, enter ABCD"
  3. POST /api/auth/device/poll {pinId} every 2s
  4. Server runs same Plex /pins/:id check + membership gate
  5. On authorized: issue deviceToken (JWE, aud='device', 1y TTL)
  6. Store in Keychain (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
  7. Every subsequent request: Authorization: Bearer <deviceToken>
```

**Server-side changes:**
- `server/routes/auth.ts` adds `POST /api/auth/device/start` and `POST /api/auth/device/poll`.
- `server/session.ts` forks: `setSessionCookie` stays; new `mintDeviceToken({sub, role}) → string` using same EncryptJWT with `aud:'device'`.
- `server/middleware/auth.ts` extends `requireAuth` to try `Authorization: Bearer` first, then cookie. Both reconcile through `sessionGate.reconcileSession`.
- Revocation: every device-token request runs the same reconciliation → 401 with `reason:'access_revoked'` returns app to PIN screen.

### 2.3 The MPEG-TS-on-AVPlayer problem

AVPlayer cannot play raw MPEG-TS over HTTP. Mybunny live streams are MPEG-TS. Three paths considered:

| Path | Choice |
|---|---|
| Transcode-to-HLS at the proxy (`ffmpeg -c copy -f hls`) | **CHOSEN.** ~3% CPU per session. Same infra M4 inherits. Works on Roku/Cast/Android-TV later without per-platform player choices. |
| VLCKit on Apple platforms | Rejected. 50 MB binary, power-hungry on tvOS. |
| Third-party MPEG-TS player (ffmpeg-kit, mpegts.swift) | Rejected. Less battle-tested. |

Implemented as part of M1 phase 4-5 once we know we're heading toward M2 — saves rework. Grant endpoint accepts `?client=avplayer` and returns an HLS playlist URL pointing at a remux session instead of `.ts`. Session has a tmpdir; ffmpeg sliding window of ~8 4-sec segments; killed on disconnect.

Capacity: 5-user household × 1 stream each = 5 ffmpeg processes ≈ 15% CPU on Apple Silicon. Comfortable.

### 2.4 M2 execution phases

| Phase | Scope |
|---|---|
| 1 | Repo + SPM workspace + EmeraldKit skeleton; empty tvOS+iOS targets; CI build green |
| 2 | Device-token auth (Hono routes + Apple PIN screen + Keychain storage) |
| 3 | Catalog browsing (categories, live grid with EPG strip, VOD grid, IPTV series) — read-only |
| 4 | Player — VOD/HLS path first (AVPlayer happy path) |
| 5 | Live remux path (Hono ffmpeg-per-session; tvOS/iOS player consumes HLS) |
| 6 | Favorites + history + resume (SwiftData cache + server sync) |
| 7 | Catchup TV in EPG grid |
| 8 | TestFlight pipeline (Xcode Cloud or Fastlane; internal testers Day 1, external after first stable) |

## Milestone 3 — Media server core (no transcoder)

### 3.1 Process model

New sibling service `media-core/` in docker-compose. Node + TypeScript (matches Hono — shares `tsconfig`, testing stack, `fetchWithTimeout`, sanitizers).

Why a separate process and not inside Hono:
- Library scanner holds file watchers continuously; coupling slows Hono boots and crashes blast-radius into the dashboard.
- Heavy file I/O benefits from its own event loop.
- Independent failure domain — Hono stays up if scanner panics.

API: `media-core` exposes HTTP on `127.0.0.1:8002`. Hono proxies `/api/media/*` (same pattern as `/api/sonarr`), applying `requireAuth`. media-core never speaks to the SPA directly.

### 3.2 Library scanner

- **Source:** NAS path mounted read-only, configured via `MEDIA_LIBRARY_PATHS=/media/movies:/media/tv` (multi-root).
- **Strategy:** initial walk via `fast-glob`, incremental via `chokidar` for file watch with rsync-aware debouncing.
- **Metadata match:** filename → TMDB. Reuse parsing rules from `recommender/workers/tmdb_client.py` (port to TS). TV via `parse-torrent-title` → show + season + episode → TMDB.
- **Probe:** ffprobe at scan time captures duration, codec, container, audio/subtitle tracks. Cached on the file row so direct-play decisions don't reprobe.

### 3.3 Schema (`./data/media.db`)

```sql
CREATE TABLE media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL, mtime TEXT NOT NULL,
  container TEXT, duration_secs INTEGER,
  video_codec TEXT, video_height INTEGER, video_profile TEXT, hdr_format TEXT,
  audio_tracks_json TEXT NOT NULL, subtitle_tracks_json TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);
CREATE TABLE movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tmdb_id INTEGER UNIQUE, imdb_id TEXT,
  title TEXT NOT NULL, year INTEGER, added_at TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE
);
CREATE TABLE shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tmdb_id INTEGER UNIQUE, tvdb_id INTEGER,
  title TEXT NOT NULL, year INTEGER, added_at TEXT NOT NULL
);
CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season INTEGER NOT NULL, episode INTEGER NOT NULL,
  title TEXT, air_date TEXT,
  file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  UNIQUE(show_id, season, episode)
);
CREATE TABLE media_watch_state (
  sub TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('movie','episode')),
  media_id INTEGER NOT NULL,
  position_secs INTEGER NOT NULL DEFAULT 0, duration_secs INTEGER,
  watched_at TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, media_kind, media_id)
);
CREATE TABLE scan_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts TEXT NOT NULL);
```

### 3.4 Multi-user

Reuse Plex `sub` everywhere (already canonical). Watch state per-user; library content shared. Future per-user library filters (kids' content gating) — schema slot reserved (`media_filters(sub, ...)`) but not built in M3.

### 3.5 Direct-play API

```
GET    /api/media/movies?q=&genre=&limit=&offset=
GET    /api/media/movies/:id
GET    /api/media/shows?q=&limit=&offset=
GET    /api/media/shows/:id
GET    /api/media/shows/:id/episodes
GET    /api/media/episodes/:id
POST   /api/media/play/:kind/:id/grant
GET    /api/media/stream/:kind/:id?t=
GET    /api/media/watch
POST   /api/media/watch
```

Grant body advertises client capabilities (containers, codecs, profiles/levels, maxBitrate, HDR, language prefs). Server response includes `directPlay: boolean`, the file's track manifest, and (in M3-only deployments) `transcoderRequired: true` with HTTP 503 if the file needs transcode and M4 isn't online.

### 3.6 M3 execution phases

| Phase | Scope |
|---|---|
| 1 | media-core skeleton: compose service, DB migrations, health |
| 2 | Scanner: glob + chokidar + ffprobe; populate `media_files`, `movies`, `shows`, `episodes` |
| 3 | TMDB match: resolve filenames → tmdb_id; backfill metadata |
| 4 | Library read APIs with pagination, search, detail |
| 5 | Direct-play grant + range-proxy through Hono |
| 6 | Watch state, per-user resume |
| 7 | SPA integration: source toggle (Plex/Local/mybunny) inside existing tabs OR a new MediaTab — UX decision in plan-phase |
| 8 | Recommender extension: add `local_library` rows so suggestions tag `available_on: ['local']` |

## Milestone 4 — Transcoder (the long pole)

### 4.1 Process model

ffmpeg-per-session (not a worker pool). Pooling would require checkpointing partial transcodes — reinventing ffmpeg's own session model.

- media-core spawns `child_process.spawn('ffmpeg', [...])`.
- Tracks PID + tmpdir per session.
- 30s heartbeat from player; 30s no-heartbeat → SIGTERM → SIGKILL after 5s.
- Orphan cleanup: PID file sweep + segment dir TTL.

### 4.2 HLS output

Per-session tmpdir `/tmp/transcoder/<sessionId>/`, 4-sec segments, sliding window of ~8 segments retained.

```
ffmpeg -hide_banner -loglevel warning \
  -ss <startSecs> -i <inputFile> \
  -map 0:v:0 -map 0:a:<audioIdx> \
  -c:v <encoder> -preset <preset> -b:v <bitrate> -maxrate <maxrate> -bufsize <bufsize> \
  -vf 'scale=...' \
  -c:a aac -b:a 192k \
  -f hls -hls_time 4 -hls_list_size 8 -hls_flags delete_segments+append_list+omit_endlist \
  -hls_segment_filename '<dir>/seg_%05d.ts' \
  '<dir>/index.m3u8'
```

Seek (`POST .../session/:id/seek?to=<secs>`): kill ffmpeg, restart with new `-ss`, return new playlist URL. Player switches source. ~0.5–1s gap on seek is acceptable.

### 4.3 Capability matrices (client-side, shipped in EmeraldKit + web)

```
tvOS 17+ (Apple TV 4K, A12+):
  containers: mp4, mov, m4v, mkv (via remux)
  video: h264 (high@5.1), hevc (main10@5.1), prores
  audio: aac, eac3, ac3, dts/trueHD (pass-through to AVR)
  HDR: HDR10, Dolby Vision (FEL on AppleTV 4K)
  max bitrate: 40 Mbps direct, 100 Mbps hardware

iOS 17+ (iPhone 12+):
  containers: mp4, mov, m4v
  video: h264 (high@5.1), hevc (main10@5.1)
  audio: aac, eac3, ac3
  HDR: HDR10, Dolby Vision
  max bitrate: 25 Mbps (cellular gates lower)

Web (Chrome/Safari/Firefox):
  containers: mp4 native, m3u8 hls.js/native
  video: h264 universal, hevc Safari-only
  audio: aac universal, eac3 spotty
  HDR: treat as SDR target
```

Server picks the smallest re-encode that satisfies caps. Audio that can pass through → `-c:a copy`. Subs that AVPlayer can't render (PGS/VOB) → burn in via `-vf 'subtitles=…:si=N'`. Text subs → extract as WebVTT into HLS as `EXT-X-MEDIA TYPE=SUBTITLES`.

### 4.4 VideoToolbox config (Apple Silicon)

```
-c:v h264_videotoolbox -profile:v high -level 5.1 -b:v <bitrate> -realtime 1
-c:v hevc_videotoolbox -profile:v main -tag:v hvc1 -b:v <bitrate>
```

VideoToolbox quality vs x264/x265 is lower for the same bitrate; for streaming-to-screen (not archival), fine. Concurrency: M1/M2 Macs ~6-8 simultaneous 1080p streams; M3 Pro/Max ~12-16. Track `processCount` vs `MAX_CONCURRENT_TRANSCODES` (env, default 4); reject grant with `503 transcoder_busy` past cap.

CPU fallback (`-c:v libx264`) when VideoToolbox refuses, HW cap hit, or `TRANSCODER_FORCE_CPU=1`. CPU is 3–5× more expensive; separate cap `MAX_CONCURRENT_CPU_TRANSCODES` (default 1).

Non-Apple-Silicon path (operator's call): same ffmpeg invocations swap encoder. Encoder choice = env `TRANSCODER_HW_ENCODER=videotoolbox|nvenc|vaapi|qsv|cpu`. Detection at boot via `ffmpeg -encoders` parse.

### 4.5 M4 execution phases

| Phase | Scope |
|---|---|
| 1 | Session manager: lifecycle (start/heartbeat/seek/stop), tmpdir mgmt, PID tracking |
| 2 | HLS pipeline: single-bitrate, h264_videotoolbox, audio pass-through where possible |
| 3 | Capability matching: direct-play vs transcode decision in grant endpoint |
| 4 | Audio + subtitle track switching mid-session |
| 5 | CPU fallback + alternate hardware encoders behind env flag |
| 6 | Concurrency limits + 503 backpressure + UX for "transcoder busy, try later" |
| 7 | Telemetry: per-session CPU/wall logs, admin export endpoint |

## Milestone 5 — Native clients for media server

### 5.1 EmeraldKit extension

`MediaService` alongside `IptvService`. Same URLSession plumbing, new models for movies/shows/episodes. New SwiftUI views:
- `MediaHomeView` — continue-watching row, recently added, suggestions (uses unified `/api/suggestions`).
- `MoviesLibraryView` — poster grid, filters.
- `ShowsLibraryView` + `ShowDetailView` + `SeasonView`.

Player: same `EmeraldPlayer` view handles both direct-play and transcoded HLS — the view doesn't need to know which it is. Grant response drives URL + delivery type.

Source picker (top-level): Plex via mybunny / Local / IPTV. Collapses to a unified home; visible in detail/search.

### 5.2 Other-platform paths (scoped but not shipped in M5)

| Platform | Stack | Effort |
|---|---|---|
| Android TV | Kotlin + Jetpack Compose for TV + ExoPlayer (handles MPEG-TS natively) | 4–6 weeks |
| Roku | BrightScript + SceneGraph, built-in Video node | ~6 weeks |
| Chromecast / Cast | Cast SDK; receiver app at `cast.theemeraldexchange.com`; senders integrate in web/iOS/Android | ~2 weeks receiver + 1 week/sender |

Spec but defer. Add to M5 only if a household member demands it; otherwise it's M5.5+.

### 5.3 M5 execution phases

| Phase | Scope |
|---|---|
| 1 | EmeraldKit MediaService + models |
| 2 | Continue-watching home + library browse (Movies, Shows) |
| 3 | Player integration with transcoder grants |
| 4 | Unified suggestions on home |
| 5 | *(Optional)* Cast receiver + web sender if Cast is in M5 scope |

## Milestone 6 — Plex-Pass equivalent (high level)

A portfolio, not a single executable plan. Pick from this menu after M5 ships based on what's actually missing.

- **DVR for IPTV-to-disk.** Tables `recordings(id, channel_id, start_utc, end_utc, status, file_path, ...)`. Reuses M2/M4 ffmpeg-remux infra (`-c copy -f mp4 -t <duration>`) to write to NAS at scheduled times. UI: EPG grid → record button; series-record via program-title regex against `epg_programs`. Conflict detection on overlapping schedules vs `IPTV_MAX_CONCURRENT_STREAMS`. Reuses existing `MIN_FREE_GB` storage-gate pattern.
- **Intro/credits detection.** PySceneDetect (cut detection) + chromaprint (audio fingerprinting across episodes of the same show). Worker runs after scan, populates `media_intro_markers(episode_id, intro_start, intro_end, credits_start)`. Player consumes via grant response; skip button. New Python worker next to recommender (ecosystem fit).
- **Music.** New library kind in media-core (`tracks`, `albums`, `artists`). Scanner extends; metadata via MusicBrainz. Player extends. ~3 weeks. *Eventually, not blocking.*
- **Photos.** EXIF scanner, thumbnailing via `sharp`. Standalone tab. *Eventually, not blocking.*
- **Sharing / invitations.** Plex membership already provides implicit shares. Extend with `shares(sub, library_id, expires_at, ...)` for per-library visibility.

## Risks & dependencies

**Sequencing constraints (hard):**
- M2 cannot ship without M1's API surface. M2 repo can scaffold in parallel with M1 phase 1, but functional work blocks on M1.
- M5 cannot ship without M3 (library) AND M4 (transcoder for non-direct-play files).
- M4 is the long pole. ffmpeg pipeline, capability matrix, hardware-encoder edge cases, and concurrency tuning are individually hard problems. **Plan for 2× initial estimates.**

**Operational risks:**
- **NAS-as-transcoder is borderline.** Apple Silicon helps, but 5 concurrent 4K HDR transcodes will saturate any Mac Mini. Real-world capacity testing in M4 phase 6 is non-optional.
- **mybunny upstream MPEG-TS hiccups.** Real-world IPTV has discontinuities (segment drops, codec changes mid-stream). ffmpeg remux handles most (`-fflags +discardcorrupt+genpts` helps); ~5% of channels expected to need special-case handling.
- **EPG XMLTV size.** Full XMLTV from a 5000-channel panel = 100+ MB. Streaming parse is mandatory.
- **Three SQLite DBs.** "What's been watched recently" requires three queries. Acceptable; revisit consolidation only if painful.
- **Shared upstream IPTV account = shared concurrency cap.** Tracked in iptv.db; 5th simultaneous user gets a friendly 429. Document in UI.

**Vendor lock-in:**
- **Apple** for M2/M5 native clients. Mitigation: API is platform-agnostic; Android TV/Roku/Cast paths sketched.
- **VideoToolbox** for M4. Mitigation: encoder choice is env-gated; nvenc/vaapi/qsv/cpu fallbacks defined. Test CPU path early so it's not theoretical.
- **TestFlight.** Fine for household app. App Store path stays open.
- **mybunny.tv / Xtream Codes.** If mybunny changes panel software or shuts down, IPTV stack goes dark. Xtream Codes is a de-facto standard — moving providers is config, not rewrite. Expect at least one provider migration over years.

## Critical files

**To modify in M1:**
- `server/app.ts` — mount new `/api/iptv` router
- `server/middleware/auth.ts` — extend to accept Bearer device tokens (M2 prereq)
- `server/session.ts` — fork into device-token variant (M2 prereq)
- `recommender/migrations/0004_iptv_kinds.sql` — widen kind CHECK
- `recommender/workers/featurize.py` — featurize iptv kinds via existing path
- `src/App.tsx` — register new tabs
- `src/lib/router.ts` — extend Route enum
- `src/components/TopNav.tsx` (or equivalent) — add tab buttons

**To create in M1:**
- `server/services/xtream.ts`, `server/services/iptvDb.ts`, `server/services/iptvSync.ts`
- `server/routes/iptv.ts` (or sub-folder)
- `server/routes/auth.ts` — device-flow endpoints (M2 prereq, but ship in M1 to validate the contract)
- `server/migrations/iptv/000N_*.sql`
- `src/lib/api/iptv.ts`
- `src/lib/hooks/useIptv*.ts`
- `src/components/tabs/LiveTab.tsx`, `VodTab.tsx`, `IptvSeriesTab.tsx`
- `src/components/player/IptvPlayer.tsx`
- `recommender/workers/iptv_ingest.py`

**Reference (read but don't modify):**
- `server/routes/sonarr.ts` — canonical route-file shape
- `server/services/upstream.ts` — `fetchWithTimeout` pattern
- `server/plex.ts` — Plex PIN flow (reused, not duplicated)
- `recommender/migrations/0001_initial.sql` — schema reference
- `recommender/workers/tmdb_client.py` — parsing rules to port to TS for M3

## Verification (how to test end-to-end)

**M1 verification gates (per phase):**
1. Schema migration applies clean on fresh + existing DB. `npm run test` passes on iptvDb helper.
2. `bootstrapOnce()` populates iptv.db from a real mybunny credential set. EPG row count > 0. Manual: hit `/api/iptv/admin/sync` and watch the job.
3. `/api/iptv/live` returns paginated channels matching mybunny's panel count. SPA tabs render the grid in < 200ms (data is local).
4. `POST /api/iptv/stream/live/:streamId/grant` issues a token; `GET …/live/:streamId.ts?t=…` streams pass-through. Verify Range works on VOD. HLS playlist rewrite produces clickable URIs.
5. Web player plays a live channel in Chrome (mpegts.js path), VOD HLS in Chrome (hls.js), VOD HLS in Safari (native). Audio/subtitle track switcher visible.
6. Favorite a channel, refresh, favorite persists per `sub`. Watch part of a VOD, return to tab, "resume from 4:32" appears.
7. EPG grid renders past programs; clicking one within `tv_archive_duration` produces a catchup grant and plays.
8. `/api/suggestions` returns at least one item tagged `available_on: ['iptv']` for a TMDB-matched VOD.

**M2 verification gates:**
1. SPM workspace builds clean on macOS in CI.
2. PIN flow on tvOS Simulator → device token in Keychain → catalog browse works.
3. AVPlayer plays VOD HLS direct.
4. Live channel grant w/ `client=avplayer` returns HLS URL pointing at a remux session; AVPlayer plays it.
5. TestFlight build distributed to internal tester (you) installs and runs end-to-end.

**M3 verification gates:**
1. media-core scans a 100-file fixture library in < 5s.
2. TMDB match resolves ≥ 95% of correctly-named files.
3. Direct-play grant returns `directPlay: true` for h264/aac mp4 files on every client platform.
4. Watch state syncs between web and tvOS for the same `sub`.

**M4 verification gates:**
1. Single h264 1080p transcode session sustains real-time on Apple Silicon.
2. 4 concurrent transcode sessions stay under 80% CPU.
3. Session kills cleanly on 30s heartbeat loss; tmpdir cleaned.
4. CPU fallback works when `TRANSCODER_FORCE_CPU=1`.
5. Seek mid-playback resumes within 2s.

**M5/M6 verification:** defined in their own brainstorm cycles.

## What comes next

1. **This document is the SPEC.** After plan-mode exit, copy to `docs/superpowers/specs/2026-05-24-mybunny-and-plex-replacement-design.md` and commit.
2. Run **`/superpowers:writing-plans`** to convert this spec into an executable implementation plan for **M1** (only M1 gets a plan now; M2–M6 each get their own writing-plans cycle when their predecessor ships).
3. Before M1 phase 1 starts, gather inputs:
   - Xtream credentials (host, username, password)
   - mybunny `IPTV_MAX_CONCURRENT_STREAMS` value (or accept default 4 and tune)
   - `MEDIA_LIBRARY_PATHS` for the NAS mount (deferred to M3 but worth confirming now)
4. Each later milestone re-enters this same brainstorm → spec → plan → implement loop. Don't try to skip the brainstorm for M2 just because some architecture is captured here — the M2 brainstorm should re-confirm assumptions and surface anything that's drifted since this doc was written.
