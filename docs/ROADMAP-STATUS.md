# theemeraldexchange — Roadmap Status

_Generated 2026-05-29. Updated 2026-06-07 to remove stale source/CI assumptions found during a full-project review; updated 2026-06-10 for web playback, the VAAPI hardware pipeline, and the wave-1 hardening campaign._

## Bottom Line

The backend half of the project is real and largely shipped: M1 (IPTV viewer), M1.5 (cross-service contract) and the M3 media-core are live on the NAS, and the M4 transcoder is deployed with real-library transcode **proven end-to-end in a real browser over the public path** (2026-06-08): the web SPA's `MediaPlayer` consumes media-core grants and plays transcoded HLS, hardware-encoded on the NAS iGPU via Intel VAAPI. The entire client half — every native Apple target (M2, M5) and the whole monetization tail (M6) — is unbuilt and **hard-blocked on Apple tooling**: Xcode is not installed and the Apple Developer Program membership (purchased 2026-05-29) is pending activation. **The single critical-path blocker is the Apple gate**; what remains buildable now is M4 stress/bench measurement evidence and the M3 perf/match-accuracy harnesses.

## Milestone Table

| id | title | status | % | one-line note |
|----|-------|--------|---|---------------|
| M1 | mybunny IPTV viewer + shared backbone | done | 98% | Shipped + live; cosmetic naming drift, a couple runtime facts trusted not re-proven |
| M1.5 | Cross-service compatibility contract | done | 98% | RATIFIED/LOCKED; Rust↔TS↔Python byte parity in CI; /version schemas + repo .gitattributes present |
| M2 | Swift SDK + tvOS/iOS apps + TestFlight | not-started | 5% | Spec-complete, zero Swift code; blocked on Xcode + Apple account + missing sibling repo |
| M3 | Media server core (Rust media-core) | mostly-done | 85% | Live in enforce mode, 793 movies/292 shows/20k episodes; web SPA now consumes grant/watch/stop (crit 4/5 demonstrated on web, 2026-06-07/08); perf + match-accuracy harnesses still missing |
| M4 | Transcoder + capability matching | in-progress | 75% | Deployed; real-library transcode PROVEN played in a real browser over the public path (2026-06-08); Intel VAAPI hardware encode + full-HW decode/tone-map live on the NAS iGPU; remaining = stress/bench evidence + seek re-measurement |
| M5 | Native clients (browse + playback + offline downloads) | not-started | 3% | Spec-only; extends the non-existent M2 EmeraldKit; offline downloads has zero code |
| M6 | Plex-Pass equivalent (DVR/intro/music/photos/sharing) | not-started | 3% | A menu, not a plan; one reserved enum line; correctly gated behind M5 |

---

## Per-Milestone Detail

### M1 — IPTV viewer + shared backbone — done (98%)
**DONE**
- All 10 success criteria (C1–C10) met in code; SHIPPED 2026-05-25, live (NAS via Cloudflare Tunnel + Netlify SPA).
- Idempotent 4-migration iptv chain, syncOnce orchestrator (mutex + 7-day EPG window), bootstrap-on-first-boot + 6h cron + nightly tombstone sweep.
- Paginated `/live`/`/vod`/`/series`; HMAC stream-grant + Range pass-through + HLS rewrite (all token/replay paths tested); web player (mpegts.js live, hls.js VOD) with audio/subtitle track switching; favorites + VOD resume; EPG past-programs + catchup; `available_on:['iptv']` suggestion tagging (tested); phase-4b remux-to-HLS for AVPlayer.
- 106 iptv tests green; `tsc --noEmit` clean.

**REMAINING**
- Cosmetic naming drift: criterion references `bootstrapOnce()`; actual symbol is `syncOnce()` via the `needsBootstrap` branch. Behavior equivalent.
- Test-coverage gap: track-switcher UI implemented but not unit-asserted (player test only checks progressive + HLS render).
- Runtime-only facts trusted per SHIPPED doc, not independently re-proven this pass: live EPG row count > 0 against real mybunny creds, panel-count parity, <200ms grid render, actual Chrome/Safari playback.

**BLOCKERS** — none.

