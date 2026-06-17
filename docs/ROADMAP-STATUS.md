# theemeraldexchange — Roadmap Status

_Generated 2026-05-29. Updated 2026-06-07 to remove stale source/CI assumptions found during a full-project review; updated 2026-06-10 for web playback, the VAAPI hardware pipeline, and the wave-1 hardening campaign; updated 2026-06-13 for the 06-11/12 streaming-stability wave and the 06-13 CI governance (see §Update 2026-06-13); **updated 2026-06-14 to reconcile the Apple client track against the sibling `theemeraldexchange-apple` repo — the "Apple gate" blocker was a measurement artifact (this repo is blind to the sibling by design), and M2/M5 are in fact built and hardened (see §Update 2026-06-14).**_

## Bottom Line

The backend half of the project is real and largely shipped: M1 (IPTV viewer), M1.5 (cross-service contract) and the M3 media-core are live on the NAS, and the M4 transcoder is deployed with real-library transcode **proven end-to-end in a real browser over the public path** (2026-06-08): the web SPA's `MediaPlayer` consumes media-core grants and plays transcoded HLS, hardware-encoded on the NAS iGPU via Intel VAAPI.

**The "Apple gate" is no longer the dominant blocker — it was opened on 2026-05-30, and this repo simply could not see it.** The native Apple client work (M2, M5) lives in the **sibling repo `theemeraldexchange-apple`** by design — Xcode artifacts are kept out of the server monorepo, so this repo's "zero `.swift` files" is correct but does **not** mean the work is unstarted. As of 2026-06-14 the sibling repo holds **Xcode 26.5 + Swift 6.3.2 live, ~197 Swift files, 589 test cases across 36 suites, an active Apple Developer membership** (App Store provisioning profiles for both bundle IDs minted 2026-05-30, valid to 2027-05-30), the **EmeraldContracts Swift port** (the 4th binding, parity-tested against the frozen Rust/TS vectors), the **EmeraldKit SDK**, the **`EmeraldExchange.xcodeproj`** with EmeraldTV (tvOS) + EmeraldMobile (iOS) shells, and **fastlane + TestFlight tooling**. Its audit-derived hardening loop has merged every confirmed bug (B1–B3), latent parity risk (R1–R6), coverage gap (C1–C6), and frontier feature (F1–F9), each red→green with a skeptic gate. So M2 is code-complete-and-hardened and M5 is largely shipped (browse/playback/offline downloads), not "near zero."

What genuinely remains: **an actual TestFlight build upload is unconfirmed**, and App-Store-quality polish (Dynamic Type / VoiceOver, iPad adaptive layout, player loading/stall states) is open in the sibling repo. On the backend, the last open measurement bars are now all closed: M4 stress/bench (crit-2/3/6 PASS on the NAS, 2026-06-14 — `scripts/m4-stress-bench.sh`), M3 scan-timing (crit-2, `65e3fc3`), M3 match-accuracy (crit-3 — 96.1% over a 51-case corpus), and the **M4 long-running soak (crit-4 PASS, 2026-06-16 — `scripts/m4-soak.sh`: a 30-min run held 24 session lifecycles, 5/5 clean idle-reaps under load, zero leak, Plex healthy)**. The only M4 item still open is the Apple-Silicon (VideoToolbox) perf variant, which is hardware-blocked (no AS transcode host), not a functional gap. The backend milestones are now measurement-complete; the remaining work is Apple-side bug-fix/polish/submission — not greenfield.

## Milestone Table

