
# War Stories: Real Incidents from theemeraldexchange

_Curated by the war-stories agent, 2026-06-11. Source: context/ files plus MEMORY.md incident notes._

---

## 1. WHAT — Why War Stories Teach Better Than Docs

Tutorials teach the happy path. War stories teach the real path. Every incident below was a working system that broke in a way the engineer did not predict, diagnosed through hypotheses they got wrong before getting right, and fixed by understanding a layer below where the symptom appeared. That gap between symptom and cause is the only thing that actually distinguishes an experienced engineer from a clever one. Docs describe what the system does when everything is fine; war stories encode what the system does when one invariant you had forgotten even existed gets violated — the container-local-loopback assumption, the tmpfs-masks-chown assumption, the depends-on-orders-only-first-start assumption. Those encoded invariants cannot be transferred through formal documentation because the writer doesn't know which one will bite the reader. They CAN be transferred through narrative, because the reader can simulate the wrong hypothesis and feel the moment of correction. Every story below was chosen because the fix is short but the path to the fix is long, and the general principle it proves recurs across different surfaces.

---

## 2. INCIDENT CATALOG

| # | Incident | Symptom as seen | Real root cause | Fix | Transferable lesson |
|---|----------|-----------------|-----------------|-----|---------------------|
| 1 | **Cloudflared 502 after network hardening** | Public API 502; NAS `curl localhost:3001` → 200; backend "Up"; SPA unaffected | cloudflared moved to bridge network but still dialed `localhost:3001` — its own empty loopback, not the backend's | `network_mode: "service:backend"` so cloudflared shares the backend's network namespace | Half-migrations kill you: moving a service's network mode without updating all reachability assumptions in the same commit leaves a silent time bomb |
| 2 | **Backend recreate → API 502 (the sequel)** | Deploy succeeds, both containers show "Up", API 502 immediately | `service:backend` netns reference is bound to the specific container instance; recreating backend breaks the ref; `depends_on` only orders first start | Always `force-recreate cloudflared` after any backend recreate | Container dependencies that share namespaces are tighter than compose knows: a recreate is not a restart |
| 3 | **curl healthcheck takes the public site down** | Every deploy → cloudflared goes `depends_on: backend healthy` → wait → site down | Backend Node image has no `curl`; curl healthcheck → perma-unhealthy → cloudflared's `depends_on: condition: service_healthy` gate never passed → cloudflared never started | Replace with Node probe (`node -e "require('http').get(...)"`) | Healthcheck tooling is part of the container's runtime environment; don't assume the OS has it |
| 4 | **SSRF guard kills live IPTV ("loads forever")** | "Loads forever" on live channels — no error, no timeout, just hung player | Security hardening (`9beac45`) required HTTPS on every redirect hop; provider 301s HTTPS→HTTP CDN (mybunny.tv → turbobunny.net, public CDN over HTTP) | Allow HTTP on PUBLIC hosts; keep the SSRF address-space checks for private RFC-1918 addresses | Security invariants applied too broadly can break legitimate traffic; the symptom says "slow/stuck," not "403 security error" |
| 5 | **Grey-box at 0:00 — four separate causes** | Player shows grey box at 0:00; no error; server returns 200 on all segments | (1) no `-g`/`-force_key_frames` → HLS first real segment past 12s window; (2) EAC3 audio copied silently — browsers only decode AAC; (3) inline `-c:s webvtt` held first VIDEO segment 9s extra; (4) multichannel AAC (5.1) rejected by MSE SourceBuffer silently → zero-frame append → grey | Keyframe cadence `-force_key_frames`; copy-AAC-only; drop inline subtitle transcode; downmix to stereo `-ac 2` | "Server returns 200" does not mean "browser plays." The browser's MSE SourceBuffer is a second acceptance gate that fails silently |
| 6 | **NAS build brown-out (CPU storm)** | Uncapped `docker compose up --build` over SSH drove load to 73 (12× core count); Plex + SSH starved for 13 min; SSH became unkillable | NAS serves both the EEX stack AND Plex Media Server on a 6-thread CPU; raw compile is competing with a live media server | `scripts/nas-safe-build.sh` with runtime CPU discovery, detached execution, Plex health monitoring, and auto-abort on load ceiling | Production machines are not build machines; "just compile it" is a production incident if the box is already serving traffic |
| 7 | **EPG sniffer race: 14k channels → 820 after restart** | EPG coverage drops from ~14k to ~820 after a backend restart or EPG sync | `xmlStream.on('data', onSniffData)` registration raced the stream open; sniffer attached after data events had already started; first `<channel>` block missed → 0 matched channels; fallback = tiny set | Test-guarded the fragile sniffer registration; fixed ordering | The most fragile line in a parser is the one that decides which events it's going to listen to — if it misses the first event, all downstream data is useless |
| 8 | **EPG resolved-but-empty poison** | After a partial-crash run: "resolved" count jumped 14,293 → 17,481 but zero new programmes stored; re-run skipped those channels permanently | `resolveAgainstExternal` set `epg_resolved_id` (marking as done) BEFORE streaming programmes; crash between commit and stream left channels marked resolved with no data; next run skipped them because they appeared resolved | Only set `epg_resolved_id` after storing ≥1 programme | Commit state changes only after the work they represent is durable; never mark something done as a precondition for doing it |
| 9 | **Plex backup WAL tar race** | Weekly appdata backup job: "tar: library.db-wal: file changed as we read it"; dontStop:yes made it worse | tar ran against live SQLite DB files with active WAL; WAL can change mid-tar; dontStop:yes meant the backup completed but was silently corrupt | Exclude live WAL/SHM files from appdata backup (`exclude` entries in backup config.json) | Filesystem-level backup of a live database is not a backup; it is a race condition disguised as a file copy |
| 10 | **Recommender franchise-collision blanket ban** | Movie strip shows only ~8 results out of a recommended 20; users blamed the algorithm | Backend `filterHouseholdSafe` used `normalizeTitleBase` (strips subtitles, returns franchise root like "Batman") to filter watched titles; owning ONE "Batman" movie banned ALL Batman films; 13 of 20 recommendations dropped | Filter on exact title+id only (`filterRecommenderSafe`), never on franchise root | Normalization that is useful for grouping (display) is toxic for filtering (exclusion); the same transform must not serve both purposes |
| 11 | **`/scratch` tmpfs masks chown → every transcode Permission Denied** | Transcoder health checks green; unit tests green; every REAL transcode fails with `Permission denied` on `/scratch` | Docker tmpfs with options (`size=2g`) mounts as `root:root 0755`; the image's `chown` runs at build time but the tmpfs OVERLAYS it at runtime, masking the ownership; tests use stub ffmpeg that never writes `/scratch` | Mount with `mode=1777` (`/scratch:size=2g,mode=1777`) | A tmpfs mount with options is a new filesystem, not an empty overlay — it replaces the image's directory permissions, not augments them |
| 12 | **cap_drop ALL crash-loops privilege-dropping containers** | Recommender + glitchtip-db + glitchtip-redis all boot-loop; logs: "operation not permitted" on `gosu`/`setpriv` | Container hardening (`cap_drop: ALL`) removed `SETUID`/`SETGID`/`CHOWN` that `gosu` (used by many Docker entrypoints to drop root) requires | Add back the minimum caps: `SETUID`, `SETGID`, `CHOWN` (+ `DAC_OVERRIDE`, `FOWNER` for postgres) | `cap_drop: ALL` is a starting point, not a finished config; any entrypoint that changes user needs privilege caps; always boot-test after hardening |
| 13 | **IPTV player buffer fix made stuttering worse** | Widening the latency-chasing buffer from 3s to 8s made periodic stutter larger and more violent | `liveBufferLatencyChasing:true` hard-seeks the playhead via MSE flush; a wider window means a bigger seek jump (~6s); the buffer bought time between stutters but doubled the stutter size | Switch from seek-based chasing to `liveSync:true` with `liveSyncPlaybackRate:1.1` (gradual speed drain, no seek) | A symptom-masking fix can simultaneously worsen the symptom-causing mechanism; measure the failure mode before applying buffer |
| 14 | **TMDB enrichment wired-but-never-called → 100% null IDs** | Zero movies had TMDB metadata; feature appeared "live" in code | Scanner (`scanner.rs`) never called `TmdbClient`; `TMDB_API_KEY` was loaded into config but the field was never read; the resolver had 9 passing unit tests in isolation, so "tested" was claimed | Wire `TmdbClient` into `index_file`; add integration test asserting non-null after scan against mocked TMDB | Unit tests on an isolated component prove the component, not the integration; a feature that never gets called in production is not a feature |
| 15 | **Internal auth mode defaults to Off → 401 tests pass against unauthenticated service** | All auth tests green; `cargo test` green; backend actually serving all internal routes unauthenticated in production | `docker-compose.yml` defaulted `MEDIA_INTERNAL_PRINCIPAL_MODE=:-off`; `auth.rs` short-circuits and serves everything when mode is `Off`; the 401 test forces `enforce` mode explicitly — it never tested the default | Production compose explicitly sets `enforce`; CI builds also set `enforce` | A test that forces the secure mode while production runs the insecure default is testing fiction; the gate under test must match the gate in production |