### M1.5 — Cross-service compatibility contract — done (97%)
**DONE**
- Contract doc RATIFIED/LOCKED for M2 (2026-05-28); all 11 criteria met. `crates/emerald-contracts` test-vector crate (8 modules, 8 vector JSONs).
- Device-token JWE frozen (alg dir/A256GCM, kid device-v1, multi-key verify, 180-day TTL, revocation tables + middleware). Stream-token HMAC byte contract mirrored byte-for-byte TS↔Rust. Identity namespace prefixes (plex/local/apple) with backfill migrations. Resolution A executed (DESTRUCTIVE drop of iptv kinds, iptv_ingest worker removed, local-first precedence). Three-DB migration convention (schema_migrations, sha256 LF-normalized) in TS+Rust+Python. Internal-principal §4 Hybrid-D **deployed and LIVE in enforce mode on NAS**, cross-binding proven in CI. Telemetry PII scrubber + Glitchtip operator guide. LICENSE proprietary placeholder (intentional defer).
- CI has 4 jobs incl. Rust↔napi↔pyo3 cross-binding gate + IPTV_DISABLED insurance build. cargo workspace + 95 TS contract tests green; Python parity loads the same vectors.

**REMAINING**
- RESOLVED (2026-06-07): production internal-principal posture verified. `docker-compose.yml` now defaults media-core + transcoder to `enforce` (fail-closed, matching the recommender); prod confirmed already running enforce.
- Cosmetic: internal_principal iss `'eex'` vs doc's illustrative `'eex-hono'` (internally consistent).
- Swift port of contracts correctly deferred to M2/M5 (vectors are the oracle it must satisfy).

**BLOCKERS** — none.

### M2 — Swift SDK + tvOS/iOS apps + TestFlight — not-started (5%)
**DONE**
- Fully specced and plan-ready (10-phase execution spec, Pre-execution status). Backend substrate the Apple client consumes is built+tested (M1, not M2): VOD direct-HLS grant, live `?client=avplayer` remux grant, device PIN pairing + Bearer device-token middleware. Wire-format vectors carrying tvos/ios platforms exist and are CI-guarded. One pre-staged `PrivacyInfo.xcprivacy`.

**REMAINING**
- **Everything that is the deliverable.** Zero Swift lines (`find -name '*.swift'` = 0), no Package.swift, no SPM workspace, no Xcode project. EmeraldContracts Swift port, EmeraldKit SDK, EmeraldTV (tvOS), EmeraldMobile (iOS) — all not started. No end-to-end PIN→Keychain→browse, no AVPlayer consuming any grant. No TestFlight pipeline (no sibling repo, no apple-ci.yml, no Fastlane/ExportOptions). No archive ever produced. App Store Connect prereqs unconfigured.

**BLOCKERS**
- **Xcode not installed** — hard gate on every M2 criterion.
- **Apple Developer Program membership pending activation** (purchased 2026-05-29) — no App Store Connect, signing, TestFlight, or Universal Purchase bundle ID.
- Mandated Apple code home (sibling `theemeraldexchange-apple/` repo) not created — Swift work has nowhere to live.

### M3 — Media server core (Rust media-core) — mostly-done (85%)
**DONE**
- Single Rust binary, edition 2024. Reliable scan pipeline (skip-unchanged, ffprobe, classify, upsert) + boot/periodic scheduler with single-flight guard. **TMDB now wired into scan** (closes prior audit H1) — live enrichment at scale: 793 movies / 292 shows / 20054 episodes. TV matching implemented (no English-only gate). Direct-play decision is a clean pure function (10 matrix tests); **503/handoff now enforced** (closes audit M1 dead-code finding). Watch-state backend complete + acting_sub IDOR guard. Internal-principal boundary LIVE in ENFORCE mode, container healthy. 104 tests green (up from 42 at audit).

**REMAINING**
- Crit 2 UNPROVEN: no 100-file <5s perf/fixture test exists — only a doc-comment target.
- Crit 3 UNPROVEN: >=95% match accuracy is asserted, not benchmarked. The matcher now scores candidates by stopword-aware title similarity and rejects zero-overlap hits, but no accuracy benchmark/eval exists to falsify the bar; a language filter is still absent.
- Crit 4 WEB HALF MET (2026-06-07/08): the web SPA consumes the grant path end-to-end — `src/lib/api/media.ts` (grant/watch/stop + paged `allMovies`/`allShows`) feeds `src/components/media/MediaPlayer.tsx` in the Movies/TV tabs, proven playing in a real Chrome over the public path. The *cross-platform* half (a second platform, tvOS) remains Apple-blocked.
- Crit 5 WEB HALF MET: the web client reads and writes `/api/media/watch` (progress rows + heartbeat persistence). Same-sub web↔tvOS sync is still undemonstrated — there is no second platform to sync against.

