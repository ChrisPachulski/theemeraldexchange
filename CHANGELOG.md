# Changelog

All notable changes to The Emerald Exchange are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
project has shipped continuously from a single working branch since its first
commit on 2026-05-08, so this history is organized by month rather than by
per-feature release; the current package version is 0.9.0.

## [Unreleased]

### Added

- Self-service account deletion for the Apple clients: `DELETE /api/account/self`
  revokes the caller's membership, invites, device tokens, and per-member state
  (IPTV favorites and history, API key, passkeys, policy, feedback, watchlist,
  media-core watch state), refuses the last remaining administrator with
  `409 last_admin`, and is advertised through `accountDeletionEnabled` on
  `/api/limits` (App Store Guideline 5.1.1(v)).
- media-core `DELETE /api/media/watch` erases the acting user's watch rows.
- Owner invites: `POST /api/admin/invites` accepts `role: 'admin'`, and the
  member who redeems that invite (or is re-granted by it) becomes an admin.
  Migration 0012 adds `invites.role`.
- The hosted privacy policy (`/privacy`) is republished from the app's canonical
  `docs/PRIVACY.md`, dated September 1, 2026: account deletion, the diagnostics
  upload switch, hosted email/Google sign-in, and YouTube's embedded player.

### Security

- Native Sign in with Apple now binds each device-pair sign-in to a
  server-issued, single-use nonce (`GET /api/auth/apple/nonce`); the server
  compares SHA-256 of the raw value with the token's claim and burns it, so a
  captured identity token cannot be replayed to mint a second device token.
  Browser sign-ins are unchanged.
- Closed an admin-name escalation: the `ADMINS` display-name match now applies
  only to `plex:` and bare-numeric subs, so a WorkOS member could no longer
  self-promote to admin by setting their first name to an allowlisted value
  (016d97e).
- Confined the transcoder to `TRANSCODER_MEDIA_ROOT=/media` in both the image
  and compose file; boot now refuses to start in `log` or `enforce` principal
  mode without that root set, path confinement runs before the Dolby Vision
  pre-probe and on `/warm`, and the ffmpeg input is restricted with
  `-protocol_whitelist file` (016d97e).
- Scoped the `?t=` CSRF exemption to `/api/transcode/session/` only, closing a
  gap where cookie-minting auth POSTs were incorrectly exempt from Origin
  checking (016d97e).
- IPTV stream tokens and the recommender's `/score` endpoint now re-check
  membership and the verified internal principal at serve time rather than
  only at mint time, closing a revocation gap (016d97e).
- Added SECURITY.md and untracked internal planning documents that had leaked
  into the public repository (016d97e).

### Changed

- Deploys are gated on CI: `scripts/ci-gate.sh` (called by `deploy-nas.sh`
  and `deploy-image.sh`) refuses an unpushed HEAD, waits for in-flight GitHub
  Actions checks, and aborts on a red or cancelled one; `--skip-ci-gate` /
  `SKIP_CI_GATE=1` overrides loudly. The `rust` CI job now surfaces the
  offending fmt/clippy/test lines as public annotations, and the `audit` job
  caches its `cargo-audit`/`cargo-deny` binaries instead of compiling them
  from source on every run.
- CI builds what ships: on main the `docker-build` job pushes the backend,
  media-core, transcoder, and recommender images to GHCR as `:main` and
  `:sha-<commit>`; `deploy-nas.sh` pulls the `:sha-` images for HEAD instead
  of compiling on the NAS (`--build-on-nas` keeps the old path). The owner
  deploy bind-mounts the private YouTube resolver binary over the image's stub.
- A tracked pre-push hook (`npm run hooks:install`) runs rustfmt/clippy and
  tsc/eslint on what the push touches.

## 2026-09

Two commits landed in September before this document was written; see
Unreleased above for 016d97e.

## 2026-08

### Auth

- Shipped WorkOS AuthKit as a redirect-flow sign-in provider, with Google and
  Apple buttons deep-linking through it (a694d81, 984cac4).
- Removed passkeys and the setup-token claim flow; `ADMIN_SUBS` became the
  sole owner-bootstrap mechanism (0182a18).
