
# Git History Teaching Dossier: The Emerald Exchange Evolution

## 1. WHAT — Project Life Story (Beginner-Friendly Paragraph)

The Emerald Exchange is a self-hosted streaming platform that evolved from a beautiful home dashboard (2026 Q1) into a full media server backend. The journey is a classic software progression: a talented developer started with a visually striking SPA (Single-Page App) and authentication layer, then progressively layered on capability—recommendations from AI (Claude + Python ML), IPTV streaming (live EPG + HLS), a Rust media library server to index local movies/shows, and finally a real-time transcoder running on home hardware to make any video playable on any device. Each era unblocked the next: you can't recommend or stream media you don't catalog, can't play transcoded streams without the transcoder running, and can't call it "shipped" until it survives in production under real load and real users. By June 2026, the backend is deployed and live; the native Apple clients are blocked only by tooling (Xcode installation).

---

## 2. WHY — Evolution & Unblocking

**Era 1 (Feb–Mar 2026): UI Foundation & Auth**  
Landing page, Plex sign-in, role gates → unblocked ability to serve personalized content to distinct users.

**Era 2 (Mar–May 2026): Streaming & Recommendations**  
IPTV viewer + EPG, then AI-driven suggestions (Claude, recommender service) → unblocked the product's core value: "what should I watch?"

**Era 3 (May–Jun 2026): Media Server & Playback**  
Rust media-core library scanner (TMDB enrichment), web playback tab, transcoder (HW encode) → unblocked playback of a real library (793 movies, 292 shows) across browsers and devices.

**Era 4 (Jun 2026): Hardening & Production-Ready**  
Wave-1 & wave-2 & wave-3 security/reliability sprints (cross-service contracts, internal auth, stream tokens, A11y gates) → unblocked shipping to production (live on NAS, Cloudflare Tunnel, accessed over the public internet).

**Era 5 (Jun 2026): Real-Library Proof & Native Preparation**  
End-to-end playback in real browsers, hardware H.264 VAAPI pipeline, device-token passkey auth → unblocked foundation for M2 (Apple clients) and M5 (offline downloads).

---

## 3. MAP — Era Timeline with Representative Commits

| Era | Name | Commit Range | Key Commits | What Shipped |
|-----|------|--------------|-------------|--------------|
| **0** | Initial Vision | `ee90455` | `ee90455` (initial), `faf29ca` (home page), `3c23252` (Plex auth) | HTML5 SPA, Plex sign-in, home hero + kraken BG, nav transitions, Netlify deploy |
| **1a** | IPTV Viewer | `06c2d69`–`d67c1c5` | `060c2d69` (AI sugg toggle), `06c2d69` (Sonarr/Radarr calendars), `1233927` (trending filter), `3929679` (trending row) | Live IPTV (HLS), VOD catalog, EPG grid, favoriting, resume, track switching |
| **1b** | Recommendations Engine | `8c249c8`–`eaa5e08` | `99eeb2f` (revert speed-trim), `ba03642` (reject sets → Claude), `8c249c8` (major overhaul: variety, quality, perf) | BYO Anthropic key, red/green feedback, Claude ranking, TMDB backfill, title dedup, fallback-to-trending |
| **1.5** | Cross-Service Contracts | `2847b40`–`2f5b727` | `893bd97` (N-API vector suite), `6dd8619` (single-key stream token), `fabda51` (APScheduler removal), `1646a80` (transcoder ownership) | Rust ↔ TypeScript ↔ Python byte parity, device-token JWE, stream-token HMAC, internal-principal auth, CI gates |
| **2a** | Media-Core Scanning | `ab0339f`–`0a1fff6` | `ba2f6aa` (pooled TMDB), `f7d6057` (skip attached_pic), `33e1dca` (caps API honest), `88a7d31` (WAL mode busy_timeout) | Rust library scanner (ffprobe + TMDB enrichment), 793 movies, 292 shows cataloged, direct-play capability matrix, watch-state backend |
| **2b** | Web Media Playback | `ae66f33`–`95857d3` | `ae66f33` (backend web-playback proxy), `98707c2` (grant route tests), `95857d3` (playback startup warm-up), `216dd06` (Media nav tab) | `MediaPlayer` component, grant/heartbeat/stop flow, HLS.js + mpeg-ts.js player, browser playback of IPTV & transcoded streams, web SPA proven playing real content |
| **3** | Transcoder & HW Pipeline | `42432da`–`8d4c373` | `8d4c373` (full VAAPI decode+tonemap), `336fb8f` (VAAPI no-preset), `6f08b2a` (Debian stock ffmpeg), `401d797` (QSV encode), `0cda2f4` (keyframe cadence), `977f892` (AAC re-encode audio) | ffmpeg arg builder, capability planner, HW H.264 encode (VAAPI), HW decode+tone-map, stereo AAC, segment key-frames, spawn/reap/heartbeat session lifecycle, Concurrency caps |
| **4a** | Playback Hardening (Wave 1) | `2f5b727`–`29babc7` | `2f5b727` (media-core hardening), `1646a80` (transcoder lifecycle), `29babc7` (suggestions god-file decomposed), `6dd8619` (single-key token), `872c4fe` (recommender tests) | Media-core panic guards, transcoder owner-or-admin enforcement, suggestions refactored into 9 service modules, contract binding unified |
| **4b** | Hardening Wave 2 & 3 | `880b3eb`–`fcf0057` | `880b3eb` (product/design doc reconciliation), `cb1aae1` (CI/deploy hardening), `fcf0057` (snake_case principal error + a11y), `b8f20a0` (hard-fail recommender binding), `231ae63` (napi signer/verifier tests) | Product docs accurate, CI gates (rustfmt, clippy, pytest, coverage), DOM component tests, third-party license notices, A11y modals, telemetry, SSRF guard hardening |
| **5** | Real-Library Proof & Native Prep | `c51bd75`–`b7dd248` | `c51bd75` (movies play—realtime throttle), `b61e4f4` (Play Direct covers whole library), `de9411c` (resume safe HLS), `8b554ee` (no double-seek), `cba25cc` (stop-on-close), `3876669` (passkeys live), `c296ad5` (MediaCapabilities probe) | End-to-end real movies in browser, remote resume working, Passkey auth live in prod, Device-token revocation, /version reporting, Deploy rollback + health gates, real-Chrome MSE test, 310 cargo tests green, 1793 vitest tests green |