**BLOCKERS**
- tvOS (the second platform for crit 4/5 cross-platform claims) blocked on Xcode; the web half is done.
- No measurement harness for crit 2/3 — both bars currently unfalsifiable in-repo.

### M4 — Transcoder + capability matching (the long pole) — in-progress (75%)
**DONE**
- Real Rust crate, tests green (310 across the cargo workspace as of 2026-06-10). Capability-matching planner delegates to media-core decide then computes smallest per-stream re-encode (hevc→h264, 4K→1080p, HDR→SDR, codec copy/remux). Complete snapshot-tested ffmpeg arg assembly (HLS, HW encoder selection, scale/tonemap filtergraph). Boot-time `ffmpeg -encoders` probe + per-encoder smoke test with libx264 fallback. 30s heartbeat-loss reap + SIGTERM→SIGKILL + tmpdir cleanup; sessions bound to the verified principal (owner-or-admin enforced, wave 1). Seek/resume = kill+respawn with server-baked `-ss`. Concurrency caps with leak-safe permits → 503 transcoder_busy; hardware sessions charge the global cap (4), only true CPU re-encodes charge the CPU cap. **media-core→transcoder handoff fully wired** (mints internal-principal bearer; degrades to 503 on outage). **Intel VAAPI hardware encode LIVE on the NAS iGPU (2026-06-08):** the image ships Debian's stock ffmpeg + `intel-media-va-driver`, `h264_vaapi -low_power 1` is the primary encoder, and a full-HW decode→`tonemap_vaapi`→`scale_vaapi` pipeline (`8d4c373`) is gated by a source-codec allowlist + boot probe, with software fallback proven. 4K HDR10→1080p-class H.264 tone-mapped on GPU; 3 concurrent HEVC→H.264 GPU sessions proven. Browser-audio planning fixed (wave of 2026-06-08 playback fixes): non-AAC audio re-encodes to stereo AAC, AAC copied only at ≤2ch.

**REMAINING / NOT MET**
- **Crit 1 MET (playback): real-library transcode proven PLAYED end-to-end (2026-06-08).** Beyond the 2026-06-07 serving proof (`scripts/m4-transcode-proof.sh`, docs/M4-TRANSCODE-VERIFICATION.md), the web SPA's `MediaPlayer` played the transcoded HLS stream in a real Chrome over the full public path — laptop → Cloudflare → cloudflared → backend `/api/transcode` proxy → media-core → transcoder — including resume (`scripts/media-playback-proof.sh`). Stress-test phase (non-optional per spec) still not performed; no bench artifacts exist.
- Crit 2 UNMEASURED: no evidence h264 1080p sustains real-time on Apple Silicon — the deployed NAS target is x86 with Intel VAAPI (no VideoToolbox), so the Apple-Silicon claim is untestable on the current deployment. NAS-side real-time encode is informally evidenced (live sessions play without stalling) but not formally measured.
- Crit 3 PARTIALLY EVIDENCED: VAAPI sessions are not CPU-charged, so 4 concurrent re-encodes are now *permitted*; 3 concurrent HEVC→H.264 GPU sessions were proven (2026-06-08), but the formal 4-concurrent-under-80%-CPU capture still doesn't exist.
- Crit 4 PARTIAL: reap/cleanup unit-tested, and deployed children have now served real library sessions through the playback-fix campaign (idle reap + stop-on-close exercised live), but no formal long-running soak has been recorded.
- Crit 5 MET: `TRANSCODER_FORCE_CPU=1` forces libx264 regardless of `TRANSCODER_HW_ENCODER`.
- Crit 6 STALE MEASUREMENT: the ~23–27s post-seek figure was taken on the CPU/libx264 pipeline and predates both VAAPI hardware encode and the forced-keyframe segment cadence (`0cda2f4`); current grants reach first segment in ~2.6–4.5s. Seek latency must be re-measured against the "<2s" target before claiming pass or fail.
- HW-encoder breadth: VAAPI (encode + full-HW decode/tone-map) is real and proven; VideoToolbox/NVENC/QSV still exist only as arg strings, never run. PGS burn-in is planner-dropped (a sidecar-subtitle path is a known follow-up). audio_codecs capability gap: planner uses a browser-safe stereo-AAC baseline rather than `ClientCaps.audio_codecs`; only first audio track mapped (per-client 5.1 passthrough deferred).

**BLOCKERS**
- Apple-Silicon perf criteria blocked on deployment target (NAS = x86 VAAPI, no VideoToolbox) + no AS transcode host.
- Remaining M4 proof is measurement, not function: stress/bench CPU evidence, a formal soak, and seek re-measurement are the open items.
- No stress harness; building/running one on NAS hardware is the gating non-optional step.