---

## 3. TOP 5 DEEP DIVES

### A. The Cloudflared 502 (and its sequel)

**Files:** `incidents/incident-2026-05-30-cloudflared-502.md`, `docs/operations/cloudflare-tunnel.md`

A security hardening pass moved cloudflared off `network_mode: host` (which exposed all admin loopback ports to a compromised tunnel image) onto the compose bridge network. This was the right security call. But the companion step — pointing cloudflared's dashboard-managed ingress origin from `http://localhost:3001` to `http://backend:3001` — was filed as "do in the dashboard later" and never done. The result: cloudflared came up healthy, backend came up healthy, but every proxied request failed with `dial tcp [::1]:3001: connection refused`. The `[::1]` looked like an IPv4/IPv6 mismatch and the first hypothesis was "force IPv4 with `127.0.0.1`." It was wrong. `[::1]:3001` was cloudflared dialing its OWN loopback — where nothing listens — because it was on the bridge network, not the backend's network. The fix was `network_mode: "service:backend"`: cloudflared joins the backend's network namespace, so `localhost:3001` inside cloudflared IS the backend's listener. No dashboard change needed. But the fix introduced a sequel incident: `service:backend` binds to the SPECIFIC backend container instance. After the next backend recreate, both containers showed "Up" and the API 502'd again. `depends_on` only orders first start; it does not re-link after a recreate. The lesson is layered: (1) half-migrations are time bombs, (2) healthcheck-green is not reachability-proven, (3) container networking abstractions have state that compose lifecycle doesn't track.

