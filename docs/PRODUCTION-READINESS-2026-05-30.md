# theemeraldexchange — Production-Readiness Review

> **Status note, 2026-06-07:** this file is a historical review ledger, not the
> authoritative current project state. It preserves the 2026-05-30 findings as
> reviewed at that time; some rows below are now stale or closed by later code/CI
> changes even when the row text still says open. Use `TODO.md`,
> `docs/ROADMAP-STATUS.md`, and a fresh grep/test pass for current planning.

> ## Re-verification — 2026-06-17
>
> The open rows below were re-checked against the current tree (branch `main`,
> HEAD ~`1df06ab`) via an adversarial read-only pass. Net state now:
>
> | Severity | Total confirmed | Closed | Still open |
> |----------|-----------------|--------|-----------|
> | Critical | 2  | **2** | 0 |
> | High     | 7  | **7** | 0 |
> | Medium   | 26 | **22** | 4 |
> | Low      | 45 | (not swept this pass) | — |
>
> **High:** all 7 now closed. HIGH-3 (recommender chown crash-loop under
> `cap_drop: ALL` on a fresh volume) was the last "🟡 partial" — closed by the
> `cap_add: [SETUID, SETGID, CHOWN, DAC_OVERRIDE]` wiring + fresh-volume cold-boot
> regression test (`939ddce`/`13ed8b5`/`c3ae48f`).
>
> **Medium — newly closed since the ledger (12):** MED-4 (TMDB lookup concurrency
> bounded at 8, `suggestionsTmdb.ts`/`suggestionsValidation.ts`), MED-8 (GPL
> ffmpeg now recorded in `THIRD-PARTY-LICENSES.md` + written source offer,
> guard-tested by `server/licensing.test.ts`; a `deny.toml` + CI `license` gate
> now keeps GPL/AGPL out of the linked trees), MED-9 (all sidecar Dockerfile bases
> now `@sha256` digest-pinned), MED-11 (LiveTab grant errors surfaced, no silent
> rejection), MED-12 (root `ErrorBoundary` in `main.tsx`), MED-13 (deploy
> direct-docker fallback fails hard instead of shipping unhardened), MED-15
> (EPG sniff buffer bounded at 1 MB), MED-22 (recommender Glitchtip/Sentry wired
> via `telemetry.py`), MED-23 (`require_event_secret` fail-closed + compose
> defines the secret), MED-24 (transcoder duplicate-grant coalescing, `e7a4524`),
> MED-25/26 (device-token `exp`/`nbf` enforced on both Rust and TS verify paths,
> with tests).
>
> **Medium — genuinely still open (4), none release-blocking on their own:**
> - **MED-14** — M3U attribute escaping for provider-controlled channel fields:
>   the `escapeM3uAttr` helper is not locatable in the current `iptv.ts`; the M3U
>   export path needs a re-grep to confirm whether escaping moved or is absent.
> - **MED-16** — synchronous gzip of the EPG grid (event-loop block): the
>   `gzipSync` call wasn't found at the old locus; verify the current compression
>   point is async/streamed before closing.
> - **MED-17** — strict single-use segment tokens break legitimate HLS
>   seek-back/buffer-recovery refetch (IPTV path). Needs a replay-window decision,
>   not just a fix.
> - **MED-18** — stream/segment bearer tokens can still reach stdout via
>   `hono/logger()`; add URL/token redaction middleware.
>
> The 45 Low findings were **not** re-swept in this pass; treat their counts as
> unverified until a dedicated low-tier review runs.

**Date:** 2026-05-30  
**Method:** 12-dimension read-only review (auth, backend, IPTV, data, frontend, Rust, Python, infra, observability, testing, deps, prior-audit follow-up), each finding adversarially re-verified against the live code (refute-by-default).  
**Raw findings:** 90 → **confirmed:** 80, refuted: 10.

Severity of confirmed: **2 critical, 7 high, 26 medium, 45 low.**

All CI gates verified green from scratch after the fixes (lint, tsc×2, vitest, cargo fmt/clippy/test, pytest).

**Fixed this pass:** all critical + all high + the clippy gate + 8 mediums/lows (16 findings across 7 commits). The rest are tracked below.

## CRITICAL (2)