### M5 — Native clients for media server — not-started (3%)
**DONE**
- Spec fully written + reconciled (phases, success outputs, sequencing). Criterion 3/4/5 met as documentation facts (verification deferred to own brainstorm cycle; hard M3+M4 dependency documented; M5.5 compile-flag-IPTV-disabled-default policy detailed). Prereqs M3 (live) + M4 (deployed today) exist in source. One `PrivacyInfo.xcprivacy` stub.

**REMAINING**
- Crit 2 NOT MET: the EmeraldKit Swift package M5 extends does not exist (0 .swift files). All phases (MediaService + models, continue-watching/library browse, player+transcoder grants, unified suggestions) unimplemented.
- **Offline downloads — the headline M5 capability — has ZERO implementation:** no download UI, no client manager, no `/api/media/download` endpoint. ("offline" in source = transcoder 503 degradation + source precedence only.)

**BLOCKERS**
- Xcode not installed; Apple Developer membership pending — neither the M2 EmeraldKit foundation nor the M5 extension can be built.
- Hard sequencing: M5 needs M3 (live) AND M4's playback proof — both now exist: the web SPA's `MediaPlayer` consumes the grant path end-to-end (2026-06-08), so the native clients have a working reference implementation to mirror. M2 (the EmeraldKit SDK M5 extends) is unbuilt — though UI can develop in parallel against a mocked media-core API.

### M6 — Plex-Pass equivalent — not-started (3%)
**DONE**
- Documented as a portfolio menu (DVR, intro/credits, music, photos, sharing) — the criterion-6 deliverable exists. One line of M6 code: `StreamKind::Recording` reserved in the stream-token contract (accepted by verifiers, minted by nothing). DVR reuse-infra from M1 exists (epg_programs table, MIN_FREE_GB gate, max-concurrent-streams, transcoder arg builder). Rust-stability precondition trending true.

**REMAINING**
- All 5 feature buckets NOT BUILT: no recordings table / record button / scheduler / mp4-to-disk path (existing remux emits HLS, not mp4); no intro-marker table or scene-detect worker; no music library kind / MusicBrainz; no EXIF/sharp photos; no per-library shares table (members/invites is authZ, a different concept). Per-feature brainstorm→spec→plan→implement cycles not started.

**BLOCKERS**
- By design: M6 is a menu to pick from AFTER M5 ships. M5 unshipped (gated on M3+M4 + Apple-blocked native clients). Correctly not-started, not behind schedule.

---

## Critical Path (dependency-ordered)

The project splits cleanly into a **buildable-now backend track** and an **Apple-blocked client track**. The Apple gate is the dominant constraint.

**Buildable now (no Apple dependency):**
1. ~~Exercise a real player against the M4 path~~ — **DONE 2026-06-08.** The web SPA's `MediaPlayer` plays the transcoded stream in a real Chrome over the full public path (laptop → Cloudflare → cloudflared → backend `/api/transcode` proxy → media-core → transcoder), including resume; harness `scripts/media-playback-proof.sh`.
2. **Build the M4 stress/bench harness on NAS hardware** (non-optional per spec) and capture CPU/latency for crit 2/3/6. The old ~23-27s seek figure predates the VAAPI pipeline and forced-keyframe cadence — re-measure before treating the "<2s" target as pass or fail.
3. **Add M3 measurement harnesses:** 100-file <5s scan-timing fixture (crit 2) and a TMDB match-accuracy eval against the title-scoring matcher (crit 3). Both bars are still unfalsifiable without fixtures.
4. ~~Wire the web SPA media-core consumer~~ — **DONE 2026-06-07.** `src/lib/api/media.ts` exposes grant/watch/stop (+ paged `allMovies`/`allShows`) and `MediaPlayer` is wired into the Movies/TV tabs; M3 crit 4/5 demonstrated on web.
5. ~~Unblock `/media/Movies` for service uids~~ — **DONE 2026-06-07.** Share loosened `0700` → `0755`; media-core (10002) and transcoder (10003) read the full movie library.
6. **M5 UI in parallel against a mocked media-core API** — the only M5 work possible pre-Apple, per spec.

**Blocked on the Apple gate (Xcode install + Developer Program activation + sibling `theemeraldexchange-apple/` repo):**
7. **M2** in full: EmeraldContracts Swift port (4th binding against the frozen vectors) → EmeraldKit SDK → EmeraldTV/EmeraldMobile → TestFlight pipeline. **Nothing here can start until Xcode is installed and the account activates.** Create the sibling repo the moment those land.
8. **M5** native media-server clients + offline downloads (needs M2 shipped AND M4 proven).
9. **M6** monetization menu — selectable only after M5 ships.

