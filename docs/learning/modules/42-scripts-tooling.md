
# Scripts & Tooling — Teaching Dossier

## 1. WHAT

Scripts in this project serve three purposes. **Proof scripts** are end-to-end verification harnesses that drive the DEPLOYED system and capture evidence that it actually works. (Exit code 0 is not enough; they prove business behavior — playback starts in N seconds, segments decode, auth gates work.) **Security monitors** detect configuration drift (home IP leaks, open ports, Plex re-enabling Remote Access) by comparing runtime state to a baseline. **Utility scripts** augment the build and deployment pipeline — they age-check Docker image pins for staleness, assemble audit reports from workflow journals, and render synthetic audits into HTML. These are discovery tools, not configuration; they surface what's actually live so you can verify "deployed ≠ claimed."

## 2. WHY

**"Exit code 0 is not done."** When you deploy a service, its process might start without errors, logs might show no crashes, and the health endpoint might return 200 — but that doesn't mean the user can actually transcode a movie, stream it, or resume playback where they left off. Proof scripts answer: "Does the deployed system **actually work** for a real user workload?"

- A proof script runs on the NAS (where the real containers live), uses real files from the library, mints real auth tokens (never hardcoded), and drives the chain end-to-end: does `curl` return the right HTTP code? Does a segment decode with ffprobe? Are the bytes >0 and the codec what we promised?
- Security monitors catch **configuration drift** — the goal is to notice immediately if someone (or a misconfigured service) re-enables Plex Remote Access, binds a container to 0.0.0.0 where it shouldn't be, or your DNS suddenly resolves to a home IP instead of Cloudflare. Baseline = "what we saw last time"; drift = "this time is different, alert the owner."
- Utility scripts like pin-staleness prevent subtle bugs: a Docker image pin can slip to a 2-year-old tag while the digest is newer (so `docker pull` returns a different binary, but no warning). These tools make the invisible visible.