### B. Grey-Box at 0:00 — Four Causes, One Symptom

**Files:** MEMORY.md `project_media_playback_greybox_triplefix.md`, commits `0cda2f4`, `977f892`, `f091d41`, `d1fc9a7`

American Dad! S01E07 showed a grey box at 0:00. Server logs: 200 on all endpoints. ffprobe on segments: valid H.264. The first diagnosis was keyframe cadence — the VAAPI encoder produced ~14s GOP intervals, so the first segment didn't arrive until after the backend's 12s ready-poll timeout expired and served a "not ready" manifest to hls.js. Fixed. Still grey. Second cause: EAC3 5.1 audio was being copy-streamed unmodified; browsers only decode AAC; the audio track was silently invalid. Fixed. Still grey (on a different episode). Third cause: inline `-c:s webvtt` subtitles under `-re` held the first video segment 9 extra seconds AND generated a manifest (`index_vtt.m3u8`) that nothing ever requested. Fixed. Declared "proven" on server-side evidence — wrong. Fourth cause (found when a user retested a different episode): 5.1 AAC SourceBuffer append was REJECTED by Chrome MSE silently despite `isTypeSupported(mp4a.40.2)` returning `true` (it ignores channel count). The rejection killed the whole fragment; hls.js re-appended without refetching; currentTime stuck at 0. The fix was `-ac 2` stereo downmix. Each cause produced identical symptoms: grey box, server-side 200. The lesson: the browser's MSE SourceBuffer is a second acceptance gate BELOW the HTTP layer that fails silently, and "manifest 200 + valid ffprobe" is not "plays in a browser." Proving playback requires a real browser with DevTools attached.

### C. The /scratch tmpfs Masks chown

**Files:** `docs/M4-TRANSCODE-VERIFICATION.md`, MEMORY.md `project_m4_deployed_transcode_proven.md`