- Added native WorkOS sign-in for the Apple app (PKCE plus device token) and
  web-claimed device pairing so any member, not just the owner, can sign the
  Apple app into their account (335f5b2, 9080ecd).
- Hid Plex-only affordances for sessions signed in through a non-Plex
  provider, and restricted the admin invites panel to active invites only
  (e5470e0, 65881b2).

### IPTV / live TV

- Enforced the parental rating cap consistently across every live surface:
  the stream grant, the M3U playlist export, and every subsequent
  `playlist.m3u` re-fetch, not just at mint time (c02b6e2, e99f7cb, f76b842).
- Scoped `GET /sessions` to the calling member (admins excepted) and redacted
  other members' sub, IP, and title on a concurrency-cap 429 (541afa0,
  8402015).
- Routed EPG ingestion and Xtream catalog-sync fetches through the SSRF
  redirect guard, closing a gap where only the initial request was checked
  (9b95e0c, 1533f03).
- Fixed several SyncPlay group-state races: resolving the group before
  reading the command body, host reassignment when the host leaves or idles
  out, and version bumps on idle-prune membership changes (a591dd3, 3186be2,
  22a3d23, af7174f).
- Replaced the raw `.ts` plus mpegts.js web-live path with the shared server
  remux (HLS), and required two clean EOFs before declaring a live feed dead
  to cut false failovers (5fbc8bf, 26b9a16).

### Media library

- Added a responsive multi-column library grid with IMDb, Rotten Tomatoes,
  and Metacritic ratings on cards and in the detail modal (2f589b9, c357e13,
  e1a2b69).
- SSRF-guarded podcast feed fetches, re-checking every redirect hop
  (53a9309).

### Playback / transcoder

- Fixed HDR tone-mapping crash-loops on HDR10 sources lacking mastering-
  display metadata by tone-mapping through libplacebo instead of
  `tonemap_vaapi` (6713b3e).
- Extended the libplacebo tone-map path to AV1/VP9 via CPU decode plus
  Vulkan, then made AV1/VP9 and 10-bit H.264 (Hi10P) CPU-decode outright,
  since full-hardware VAAPI decode fails on them (bdfde1f, cb9ebe2).
- DVR recordings now wait for ffmpeg's real process exit before being marked
  completed, and honor the concurrency-cap rejection instead of spawning
  ffmpeg over the limit (3e3949d, 6f4652b).

### Ops / deploy

- Attached OCI provenance labels to published images and moved CI to Node 25
  to match the shipped image (0ea7d4c, 8b3d7a8).
- Gave `nas-safe-build` a fallback to bare `ssh` when GNU `timeout` is absent,
  fixing builds initiated from macOS (d7b3129).

## 2026-07

### Auth

- Shipped the first-owner claim flow: a setup token, an admin members row,
  and a closed fall-open so a fresh install cannot silently grant ownership
  (98a1475).
- Ran a large login-reliability hardening pass (2026-07-18) covering session
  truth, provider polling, revocation actors, and bootstrap origins: Plex
  polling was serialized and rate-limited per identity, browser session
  truth is now confirmed against `/api/me` rather than trusted from the
  provider response, member revocation actors are revalidated, invited
  passkey registration and ownership writes were made atomic, and session
  expiry classification was hardened end to end (4a0e867, 8177d15, ab23aed,
  f780389, 0fa8d96, ad33f65, b370c98).
- Stopped force-logging users out on a 403; only an actually expired session
  now clears client-side auth state (203fcbc).

### Playback / transcoder

- Shipped HLS trick-play (I-frame scrubbing thumbnails) behind
  `TRANSCODER_TRICKPLAY`, then defaulted it on along with Dolby Vision
  passthrough behind its own flag (02a5dee, 8443ef6, b7570d7).
- Added switchable in-band audio and `EXT-X-MEDIA:TYPE=AUDIO` alternate
  renditions for native (AVPlayer) clients (5bd401f, 342f9c5).