---

## 4. PREREQUISITES — Concepts a Beginner Should Know

Before diving into the timeline, understand:

1. **SPA vs Backend Split**: This project is a React TypeScript frontend (Netlify) + Node.js Hono backend (NAS). Commits touch both; know which you're reading.

2. **Plex as the User Directory**: All auth and identity flows through Plex (local media server's identity provider). No homegrown user database. Later: device-token + passkeys layer on top.

3. **IPTV Anatomy**: Live TV + VOD calendar data (EPG) from external provider (mybunny), repackaged as HLS streams and playlists. Browser plays via mpegts.js (live) or hls.js (VOD/catchup).

4. **Transcoding Pipeline**: Movies/shows are stored in various codecs (HEVC, VP9, AV1, H.264) and containers (mkv, mp4). To play in a web browser (which requires H.264 + AAC), re-encode via ffmpeg. The transcoder is a Rust daemon that spawns ffmpeg processes and manages HLS segments.

5. **Hardware Encoding**: Home NAS has an Intel iGPU. VAAPI is the Linux hardware-acceleration API. H.264 encoding on GPU is 10–15× faster than libx264 (CPU). Tone-mapping HDR→SDR on GPU saves CPU cycles.

6. **Stream Tokens & HMAC**: API security relies on HMAC-signed tokens (not JWTs). Each request includes a time-bound token proving the caller is the owner. This prevents token leakage in logs.

7. **CI Gates as Contracts**: The codebase enforces Rust ↔ TypeScript ↔ Python byte parity in CI (via `emerald-contracts` test vectors). A gate fails if serialization diverges. This prevents subtle cross-service bugs.

---

## 5. GOTCHAS & WAR STORIES — Firefighting Visible in Commit Messages

**EPG Collapse (waves of fixes, ~May 2026)**  
- Commit `ec6c480` (test coverage for name-match accuracy) + `357b227` (sniffBuf OOM bound): early EPG ingest was crashing. Malformed feeds caused unbounded XML parsing, starving memory. Fixed with a cap + explicit test.

**Streaming Gaps & Resume Breaks**  
- Commits `8b554ee` (no double-seek HLS), `de9411c` (resume safe), `c51bd75` (realtime throttle): early playback had race conditions. Server and client both trying to seek caused jitter. Fixed by baking `-ss` (seek) into the ffmpeg command server-side, never from the client.

**Grey Box at 0:00 (FOUR separate fixes, ~Jun 8)**  
- `0cda2f4` (force keyframes at HLS segment boundary): ffmpeg GOP was too long, first segment dropped after 12s timeout. Added `-force_key_frames expr:gte(t,n_forced*N)`.
- `977f892` (re-encode non-AAC audio): browsers reject Dolby Digital (AC3/EAC3); had to re-encode to stereo AAC.
- `f091d41` (stop inline subtitle extraction): PGS subtitle burn-in was orphaning the first video segment, delaying the manifest. Dropped inline burn-in.
- `d1fc9a7` (downmix audio to stereo): 5.1-channel AAC caused Chrome/Firefox MSE append to fail silently. Downmixed to stereo on re-encode.

**Transcoder Lifecycle Leaks**  
- `1646a80` (transcoder session lifecycle + ownership): sessions weren't bound to the principal who initiated them. Could cause IDOR (Indirect Object Reference) bugs. Enforced owner-or-admin on all reads/writes.

**Recommender Crash-Loops**  
- `884d7ce` (Glitchtip-db/redis cap_add): recommender container crashed 970 times because setpriv (user-switch) failed. Added capability grants (`cap_add: [SETUID, SETGID, CHOWN]`).
- `29d85be` (unbrick fresh-DB boots): migration 0005 was DESTRUCTIVE (dropped a table). Fresh starts hung. Added explicit annotation + ordering guard.

**Device Token Expiry Bugs**  
- `3387654` (enforce nbf/exp in verifyDeviceToken): device tokens had issue (`nbf`) and expiry (`exp`) claims but weren't being validated. Sessions lived forever. Enforced at the verify chokepoint.

**Build Runaway Prevention**  
- `2da16c2` (nas-safe-build): raw `docker compose up --build` on weak NAS hardware (6 threads) brought Plex to a halt. Built `nas-safe-build.sh` to cap jobs, run detached, monitor heartbeat, auto-abort if load spikes.

---

## 6. QUIZ BANK — Application-Style Questions WITH Answers

**Q1: VOD Playback Regression (Commits `8b554ee` + `de9411c`)**  
*Scenario:* You deploy local media playback. A user plays a movie, pauses at 10 minutes, closes the browser. Later they open the app and click "Resume." Playback starts at 0:00 instead of 10:00.  
*Question:* What two separate seeks are happening, and why does the second one win?  
*Answer:* (1) Server bakes `-ss 10s` into the ffmpeg command when granting the stream (server-side seek). (2) Client sees the HLS playlist's EXTINF timing and tells hls.js to seek to 10s client-side. The client's second seek cancels the server's preparation. Fix: client reports the absolute position to the server (via heartbeat), server encodes only once with the correct `-ss`, and client never seeks HLS streams (only direct-play). Commit messages: "don't double-seek HLS resume" and "resume crash respawns at furthest-encoded position."

**Q2: Transcoder Audio Format Mismatch (Commits `977f892` + `d1fc9a7`)**  
*Scenario:* A movie in the library has AC3 (Dolby Digital) audio. User clicks "Play Direct here" → transcoder starts. Movie appears in the browser, audio plays fine for 4 seconds, then silence. HLS playlist shows segments, but player stops appending.  
*Question:* Why does the audio disappear, and what are two separate fixes needed to ship the movie?  
*Answer:* (1) Browsers' MediaSource API only accepts AAC audio in MP4 containers. AC3 is rejected silently by the append operation. (2) Even if re-encoded to 5.1 AAC, Chrome/Firefox reject 6-channel AAC in MSE (they only accept stereo or mono). Fixes: (a) plan re-encodes AC3→AAC at segment creation time (commit 977f892), (b) stereo-downmix AAC on re-encode so append never fails (commit d1fc9a7). You must do both: transcode audio AND reduce channels.

**Q3: Segment Delivery Timeout (Commit `0cda2f4`)**  
*Scenario:* A 1080p H.265 movie starts playing in the browser. The first HLS segment takes 14 seconds to arrive. The client's manifest-poll timeout is 12 seconds, so it times out and shows a grey box instead of video.  
*Question:* Why is the first segment delayed, and how does forcing keyframes at segment boundaries fix it?  
*Answer:* ffmpeg's default H.264 GOP (Group of Pictures) is ~14 seconds. If the HLS segment boundary is 6 seconds (common), ffmpeg might encode 2 full GOPs before hitting a keyframe at the boundary, so the segment can't be cut until ~14s in. Fix: force keyframes every N seconds (`-force_key_frames expr:gte(t,n_forced*N)`) pinned to the HLS segment duration, so segments always start on a keyframe and are never delayed waiting for the next one.

**Q4: Recommender Fresh-Boot Hang (Commit `29d85be`)**  
*Scenario:* Deploy the stack to a fresh NAS with no pre-existing database. The recommender container starts, runs migrations, then hangs indefinitely on startup.  
*Question:* Which migration is destructive, what goes wrong, and why does a missing annotation cause the hang?  
*Answer:* Migration 0005 drops a table. When the migration runs on a fresh database, it tries to drop a table that doesn't exist (the migration was never meant to run on fresh starts, only on upgrades). The container doesn't crash; it hangs silently because the transaction fails but the app doesn't abort. Fix: (a) annotate the migration as `-- DESTRUCTIVE`, (b) add a guard in the migration runner to ensure migrations run in order and skip DROP operations on fresh boots. Commit message: "Unbrick fresh-DB boots (0005 DESTRUCTIVE annotation + 0007 title_vec ordering)."

**Q5: Device Token Authorization Loophole (Commit `3387654`)**  
*Scenario:* A user receives a device-token JWT. The token claims to expire 1 minute from now (`exp: 1719123660`). User waits 2 minutes, then tries to use the token again. The API still accepts it.  
*Question:* Why is the token still valid, and what is the chokepoint that needs to enforce validation?  
*Answer:* Device tokens are JWE (encrypted, not signed). The JWE payload contains `exp` and `nbf` (not-before) claims, but the `verifyDeviceToken()` function only decrypts the token—it never checks whether the claims are still valid. The fix: enforce `exp` and `nbf` at the verification chokepoint (every function that decrypts a device token must check the time window). Missing this check = sessions live forever, even after device revocation tables would have blocked them.

**Q6: Build Runaway Starves Plex (Commit `2da16c2`)**  
*Scenario:* You SSH to the NAS and run `docker compose up --build`. Cargo compiles the transcoder and media-core. After 5 minutes, Plex becomes unresponsive (no web UI, no remoting). SSH also hangs. After 15 minutes, compilation finishes, and Plex comes back.  
*Question:* What is the root cause, and why does `nas-safe-build.sh` prevent it?  
*Answer:* Raw `docker compose up --build` on a 6-thread NAS runs `cargo` with no job cap. A single crate compiles on all 6 threads + hyperthreads, driving the load average to 70+. The kernel's scheduler can't keep up with interactive tasks (Plex, SSH), so they starve. Fix: `nas-safe-build.sh` discovers the box's spare cores at runtime (`nproc`), caps `CARGO_BUILD_JOBS`, runs detached (so a dropped SSH doesn't orphan it), polls the heartbeat, and auto-aborts if Plex load spikes. Slow is fine; overwhelming is not.

