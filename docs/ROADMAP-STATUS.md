# theemeraldexchange — Roadmap Status

_Generated 2026-05-29. Updated 2026-06-07 to remove stale source/CI assumptions found during a full-project review._

## Bottom Line

The backend half of the project is real and largely shipped: M1 (IPTV viewer), M1.5 (cross-service contract) and the M3 media-core are live on the NAS, and the M4 transcoder is deployed with real-library transcode now proven end-to-end (2026-06-07). The entire client half — every native Apple target (M2, M5) and the whole monetization tail (M6) — is unbuilt and **hard-blocked on Apple tooling**: Xcode is not installed and the Apple Developer Program membership (purchased 2026-05-29) is pending activation. **The single critical-path blocker is the Apple gate**; secondarily, M4's deployed transcoder is now proven to transcode a real non-direct-play file and serve `ffprobe`-validated HLS end-to-end; what remains for M5 playback is a real client consuming that stream, plus stress/bench evidence.

## Milestone Table

| id | title | status | % | one-line note |
|----|-------|--------|---|---------------|
| M1 | mybunny IPTV viewer + shared backbone | done | 98% | Shipped + live; cosmetic naming drift, a couple runtime facts trusted not re-proven |
| M1.5 | Cross-service compatibility contract | done | 98% | RATIFIED/LOCKED; Rust↔TS↔Python byte parity in CI; /version schemas + repo .gitattributes present |
| M2 | Swift SDK + tvOS/iOS apps + TestFlight | not-started | 5% | Spec-complete, zero Swift code; blocked on Xcode + Apple account + missing sibling repo |
| M3 | Media server core (Rust media-core) | mostly-done | 75% | Live in enforce mode, 793 movies/292 shows/20k episodes; perf + match-accuracy unproven, no client consumer |
| M4 | Transcoder + capability matching | in-progress | 60% | Deployed; real-library transcode PROVEN end-to-end (serves `ffprobe`-validated HLS, 2026-06-07; found+fixed a /scratch EACCES bug); remaining = real client player path + stress/bench |
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

### M3 — Media server core (Rust media-core) — mostly-done (75%)
**DONE**
- Single Rust binary, edition 2024. Reliable scan pipeline (skip-unchanged, ffprobe, classify, upsert) + boot/periodic scheduler with single-flight guard. **TMDB now wired into scan** (closes prior audit H1) — live enrichment at scale: 793 movies / 292 shows / 20054 episodes. TV matching implemented (no English-only gate). Direct-play decision is a clean pure function (10 matrix tests); **503/handoff now enforced** (closes audit M1 dead-code finding). Watch-state backend complete + acting_sub IDOR guard. Internal-principal boundary LIVE in ENFORCE mode, container healthy. 104 tests green (up from 42 at audit).

**REMAINING**
- Crit 2 UNPROVEN: no 100-file <5s perf/fixture test exists — only a doc-comment target.
- Crit 3 UNPROVEN: ≥95% match accuracy is asserted, not benchmarked. The matcher now scores candidates by stopword-aware title similarity and rejects zero-overlap hits (no longer blind `results.first()`), but no accuracy benchmark/eval exists to falsify the bar; a language filter is still absent.
- Crit 4 cross-platform UNPROVEN: backend grant correct but no client exercises it; web `mediaApi` exposes only movies/shows/episodes/scan — no grant/stream/watch consumer.
- Crit 5 NOT end-to-end: zero clients consume `/api/media/watch`; web position/grant wiring is IPTV-only. Same-sub web↔tvOS sync structurally possible, never demonstrated.

**BLOCKERS**
- Native clients (web library player + tvOS) gate crit 4/5; web SPA never wires media-core endpoints, tvOS blocked on Xcode.
- No measurement harness for crit 2/3 — both bars currently unfalsifiable in-repo.

### M4 — Transcoder + capability matching (the long pole) — in-progress (60%)
**DONE**
- Real Rust crate (3304 LoC), 55 tests green. Capability-matching planner delegates to media-core decide then computes smallest per-stream re-encode (10 plan tests: hevc→h264, 4K→1080p, HDR→SDR, codec copy/remux). Subtitles first-class (text→WebVTT, image→burn-in). Complete snapshot-tested ffmpeg arg assembly (HLS, HW encoder selection, scale/tonemap/burn-in filtergraph). Boot-time `ffmpeg -encoders` probe with libx264 fallback. 30s heartbeat-loss reap + SIGTERM→SIGKILL + tmpdir cleanup. Seek = kill+respawn with new `-ss`. Concurrency caps (4 global/1 CPU) with leak-safe permits → 503 transcoder_busy. **media-core→transcoder handoff fully wired** (mints internal-principal bearer; degrades to 503 on outage). Deployed to NAS this session — container up + healthy.

