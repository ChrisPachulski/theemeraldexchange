# API Reference

This is a complete route reference for the backend HTTP API. It was built by
reading `server/app.ts`, `server/middleware/csrf.ts`, `server/auth.ts`, every
middleware file under `server/middleware/`, and every non-test file under
`server/routes/`. Every route, method, and auth guard below is taken directly
from the code at those paths, nothing here is inferred from naming
conventions or the SPA.

Auth-guard vocabulary used in the tables:

- **public**, no session, bearer, or token required.
- **session (cookie/bearer)**, `requireAuth` (`server/middleware/auth.ts:78`).
  Accepts a session cookie or an `Authorization: Bearer <JWE>` device token;
  Bearer is tried first, falls back to cookie.
- **admin**, `requireAdmin` (`server/middleware/auth.ts:97`). Same as above,
  plus `session.role === 'admin'`.
- **section(name)**, `requireSection('live' | 'downloads' | 'arr', opts?)`
  (`server/services/userPolicies.ts`, applied in the route file). Reads the
  caller's per-user policy; a policy that denies the named section 403s.
  Admins always bypass it. `requireSection('arr', { mutationsOnly: true })`
  only gates POST/PUT/DELETE, leaving GET open to every member.
- **stream token (`?t=`)**, a signed, kind-bound HMAC token minted by a
  `.../grant` endpoint and verified with `verifyStreamToken` /
  `verifyMediaToken` on the playback route itself. No cookie is read; the
  token's own `sub` claim is re-checked against `memberStatus` at serve time.
- **rating cap**, in addition to the guard above, `capBlocksUnrated` /
  `ratingBlocked` runs and 403s (`rating_blocked`) a parental-rating-capped
  session before a stream token is minted.
- **shared secret (header)**, a constant-time comparison against a
  configured secret sent in a request header (not a session at all).

## CSRF: state-changing requests

`server/middleware/csrf.ts` mounts `requireSafeOrigin` globally (`app.ts:153`)
on every path. It only inspects `POST`, `PUT`, `PATCH`, `DELETE`
(`STATE_CHANGING`, csrf.ts:27), GET/HEAD are never gated by this middleware,
because cookies are the CSRF vector and reads are idempotent.

For a state-changing request, `requireSafeOrigin` (csrf.ts:132-150) admits the
request if ANY of the following hold, otherwise it requires
`Origin` to be in `env.allowedOrigins` (or, if `allowedOrigins` is empty,
requires dev/non-prod, csrf.ts:115-130):

1. **Bearer-only** (csrf.ts:38-42, `isBearerOnly`): an `Authorization: Bearer`
   header is present and there is no `Cookie` header at all. A bearer can't be
   forged from a victim's browser tab, so the Origin check is moot.
2. **Native bootstrap** (csrf.ts:59-71, `isNativeBootstrap`): the request has
   no `Cookie` and no `Origin` header, AND the path is one of
   `/api/auth/device/poll`, `/api/auth/apple`, `/api/auth/google`
   (`NATIVE_BOOTSTRAP_PATHS`, csrf.ts:59-63). This lets the iOS/tvOS app mint
   its very first bearer token, before it has one, from a native
   `URLSession` client that never sets `Origin`. Any request to these same
   paths that carries a cookie or an Origin header is NOT exempt and falls
   through to the normal check.
3. **Stream-token-only** (csrf.ts:90-96, `isStreamTokenOnly`): the request
   carries a `?t=` query parameter, no `Cookie` header, AND the path starts
   with one of `TOKEN_AUTH_PREFIXES = ['/api/transcode/session/']`
   (csrf.ts:88). This is deliberately narrow, it exists so a cross-origin
   `<video>`/hls.js client can POST a heartbeat or stop signal to a
   transcode session using only its stream token, with no cookie riding
   along. It does NOT cover the `?t=`-gated GET playback routes in
   `iptv.ts`, `media.ts`, `tmdb.ts`, or `dvr.ts`, those are all GET/HEAD and
   are outside `STATE_CHANGING` in the first place, so they never reach this
   check at all. A request presenting both a `?t=` token and a cookie is
   still gated normally.
4. **Same-host origin** (csrf.ts:106-113, `isSameHostOrigin`): the `Origin`
   header's host equals the request's own `Host` header (scheme ignored).
   This covers the backend-served SPA (`SERVE_SPA=1`) mutating same-origin
   without the operator having to enumerate `ALLOWED_ORIGINS`.
5. Otherwise, `checkOrigin` (csrf.ts:115-130) requires `Origin` to be one of
   `env.allowedOrigins`; a missing or unlisted Origin is rejected
   (`bad_origin`, 403). If `allowedOrigins` is empty entirely (dev / Vite
   proxy), non-prod passes and prod fails closed (`csrf_misconfigured`).