---

## 7. CODE-READING EXERCISE — Guided Git Log Exploration

**Tutor Assignment**: "Walk through the stream-token security architecture by reading commit messages + code snippets."

**Steps:**

1. **Start at the contract boundary** (commit `6dd8619`):
   ```bash
   git show 6dd8619 --stat | head -30
   ```
   *What to notice:* "remove expired D2a dual-key fallback and M1 token grace paths." This means the codebase ONCE had two keys (D2a era) and a grace period. Now it's single-key only. Why? Fewer secrets = less surface area. Read the message: "STREAM_TOKEN_SECRET is the single signing/verifying secret."

2. **Find where tokens are minted** (search: `git log --grep="stream.token" --oneline`):
   ```bash
   git log --all --oneline | grep -i "stream.*token\|hmac\|grant"
   ```
   *Look for:* Commits about token minting (server creates them) and verification (client must present them). The minting path is in `server/routes/media.ts` (the `/api/transcode` grant endpoint).

3. **Trace a specific token path** (commit `231ae63`):
   ```bash
   git show 231ae63 --stat
   ```
   *What to notice:* "test(server): exercise the napi signer/verifier in the stream-token vector suite." This means the Rust napi binding exports signer+verifier. The TypeScript server delegates to Rust (for speed + consistency). The test vectors (JSON files) prove both sides compute the same HMAC.

4. **Find the attack vectors that were fixed** (commit `b3f37bc`):
   ```bash
   git log --oneline | grep -i "device\|revocation\|authz"
   ```
   *Read specifically:* `b3f37bc` (test deviceTokenAuth + cascade revocation), `dada436` (close device-token allowlist bypass). These commits added tests for edge cases that were initially missing. What attack were they preventing?

5. **Synthesize: Why single-key was better than dual-key** (search commit messages):
   ```bash
   git log --all --grep="D2a\|dual-key" --oneline
   ```
   *Insight:* The earlier architecture had a D2a key (old) and a new key, with a grace period for clients still using the old key. This meant old secrets lived in the active signing set for weeks. Single-key (commit 6dd8619) cuts that risk: old secrets are garbage-collected immediately. The tradeoff: you must deploy the new key to all clients first (not gradual), so this requires coordinated deploys. Read the deployment section in `DEPLOY.md` to see how it's mitigated.

**Follow-Up Questions for Students:**
- Why is this HMAC-based instead of JWT-based?
- What's the difference between a stream token and a device token? (Hint: one is per-playback, one is per-device.)
- If the server's `STREAM_TOKEN_SECRET` leaks, how long is the attacker's window?

---