**REMAINING / NOT MET**
- **Crit 1 MET (serving): deployed real-library transcode proven end-to-end (2026-06-07).** The deployed enforce-mode transcoder was driven against a real HEVC 1080p library file: HEVC→H.264 in 2.6s to first segment, served `ffprobe`-validated h264/yuv420p/bt709 + aac over the authed HTTP path (harness `scripts/m4-transcode-proof.sh`; see docs/M4-TRANSCODE-VERIFICATION.md). This also found+fixed a `/scratch` tmpfs EACCES that meant the deployed transcoder had never actually transcoded. NOT yet proven: a real client *playing* the stream (serving + ffprobe only). Stress-test phase (non-optional per spec) still not performed; no bench artifacts exist.
- Crit 2 UNMEASURED: no evidence h264 1080p sustains real-time on Apple Silicon — and the deployed NAS target is x86 + static libx264 (no VideoToolbox), so the Apple-Silicon claim is untestable on the current deployment.
- Crit 3 UNMEASURED: 4-concurrent-under-80%-CPU unverified; NAS default max_cpu=1 won't even permit 4 CPU transcodes.
- Crit 4 PARTIAL: reap/cleanup unit-tested against the stub and argv fixture-tested against real ffmpeg, but not yet exercised as a long-running deployed child holding real library segments.
- Crit 5 MET: `TRANSCODER_FORCE_CPU=1` now exists and forces libx264 regardless of `TRANSCODER_HW_ENCODER`.
- Crit 6 MEASURED + FAILING: deployed seek (`?to=`) first post-seek segment took ~23–27s, far above the "<2s" target — seek is a full kill+respawn+re-encode, so the 2s bar needs a different approach (e.g. segment pre-seek / keyframe index), not just measurement.
- HW-encoder edge cases (VideoToolbox/NVENC/VAAPI/QSV, HDR/DV tone-map, PGS burn-in) exist only as arg strings, never run. audio_codecs capability gap: planner uses a hardcoded Apple-safe baseline (no ClientCaps.audio_codecs); only first audio track mapped.

**BLOCKERS**
- Apple-Silicon perf criteria blocked on deployment target (NAS = x86 no-VideoToolbox) + no AS transcode host.
- End-to-end proof (crit 1/2/3/4/6) blocked on running real library files under the deployed service and capturing playback, CPU, and latency evidence — not started.
- No stress harness; building/running one on NAS hardware is the gating non-optional step.

### M5 — Native clients for media server — not-started (3%)
**DONE**
- Spec fully written + reconciled (phases, success outputs, sequencing). Criterion 3/4/5 met as documentation facts (verification deferred to own brainstorm cycle; hard M3+M4 dependency documented; M5.5 compile-flag-IPTV-disabled-default policy detailed). Prereqs M3 (live) + M4 (deployed today) exist in source. One `PrivacyInfo.xcprivacy` stub.

**REMAINING**
- Crit 2 NOT MET: the EmeraldKit Swift package M5 extends does not exist (0 .swift files). All phases (MediaService + models, continue-watching/library browse, player+transcoder grants, unified suggestions) unimplemented.
- **Offline downloads — the headline M5 capability — has ZERO implementation:** no download UI, no client manager, no `/api/media/download` endpoint. ("offline" in source = transcoder 503 degradation + source precedence only.)

**BLOCKERS**
- Xcode not installed; Apple Developer membership pending — neither the M2 EmeraldKit foundation nor the M5 extension can be built.
- Hard sequencing: M5 needs M3 (live) AND M4 (deployed but not yet proven by a real non-direct-play transcode+play). M2 (the EmeraldKit SDK M5 extends) is unbuilt — though UI can develop in parallel against a mocked media-core API.

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
1. **Prove M4 deployed playback end-to-end.** The real-ffmpeg fixture test proves argv/playable-HLS generation; the remaining proof is a real non-direct-play library file under the deployed transcoder with one captured transcode+play. This is the highest-leverage unblock and remains a hard prerequisite for M5 playback.
2. **Build the M4 stress/bench harness on NAS hardware** (non-optional per spec) and capture CPU/latency for crit 2/3/6.
3. **Add M3 measurement harnesses:** 100-file <5s scan-timing fixture (crit 2) and a TMDB match-accuracy eval with title-similarity scoring/confidence threshold (crit 3). Both bars are currently unfalsifiable.
4. **Wire the web SPA media-core consumer** (grant/stream/watch in `mediaApi`) so M3 crit 4/5 can be demonstrated on at least one client without waiting for Apple.
5. **Verify deployment config:** prove production media-core/transcoder run with internal-principal enforcement, or make enforce mode the compose default.
6. **M5 UI in parallel against a mocked media-core API** — the only M5 work possible pre-Apple, per spec.