The transcoder had been "passing tests" for weeks. Unit tests used a stub ffmpeg that wrote fake playlists and never touched `/scratch`. The healthcheck ran on startup and verified the HTTP surface was live. Nothing wrote to `/scratch` during any automated verification. Then the first real transcode ran against an actual library file and died immediately: `failed to prepare session: Permission denied`. The Dockerfile had a `chown` on `/scratch` that gave the container user write access. The docker-compose.yml had `tmpfs: /scratch:size=2g`. A tmpfs mount with options creates a fresh filesystem at `root:root 0755` and OVERLAYS the directory — the image's `chown` is masked. The fix was `mode=1777` on the tmpfs mount. The principle: a hermetic test suite that never exercises the runtime filesystem gives you green CI and a broken production deployment. The test told you the HTTP surface works; it never told you the container can write to its working directory.

### D. The EPG Resolved-But-Empty Poison

**Files:** `docs/operations/epg.md`

The third-party EPG supplement ran a partial ingest. The pipeline: (1) SELECT channels with no `epg_resolved_id`; (2) SET `epg_resolved_id` for matching channels; (3) stream their programmes. The ingest crashed between step 2 and step 3. On next run, those 3,172 channels had `epg_resolved_id` set (they appeared "done") so step 1 returned zero rows for them — permanently skipped. The resolved count jumped from 14,293 to 17,481 with zero new programmes — a state that looked like progress but was actually poison. The cleanup: null out any `epg_resolved_id` with zero associated programmes. The general principle: marking state as "done" must be the LAST step, not a precondition for doing the work. If you mark it done first and then do the work, a crash between commit and completion leaves corrupted state that can never be retried. This is the two-phase commit problem; it appears constantly in pipelines.

### E. The IPTV Quality "Fix" That Made Things Worse

**Files:** `docs/IPTV-QUALITY-DIAGNOSIS.md`

A player was stuttering on live IPTV. Someone added a buffer: widened `liveBufferLatencyChasing` from 3s to 8s, enabled stash. Playback smooth for a few seconds, then a much larger, more violent stutter. The analysis: `liveBufferLatencyChasing:true` doesn't buffer — it hard-SEEKS the playhead (MSE flush + decoder reset) whenever latency drifts outside the window. Widening the window from 3s to 8s meant the seek jump went from ~1s to ~6s: a bigger buffer buys more time between seeks, then delivers a bigger MSE-flushing lurch. The buffer and the seek mechanism were in conflict, and adding buffer made the seek worse. The actual fix was a different mechanism entirely — `liveSync:true` with `liveSyncPlaybackRate:1.1`, which gradually speeds up playback to drain excess buffer (no seek at all). The lesson: understand the failure mechanism before applying a mitigation. A mitigation that masks a symptom while feeding the mechanism is not a fix — it is a delayed bigger failure.

---

## 4. PREREQUISITES — Syllabus Module Mapping

| Story | Module |
|-------|--------|
| Cloudflared 502 / netns | `nas-infra.md` — Docker compose network modes; container lifecycle |
| Backend recreate breaks tunnel | `nas-infra.md` — deploy runbooks; `ops-cloudflare-tunnel.md` |
| curl healthcheck takes site down | `nas-infra.md` — healthcheck design; container runtime environments |
| SSRF guard kills live IPTV | `backend-middleware.md` — SSRF guards; security invariants and edge cases |
| Grey-box at 0:00 (four causes) | `transcoder-runtime.md`, `spa-player.md` — HLS pipeline; browser MSE; audio codec compatibility |
| NAS build brown-out | `nas-infra.md` — `nas-safe-build` skill; homelab constraint model |
| EPG sniffer race | `epg.md` — event stream parsing; SAX sniffer patterns |
| EPG resolved-but-empty poison | `epg.md`, `data-layer.md` — two-phase commit; pipeline idempotency |
| Plex backup WAL race | `nas-infra.md` — SQLite WAL behavior; filesystem backup of live databases |
| Franchise-collision filter | `rec-serving.md`, `suggestions-feedback.md` — normalization vs. exclusion |
| `/scratch` tmpfs masks chown | `transcoder-runtime.md` — Docker volume and tmpfs semantics |
| cap_drop ALL crash-loops | `nas-infra.md` — container hardening; minimum capability sets |
| Buffer fix worsens stutter | `spa-player.md`, `iptv-core.md` — live player sync mechanisms |
| TMDB wired-but-never-called | `media-core.md` — integration testing vs. unit testing |
| Auth mode defaults Off | `sessions-tokens.md`, `backend-middleware.md` — security defaults; test-vs-production config drift |