A second, stricter middleware, `requireTrustedOrigin` (csrf.ts:157-171), is
mounted only on `GET /api/suggestions/:type` (`suggestions.ts:83`). It applies
the same Bearer/same-host/allowlist checks but does NOT skip GET, that route
has a side effect (writes `rec_log`/`recently_shown` when the local
recommender is on), so a forged cross-origin GET with a riding cookie would
otherwise be able to poison another user's recommendation rotation.

## /api/health, /api/limits (server/app.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | Liveness/readiness probe used by the Docker healthcheck and cloudflared. Probes `server.db` with `SELECT 1`; 503 on failure. (`app.ts:162`) |
| GET | `/api/limits` | public (session optional) | Configured limits/feature flags the SPA needs pre-login (min free space, size caps, which integrations are configured). Two fields (`defaultSonarrRootFolderPath`, `defaultRadarrRootFolderPath`) are withheld unless a session is present. `accountDeletionEnabled: true` advertises `DELETE /api/account/self` to the Apple app. (`app.ts:178`) |

## /api/auth (server/auth.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/auth/plex/config` | public | Non-secret `X-Plex-Client-Identifier` + product label so the SPA can create a Plex PIN in the browser. (`auth.ts:378`) |
| GET | `/api/auth/methods` | public | Which login providers this install has configured (plex/apple/google/workos booleans). (`auth.ts:391`) |
| POST | `/api/auth/plex/check` | public (CSRF-gated; mints the session) | Poll a Plex PIN; on success, verify identity, run the shared invite/members authZ gate, optionally auto-admit via Plex-server-share, and set the session cookie. (`auth.ts:419`) |
| GET | `/api/auth/apple/nonce` | public (apple rate-limit bucket) | Issue a single-use, five-minute nonce for the native device-pair Sign in with Apple flow: the app gives Apple its SHA-256 hex and returns the raw value with the token. 503 when SIWA is not configured. (`auth.ts`, `issueAppleNonce`) |
| POST | `/api/auth/apple` | public (native-bootstrap CSRF exemption) | Verify a Sign in with Apple identity token against Apple's JWKS, run the shared authZ gate, then either mint a device-token Bearer (device-pair body) or set a session cookie. A device-pair body must carry a server-issued `nonce` (400 `invalid_nonce` otherwise; the nonce is burned on first use); browser sign-ins keep the client-chosen nonce. (`auth.ts`, `auth.post('/apple')`) |
| POST | `/api/auth/google` | public (native-bootstrap CSRF exemption) | Same as `/apple` for Google Sign-In identity tokens. (`auth.ts:685`) |
| GET | `/api/auth/workos/start` | public | Parks a CSRF nonce (+ optional invite code) in a short-lived HttpOnly cookie and redirects to the WorkOS AuthKit hosted login page. (`auth.ts:818`) |
| GET | `/api/auth/workos/callback` | public | Exchanges the WorkOS authorization code, verifies the state cookie, runs the shared authZ gate, sets the session cookie, redirects back to the SPA. (`auth.ts:837`) |
| POST | `/api/auth/workos/native/start` | public | Native (Apple app) WorkOS PKCE flow: mints a state nonce and returns the AuthKit URL for an in-app `ASWebAuthenticationSession`. (`auth.ts:904`) |
| POST | `/api/auth/workos/native` | public | Exchanges the PKCE code + verifier, runs the shared authZ gate, mints a device-token Bearer. (`auth.ts:929`) |
| POST | `/api/auth/logout` | public (reads the cookie if present) | Best-effort Plex sign-out, then clears the session cookie. (`auth.ts:989`) |

Every provider path above converges on the same authZ decision,
`authorizeOrRedeem` (`auth.ts:346-369`): an existing allowed member is
admitted; otherwise a valid unredeemed invite in the request mints
membership; otherwise 403 `no_invite`.

## /api/auth/device/link (server/routes/deviceLink.ts)

Web-claimed device pairing for providers (WorkOS/Google/Apple) that have no
native PIN flow of their own.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/device/link/start` | public | Device generates an 8-char link code and registers it. (`deviceLink.ts:67`) |
| POST | `/api/auth/device/link/claim` | session (cookie/bearer) | The signed-in member (any provider) binds their identity to the code from a browser. (`deviceLink.ts:102`) |
| POST | `/api/auth/device/link/poll` | public | Device polls the code; once claimed, mints a device-token Bearer identical in shape to the Plex device-pair path. (`deviceLink.ts:123`) |

## /api/auth/device (server/routes/device.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/device/poll` | public (native-bootstrap CSRF exemption) | Apple/tvOS device-pair: poll a Plex PIN created client-side, verify identity, run the shared authZ gate, mint a device-token Bearer JWE bound to `device_id`/`device_name`. (`device.ts:49`) |