**Monetization / M6 risk flags:**
- **ffmpeg licensing:** the transcoder image now ships Debian's apt ffmpeg + the Intel VAAPI stack (`h264_vaapi` primary; libx264 only as the boot-probe fallback), while the backend and media-core images still copy the static `mwader/static-ffmpeg` binary. Every variant enables GPL x264, so for App-Store/paid distribution the licensing question must be resolved before any binary ships commercially — not yet addressed anywhere in the repo.
- **IPTV legal/compliance risk:** the M5.5 policy already makes the **IPTV-disabled compile-flag build the default public artifact** (good), but the IPTV feature's distributability is the structural reason that policy exists; treat any monetized build's IPTV surface as a standing risk.

---

## Update 2026-06-10 — hardening campaign (wave 1)

A repo-wide review-and-fix campaign landed on `main` (merge train `2f5b727`…`fcf0057`).
No milestone percentages moved — this was correctness/security debt, not feature work:

- **Transcoder session lifecycle + ownership** (`1646a80`): sessions are bound to
  the verified principal with owner-or-admin enforcement on every session
  operation.
- **media-core scanner/probe/db hardening** (`2f5b727`): scanner panic paths,
  watch-state, and library pruning fixed.
- **suggestions.ts god-file decomposed** (`29babc7`): the route is now
  parse/snapshot/dispatch over nine `server/services/suggestions*` modules
  (TMDB client, library cache, prompt building, Claude + recommender path
  runners, validation, recently-shown state, shared helpers).
- **Stream-token single-key** (`6dd8619`): the expired D2a dual-key fallback and
  M1 token grace paths were removed; `STREAM_TOKEN_SECRET` is the single
  signing/verifying secret.
- **Recommender scoring tests** (`872c4fe`): behavioral suite for the core
  scoring path; fresh-DB boot unbricked (`29d85be`).

Gates after the campaign, all green: **vitest 1793** · **cargo 310** · **pytest 189**.

## Update 2026-05-31 (supersedes the 05-29 "What Changed" notes below)

The 05-29 synthesis below predates two merges now on `main` (HEAD `155f73f`):

1. **Passkeys are LIVE in prod.** WebAuthn cross-platform login/register shipped
   2026-05-30; the passkey/device-auth work described as "unmerged on
   `m3-media-core`" in item 3 below **is now merged to `main`.** Treat item 3 as resolved.
2. **Production-readiness review (2026-05-30):** all critical + high findings
   fixed; ~63 medium/low open. See
   [docs/PRODUCTION-READINESS-2026-05-30.md](./PRODUCTION-READINESS-2026-05-30.md).

The milestone table above (M1–M6 status/%) was unchanged by this update and was current as of 2026-05-31; the 2026-06-10 update has since moved M3/M4.

## What Changed This Session (supersedes stale roadmap memory)

The canonical memory note ("M1 shipped, M1.5 contract gate before M2") is now stale on the backend. This session advanced three things:

1. **M4 transcoder deployed to NAS.** `exchange-transcoder` container is up + healthy, libx264 present, `/health` ok, reachable on the docker net, and media-core is wired to it via `MEDIA_TRANSCODER_URL`. The media-core→transcoder handoff is fully wired (not a stub) and degrades to the pre-M4 503 path on outage. **Caveat:** deployed ≠ proven — no real non-direct-play file has transcoded+played end-to-end. 55 transcoder tests green, but against a shell stub.
2. **Internal auth overhaul is LIVE.** The M1.5 §4 internal-principal JWE boundary (Hybrid-D) is deployed and running in **ENFORCE mode** on the NAS in media-core; cross-binding (N-API mint ↔ PyO3 decrypt) is gated in CI. This is a meaningful security posture change from spec-only to enforced-in-prod.
3. **Passkey / device-auth branch unmerged.** This work is on branch `m3-media-core` (current). Device-token JWE + PIN-pairing + Bearer middleware + revocation tables are implemented and tested, but the broader passkey/auth work has **not been merged to `main`** — `main` does not yet carry these changes. Treat the passkey branch as the integration risk to track before the next milestone gate.

M3 also moved from the 2026-05-28 audit state: TMDB-unwired, dead-503, and no-scheduler findings are **closed**; the media-core library-UI consumer gap persists.