| id | title | status | % | one-line note |
|----|-------|--------|---|---------------|
| M1 | mybunny IPTV viewer + shared backbone | done | 98% | Shipped + live; cosmetic naming drift, a couple runtime facts trusted not re-proven |
| M1.5 | Cross-service compatibility contract | done | 98% | RATIFIED/LOCKED; Rust↔TS↔Python byte parity in CI; /version schemas + repo .gitattributes present |
| M2 | Swift SDK + tvOS/iOS apps + TestFlight | mostly-done | 80% | Built + hardened in sibling repo `theemeraldexchange-apple` (~197 Swift files, 589 tests): EmeraldContracts port, EmeraldKit SDK, EmeraldTV/EmeraldMobile shells, fastlane/TestFlight tooling, active Developer membership + App Store profiles (2026-05-30); all audit bugs/risks merged red→green. Remaining = confirmed TestFlight upload + App-Store-quality polish |
| M3 | Media server core (Rust media-core) | mostly-done | 92% | Live in enforce mode, 793 movies/292 shows/20k episodes; web SPA consumes grant/watch/stop (crit 4/5 on web, 2026-06-07/08); tvOS now exists in sibling repo so cross-platform crit 4/5 is demonstrable; scan-timing harness DONE + match-accuracy eval DONE 2026-06-14 (51-case corpus, 96.1% ≥95% bar) |
| M4 | Transcoder + capability matching | mostly-done | 93% | Deployed; real-library transcode PROVEN played in a real browser over the public path (2026-06-08); Intel VAAPI hardware encode + full-HW decode/tone-map live on the NAS iGPU; stress/bench DONE 2026-06-14 (crit-2/3/6 PASS: 4 concurrent @ 48% box CPU, 3.2-4.0x sustain, 0.54s seek); **30-min soak DONE 2026-06-16 (crit-4 PASS: 24 session lifecycles, 5/5 idle-reaps clean, zero leak, Plex healthy)**; only remaining = Apple-Silicon (VideoToolbox) variant, hardware-blocked (no AS host) |
| M5 | Native clients (browse + playback + offline downloads) | mostly-done | 75% | Built in sibling repo (`theemeraldexchange-apple` README: "M5 shipped") — media-core browse/playback, downloaded-library affordance, `DownloadsAPI`/`DownloadsStore`, continue-watching shelf, codec-fallback (forced HLS). Remaining = on-device verification, offline edge cases, polish |
| M6 | Plex-Pass equivalent (DVR/intro/music/photos/sharing) | not-started | 5% | A menu, not a plan; one reserved enum line. Gate now OPEN (M5 client effectively shipped) but the five feature buckets remain unbuilt |

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

### M2 — Swift SDK + tvOS/iOS apps + TestFlight — mostly-done (80%)
> **2026-06-14 reconciliation.** The prior "not-started (5%) / zero Swift code" status was a **measurement artifact**: this monorepo is blind by design to the sibling Apple repo where the work lives. The corrected status reads against `/Users/cujo253/Documents/theemeraldexchange-apple` (README, AUDIT.md 2026-06-13, `.autoloop/GOALS.md`, `Sources/`, `Apps/EmeraldExchange.xcodeproj`, the two App Store `.mobileprovision` profiles, and its `git log` — last commit 2026-06-14, 69 commits since June 1).

**DONE**
- Fully specced and plan-ready (10-phase execution spec). Backend substrate the Apple client consumes is built+tested (M1): VOD direct-HLS grant, live `?client=avplayer` remux grant, device PIN pairing + Bearer device-token middleware. Wire-format vectors carrying tvos/ios platforms exist and are CI-guarded.
- **Toolchain + account live (sibling repo):** Xcode 26.5 / Swift 6.3.2 installed; Apple Developer membership **active** — App Store provisioning profiles for both bundle IDs minted **2026-05-30** (valid to 2027-05-30, team "CHRISTOPHER JOSEPH PACHULSKI"); you cannot mint App Store profiles without an active paid membership.
- **Swift code built (sibling repo):** ~197 `.swift` files, `swift build` green, **589 test cases across 36 suites**. The **EmeraldContracts Swift port** (the 4th binding — HKDF, StreamToken, DeviceToken/JWE verify, CanonicalJSON, Base64URL, sub-namespace parsing) is done and parity-tested against the frozen Rust/TS wire vectors. **EmeraldKit SDK** (auth/device-flow, IPTV catalog, sessions, player grants, Library/Discover, Downloads + Users admin), **`Apps/EmeraldExchange.xcodeproj`** with EmeraldTV (tvOS) + EmeraldMobile (iOS) shells and schemes, plus **fastlane + TestFlight tooling**.
- **Hardened:** the audit-derived autoloop (`.autoloop/GOALS.md`) has merged every confirmed bug **B1–B3** (stale error banners, continue-watching sort, IPTV fail-open), every latent parity risk **R1–R6** (regex anchoring, fractional-number token parse, pagination truncation, concurrent-favorites/history wipe, strict Base64), every coverage gap **C1–C6**, and frontier features **F1–F9** — each red→green with a skeptic VALID gate. (F10 PlaybackCaps-by-device-class was deliberately REJECTED as unsound, not skipped.)