| # | Status | Commit | Finding | Location |
|---|--------|--------|---------|----------|
| 1 | ✅ fixed | 08f098a | Device-token mint (/api/auth/device/poll) bypasses the invite/members allowlist — invitation-only model and me | `server/routes/device.ts device.post('/poll') lines 99-178 (m` |
| 2 | ✅ fixed | 34f691e | Deploy script never restarts cloudflared after recreating the backend → public site 502/down after every deplo | `scripts/deploy-nas.sh lines 204-232 (compose up -d --build) ` |

## HIGH (7)

| # | Status | Commit | Finding | Location |
|---|--------|--------|---------|----------|
| 1 | ✅ fixed | 08f098a | Cross-provider admin privilege escalation: Apple/passkey role derived from attacker-chosen email local-part ma | `server/auth.ts apple handler lines 392-395 (roleFor(displayN` |
| 2 | ✅ fixed | 5aeb6c0 | Media streaming proxy fully buffers every response into memory (no streaming/backpressure) and caps streams at | `server/services/upstream.ts fetchWithTimeout, lines 33-43; c` |
| 3 | 🟡 partial | 34f691e | recommender entrypoint chown fails under cap_drop ALL → crash-loop on every fresh volume | `recommender/docker-entrypoint.sh lines 6-9 (chown -R) intera` |
| 4 | ✅ fixed | 34f691e | media-core cannot write media.db on a fresh volume → boot crash-loop regardless of USE_MEDIA_CORE | `crates/media-core/Dockerfile Dockerfile line 54 (USER mediac` |
| 5 | ✅ fixed | 34f691e | Deploy script has no post-deploy healthcheck and no rollback — a crash-looping backend ships silently | `scripts/deploy-nas.sh lines 237-243 (final verification)` |
| 6 | ✅ fixed | 5aeb6c0 | AVPlayer/remux concurrency slot is reaped after 30s, defeating the upstream connection cap | `server/routes/iptv.ts grant at lines 509-516 + 527-534; serv` |
| 7 | ✅ fixed | 34f691e | /api/health reports healthy unconditionally — docker healthcheck and cloudflared gate trust it | `server/app.ts line 81 (app.get('/api/health'))` |

## MEDIUM (26)