**Blocked on the Apple gate (Xcode install + Developer Program activation + sibling `theemeraldexchange-apple/` repo):**
7. **M2** in full: EmeraldContracts Swift port (4th binding against the frozen vectors) → EmeraldKit SDK → EmeraldTV/EmeraldMobile → TestFlight pipeline. **Nothing here can start until Xcode is installed and the account activates.** Create the sibling repo the moment those land.
8. **M5** native media-server clients + offline downloads (needs M2 shipped AND M4 proven).
9. **M6** monetization menu — selectable only after M5 ships.

**Monetization / M6 risk flags:**
- **ffmpeg licensing:** the transcoder ships static ffmpeg with libx264 (GPL/x264). For App-Store/paid distribution this is a licensing question that must be resolved before any binary ships commercially — not yet addressed anywhere in the repo.
- **IPTV legal/compliance risk:** the M5.5 policy already makes the **IPTV-disabled compile-flag build the default public artifact** (good), but the IPTV feature's distributability is the structural reason that policy exists; treat any monetized build's IPTV surface as a standing risk.

---

## Update 2026-05-31 (supersedes the 05-29 "What Changed" notes below)

The 05-29 synthesis below predates two merges now on `main` (HEAD `155f73f`):

1. **Passkeys are LIVE in prod.** WebAuthn cross-platform login/register shipped
   2026-05-30; the passkey/device-auth work described as "unmerged on
   `m3-media-core`" in item 3 below **is now merged to `main`.** Treat item 3 as resolved.
2. **Autoloop substrate landed (P0–P1).** A new out-of-band subsystem —
   `scripts/autoloop/` + `.autoloop/` — an autonomous codex mesh (P0 engine/guard/
   node-contract, P1 governor/kill-switch/supervisor/launchd). Not part of the
   product runtime; see [scripts/autoloop/README.md](../scripts/autoloop/README.md).
   P2–P5 pending. This is independent of the M1–M6 milestone track.
3. **Production-readiness review (2026-05-30):** all critical + high findings
   fixed; ~63 medium/low open. See
   [docs/PRODUCTION-READINESS-2026-05-30.md](./PRODUCTION-READINESS-2026-05-30.md).

The milestone table above (M1–M6 status/%) is unchanged and remains current.

## What Changed This Session (supersedes stale roadmap memory)

The canonical memory note ("M1 shipped, M1.5 contract gate before M2") is now stale on the backend. This session advanced three things:

1. **M4 transcoder deployed to NAS.** `exchange-transcoder` container is up + healthy, libx264 present, `/health` ok, reachable on the docker net, and media-core is wired to it via `MEDIA_TRANSCODER_URL`. The media-core→transcoder handoff is fully wired (not a stub) and degrades to the pre-M4 503 path on outage. **Caveat:** deployed ≠ proven — no real non-direct-play file has transcoded+played end-to-end. 55 transcoder tests green, but against a shell stub.
2. **Internal auth overhaul is LIVE.** The M1.5 §4 internal-principal JWE boundary (Hybrid-D) is deployed and running in **ENFORCE mode** on the NAS in media-core; cross-binding (N-API mint ↔ PyO3 decrypt) is gated in CI. This is a meaningful security posture change from spec-only to enforced-in-prod.
3. **Passkey / device-auth branch unmerged.** This work is on branch `m3-media-core` (current). Device-token JWE + PIN-pairing + Bearer middleware + revocation tables are implemented and tested, but the broader passkey/auth work has **not been merged to `main`** — `main` does not yet carry these changes. Treat the passkey branch as the integration risk to track before the next milestone gate.

M3 also moved from the 2026-05-28 audit state: TMDB-unwired, dead-503, and no-scheduler findings are **closed**; the media-core library-UI consumer gap persists.