---

## 5. QUIZ BANK

**Q1.** The public API (`api.theemeraldexchange.com`) is returning 502. You SSH to the NAS and run `curl http://127.0.0.1:3001/api/health` — it returns `{"ok":true}`. Both the backend and cloudflared containers show "Up" in `docker ps`. What is your first check, and why?

**A1.** Check whether the backend was recently recreated (redeployed), then check `docker logs --tail 30 exchange-cloudflared` for `Unable to reach the origin service ... originService=http://localhost:3001`. If you see `dial tcp [::1]:3001: connection refused`, cloudflared is dialing its OWN loopback — not the backend's — because the `service:backend` netns reference broke when the backend container instance was replaced. Fix: `docker compose up -d --no-deps --force-recreate cloudflared`. Background: `network_mode: "service:backend"` binds to a specific container instance, not to a service name; recreating the backend creates a new instance, orphaning the tunnel's netns ref. `depends_on` does not re-link on recreate.

**Q2.** A video plays the first segment, then the player freezes at 0:00 with no error. Server logs show 200 on all segment fetches. `ffprobe` on a downloaded segment shows valid H.264 video. What additional check do you make before declaring the server-side clean?

**A2.** Open a real browser (not headless/bundled Chromium — it lacks H.264/AAC codecs) with DevTools Network and Console open. Look for `bufferAppendError` or `SourceBuffer error` in the console, and check whether `currentTime` stays at 0 despite `fragBuffered` incrementing. A SourceBuffer append rejection is silent at the HTTP layer — the segment is served and fetched successfully but the browser's MSE rejects the append (common causes: non-AAC audio codec, multichannel AAC >2ch, or audio/video stream mismatch). The fix is at the transcoder (downmix to stereo, enforce AAC output), not at the server routing layer.

**Q3.** You run `cargo test -p transcoder` and get 100% pass. You deploy. The first real transcode fails with `Permission denied` on `/scratch`. What happened, and how do you fix it?

**A3.** The tests use a stub ffmpeg that never writes to `/scratch` — they prove the HTTP surface but not the runtime filesystem. The real issue: the docker-compose.yml mounts a tmpfs at `/scratch` with a `size=` option. A tmpfs with options creates a fresh filesystem at `root:root 0755`, OVERLAYING and masking the `chown` baked into the Docker image. Fix: mount with `mode=1777` (same as `/tmp`), e.g. `tmpfs: /scratch:size=2g,mode=1777`. General lesson: a tmpfs mount with options is a new filesystem, not an empty directory — it replaces the image's directory permissions at container start time.

**Q4.** An engineer adds a wider latency buffer to the IPTV live player to fix stuttering — `liveBufferLatencyChasing: true`, `liveSyncMaxLatency: 8.0`. The stuttering gets worse, not better. Explain why, and what the correct fix is.

**A4.** `liveBufferLatencyChasing:true` is NOT a smooth-drain buffer — it hard-SEEKS the playhead (MSE flush + decoder reset) when latency drifts outside the window. Widening the window from 3s to 8s delays the seek trigger, but when it fires, the jump is now ~6s instead of ~1s — a larger, more disruptive flush. More buffer → longer delay → bigger lurch. The correct mechanism is `liveSync:true` with `liveSyncPlaybackRate:1.1` (plays slightly fast to drain excess buffer gradually, never seeks). Lesson: understand the mechanism before adding buffer; the two approaches (seek-based and playback-rate-based) are not equivalent.

**Q5.** An EPG ingest pipeline marks a channel's `epg_resolved_id` BEFORE streaming its programme data. The ingest crashes partway through. On the next run, those channels are skipped. Why, and how do you design around it?