## /api/me (server/auth.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/me` | public route; self-checks the session, 401 if absent/revoked | Current reconciled user (sub, username, role, auth_mode), or 401. (`auth.ts:1004`) |

## /api/version (server/routes/version.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/version` | public | Server id, release, which auth modes are configured, whether device pairing is accepted, and DB schema versions. Deliberately minimal, no PII, no tokens. (`version.ts:40`) |

## /api/devices, /api/admin/devices (server/routes/devices.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/devices/self` | session (cookie/bearer) | List the caller's own paired devices. (`devices.ts:105`) |
| DELETE | `/api/devices/self/:jti` | session, ownership-checked | Revoke one of the caller's own devices. (`devices.ts:118`) |
| DELETE | `/api/devices/self` | session | Revoke every device belonging to the caller ("log out everywhere"). (`devices.ts:130`) |
| PATCH | `/api/devices/self/:jti/name` | session, ownership-checked | Rename one of the caller's own devices. (`devices.ts:152`) |
| GET | `/api/admin/devices` | admin | List every paired device across all users. (`devices.ts:179`) |
| DELETE | `/api/admin/devices/:jti` | admin | Revoke any device. (`devices.ts:192`) |
| PATCH | `/api/admin/devices/:jti/name` | admin | Rename any device. (`devices.ts:202`) |

## /api/account (server/routes/account.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| DELETE | `/api/account/self` | session (cookie/bearer) | Self-service account deletion for the Apple clients (Guideline 5.1.1(v)). Revokes the caller's members row and every invite they issued in one transaction, then cascade-revokes every device token (including the one authorizing the call), IPTV playlist tokens, favorites and watch history, the API key, passkeys, policy, feedback, watchlist, and (when `USE_MEDIA_CORE=1`) media-core watch state. `204` empty on success or replay; `409 {"error":"last_admin"}` when the caller is the only remaining administrator or is listed in `ADMIN_SUBS`. Erasure steps that fail are logged, never surfaced. (`account.ts`) |

## /api/admin/invites, /api/admin/members (server/routes/adminInvites.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/invites` | admin | List outstanding invites (redacted, never the plaintext code). (`adminInvites.ts:41`) |
| POST | `/api/admin/invites` | admin | Issue a new invite; returns the plaintext code exactly once. (`adminInvites.ts:47`) |
| DELETE | `/api/admin/invites/:prefix` | admin | Revoke an invite by its code-hash prefix. (`adminInvites.ts:92`) |
| GET | `/api/admin/members` | admin | List members (active + revoked), including synthesized rows for `ADMIN_SUBS` owners who never redeemed an invite. (`adminInvites.ts:116`) |
| DELETE | `/api/admin/members/:sub` | admin | Revoke a member; cascades to device-token and IPTV-playlist-token revocation. (`adminInvites.ts:143`) |

## /api/sonarr (server/routes/sonarr.ts)