| # | Status | Commit | Finding | Location |
|---|--------|--------|---------|----------|
| 1 | ✅ fixed | f73f7be | CI rust job reports green while `cargo clippy -D warnings` actually fails (8 errors) — gate is advisory on `ma | `.github/workflows/ci.yml rust job, `cargo clippy` step lines` |
| 2 | ✅ fixed | post-ledger | media-core/transcoder internal-principal defaults now enforce/fail-closed in production compose | `docker-compose.yml media-core/transcoder MEDIA_INTERNAL_PRINCIPAL_MODE` |
| 3 | ✅ fixed | post-ledger | CI now validates compose config, builds the backend image, and builds sidecar images on `main` | `.github/workflows/ci.yml docker-build job` |
| 4 | ⬜ open | — | Suggestions route can issue ~30+ concurrent unbounded TMDB /search lookups per request (rate-limit self-DoS) | `server/routes/suggestions.ts validate(), lines 2362-2366 (Pr` |
| 5 | ✅ fixed | c3871be | iptv.db connection is missing busy_timeout pragma — concurrent reader/writer or backup gets SQLITE_BUSY thrown | `server/services/iptvDb.ts openIptvDb, lines 43-45` |
| 6 | ✅ fixed | c3871be | No integrity_check on backup snapshots or on restore — a corrupt VACUUM INTO copy is silently trusted | `server/services/dbBackup.ts runScheduledBackup / vacuumIntoH` |
| 7 | ✅ fixed | post-ledger | CI now runs npm audit, cargo audit, and pip-audit in the `audit` job | `.github/workflows/ci.yml audit job` |
| 8 | ⬜ open | — | GPL-3.0 ffmpeg/libx264 bundled in every shipped image with no source offer, attribution, or THIRD-PARTY-LICENS | `Dockerfile Dockerfile:91; crates/media-core/Dockerfile:30; c` |
| 9 | ⬜ open | — | Sidecar Dockerfile base images are tag-only (unpinned) while the main image is digest-pinned — non-reproducibl | `recommender/Dockerfile recommender/Dockerfile:16 & :42; crat` |
| 10 | ✅ fixed | post-ledger | Recommender Docker image now installs from committed `requirements.lock`; CI audits that shipped lockfile | `recommender/requirements.lock`; `.github/workflows/ci.yml audit job` |
| 11 | ⬜ open | — | Grant failures other than 429 produce a silent unhandled promise rejection — no error UI for the user | `src/components/tabs/LiveTab.tsx playChannel (lines 93-110) /` |
| 12 | ⬜ open | — | Single root-only error boundary: one tab's lazy-chunk failure tears down the entire authenticated SPA | `src/App.tsx Shell <Suspense> (lines 84-86), TABS lazy import` |
| 13 | ⬜ open | — | Direct-docker deploy fallback ships the backend without any of the compose security hardening | `scripts/deploy-nas.sh lines 217-231 (docker run fallback bra` |
| 14 | ⬜ open | — | M3U playlist injection via unescaped newlines/quotes in provider-controlled channel fields | `server/routes/iptv.ts escapeM3uAttr (267-269) and the #EXTIN` |
| 15 | ⬜ open | — | Unbounded sniffBuf growth on an unclosed/stray '<channel' token in the 151MB EPG feed | `server/services/iptvEpg.ts extractChannelDefs() slice logic,` |
| 16 | ⬜ open | — | Synchronous gzipSync of the ~28MB EPG grid blocks the event loop for all requests | `server/routes/iptv.ts /epg/grid handler, lines 224-238 (gzip` |
| 17 | ⬜ open | — | Segment tokens are strict single-use, so any HLS segment re-fetch (seek-back, buffer recovery) fails permanent | `server/routes/iptv.ts /stream/segment replay check (1116-111` |
| 18 | ⬜ open | — | Stream/segment bearer tokens leak into stdout container logs via hono/logger | `server/app.ts line 49 (app.use('*', logger())) + token URLs ` |
| 19 | ✅ fixed | 0dd1aca | DB backup job failures are console-only and never reach the mandatory Glitchtip pipeline | `server/services/dbBackupScheduler.ts registerDbBackupSchedul` |
| 20 | ✅ fixed | 0dd1aca | IPTV scheduler (sync + tombstone sweep) failures are console-only, not reported to telemetry | `server/services/iptvScheduler.ts lines 27, 36, 49 (bootstrap` |
| 21 | ✅ fixed | 0dd1aca | Recommender hot-path failure (scoreOnce) is logged to console only, not telemetry — silent personalization out | `server/routes/suggestions.ts lines 2027-2032 (catch around s` |
| 22 | ⬜ open | — | Recommender Python sidecar has zero Sentry/Glitchtip wiring — crashes invisible in mandatory pipeline | `recommender/pyproject.toml no sentry-sdk dependency; recomme` |
| 23 | ⬜ open | — | /score and all event endpoints 503 hard-down when RECOMMENDER_EVENT_SECRET is unset, and the compose default l | `recommender/app/main.py require_event_secret (lines 113-120)` |
| 24 | ⬜ open | — | Same-second transcode start for one (kind,id,sub) silently hijacks the first session and orphans its playback | `crates/transcoder/src/session.rs start() / session_id = form` |
| 25 | ⬜ open | — | Device-token JWE exp/nbf claims are never enforced against the clock on verify | `crates/emerald-contracts/src/device_token.rs decrypt() lines` |
| 26 | ⬜ open | — | Device-token expiry is not enforced in the TS verify path and is not tested | `server/session.ts verifyDeviceToken, lines 269-324` |

## LOW (45)

| # | Status | Commit | Finding | Location |
|---|--------|--------|---------|----------|
| 1 | ⬜ open | — | Recommender pytest broadening (whole-suite collection) is uncommitted — CI still gates only 3 hand-picked pari | `.github/workflows/ci.yml recommender job parity step; commit` |
| 2 | ⬜ open | — | Unauthenticated, unthrottled passkey and device-pair endpoints allow unbounded challenge/ulid row creation (Do | `server/routes/passkey.ts passkey routes lines 47-126; device` |
| 3 | ⬜ open | — | CSRF Origin gate exempts any request that presents a Bearer header and omits a Cookie — a logged-out attacker  | `server/middleware/csrf.ts isBearerOnly lines 38-42; requireS` |
| 4 | ⬜ open | — | Session cookie SameSite=None applied unconditionally in prod even for first-party/native flows; dev fallback d | `server/session.ts setSessionCookie lines 424-433; verifiedPl` |
| 5 | ⬜ open | — | Device-token verifier accepts role='guest' that the Role type/authz model does not define, propagating an unmo | `server/session.ts verifyDeviceToken line 286 and cast line 3` |
| 6 | ⬜ open | — | WebAuthn ceremonies run with requireUserVerification:false, accepting assertions/registrations with no user pr | `server/services/webauthn.ts verifyRegistration line 151; ver` |
| 7 | ⬜ open | — | SAB queue-mutation routes forward the nzoId path param to upstream without validation | `server/routes/sab.ts pause/resume/delete handlers, lines 80-` |
| 8 | ⬜ open | — | Notifications POST can leave a duplicate Discord connector when create response lacks an id and findEmerald fa | `server/routes/notifications.ts POST /discord, lines 289-292` |
| 9 | ⬜ open | — | Expired device_tokens, iptv_playlist_tokens and webauthn_credentials/challenges are never swept — unbounded ta | `server/services/reconcileDeviceToken.ts device_tokens / iptv` |
| 10 | ⬜ open | — | Migration 0003 uses non-idempotent bare ALTER TABLE / CREATE INDEX — re-run on a DB whose ledger row was lost  | `server/migrations/iptv/0003_link_tombstones.sql lines 6 and ` |
| 11 | ⬜ open | — | Migrator schema-checksum drift only WARNs — a changed already-applied migration silently diverges schemas | `server/services/migrator.ts applyMigrations, lines 255-268 (` |
| 12 | ⬜ open | — | JSONL tail reader can corrupt lines at 64KB chunk boundaries that split a multi-byte UTF-8 character | `server/services/usageLog.ts readTail / readTailUntilCutoff (` |
| 13 | ⬜ open | — | uuid buffer-bounds-check advisory (GHSA-w5hq-g745-h8pq, CVSS 7.5) reachable via node-cron in production deps | `package.json package.json:40 ("node-cron": "^3.0.3")` |
| 14 | ⬜ open | — | @napi-rs/cli floats `^3.7.0` in the ABI-critical wire-format binding builder while the Dockerfile pins it exac | `crates/emerald-contracts-napi/package.json crates/emerald-co` |
| 15 | ⬜ open | — | brace-expansion ReDoS/DoS advisory (GHSA-jxxr-4gwj-5jf2) present in dev/build tree | `package.json transitive (node_modules/brace-expansion 5.0.2-` |
| 16 | ⬜ open | — | Two IPTV player/detail modals declare aria-modal but ship no focus trap, Escape, or focus restoration | `src/components/tabs/VodTab.tsx VodTab player modal div (line` |
| 17 | ⬜ open | — | M3U export blocks the UI thread with alert() and swallows generatePlaylist errors silently | `src/components/tabs/LiveTab.tsx Export M3U onClick (lines 27` |
| 18 | ⬜ open | — | Animated favicon re-encodes a PNG via toDataURL on the main thread at 14fps for the entire session | `src/lib/animatedFavicon.ts pump() (lines 88-104), mountAnima` |
| 19 | ⬜ open | — | VodTab/IptvSeriesTab favorite toggles render no error state when the favorites store is unreachable | `src/components/tabs/VodTab.tsx fav toggle button onClick (li` |
| 20 | ⬜ open | — | Dead TabPlaceholder component ships a console.log probe into the production bundle | `src/components/tabs/TabPlaceholder.tsx probe.onConfirm conso` |
| 21 | ⬜ open | — | Sidecar Dockerfiles use floating base tags while the backend is digest-pinned — non-reproducible builds and un | `crates/transcoder/Dockerfile transcoder/Dockerfile lines 13,` |
| 22 | ✅ fixed | post-ledger | real-ffmpeg verification gate now triggers on transcoder plus media-core, emerald-contracts, Cargo.toml, and Cargo.lock changes | `.github/workflows/transcoder-ffmpeg.yml paths` |
| 23 | ✅ fixed | post-ledger | CI now runs npm audit, cargo audit, and pip-audit in the `audit` job | `.github/workflows/ci.yml audit job` |
| 24 | ⬜ open | — | Attacker-controlled 'ext' path segment is interpolated unencoded into the upstream provider URL | `server/routes/iptv.ts /stream/vod/:streamId/:ext (1025-1040)` |
| 25 | ⬜ open | — | Non-constant-time comparison of the recommender export secret | `server/routes/iptv.ts /export/recommender, line 1190` |
| 26 | ✅ fixed | 0dd1aca | reportServerEvent relay bypasses the §15.3 PII scrubber when POSTing context to Glitchtip | `server/services/serverTelemetry.ts reportServerEvent, lines ` |
| 27 | ⬜ open | — | Stale recovery runbook: references docker volume glitchtip-postgres, but compose renamed it to glitchtip-pgdat | `docs/operations/glitchtip-setup.md lines 198, 202 (§6) and l` |
| 28 | ⬜ open | — | autoSessionTracking: false is mandated by the runbook but set in no SDK init | `server/index.ts Sentry.init lines 40-49 (server) and src/lib` |
| 29 | ⬜ open | — | No request-id / correlation ID on any request — logs and telemetry events cannot be tied together | `server/app.ts middleware stack lines 43-79 (onError + logger` |
| 30 | ⬜ open | — | Optimizer eval runs recipe scoring against the LIVE production DB connection inside the nightly job, contendin | `recommender/workers/optimizer.py _evaluate_entries (lines 45` |
| 31 | ⬜ open | — | Empty-string sub bypasses namespace validation when the PyO3 binding is unavailable, then becomes a wildcard p | `recommender/app/sub_validation.py validate_sub (lines 42-54)` |
| 32 | ⬜ open | — | Holdout JSONL has no size cap; a large operator-supplied holdout makes /health (and every health probe) do unb | `recommender/workers/optimizer.py holdout_status (lines 439-4` |
| 33 | ⬜ open | — | Library-title-key dedup unions over a generator that is empty for an empty inline library; benign now but titl | `recommender/app/context.py load_user_context (line 237)` |
| 34 | ⬜ open | — | Internal-principal HKDF key derived once at import time; rotating INTERNAL_PRINCIPAL_SECRET requires a full pr | `recommender/app/internal_principal.py _KEY module global (li` |
| 35 | ⬜ open | — | Transcoder shutdown does not gracefully stop sessions or clean tmpdirs as documented; session dirs leak on eve | `crates/transcoder/src/main.rs shutdown_signal() doc + main()` |
| 36 | ⬜ open | — | Internal-principal verifier accepts any future exp; the 60s TTL invariant is not enforced | `crates/emerald-contracts/src/internal_principal.rs enforce_t` |
| 37 | ⬜ open | — | ffmpeg burn-in subtitle filtergraph path escaping is incomplete (filename comma / bracket breaks the encode) | `crates/transcoder/src/args.rs build_video_filter burn-in bra` |
| 38 | ⬜ open | — | verify_principal re-derives the HKDF key on every request on the hot internal-auth path | `crates/media-core/src/auth.rs verify_principal() lines 21-28` |
| 39 | ⬜ open | — | Library scan issues unbounded serial TMDB round-trips with per-call 5s timeout; a large library scan can run f | `crates/media-core/src/scanner.rs scan_once loop -> index_fil` |
| 40 | ✅ fixed | post-ledger | Coverage thresholds now exist; SPA floors are intentionally low and should be ratcheted upward | `vitest.config.ts coverage.thresholds` |
| 41 | ✅ fixed | post-ledger | Coverage scope now includes the SPA; coverage remains low and needs focused hook/player tests | `vitest.config.ts coverage.include + thresholds` |
| 42 | ⬜ open | — | Recommendation eval harness never runs in CI — recommendation quality and library-leak hygiene are not gated | `.github/workflows/ci.yml jobs (no eval:recs step anywhere); ` |
| 43 | ⬜ open | — | E2E suite never exercises real login or any playback path | `tests/e2e/auth.spec.ts whole e2e suite + tests/e2e/helpers/m` |
| 44 | ⬜ open | — | media proxy route test stubs out requireAuth, so its auth gate is never exercised | `server/routes/media.test.ts vi.mock('../middleware/auth.js')` |
| 45 | ⬜ open | — | tokenReplayCache GC-sweep test relies on real wall-clock timers — latent CI flake | `server/services/tokenReplayCache.test.ts 'removes expired en` |