**REMAINING**
- **No confirmed TestFlight build upload** — the fastlane tooling and signing profiles exist, but an actual archive submission to App Store Connect is not evidenced.
- App-Store-quality polish open in the sibling repo's AUDIT: no Dynamic Type / VoiceOver labels, no iPad adaptive layout, no player loading/stall state, an AI key still in plain `UserDefaults` instead of Keychain, write-only Favorites, and README/api-contract doc drift.

**BLOCKERS** — none structural. The Xcode/account gate that previously pinned this milestone was opened 2026-05-30. Remaining work is submission + polish, not greenfield.

### M3 — Media server core (Rust media-core) — mostly-done (85%)
**DONE**
- Single Rust binary, edition 2024. Reliable scan pipeline (skip-unchanged, ffprobe, classify, upsert) + boot/periodic scheduler with single-flight guard. **TMDB now wired into scan** (closes prior audit H1) — live enrichment at scale: 793 movies / 292 shows / 20054 episodes. TV matching implemented (no English-only gate). Direct-play decision is a clean pure function (10 matrix tests); **503/handoff now enforced** (closes audit M1 dead-code finding). Watch-state backend complete + acting_sub IDOR guard. Internal-principal boundary LIVE in ENFORCE mode, container healthy. 104 tests green (up from 42 at audit).

**REMAINING**
- Crit 2 MET (2026-06-14, `65e3fc3`): `scan_once_100_file_library_under_5s` drives the real `scan_once` over a 100-file fixture via a deterministic ffprobe stub, indexing all 100 files (walk + stat + classify + movie/episode upsert + prune/GC) and asserting `files_added == 100`, `errors == 0`, and `<5s`. Measured well under 1s locally — a regression floor, not a doc-comment target.
- Crit 3 MET (2026-06-14): the `tmdb_match_accuracy_eval` now drives the real `parse_search_response` selection logic over a representative **51-case** labeled corpus (remake/year-collision, token-subset traps, sequels, punctuation/accents, numeric titles, fuzzy-legit, zero-overlap rejects, TV) and measures **49/51 = 96.1%**, clearing the ≥95% bar. Two gates: every *clean* case must resolve (immediate regression catch) **and** overall ≥95%. The only two misses are the documented language-filter gap — a filename in a film's original/romaji title vs TMDB's English `title` ("Sen to Chihiro…" → Spirited Away) and a stylized numeral ("Seven" vs "Se7en") — flagged `known_gap` so the corpus stays representative rather than cherry-picked to 100%. The earlier 24-case/100% eval (`2c19038`) was a real start but circular; this is the credible distributional proof.
- Crit 4 BOTH PLATFORMS EXIST (updated 2026-06-17): the web SPA consumes the grant path end-to-end — `src/lib/api/media.ts` (grant/watch/stop + paged `allMovies`/`allShows`) feeds `src/components/media/MediaPlayer.tsx`, proven playing in real Chrome over the public path. The second platform (tvOS) now exists in the sibling repo, so the cross-platform claim is no longer blocked on building a client.
- Crit 5 MET — LIVE-PROVEN (2026-06-17): the web client reads/writes `/api/media/watch`, and the native tvOS/iOS client (sibling repo, `46c2265 fix(apple): … continue-watching`) consumes the same route. Pinned in CI by `resume_state_is_account_scoped_across_devices` (media-core) — watch state keys on the verified account `sub` via `acting_sub`, never the device — **and demonstrated end-to-end on the deployed NAS in enforce mode**: two device tokens for one account (web + tvOS, distinct `device_id`) shared a resume row (web wrote 1234 → tvOS read 1234; tvOS wrote 4000 → web read 4000) while a different account saw 0 rows. Transcript: `docs/cross-device-sync-2026-06-17.log`.