Allow-listed Sonarr proxy. `sonarr.use('*', requireAuth)` then
`requireSection('arr', { mutationsOnly: true })` (`sonarr.ts:44-47`): reads are
open to any member; mutations 403 for a member whose policy denies the `arr`
section (admins always pass). Mutate routes additionally carry a per-session
token-bucket rate limit (`sonarrMutateLimit`, `sonarr.ts:53-58`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/sonarr/api/v3/system/status` | session | Forwarded read. (`sonarr.ts:98`) |
| GET | `/api/sonarr/api/v3/qualityprofile` | session | Forwarded read. (`sonarr.ts:99`) |
| GET | `/api/sonarr/api/v3/rootfolder` | session | Forwarded read. (`sonarr.ts:100`) |
| GET | `/api/sonarr/api/v3/series` | session | Forwarded read. (`sonarr.ts:101`) |
| GET | `/api/sonarr/api/v3/series/lookup` | session | Forwarded read. (`sonarr.ts:102`) |
| GET | `/api/sonarr/api/v3/episode` | session | Forwarded read; per-series episode list (`?seriesId=`). (`sonarr.ts:105`) |
| GET | `/api/sonarr/api/v3/queue` | session | Forwarded read; used by the Downloads tab. (`sonarr.ts:109`) |
| POST | `/api/sonarr/api/v3/queue/clear-stuck` | admin, rate-limited | Bulk-remove queue entries stuck in `importPending`/`importBlocked`, blocklisting the bad release. (`sonarr.ts:117`) |
| POST | `/api/sonarr/api/v3/command` | admin, rate-limited | Fire an allowlisted Sonarr command (`RefreshSeries`, `SeriesSearch`, `EpisodeSearch`, `RenameFiles`). (`sonarr.ts:202`) |
| GET | `/api/sonarr/api/v3/release` | admin, rate-limited | Interactive release search for a series/season, projected with size/over-cap info. (`sonarr.ts:221`) |
| POST | `/api/sonarr/api/v3/release` | admin, rate-limited | Grab a hand-picked release, honoring (or explicitly overriding) the per-episode size cap. (`sonarr.ts:249`) |
| GET | `/api/sonarr/api/v3/rename` | admin | Preview the rename diff for a series. (`sonarr.ts:288`) |
| PUT | `/api/sonarr/api/v3/episode/monitor` | admin, rate-limited | Batch-toggle `monitored` on a set of episode ids. (`sonarr.ts:316`) |
| GET | `/api/sonarr/api/v3/history/series` | admin | Newest-first grab history for a series. (`sonarr.ts:336`) |
| PUT | `/api/sonarr/api/v3/series/:id` | admin, rate-limited | Edit a series (monitored/qualityProfileId/rootFolderPath only, fetched, overlaid, PUT back whole). (`sonarr.ts:353`) |
| POST | `/api/sonarr/api/v3/series` | session (mutation section-gated), rate-limited | Add a series. Non-admin bodies are policy-materialized/validated server-side; forces `searchForMissingEpisodes:false` upstream and instead runs the per-episode-size-capped background grab (`grabTvUnderCap`). Gated on a disk-space check against the chosen root folder. (`sonarr.ts:752`) |
| POST | `/api/sonarr/api/v3/series/:id/seasons/:n/monitor` | admin, rate-limited | Flip one season to monitored and kick the capped background grab for it. (`sonarr.ts:1027`) |
| DELETE | `/api/sonarr/api/v3/series/:id` | admin, rate-limited | Delete a series. (`sonarr.ts:1115`) |

## /api/radarr (server/routes/radarr.ts)

Mirrors `/api/sonarr`'s guard shape: `requireAuth` then
`requireSection('arr', { mutationsOnly: true })` (`radarr.ts:43-46`), with the
same `radarrMutateLimit` token bucket on mutate routes.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/radarr/api/v3/system/status` | session | Forwarded read. (`radarr.ts:94`) |
| GET | `/api/radarr/api/v3/qualityprofile` | session | Forwarded read. (`radarr.ts:95`) |
| GET | `/api/radarr/api/v3/rootfolder` | session | Forwarded read. (`radarr.ts:96`) |
| GET | `/api/radarr/api/v3/movie` | session | Forwarded read. (`radarr.ts:97`) |
| GET | `/api/radarr/api/v3/movie/lookup` | session | Forwarded read. (`radarr.ts:98`) |
| GET | `/api/radarr/api/v3/queue` | session | Forwarded read. (`radarr.ts:104`) |
| POST | `/api/radarr/api/v3/queue/clear-stuck` | admin, rate-limited | Bulk-remove stuck import-blocked queue entries. (`radarr.ts:113`) |
| POST | `/api/radarr/api/v3/command` | admin, rate-limited | Fire an allowlisted Radarr command (`RefreshMovie`, `MoviesSearch`, `RenameMovie`). (`radarr.ts:167`) |
| GET | `/api/radarr/api/v3/release` | admin, rate-limited | Interactive release search for a movie. (`radarr.ts:185`) |
| POST | `/api/radarr/api/v3/release` | admin, rate-limited | Grab a hand-picked movie release. (`radarr.ts:203`) |
| GET | `/api/radarr/api/v3/rename` | admin | Preview the rename diff for a movie. (`radarr.ts:236`) |
| GET | `/api/radarr/api/v3/history/movie` | admin | Newest-first grab history for a movie. (`radarr.ts:262`) |
| PUT | `/api/radarr/api/v3/movie/:id` | admin, rate-limited | Edit a movie (monitored/qualityProfileId/rootFolderPath only). (`radarr.ts:279`) |
| POST | `/api/radarr/api/v3/movie` | session (mutation section-gated), rate-limited | Add a movie. Forces `searchForMovie:false` upstream, runs the flat-size-capped grab (`grabBestUnderCap`), and rolls the add back on a failed/over-cap grab (`424`) or flips it to `monitored:true` when nothing is grabbable yet. (`radarr.ts:618`) |
| POST | `/api/radarr/api/v3/movie/:id/upgrade` | admin, rate-limited | Manually trigger a capped upgrade search on an existing movie. (`radarr.ts:901`) |
| DELETE | `/api/radarr/api/v3/movie/:id` | admin, rate-limited | Delete a movie. (`radarr.ts:986`) |

## /api/sab (server/routes/sab.ts)

`requireAuth` then `requireSection('downloads')` on every route
(`sab.ts:27-31`); a member whose policy denies `downloads` cannot even read
the queue.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/sab/api?mode=queue` | session + section(downloads) | SABnzbd queue snapshot (both roles). (`sab.ts:47`) |
| GET | `/api/sab/api?mode=history` | session + section(downloads) | SABnzbd history (both roles). (`sab.ts:47`) |
| POST | `/api/sab/api/queue/:nzoId/pause` | session + section(downloads) + admin check in-handler, rate-limited | Pause a queue item. (`sab.ts:85`) |
| POST | `/api/sab/api/queue/:nzoId/resume` | same | Resume a queue item. (`sab.ts:92`) |
| DELETE | `/api/sab/api/queue/:nzoId` | same | Delete a queue item (with `del_files=1`). (`sab.ts:99`) |

## /api/tmdb (server/routes/tmdb.ts)

`tmdb.use('*', trailerStreamAuth)` (`tmdb.ts:50`): every path requires a
session except the muxed-trailer stream, which accepts a `?t=` token bound to
that video id.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/tmdb/credits` | session | Cast/crew for a Sonarr (TVDB id) or Radarr (TMDB id) title. (`tmdb.ts:87`) |
| GET | `/api/tmdb/person/:personId` | session | Person bio + filmography (capped to 40 credits). (`tmdb.ts:188`) |
| GET | `/api/tmdb/person/:personId/credits` | session | Filmography only, no bio fetch. (`tmdb.ts:224`) |
| GET | `/api/tmdb/trending/:type` | session | TMDB week-window trending feed for `movie`/`tv`. (`tmdb.ts:244`) |
| GET | `/api/tmdb/videos` | session | Trailers/extras (YouTube keys) for a title. (`tmdb.ts:294`) |
| GET | `/api/tmdb/related` | session | "More like this" (TMDB recommendations, falling back to similar). (`tmdb.ts:327`) |
| GET | `/api/tmdb/trailer` | session | Resolve a YouTube video id to a directly-playable URL (native Rust resolver, then yt-dlp fallback). (`tmdb.ts:380`) |
| GET | `/api/tmdb/trailer/:key/stream.mp4` | stream token (`?t=`) or session | Serve a locally-muxed adaptive trailer, range-seekable. (`tmdb.ts:439`) |

## /api/ratings (server/routes/ratings.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/ratings?ids=tt...` | session | IMDb/Rotten Tomatoes/Metacritic scores by IMDb id, cached in `server.db`; fills missing ids from OMDb + Wikidata + the RT page, waits briefly, returns whatever's ready plus a `pending` list. (`ratings.ts:248`) |

## /api/iptv (server/routes/iptv.ts composing server/routes/iptv/*.ts, mounted only when `IPTV_DISABLED` is unset)

Most routes carry `requireAuth` plus `requireSection('live')`, the whole
IPTV surface (catalog, EPG, grants, favorites, history) lives under the
`live` policy section. Grant routes additionally 403 (`rating_blocked`) any
parental-rating-capped session, because IPTV content carries no
certification to check against. Playback byte routes are token-authed
(`checkToken`, `iptv.ts:965`) and carry no session at all, the browser
doesn't attach cookies cross-origin to them.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/iptv/health` | session | Upstream Xtream account health (expiry, connection cap, status). (`iptv.ts:153`) |
| GET | `/api/iptv/sessions` | session | Caller's own active stream sessions (admin sees everyone's). (`iptv.ts:250`) |
| DELETE | `/api/iptv/sessions/:sessionId` | session, self or admin | Force-release a stream session; also tears down its live remux ffmpeg if applicable. (`iptv.ts:281`) |
| GET | `/api/iptv/categories` | session + section(live) | Category list for `live`/`vod`/`series`. (`iptv.ts:366`) |
| GET | `/api/iptv/live` | session + section(live) | Live channel listing. (`iptv.ts:387`) |
| GET | `/api/iptv/vod` | session + section(live) | VOD listing. (`iptv.ts:388`) |
| GET | `/api/iptv/series` | session + section(live) | Series listing. (`iptv.ts:389`) |
| GET | `/api/iptv/epg/now` | session + section(live) | Now-playing EPG entries for a channel id list. (`iptv.ts:391`) |
| GET | `/api/iptv/epg/channel/:channelId` | session + section(live) | EPG window for one channel. (`iptv.ts:399`) |
| GET | `/api/iptv/epg/grid` | session + section(live) | Full EPG grid (gzip'd when large). (`iptv.ts:408`) |
| GET | `/api/iptv/epg/search` | session + section(live), rate-limited | Server-side programme search over the entire synced EPG store. (`iptv.ts:470`) |
| GET | `/api/iptv/vod/:streamId` | session + section(live) | VOD detail. (`iptv.ts:504`) |
| GET | `/api/iptv/series/:seriesId` | session + section(live) | Series detail. (`iptv.ts:511`) |
| POST | `/api/iptv/playlist/token` | session + section(live) + rating cap | Mint a long-lived (90-day) M3U export token. (`iptv.ts:540`) |
| GET | `/api/iptv/playlist/tokens` | session | List the caller's minted playlist tokens. (`iptv.ts:566`) |
| DELETE | `/api/iptv/playlist/tokens/:jti` | session, self or admin | Revoke a playlist token. (`iptv.ts:571`) |
| GET | `/api/iptv/playlist.m3u` | playlist token (`?t=`) | Serve the full M3U export for external players (VLC, TiviMate); re-checks section + rating cap at serve time. (`iptv.ts:585`) |
| GET | `/api/iptv/favorites` | session + section(live) | Caller's favorites. (`iptv.ts:635`) |
| POST | `/api/iptv/favorites` | session + section(live) | Add a favorite. (`iptv.ts:641`) |
| DELETE | `/api/iptv/favorites/:kind/:itemId` | session + section(live) | Remove a favorite. (`iptv.ts:656`) |
| GET | `/api/iptv/history` | session + section(live) | Caller's watch history. (`iptv.ts:672`) |
| POST | `/api/iptv/history` | session + section(live) | Upsert a watch-position row; mirrors a `watched` signal to the recommender once per qualifying transition. (`iptv.ts:678`) |
| POST | `/api/iptv/stream/live/:streamId/grant` | session + section(live) + rating cap | Acquire a concurrency slot and mint a stream token for live playback (mpegts or, for AVPlayer, an HLS remux). (`iptv.ts:785`) |
| POST | `/api/iptv/stream/catchup/:streamId/grant` | session + section(live) + rating cap | Same, for a time-shifted catch-up window within the channel's archive retention. (`iptv.ts:879`) |
| GET | `/api/iptv/stream/live/:streamId.ts` | stream token (`?t=`, kind `live`) | Raw MPEG-TS byte proxy with dead-feed sibling failover. (`iptv.ts:1018`) |
| GET | `/api/iptv/stream/live/:streamId/remux/index.m3u8` | stream token (`?t=`, kind `remux`) | HLS manifest for the ffmpeg remux session, with sibling failover and a startup-window wait. (`iptv.ts:1125`) |
| GET | `/api/iptv/stream/live/:streamId/remux/seg` | stream token (`?t=`, kind `remux`) | One remux HLS segment. (`iptv.ts:1235`) |
| GET | `/api/iptv/stream/catchup/:streamId/:startUtc/:durationMin.ts` | stream token (`?t=`, kind `catchup`) | Catch-up byte proxy against Xtream's timeshift endpoint. (`iptv.ts:1275`) |
| POST | `/api/iptv/stream/vod/:streamId/grant` | session + section(live) + rating cap | Mint a VOD stream token (progressive or HLS depending on container). (`iptv.ts:1330`) |
| GET | `/api/iptv/stream/vod/:streamId/:ext` | stream token (`?t=`, kind `vod`) | VOD byte proxy (range-seekable) or HLS playlist rewrite. (`iptv.ts:1390`) |
| POST | `/api/iptv/stream/series/:episodeId/grant` | session + section(live) + rating cap | Mint a series-episode stream token. (`iptv.ts:1433`) |
| GET | `/api/iptv/stream/series/:episodeId/:ext` | stream token (`?t=`, kind `series`) | Series-episode byte proxy or HLS playlist rewrite. (`iptv.ts:1497`) |
| GET | `/api/iptv/stream/segment` | stream token (`?u=`, kind `segment`) | Generic HLS sub-resource proxy (variant playlists / media segments) with SSRF containment on the resolved upstream URL. (`iptv.ts:1537`) |
| GET | `/api/iptv/export/recommender` | shared secret (`x-iptv-export-secret` header) | Dump the VOD/series catalog for the recommender sidecar's offline ingest. (`iptv.ts:1623`) |
| POST | `/api/iptv/admin/sync` | admin | Kick off a background Xtream catalog sync job. (`iptv.ts:1657`) |
| GET | `/api/iptv/admin/sync/:id` | admin | Poll a sync job's status. (`iptv.ts:1661`) |

## /api/dvr (server/routes/dvr.ts, mounted only when `DVR_ENABLED` and IPTV are both on)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/dvr/recordings` | admin | Schedule a new recording, validated against tuner-slot conflicts. (`dvr.ts:55`) |
| GET | `/api/dvr/recordings` | session + section(live) | List all recordings. (`dvr.ts:87`) |
| GET | `/api/dvr/recordings/:id` | session + section(live) | One recording's detail. (`dvr.ts:92`) |
| DELETE | `/api/dvr/recordings/:id` | admin | Cancel an in-flight recording (stops ffmpeg) or delete a terminal one (removes the file). (`dvr.ts:103`) |
| POST | `/api/dvr/recordings/:id/grant` | session + section(live) + rating cap | Mint a playback stream token for a completed recording. (`dvr.ts:133`) |
| GET | `/api/dvr/recordings/:id/play` | stream token (`?t=`, kind `recording`) or session + section(live) + rating cap | Range-serve the recorded `.ts` file. (`dvr.ts:216`) |

## /api/users, /api/users/policies, /api/users/:sub/policy

`server/routes/users.ts` and the admin half of `server/routes/policy.ts` share
the `/api/users` mount (`app.ts:276-280`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/users` | admin | Merge accepted/shared/home/local-PMS/pending Plex user lists into one dashboard-access roster. (`users.ts:28`) |
| GET | `/api/users/policies` | admin | Every stored per-user policy document. (`policy.ts:91`) |
| PUT | `/api/users/:sub/policy` | admin | Replace one user's policy (parental rating cap, section allowlist, kid flag). (`policy.ts:95`) |

## /api/policy (server/routes/policy.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/policy` | session | The caller's own policy (default-open when unset). (`policy.ts:82`) |

## /api/plex (server/routes/plex-links.ts, server/routes/plex-admin.ts)

`plexLinks` (auth-only) is mounted before `plexAdmin` (admin-only) on the same
prefix so Hono's first-match routing doesn't let the admin gate leak onto the
auth-only paths (`app.ts:281-286`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/plex/library-links` | session | Resolve tmdb/tvdb/imdb ids to Plex `ratingKey`s for the "Play in Plex" overlay, cached per-sub. (`plex-links.ts:205`) |
| GET | `/api/plex/server-id` | session | The configured `PLEX_SERVER_ID`. (`plex-links.ts:219`) |
| GET | `/api/plex/remote-access` | admin | Diagnostic summary of the Plex server's external-reachability prefs. (`plex-admin.ts:27`) |

## /api/notifications (server/routes/notifications.ts)

Every route is admin-only (`notifications.ts:20`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/notifications/discord` | admin | Whether the Emerald Discord webhook connector exists on Sonarr/Radarr. (`notifications.ts:180`) |
| POST | `/api/notifications/discord` | admin | Create or update the Discord webhook connector on both apps, with rollback on partial failure. (`notifications.ts:196`) |
| DELETE | `/api/notifications/discord` | admin | Remove the connector from both apps. (`notifications.ts:297`) |
| POST | `/api/notifications/discord/test` | admin | Fire a test embed via Sonarr's test endpoint. (`notifications.ts:343`) |

## /api/grabs (server/routes/grabs.ts)

`grabs.use('*', requireAuth)` (`grabs.ts:21`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/grabs/recent` | admin | Full grab-event activity feed. (`grabs.ts:29`) |
| GET | `/api/grabs/by-item` | session | Per-item grab history, scoped to the caller's own events by `sub`. (`grabs.ts:35`) |

## /api/suggestions (server/routes/suggestions.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/suggestions/:type` | session + requireTrustedOrigin | Personalized (or trending, or cold-start) movie/TV suggestions, routed to the local recommender sidecar or the legacy Claude BYO-key pipeline depending on `USE_LOCAL_RECOMMENDER`. (`suggestions.ts:105`) |

## /api/settings (server/routes/settings.ts)

Per-user, admin-free; every route scopes to `session.sub`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/settings/anthropic-key` | session | Whether a BYO Anthropic key is set, plus its masked last-4. (`settings.ts:33`) |
| PUT | `/api/settings/anthropic-key` | session + `X-EEX-Expected-Sub` header match | Set/replace the caller's encrypted-at-rest Anthropic key. (`settings.ts:38`) |
| DELETE | `/api/settings/anthropic-key` | session + `X-EEX-Expected-Sub` header match | Clear the caller's key. (`settings.ts:63`) |

## /api/feedback (server/routes/feedback.ts)

Per-user like/dislike dots; every route scopes to `session.sub`
(`feedback.ts:37`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/feedback` | session | Caller's own like/dislike feedback. (`feedback.ts:82`) |
| POST | `/api/feedback` | session | Set a like/dislike signal; keeps the personal feedback store and the household rejection veto in sync, with rollback on partial failure. (`feedback.ts:88`) |
| DELETE | `/api/feedback/:type/:tmdbId/:signal` | session | Clear a signal; drops the household veto too if no other member still dissents. (`feedback.ts:218`) |

## /api/watchlist (server/routes/watchlist.ts)

Per-user; every route scopes to `session.sub` (`watchlist.ts:28`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/watchlist` | session | Caller's combined movie+tv watchlist, newest first. (`watchlist.ts:54`) |
| PUT | `/api/watchlist/:kind/:id` | session | Add/update a watchlist entry. (`watchlist.ts:59`) |
| DELETE | `/api/watchlist/:kind/:id` | session | Remove a watchlist entry. (`watchlist.ts:86`) |

## /api/syncplay (server/routes/syncplay.ts)

`syncplay.use('*', requireAuth)` (`syncplay.ts:28`); the group poll and
command routes additionally require the caller to already be a member of
that group.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/syncplay/groups` | session | List active watch-together groups (membership-scoped visibility of host/members). (`syncplay.ts:37`) |
| POST | `/api/syncplay/groups` | session | Create a group pinned to one media item. (`syncplay.ts:53`) |
| POST | `/api/syncplay/groups/:id/join` | session | Join a group. (`syncplay.ts:72`) |
| POST | `/api/syncplay/groups/:id/leave` | session | Leave a group. (`syncplay.ts:81`) |
| GET | `/api/syncplay/groups/:id` | session, must be a group member | Poll shared transport state; doubles as the liveness heartbeat. (`syncplay.ts:91`) |
| POST | `/api/syncplay/groups/:id/command` | session, must be a group member | Drive the shared transport (play/pause/seek). (`syncplay.ts:107`) |

## /api/usage (server/routes/usage.ts)

`usage.use('*', requireAuth)` (`usage.ts:19`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/usage/me` | session | Caller's own last-30-day Claude usage summary. (`usage.ts:23`) |
| GET | `/api/usage/admin` | admin | Same summary keyed by every user. (`usage.ts:44`) |
| GET | `/api/usage/log` | admin | Recent raw usage events. (`usage.ts:50`) |

## /api/recommender (server/routes/recommenderEvents.ts)

`recommenderEvents.use('*', requireAuth)` (`recommenderEvents.ts:29`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/recommender/metrics` | admin | Funnel metrics (impressions to added/clicked/dot-feedback with Wilson CIs). (`recommenderEvents.ts:33`) |
| POST | `/api/recommender/event` | session | Mirror a `clicked` client-side conversion signal to the local recommender. (`recommenderEvents.ts:57`) |

## /api/telemetry (server/routes/telemetry.ts)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/telemetry/config` | public | Distributes the Sentry/Glitchtip DSN + environment so client apps can init their own SDK. (`telemetry.ts:19`) |

## /api/media (server/routes/media.ts, mounted only when `USE_MEDIA_CORE=1`)

`media.use('*', mediaAuth)` (`media.ts:182`): `/stream/:kind/:id` accepts a
`?t=` direct-play token bound to that exact title; `/subtitles/{movie,episode}/...`
requires a session plus a per-title rating-cap re-check; everything else
requires a session.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/media/playback/:kind/:id` | session + rating cap | Orchestrate a media-core playback grant: direct-play token, or start a transcoder HLS session and return a remux token + manifest/heartbeat/stop URLs. (`media.ts:188`) |
| ALL | `/api/media/*` (catch-all) | stream token (`?t=`) on `/stream/:kind/:id`; session elsewhere | Proxy every other media-core JSON/metadata route and the direct `/stream` byte range; mirrors a `watched` signal to the recommender on a successful `POST /watch`. (`media.ts:429`) |

## /api/transcode (server/routes/transcode.ts, mounted only when `USE_MEDIA_CORE=1`)

`transcode.use('*', transcodeAuth)` (`transcode.ts:84`): a `?t=` token bound
to `/session/:sid/*` is accepted cookielessly; every other path (including
`GET /sessions` admin/list) requires a session.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| ALL | `/api/transcode/*` (catch-all) | stream token (`?t=`, kind media-HLS, on `/session/:sid/*`) or session | Authenticated proxy for the transcoder's HLS surface (manifest + segments), minting the internal-principal bearer on every forwarded request and rewriting manifest URIs to carry the token. (`transcode.ts:86`) |

## SPA fallback (server/app.ts, mounted only when `SERVE_SPA=1`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `*` (non-`/api` paths only) | public | Serves the built SPA (`./dist`) same-origin; `/api/*` always falls through to the JSON 404 instead of `index.html`. (`app.ts:334-338`) |