- Bounded trick-play thumbnail decode so it cannot brown out the NAS, and
  added a per-read input timeout to live remux ffmpeg so a half-open
  provider socket exits instead of wedging the session (8b60422, 66b3180).

### IPTV / live TV

- Added watch-together SyncPlay groups with shared transport state
  (6daef03).
- Built dead-feed failover across sibling channels with an explicit
  `channel_offline_upstream` state and a remux concurrency clamp
  (1732a62, 8812362, cf54478).
- Gated VOD, series, catchup, favorites, and history routes behind
  `requireSection('live')`, and enforced the parental rating cap and live
  upstream connection cap on scheduled DVR recordings (7f5d7a4, c896b77,
  a2e3134, ca43e81).

### Media library

- Added a minimal music library (scan, browse, direct-play audio), then
  photos, audiobooks, podcasts, per-user video playlists and collections,
  subtitle download via OpenSubtitles, and Whisper transcription
  (e0a76cf, d4fc1a0, a0f8c09, b4968bf).
- Added a per-user watchlist store with routes and tests (c5cc243).
- Stopped transient TMDB failures from poisoning negative caches and
  re-searching enriched shows on every scan, and negative-cached
  unmatchable movies and ffprobe failures the same way (9a07d12, 115f604,
  696f3a6).

### Ops / deploy

- Made every optional integration (Plex, the *arr/SAB stack, telemetry)
  boot-optional, and had the backend serve the SPA same-origin so a browser
  can reach the product without Netlify (949bc98, 9a3dfbc).
- Profile-gated optional compose services and added a Tailscale Serve
  private-remote profile (3ff9ad7).
- Verified published images boot on native amd64 and arm64 runners as part
  of CI, and documented the Apple `container` / Microsoft `wslc` runtime
  support gap (720d24f, be73105).
- Fixed GlitchTip delivery end to end (event ID plumbing, internal DSN, an
  auto-installed watchdog) and added a cloudflared stale-netns watchdog with
  a self-test (e5ff63a, e394845).

## 2026-06

### Auth

- Enforced `nbf`/`exp` JWE claims inside the device-token verify chokepoint,
  and moved to identity-keyed rate-limit buckets so a rotating IP could not
  evade the limiter (616ce9e, 5f791bb).
- Stopped leaking the host's IP by creating Plex PIN and device PINs
  client-side instead of server-side (03ed7f6, 56acb59).
- Added independent non-Plex login (Apple, Google, passkeys), and advertised
  the real set of supported `auth_mode`s from `/api/version` (a9863e0,
  f8f00e0).