**BLOCKERS**
- ~~tvOS (the second platform for crit 4/5 cross-platform claims) blocked on Xcode~~ — **stale.** tvOS (EmeraldTV) now exists and is tested in the sibling `theemeraldexchange-apple` repo, so the cross-platform crit 4/5 claim is now *demonstrable* (web ↔ tvOS same-sub sync). What remains is running that demonstration, not building the second platform.
- ~~No match-accuracy measurement harness for crit 3~~ — **stale/closed.** `tmdb_match_accuracy_eval` landed 2026-06-14 (51-case corpus, 96.1%); see Crit 3 above.

### M4 — Transcoder + capability matching (the long pole) — mostly-done (93%)
**DONE**
- Real Rust crate, tests green (310 across the cargo workspace as of 2026-06-10). Capability-matching planner delegates to media-core decide then computes smallest per-stream re-encode (hevc→h264, 4K→1080p, HDR→SDR, codec copy/remux). Complete snapshot-tested ffmpeg arg assembly (HLS, HW encoder selection, scale/tonemap filtergraph). Boot-time `ffmpeg -encoders` probe + per-encoder smoke test with libx264 fallback. 30s heartbeat-loss reap + SIGTERM→SIGKILL + tmpdir cleanup; sessions bound to the verified principal (owner-or-admin enforced, wave 1). Seek/resume = kill+respawn with server-baked `-ss`. Concurrency caps with leak-safe permits → 503 transcoder_busy; hardware sessions charge the global cap (4), only true CPU re-encodes charge the CPU cap. **media-core→transcoder handoff fully wired** (mints internal-principal bearer; degrades to 503 on outage). **Intel VAAPI hardware encode LIVE on the NAS iGPU (2026-06-08):** the image ships Debian's stock ffmpeg + `intel-media-va-driver`, `h264_vaapi -low_power 1` is the primary encoder, and a full-HW decode→`tonemap_vaapi`→`scale_vaapi` pipeline (`8d4c373`) is gated by a source-codec allowlist + boot probe, with software fallback proven. 4K HDR10→1080p-class H.264 tone-mapped on GPU; 3 concurrent HEVC→H.264 GPU sessions proven. Browser-audio planning fixed (wave of 2026-06-08 playback fixes): non-AAC audio re-encodes to stereo AAC, AAC copied only at ≤2ch.