**A5.** The pipeline committed "done" state as a precondition for doing the work. A crash after the commit but before the work leaves channels that look resolved (they have an `epg_resolved_id`) but have zero programmes stored. The next run's `SELECT WHERE epg_resolved_id IS NULL` doesn't see them; they're permanently orphaned. Design principle: mark state as done LAST, after the work is durable. If you must checkpoint early (for very long operations), use a different state (e.g., `epg_resolved_pending`) that the retry logic knows to re-attempt. As a cleanup: `UPDATE channels SET epg_resolved_id = NULL WHERE NOT EXISTS (SELECT 1 FROM programmes WHERE channel_id = ...)`.

**Q6.** A container was hardened with `cap_drop: ALL` in docker-compose.yml. It now crash-loops on startup with "operation not permitted." What is the most likely cause, and what is the minimum fix?

**A6.** The container's entrypoint uses `gosu` (or a similar privilege-dropping utility like `setpriv` or `su-exec`) to switch from root to a lower-privilege user before exec-ing the main process. `gosu` requires `SETUID` and `SETGID` capabilities; Postgres-based images also need `CHOWN`, `DAC_OVERRIDE`, and `FOWNER` to own their data directory. `cap_drop: ALL` removes these. Minimum fix: add `cap_add: [SETUID, SETGID, CHOWN]` (plus `DAC_OVERRIDE` and `FOWNER` if it's a database container). Rule: always boot-test a hardened image before declaring it production-ready; the crash is invisible in unit tests and CI because they don't run entrypoints under the full compose security profile.

---

## 6. PATTERNS — Recurring Failure Patterns Across All Incidents

### Pattern 1: The Symptom Lies About the Layer

Every grey-box incident, the SSRF "loads forever," the 502 with a healthy backend — in each case the observable symptom was at layer N while the cause was at layer N-2 or N-3. "API 502" looks like a backend problem; the backend was fine — the issue was container networking. "Player grey box" looks like a player bug; the player was correct — the issue was the SourceBuffer codec contract. "Loads forever" looks like a network problem; the network was fine — the issue was a security guard rejecting a redirect hop. **Diagnosis reflex:** always check one layer deeper than the symptom suggests before concluding anything.

### Pattern 2: Green Tests, Broken Production (the Verification Gap)

The `/scratch` tmpfs masked the Dockerfile chown — unit tests never write to that directory. The TMDB enrichment had 9 passing unit tests but was never called. The internal auth mode defaulted to Off in production while tests forced enforce. In each case, the test suite was testing a property of the component in isolation that was not the property being exploited in production. **Design reflex:** integration tests must test the deployed configuration, not the test-friendly configuration. The thing that can kill you in production is the default, not the forced-test-mode.

### Pattern 3: Half-Migrations Leave Time Bombs

The cloudflared bridge network move changed `network_mode` but deferred the dashboard ingress origin update. The EPG resolved-but-empty bug committed "done" state before storing data. The CSRF bearer exemption was added without fully auditing all call sites that would now bypass cookie auth. In each case, a multi-step migration was committed with step 1 done and step 2 deferred. The deferral is almost never explicitly tracked; it surfaces as an incident. **Process reflex:** a migration is atomic. If step 2 cannot be done in the same commit, it must be blocked by a test or a deploy guard — not filed as "do later."

### Pattern 4: Mitigations That Feed the Mechanism

The buffer widening for IPTV stutter, the `depends_on` ordering that doesn't survive a recreate, the sniffer registration race patched with retry logic that still had a window. In each case a mitigation reduced the symptom's frequency without understanding the underlying mechanism, and later a condition caused the mechanism to fire harder. **Design reflex:** before adding a mitigation, write down the mechanism that produces the failure. If the mitigation doesn't interrupt the mechanism — only delays or dampens it — it is not a fix.

### Pattern 5: State Commits Must Trail Work Commits

The EPG pipeline, the transcoder session hijack (same (kind,id,sub) — the second grant silently orphans the first), the Plex backup WAL race. In all cases, a durable state marker was written before the work it represented was durable. The principle is the same as two-phase commit: you don't write the "success" record until the data is fsync'd. In distributed pipelines this is especially dangerous because crashes between the state commit and the work leave entries that appear "done" but are empty, and retries skip them. **Design reflex:** if your pipeline writes a "done" marker, ask: "what does a crash one millisecond after this write look like to a retry?"