- Closed a device-token allowlist bypass and a cross-provider admin
  escalation path (from May's audit) and closed remaining M1 session grace
  windows (22e768c).

### Playback / transcoder

- Landed the full hardware VAAPI pipeline (GPU decode, tone-map, scale) and
  Intel QSV hardware H.264 encode, replacing jellyfin-ffmpeg with Debian's
  stock ffmpeg plus VAAPI (76ce30c, 462d8f9, 5208315).
- Fixed playback actually starting end to end: warm-up wait plus HLS error
  recovery, correct realtime throttling, and treating a clean ffmpeg exit as
  session-done rather than an error (0d4b179, a1ff938).
- Made the transcoder supervisor the sole owner of the ffmpeg process so a
  kill signal reaches the real process, and had crash-respawn resume from the
  furthest-encoded position (3de01a1, 57a39e5).
- Fixed HLS resume and seeking across both re-encode and copy-remux paths:
  absolute position reporting, full-timeline VOD manifests, `EXT-X-ENDLIST`
  on finite VOD, and forward-seek re-granting instead of dying (6431572,
  0189b09, bb9dffa, ba5f4d3, 7d83b95).
- Played Dolby Vision via a libplacebo RPU re-encode, and downmixed
  transcoded audio to stereo plus re-encoded non-AAC audio for browser MSE
  compatibility (2aedc65, 3f023da, f08a027).

### IPTV / live TV

- Decomposed the 1,500-line IPTV route file into services with typed row
  mappers (4e88d20).
- Shipped DVR phase 1 and 2: scheduling, listing, and canceling recordings,
  plus the ffmpeg recorder engine, playback, and scheduler (75324b1,
  84bb0ae).
- Fixed live cable stability: normalized broken upstream timestamps, gave
  live grant tokens a 12-hour TTL instead of freezing at 5 minutes, and
  re-encoded non-H.264 live channels to H.264 so every channel plays
  (75b86a2, e870c63, b01587b).
- Validated the forwarded `Host` header against `ALLOWED_ORIGINS` before
  minting playlist URLs, and capped simultaneous upstream provider
  connections (227de0b, e550552).

### Media library

- Hardened the Rust scanner: moved blocking file I/O off the async runtime,
  opened `media.db` in WAL mode with a busy timeout, pruned deleted files and
  reaped orphan watch state after each scan, and stopped `INSERT OR REPLACE`
  from destroying watch state on rescan (f690a80, fa5511f, c635a72, cd94665).
- Gated TMDB matching on title confidence instead of blindly taking
  `results[0]`, and stopped TMDB matches from collapsing remakes into
  originals (c99466f, 53a06fc).
- Denied direct play of 10-bit H.264 (Hi10P) on profile, since it cannot be
  played back reliably in-browser (a8a9562).
- Added intro/credit markers ("Skip Intro") and denormalized show/movie
  metadata onto watch rows for faster reads (6daddaa, 73c1185).

### Recommender

- Shipped the production "fused" recipe combining content-based and
  cast/crew item-based re-ranking (ffdcb2c).
- Closed the implicit-feedback loop: watches now feed back in as a positive
  signal (477e1d1).
- Decomposed the suggestions god-file into typed services (TMDB client,
  library cache, prompt building, validation) as a dedicated refactor wave
  (09b11e4, 7418bfd, d6433f5, 36ec8c1, ba66fb2).
- Fixed a cold-boot crash-loop on a fresh `/data` volume, and clamped KNN `k`
  to sqlite-vec's 4096 cap after every `/score` call started 500ing past it
  (63df128, 8c98708).

### Apple app support

- Added a native Rust YouTube extractor (iOS-client resolution) as phase 1 of
  trailer support, and brought the desktop TV guide to parity with the Apple
  app's now/next detail pane (0e9b6e8, 851c9ec, 89f1c6c).

### Ops / deploy

- Made cargo fmt and a dependency vulnerability audit hard CI gates, and
  pinned every GitHub Action to a full commit SHA (3ac5ba6, 9557c3a,
  ceff2e0).
- Reworked the deploy script to ship a `git archive HEAD` payload, gate on a
  clean tree, and health-gate the full stack with an automatic rollback to
  the newest timestamped generation on failure (b91502a, 01da2d6).
- Hardened the NAS build path: a self-throttling, fork-free build watchdog
  with memory floors and incremental cache mounts (12bb552, 1d77c17).

### Security

- Rate-limited passkey and device auth, and stopped Plex-admin routes from
  leaking host IPs (c69538f).
- Closed remaining SSRF gaps in the egress guard, including special-purpose
  IPv4/IPv6 ranges, and documented the residual DNS-rebind TOCTOU risk
  explicitly rather than silently accepting it (cb8121a, 2edbe3a).
- Ran the server as non-root uid 10001, removing the last root container in
  the deployment (1a65199).

## 2026-05

The initial build-out month: the product went from a single-page dashboard
prototype to a multi-service stack with IPTV, a Rust media-core, hardware
transcoding, and encrypted sessions in about three weeks.

### Auth

- Landed Plex OAuth, a role-gated API backend, and the first login screen
  (3c23252).
- Encrypted session cookies (moved from a signed JWT to JWE A256GCM), and
  rejected legacy tokenless sessions once the Plex gate was configured
  (af76afe, ffb7f61).
- Added the members/invites data layer and wired parallel Sign-in-with-Apple
  plus Plex paths through shared invite and members authorization
  (d27bcfa, 2596cc9).
- Shipped WebAuthn (passkey) login and registration, and closed a
  cross-provider admin escalation plus a device-token allowlist bypass in
  the same week (1da9204, 8fbae3c).
- Added Apple device-flow PIN pairing with Bearer middleware for the future
  native app (ad66d57).

### Playback / transcoder

- Scaffolded the M4 capability-driven transcode service and handed off
  transcode-required streams from media-core to it (21e0e41, 180c334).
- Hardened the ffmpeg-HLS session lifecycle: SIGTERM trapping for graceful
  shutdown, a boot-time real-ffmpeg verification gate, and non-root
  container execution (b2a17f3, 7485e84).
- Confined the transcoder's `source_path` grant to `TRANSCODER_MEDIA_ROOT`,
  the first version of the path-confinement guard later hardened again in
  the 2026-09-01 security fix (55c1399).

### IPTV / live TV

- Built the entire IPTV core in a single week (2026-05-25 to 2026-05-31):
  SQLite schema, Xtream client, catalog and EPG parsers, HMAC stream tokens,
  concurrency tracking, live/VOD/series grant routes, and the player
  component (1fb7ad5, 24641d6, 234ac2b, 9bdeb72).
- Added a signed `playlist.m3u` export with per-channel signed URLs, then
  closed an SSRF hole in the segment proxy by enforcing public-HTTPS-only
  egress (1def2e2, 1bf56ae).
- Lifted EPG guide coverage roughly 15-fold (about 806 to 12,500 channels)
  by adding name/alias matching and a third-party supplemental EPG source
  (d1334f6, c3828de).
- Hardened M3U export against injection and made the export secret
  comparison constant-time (fb10fe8).

### Media library

- Scaffolded the M3 Rust media-core: library server, Hono proxy, TMDB
  enrichment, background scanning, and an episodes route (0420192,
  4543353, 1864253).
- Closed a watch-state IDOR and enforced the stream contract as part of an
  auth-posture hardening pass, and gated the `/scan` trigger behind the
  admin role (260e854, 67063f1).
- Deduped movies on `tmdb_id` to avoid unique-constraint collisions, and
  backfilled episode/show metadata with rate-limit hardening (0126e4f,
  8a2ccda).

### Recommender

- Replaced per-request Claude calls with a local recommender sidecar plus a
  nightly Claude optimizer (efa0274).
- Shipped a real holdout example and JSONL generator so the optimizer's
  auto-promotion eval gate actually wires up (503e1eb).
- Ran a 21-iteration automated hardening loop (`codex-loop`) over the
  recommender and suggestions code, covering explicit transaction handling,
  feedback attribution clearing stale data, and TMDB query-parameter auth
  (f6ff0e4, f6a5253, 81f6bd8).
- Added an internal-principal bridge (`mintInternalPrincipal`) so the
  backend's calls into the recommender carry verified caller identity across
  13 call sites (3cc86d9, c97cd61).

### Ops / deploy

- Added GitHub Actions CI (tsc, vitest, build on push and PR) on day one,
  then Playwright E2E in CI two weeks later (4d29ec8, 8778926).
- Deployed the split architecture: Hono backend on the NAS behind a
  Cloudflare Tunnel, SPA on Netlify (f156aab).
- Made the backend healthcheck use `node` instead of `curl` (the base image
  has no `curl`), and joined cloudflared to the backend's network namespace
  instead of the host's, closing exposure of loopback-only admin ports
  (d0e03ce, c5e3313).
- Added per-service memory/CPU limits and healthcheck-gated `depends_on`
  ordering to the compose stack (31664a7, b7edc13).

### Security

- Added an Origin-header CSRF gate and split app wiring from the listener so
  the gate could be tested in isolation (d020409).
- Sanitized feedback and rejection titles on both read and write as a
  prompt-injection guard (2bd43e9, 6ef9a0f).
- Ran a large end-of-month audit remediation wave across the server, the
  transcoder, media-core, and compose: SSRF fixes, migration and concurrency
  hardening, stream-token TTL bounds, and *arr/SAB/IPTV integration
  hardening (165c279, 25e1c7f, d6bfc70, d0d645e).
- Scrubbed a hardcoded notify email and internal LAN/Tailscale IPs from the
  repository (453c421).