**REMAINING / NOT MET**
- **Crit 1 MET (playback): real-library transcode proven PLAYED end-to-end (2026-06-08).** Beyond the 2026-06-07 serving proof (`scripts/m4-transcode-proof.sh`, docs/M4-TRANSCODE-VERIFICATION.md), the web SPA's `MediaPlayer` played the transcoded HLS stream in a real Chrome over the full public path — laptop → Cloudflare → cloudflared → backend `/api/transcode` proxy → media-core → transcoder — including resume (`scripts/media-playback-proof.sh`). Stress-test phase (non-optional per spec) DONE 2026-06-14 — `scripts/m4-stress-bench.sh` captured the N=4/60s bench on the NAS (see docs/M4-TRANSCODE-VERIFICATION.md §Stress / bench).
- Crit 2 MET NAS-side (2026-06-14): the bench formally measured **3.17×–4.00× real-time sustain** per session across 4 concurrent HEVC→H.264 re-encodes on the x86 VAAPI iGPU — comfortably above playback rate. The *Apple-Silicon* (VideoToolbox) variant remains untestable: the deployed target is x86 VAAPI and there is no AS transcode host.
- Crit 3 MET (2026-06-14): the formal 4-concurrent capture now exists — **peak 48% / avg 18% box CPU** (ceiling 80%) on the 6-thread box, Plex `healthy` throughout, load ≤0.56. VAAPI offloads encode to the iGPU (transcoder container ~92% ≈ <1 core), which is why 4 concurrent re-encodes stay well under the box ceiling.
- Crit 4 MET (2026-06-16): the formal long-running soak is recorded — `scripts/m4-soak.sh 3 1800` held **1802 s (30 min)** of 3 concurrent HEVC→H.264 VAAPI re-encodes with continuous load (pool refreshed every 240 s → **24 session lifecycles** over 7 refreshes), forced the 30 s idle reaper to fire **5/5 clean** under load (each ephemeral session 404'd), and showed **zero leak**: steady-mem floor +4% across the window (776→809 MiB), post-stop ffmpeg procs **0**, **Plex `healthy` throughout** (box CPU peak 57%/avg 15%, watchdog never fired). Full log: `docs/m4-soak-2026-06-16.log`; details in docs/M4-TRANSCODE-VERIFICATION.md §Long-running soak.
- Crit 5 MET: `TRANSCODER_FORCE_CPU=1` forces libx264 regardless of `TRANSCODER_HW_ENCODER`.
- Crit 6 MET (2026-06-14): re-measured on the VAAPI + 2s-segment pipeline, post-seek time-to-first-segment is **0.54s** (target <2s) — the stale ~23–27s figure was the old CPU/libx264 pipeline before forced-keyframe cadence (`0cda2f4`) and the 4→2s segment halving (`25d84da`). Cold concurrent startup TTFS measured 1.72–1.74s at 4 concurrent.
- HW-encoder breadth: VAAPI (encode + full-HW decode/tone-map) is real and proven; VideoToolbox/NVENC/QSV still exist only as arg strings, never run. PGS burn-in is planner-dropped (a sidecar-subtitle path is a known follow-up). audio_codecs capability gap: planner uses a browser-safe stereo-AAC baseline rather than `ClientCaps.audio_codecs`; only first audio track mapped (per-client 5.1 passthrough deferred).

**BLOCKERS**
- Apple-Silicon perf criteria blocked on deployment target (NAS = x86 VAAPI, no VideoToolbox) + no AS transcode host. This is the **only** remaining M4 item and it is hardware-blocked, not functional.
- ~~Remaining M4 proof is measurement, not function: stress/bench CPU evidence, a formal soak, and seek re-measurement~~ — **all DONE.** Stress/bench (crit-2/3/6) 2026-06-14; formal 30-min soak (crit-4) 2026-06-16 (`scripts/m4-soak.sh`, `docs/m4-soak-2026-06-16.log`).
- ~~No stress harness~~ — **DONE.** `scripts/m4-stress-bench.sh` (60 s crit-2/3/6) + `scripts/m4-soak.sh` (30 min crit-4) both exist and ran clean on NAS hardware.

### M5 — Native clients for media server — mostly-done (75%)
> **2026-06-14 reconciliation.** Same measurement artifact as M2: the M5 native-client work lives in the sibling `theemeraldexchange-apple` repo, whose README states **"M5 is shipped."** The prior "not-started (3%) / zero code" status reflected only this server monorepo's (correct) absence of Swift files.

**DONE**
- Spec fully written + reconciled (phases, success outputs, sequencing; M5.5 compile-flag-IPTV-disabled-default policy detailed). Prereqs M3 (live) + M4 (deployed) exist in source.
- **Built in the sibling repo:** media-core browse/playback, the downloaded-library watch affordance, `DownloadsAPI` / `DownloadsStore`, the Home "Jump back in" continue-watching shelf, and codec-fallback (forced HLS). The EmeraldKit `MediaService` + models, library browse, player/transcoder grants, and unified suggestions the M5 phases call for are present (the SDK M5 extends now exists — ~197 Swift files, 589 tests). Offline downloads — the headline M5 capability — has a real client manager and store, not the prior "zero implementation."

**REMAINING**
- On-device / TestFlight verification of the shipped client (tied to M2's unconfirmed TestFlight upload).
- Offline-download edge cases and the App-Store-quality polish tracked in the sibling AUDIT (a11y, iPad layout, player stall states) apply here too.

**BLOCKERS** — none structural. M5 needs M3 (live) AND M4's playback proof — both exist (web `MediaPlayer` consumes the grant path end-to-end, 2026-06-08) — and the M2 EmeraldKit foundation it extends is now built. The Apple-tooling gate is open.

### M6 — Plex-Pass equivalent — not-started (5%)
> **2026-06-14 note.** The sequencing gate ("M6 is selectable only after M5 ships") is now **open** — the M5 native client is shipped in the sibling repo. M6 stays low because its five feature buckets are genuinely unbuilt, not because it is blocked; it is now correctly *available to start*, not gated.

**DONE**
- Documented as a portfolio menu (DVR, intro/credits, music, photos, sharing) — the criterion-6 deliverable exists. One line of M6 code: `StreamKind::Recording` reserved in the stream-token contract (accepted by verifiers, minted by nothing). DVR reuse-infra from M1 exists (epg_programs table, MIN_FREE_GB gate, max-concurrent-streams, transcoder arg builder). Rust-stability precondition trending true.

**REMAINING**
- All 5 feature buckets NOT BUILT: no recordings table / record button / scheduler / mp4-to-disk path (existing remux emits HLS, not mp4); no intro-marker table or scene-detect worker; no music library kind / MusicBrainz; no EXIF/sharp photos; no per-library shares table (members/invites is authZ, a different concept). Per-feature brainstorm→spec→plan→implement cycles not started.

**BLOCKERS**
- By design: M6 is a menu to pick from AFTER M5 ships. M5 unshipped (gated on M3+M4 + Apple-blocked native clients). Correctly not-started, not behind schedule.

---

## Critical Path (dependency-ordered)

The project splits into a **backend track** (this repo) and a **native-client track** (sibling `theemeraldexchange-apple` repo). **As of 2026-06-14 the Apple gate is no longer the dominant constraint** — Xcode is installed, the Developer membership is active, and the client track (M2, most of M5) is built and being hardened in the sibling repo. The remaining critical-path work is measurement/proof on the backend and submission/polish on the client.

**Buildable now (no Apple dependency):**
1. ~~Exercise a real player against the M4 path~~ — **DONE 2026-06-08.** The web SPA's `MediaPlayer` plays the transcoded stream in a real Chrome over the full public path (laptop → Cloudflare → cloudflared → backend `/api/transcode` proxy → media-core → transcoder), including resume; harness `scripts/media-playback-proof.sh`.
2. **Build the M4 stress/bench harness on NAS hardware** (non-optional per spec) and capture CPU/latency for crit 2/3/6. The old ~23-27s seek figure predates the VAAPI pipeline and forced-keyframe cadence — re-measure before treating the "<2s" target as pass or fail.
3. ~~**Add M3 measurement harnesses**~~ **DONE 2026-06-14.** crit-2: `scan_once_100_file_library_under_5s` drives the real `scan_once` over a 100-file fixture via an ffprobe stub (`<5s` + full indexing, `65e3fc3`). crit-3: `tmdb_match_accuracy_eval` measures **96.1%** over a 51-case labeled corpus against the real selection logic (≥95% bar). Both M3 measurement bars are now falsifiable in-repo.
4. ~~Wire the web SPA media-core consumer~~ — **DONE 2026-06-07.** `src/lib/api/media.ts` exposes grant/watch/stop (+ paged `allMovies`/`allShows`) and `MediaPlayer` is wired into the Movies/TV tabs; M3 crit 4/5 demonstrated on web.
5. ~~Unblock `/media/Movies` for service uids~~ — **DONE 2026-06-07.** Share loosened `0700` → `0755`; media-core (10002) and transcoder (10003) read the full movie library.
6. **M5 UI in parallel against a mocked media-core API** — the only M5 work possible pre-Apple, per spec.

**Formerly "blocked on the Apple gate" — now unblocked and largely built (sibling `theemeraldexchange-apple` repo):**
7. ~~**M2** in full: EmeraldContracts Swift port → EmeraldKit SDK → EmeraldTV/EmeraldMobile → TestFlight pipeline; blocked until Xcode + account~~ — **DONE except the final TestFlight upload.** Xcode 26.5 installed, membership active (App Store profiles 2026-05-30), sibling repo created and active. EmeraldContracts port, EmeraldKit SDK, EmeraldTV/EmeraldMobile shells, and fastlane/TestFlight tooling all exist; ~197 Swift files, 589 tests, all audit bugs/risks merged. **Remaining: confirm an actual archive upload + App-Store polish.**
8. ~~**M5** native media-server clients + offline downloads~~ — **largely DONE** (sibling README: "M5 shipped"): browse/playback, `DownloadsAPI`/`DownloadsStore`, continue-watching shelf, codec-fallback. Remaining: on-device verification + edge cases.
9. **M6** monetization menu — gate is now **open** (M5 client shipped); the five feature buckets are still unbuilt and are the next greenfield target.

**Monetization / M6 risk flags:**
- **ffmpeg licensing — server-side posture RESOLVED (2026-06-17):** every image's ffmpeg provisioning + GPL terms are now recorded per-image in `THIRD-PARTY-LICENSES.md` (backend/media-core static `mwader/static-ffmpeg` = GPL-3.0+; transcoder Debian apt ffmpeg = GPL-2.0+), with the process-isolation argument (ffmpeg is spawned as a child process, never linked) and a written corresponding-source offer; `server/licensing.test.ts` guards the table against Dockerfile drift. A `deny.toml` + CI `license` job (cargo-deny + license-checker) now denies GPL/AGPL in the *linked* Rust/JS dependency trees, so the only copyleft stays the process-isolated ffmpeg binary. The App-Store path is unaffected: the native clients bundle **no** ffmpeg (VideoToolbox), so the GPL binary never enters an App Store artifact. Still open (not blocking): the product LICENSE choice for community self-hosting (PolyForm Shield recommended — docs/MONETIZATION-AND-PUBLISHING.md Decision 1).
- **IPTV legal/compliance risk:** the M5.5 policy already makes the **IPTV-disabled compile-flag build the default public artifact** (good), but the IPTV feature's distributability is the structural reason that policy exists; treat any monetized build's IPTV surface as a standing risk.

---

## Update 2026-06-14 — Apple client track reconciled against the sibling repo (headline % 52 → ~74)

**Why the headline number jumped without a line of feature code in this repo.** The
dashboard scores "Emerald Exchange" as the average of the milestone-table `%` column.
M2 (5%) and M5 (3%) were dragging that average down on the premise that the native
Apple client was *unbuilt and hard-blocked on Apple tooling*. That premise was a
**measurement artifact**: this server monorepo is blind by design to the sibling
repo `/Users/cujo253/Documents/theemeraldexchange-apple`, where the Apple work
actually lives (Xcode artifacts are deliberately kept out of the server repo). So
"zero `.swift` files here" was true but did not mean "not started."

**What is actually true as of 2026-06-14** (verified against the sibling repo's
README, AUDIT.md 2026-06-13, `.autoloop/GOALS.md`, `Sources/`,
`Apps/EmeraldExchange.xcodeproj`, both App Store `.mobileprovision` profiles, and its
`git log`):

- **The Apple gate opened on 2026-05-30.** Xcode 26.5 / Swift 6.3.2 are live; the
  Apple Developer membership is **active** (App Store provisioning profiles for both
  bundle IDs minted 2026-05-30, valid to 2027-05-30 — impossible without a paid
  membership). The "purchased 2026-05-29, pending activation" story is stale.
- **M2 is built and hardened**, not 5%: ~197 Swift files, 589 test cases / 36 suites,
  the EmeraldContracts Swift port (4th binding, parity-tested against the frozen
  Rust/TS vectors), the EmeraldKit SDK, the `EmeraldExchange.xcodeproj` with EmeraldTV
  (tvOS) + EmeraldMobile (iOS) shells, and fastlane/TestFlight tooling. The audit
  autoloop has merged every B1–B3 bug, R1–R6 parity risk, C1–C6 coverage gap, and
  F1–F9 feature, each red→green with a skeptic gate. **Rescored 5% → 80%** (remaining:
  confirmed TestFlight upload + App-Store polish).
- **M5 is largely shipped**, not 3%: the sibling README states "M5 is shipped" —
  browse/playback, `DownloadsAPI`/`DownloadsStore`, downloaded-library affordance,
  continue-watching shelf, codec-fallback. **Rescored 3% → 75%** (remaining: on-device
  verification + offline edge cases).
- **M3**: the tvOS second platform now exists, so the cross-platform crit 4/5 claim is
  demonstrable; the "blocked on Xcode" blocker is struck. % unchanged (85%) pending the
  actual web↔tvOS sync demonstration + the still-missing match-accuracy harness.
- **M6**: its sequencing gate is now **open** (M5 client shipped). Nudged 3% → 5% to
  reflect "available to start" vs "blocked"; the five feature buckets remain unbuilt.

**Net:** milestone-table average moves from **~52%** (98, 98, 5, 85, 75, 3, 3) to
**~74%** (98, 98, 80, 85, 75, 75, 5). This is a *reconciliation*, not progress — the
work was always there; the server repo just couldn't see it. The companion dashboard
metric "Emerald Exchange (Apple)" (a checkbox count over the sibling repo's
`.autoloop/GOALS.md`) already reflects this — every objective is `[x]` except the one
deliberately-rejected F10 — so that project correctly reads as essentially complete.

**Honest caveat:** "built" ≠ "on the App Store." No TestFlight upload is confirmed, and
the sibling AUDIT lists real App-Store-quality gaps (Dynamic Type/VoiceOver, iPad
layout, player stall states, an AI key in `UserDefaults`). The accurate framing is
*bug-fix / polish / submission*, not greenfield.

## Update 2026-06-13 — streaming-stability wave + CI governance

No milestone percentages moved; M4 stays in-progress (~75%) — this was playback
hardening and infra, not new criteria met:

- **Streaming-stability wave (06-11/12, ~15 commits).** Playback-bar redesign on
  the emerald design system; fullscreen fixes; resume-or-start-over prompt +
  absolute-timeline-on-resume; 20 s fresh-HLS startup-stall fix (`5e95faa`); HLS
  timeline pinned to the grant's known duration (`53ed1f4`); forward-seek past
  the produced edge re-grants instead of dying (`a8f3c09`); HLS segment length
  halved 4→2 s for faster startup (`25d84da`). The M4 player path was *working*
  on 06-08 but kept being stabilized through 06-12 — the four grey-box fixes were
  not the end of it.
- **Recommender:** KNN `k` clamped to sqlite-vec's 4096 cap — every `/score` was
  500ing (`46f8a20`).
- **Scanner:** TMDB remake-collapse + year-token-boundary + extras-dir ingestion
  fixed (`11b2454`).
- **CI governance (06-13).** Dependabot bumps grouped to cut weekly branch churn;
  an auto-merge routine merges low-risk bumps once green (majors + cargo-minors
  stay manual for crypto byte-compat review); a `main` CI-gate ruleset (required
  status checks, owner as bypass actor) now stops a red commit from silently
  landing on `main` — the gap that had briefly left `main` red. Two process-spawn
  flaky tests (media-core probe ETXTBSY, transcoder `crash_respawn` arg race) were
  de-flaked so the gate is reliable.
- **Gate counts** (vitest 1793 / cargo 310 / pytest 189) are a 06-10 snapshot and
  have drifted with tests added since; re-run before quoting.

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