The pattern: **deploy, then prove** (don't prove on staging — prove on real deployed systems against real data).

## 3. MAP

| Script | What It Proves | How to Run |
|--------|----------------|-----------|
| **media-playback-proof.sh** | End-to-end web playback: media-core /stream → transcoder HLS → backend /api/transcode proxy → segments fetch & decode. Auth gate (no token = 401). | `ssh root@theemeraldexchange.local "bash /path/to/scripts/media-playback-proof.sh <movie_id>"` — runs inside the backend container, mints tokens, polls manifest until seg appears (TTFS ~few sec), fetches & validates segment bytes. |
| **m4-transcode-proof.sh** | Real-library transcode: file grant → ffmpeg session start → manifest readiness → first-segment latency (TTFS) → segment decode via ffprobe (codec/profile/bitrate check) → seek latency (jump +1800s, re-measure). | `ssh root@theemeraldexchange.local "bash scripts/m4-transcode-proof.sh <media_files.id>"` — queries live media.db for file metadata, mints internal-principal token inside recommender, POSTs grant to transcoder, polls until seg, ffprobes output for codec type & HDR tonemap proof. |
| **exposure-monitor.sh** | Security drift: DNS (all known hostnames resolve only to Cloudflare/Netlify ranges, not home IP) + NAS ports (no new 0.0.0.0 binds) + Plex Remote Access (PublishServerOnPlexOnlineKey stays 0). | Local (macOS): `bash scripts/security/exposure-monitor.sh`. Installs to ~/.local/share/eex-security/ for launchd+cron scheduling. First run writes baseline; later runs diff against it. Alerts via macOS notification if drift detected. |
| **check-image-pin-staleness.mjs** | Docker image pins are fresh: every image repo:tag@digest in docker-compose.yml is queried against Docker Hub; if tag last pushed >365 days ago, fail CI. Detects lagged tags & digest drift (warning only). | `node scripts/check-image-pin-staleness.mjs [compose-file]` (default: docker-compose.yml). Also `node scripts/check-image-pin-staleness.mjs --self-test` for offline parser validation. |
| **assemble-audit.mjs** | Reconstructs audit result object from workflow journal. Enriches findings w/ verdicts, computes stats, writes docs/audit-results.json. | `node scripts/assemble-audit.mjs <journal.jsonl> [synthesis.json]` — reads a JSONL stream of workflow events, flattens findings across subsystems, merges synthesis block if provided. |
| **build-audit-html.mjs** | Renders audit results into browsable HTML report. | `node scripts/build-audit-html.mjs <audit-results.json>` → writes docs/audit-results.html. |
| **write-audit-synthesis.mjs** | Synthesizes adversarial audit verdicts into a narrative summary. | Part of the multi-agent audit workflow; called by the orchestrator. |

## 4. PREREQUISITES

Before you can understand proof scripts, you need to know:

1. **How containers communicate on this NAS:** cloudflared bridges the public internet to a private backend namespace (localhost:3001 inside, not reachable over SSH). Proof scripts run ON the NAS inside a container so they reach private sockets; they cannot be run from your laptop.

2. **Authentication layers:** two separate token systems coexist:
   - **internal-principal:** minted inside recommender, signed with INTERNAL_PRINCIPAL_SECRET, grants access to media-core's /stream handoff.
   - **media stream token:** minted inside backend, signed with STREAM_TOKEN_SECRET, bound to a transcode session, passed as `?t=` query param on segment URLs.

3. **Session lifecycle:** transcode sessions are ephemeral (spawned by `grant`, live while ffmpeg runs, stopped explicitly or on 30s idle timeout). No session = no playback. Proof scripts mint them fresh and clean them up.

4. **FFprobe output:** `ffprobe -print_format json` returns a flat JSON with `streams` array (video/audio/subtitle objects) and `format` object (container metadata). Video streams have `codec_name`, `profile`, `width/height`, `pix_fmt` (pixel format: yuv420p, nv12, etc.), color space (`color_primaries`, `color_transfer`).

5. **HLS segments:** MPEG-TS files (.ts), ~4-6 seconds each. A manifest lists them: `index.m3u8` contains `#EXTINF:6.0`, `seg_00000.ts`, `#EXTINF:6.0`, `seg_00001.ts`, etc. The backend rewrites segment URLs to include the stream token: `seg_00000.ts?t=<token>`.

## 5. GOTCHAS & WAR STORIES

### media-playback-proof.sh

- **Internal principal is language-specific:** minted via `python3 + emerald_contracts` pyo3 binding inside the recommender. If you change the format or signature, old tokens won't validate.
- **Polling for manifest readiness is your TTFS clock:** the script polls the manifest every 0.5s for up to 30 iterations (15s timeout). If ffmpeg is slow to encode the first segment, you hit the timeout with "NO SEGMENT" before ever seeing bytes.
- **Segment lines are rewritten by the backend:** the manifest returned by `/api/transcode/session/{id}/index.m3u8` MUST have `?t=` appended to each segment URL. If it doesn't, the rewrite gate broke and segments will 401. Proof verifies this explicitly: `if(mt){ seg=mt[0]; ... if(!seg){ FAIL }`.
- **Auth gate test is negative:** the proof fetches the manifest WITHOUT the token and expects 401. If you get 200, the gate is missing.

### m4-transcode-proof.sh

- **`immutable=1` on sqlite3 URI is critical:** media.db lives in /mnt/user/appdata and is accessed over SSH via sqlite3 CLI. Opening it with `immutable=1` prevents SQLite from holding write locks and blocking Plex.
- **Real file metadata comes from media_files rows:** the script constructs a grant body by querying the live DB. If media_files.id doesn't exist, you get "no such row" before ever hitting the transcoder.
- **docker exec -e VARS is how you pass secrets into containers:** the script exports SID, TOK, etc. as env vars and runs `node -e` to fetch within the container context. This is the safe pattern (secrets never cross the network).
- **ffprobe JSON must be parsed per-stream:** video/audio/subtitle tracks are separate objects in the `streams` array. The script iterates them and prints codec_type-specific fields (codec_name for video/audio, but no codec for subtitles). Subtitle count often ≠ visible tracks.
- **Segment bytes are small (1–10KB typical for a 0.5s segment):** if you fetch a segment and get <1000 bytes, something went wrong (encoding failed, early EOF, etc.). Proof uses this as a sanity gate.
- **Seek latency is measured from POST /seek to first 200 segment:** the script polls every 0.5s for the segment and expects a 200 within 2 minutes. If the transcoder's ffmpeg doesn't support seek(-ss offset), you timeout here.
- **Cleanup via curl is fire-and-forget:** the final `curl ... /stop` might fail (session already gone, timeout, network) but the script ignores it. Sessions auto-reap after 30s idle anyway.

### exposure-monitor.sh

- **Baseline is JSON, not a simple list:** the script stores `{dns: "...", nas_ports: "...", plex_publish: "..."}` to detect NEW drifts only. If the state was `[a, b]` and is now `[a, b, c]`, only `c` triggers an alert (so you don't spam on startup if every port shows up).
- **SSH to NAS uses ConnectTimeout + BatchMode=yes:** if the NAS is unreachable or SSH hangs, the script waits up to 10s, then continues with empty output. No ports detected = no alerts (conservative: better to skip a check than to scream falsely).
- **Plex preference XML is brittle:** the regex extracts `PublishServerOnPlexOnlineKey="<value>"`. If Plex updates the format, the regex fails silently. Check manually with `grep PublishServerOnPlexOnlineKey /mnt/user/appdata/...` if you suspect drift.
- **macOS launchd cannot read ~/Documents (TCC):** so the script must be copied to ~/.local/share/eex-security/ and run from there. The LaunchAgent points to that copy, not the repo.

### check-image-pin-staleness.mjs

- **Docker Hub API is best-effort:** if the API is rate-limited, down, or returns 404, the script warns and continues (exit 0, not 1). Network errors never fail CI.
- **Non-Hub registries (ghcr.io, lscr.io, etc.) are silently skipped:** the script only checks Docker Hub pins. If you need to age-check GitHub Container Registry, that's a separate tool.
- **Digest drift is reported but not fatal:** if a pin like `postgres:15@sha256:<old>` has a newer digest live, the script prints "note: ..." but exits 0. This is intentional — lagging a fast-moving tag is the whole point of digest pinning.
- **Official images have implicit `library/` prefix:** `postgres:15` is really `library/postgres:15` in the Hub API path. The script handles this via `hubRepoPath()`.

### assemble-audit.mjs & build-audit-html.mjs

- **These are post-processing tools**, not proofs. They ingest JSON from multi-agent audit workflows and generate reports. If a workflow fails, these have nothing to assemble.
- **Finding IDs are deterministic:** `di-fi` (dossier index, finding index within dossier). If you re-run the audit with a different agent order, IDs will shift. Do not hardcode finding IDs in playbooks.

## 6. QUIZ BANK

### Q1: Proof vs. Health Check
You deploy a new transcoder image. The Docker health check runs `curl http://localhost:8003/api/health` from inside the container, and it returns 200. The container is marked "healthy." Should you declare victory?

**A1:** No. A 200 health check means the HTTP server is up and listening. It does NOT mean ffmpeg can encode, the GPU is accessible, or a real transcode will succeed. You need a proof script: pick a movie, run `m4-transcode-proof.sh <id>`, wait for TTFS, ffprobe the output, verify H.264 + the right bitrate came out. Only then is the transcode chain proven.

---

### Q2: Token Minting and Secrets
`media-playback-proof.sh` mints an internal principal using `docker exec exchange-recommender python3 -c "..."` and passes `INTERNAL_PRINCIPAL_SECRET` from the environment. Why does the script NOT retrieve the secret via `docker inspect --format='...'` or `docker exec ... printenv`?

**A2:** Because the secret leaves the container and crosses the SSH network. The proof runs ON the NAS (via SSH), so if the script fetched the raw secret via `printenv`, it would transit over the SSH connection in plaintext and logs. Instead, the script asks the container to mint the token internally (python3 inside recommender with the secret already loaded), then the script receives only the signed token. The secret never leaves the container.

---

### Q3: Segment Size Sanity
In `m4-transcode-proof.sh`, after fetching a segment, the script checks `if(bytes<1000){ FAIL }`. Why 1000 bytes as the threshold, and what does a segment <1000 bytes indicate?

**A3:** A ~4–6 second segment of H.264 video is typically 50KB–500KB depending on bitrate and scene complexity. <1000 bytes is a smoking gun for early EOF, encoding crash, or the transcoder serving an empty/corrupted file. The 1000-byte threshold is conservative; it catches obvious breakage without being so tight that a legitimately tiny segment (e.g., a 1-frame black intro) fails. If this ever fires in prod, the ffmpeg process probably crashed mid-encode or the disk ran out of space.

---

### Q4: Baseline Drift Detection
`exposure-monitor.sh` writes a JSON baseline on first run and diffs against it on subsequent runs. Why not just alert on every check, comparing to a hardcoded safe list?

**A4:** Because the hardcoded list would need to know EVERY current state (all NAS ports, all DNS zones, Plex settings). If you add a new container with a 0.0.0.0 bind, the hardcoded list doesn't know about it and alerts forever as "false positive." The baseline approach: first run = silent (writes observed state as baseline), second run = compare, alert ONLY on changes. This means safe states (even new-but-intentional ones) are baseline-silent, but you catch drifts (e.g., Plex re-enabled Remote Access) immediately.

---

### Q5: Why Immutable SQLite
`m4-transcode-proof.sh` opens media.db with `immutable=1` in the URI: `file://...?immutable=1`. What breaks if you use the default (mutable) mode?

**A5:** media.db lives in an active Plex Media Server appdata volume. Plex is reading and writing it constantly (library scans, metadata updates). If the proof opens it in mutable mode, SQLite takes a write lock (or at least a reserved lock) and Plex stalls on its next write, causing stuttering or timeouts in Plex. `immutable=1` tells SQLite "I will not write, open for reading only, skip locks." This lets the proof coexist with Plex without interference.

---

### Q6: Proof Completeness
You run `media-playback-proof.sh 7` and it prints:
```
sessionId=abc123
manifest status: 200 ct: application/vnd.apple.mpegurl
rewritten segment line: seg_00000.ts?t=<token> (token preserved on segment URL ✓)
segment status: 200 ct: video/mp2t bytes: 45000
no-token manifest status (expect 401): 401
PROXY CHAIN OK ✓
```
Does this prove the user can stream the movie on their M4?

**A6:** Partially, but not completely. The proof shows (1) auth gate works, (2) manifest rewrites correctly, (3) a segment fetches, (4) the bytes are reasonable. But it does NOT probe (1) whether the user's browser can MSE-append the segment (audio mismatch, codec unsupport), (2) whether the H.264 profile is decodable on M4 hardware, or (3) whether resume/seeking from the browser works (the proof does a server-side seek, not a client-side one). For full confidence, you'd also run the proof in a real browser with Playwright + video.currentTime polling.

## 7. CODE-READING EXERCISE

**Task:** Read `m4-transcode-proof.sh` lines 42–65. This is the "grant and wait for first segment" phase. Walk through what happens and why each step matters.

**Your task:**
1. Why does the script POST to `/api/transcode/grant` before polling the manifest?
2. What does the `BODY` variable contain, and why is it constructed from a live DB query instead of hardcoded?
3. The polling loop runs 120 times with 0.5s sleeps. Why 120 (= 60s timeout) and not 30 (= 15s)?
4. When the segment appears (line 56 finds `seg_\d+\.ts`), why does the script break immediately instead of waiting for a few more segments?

**Walkthrough:**

**1. Why POST /grant first?**
The `/grant` endpoint is the contract handshake. You send it file metadata (path, codec, bitrate caps) and playback caps (what the client can decode). The transcoder responds with a plan (H.264, 1080p, AAC stereo) and a sessionId. The sessionId is the handle for all subsequent requests: seek, manifest fetch, segment fetch, stop. Without a grant, there's no session, so manifest requests fail with 404.

**2. Why construct BODY from the live DB?**
This is the linchpin of the "real file" proof. The script does NOT hardcode `file: {path: "/mnt/data/movies/example.mkv", ...}`. Instead, it queries `media_files.id=$ID` and reads the REAL metadata: actual container, duration, video codec (h265 or mpeg4 — you don't know until you look), hdr_format, audio tracks. If media-core's grant logic is broken (e.g., it ignored a 10-bit HEVC file, tried to copy it, crashed), this proof catches it because you're sending REAL metadata, not a carefully-chosen test case.

**3. Why 120 × 0.5s = 60s timeout?**
Encoding latency varies wildly. A simple H.264 copy-remux of a 100MB file might have TTFS in 1–2 seconds (just streaming and muxing). But a full HEVC→H.264 transcode of a 4K file on the NAS's 6-thread iGPU with concurrent Plex activity can take 30–40s before the first segment is ready. 60s is a conservative budget that accounts for slow encodes, network jitter, and load. If TTFS exceeds 60s, it indicates a serious problem (ffmpeg stalled, GPU wedged, I/O bottleneck).

**4. Why not wait for more segments?**
Speed of proof. If you see seg_00000.ts, you have enough data to answer "did encoding start?" The segment took TTFS seconds to produce; waiting for seg_00001.ts would add another 4–6 seconds (a segment's worth of encoding time) and prove nothing new — if seg_00000.ts is there, the pipeline is unblocked, the manifest is being written, and the next segment will follow. The proof trades throughput for coverage: measure TTFS fast, move to output validation next.

---

