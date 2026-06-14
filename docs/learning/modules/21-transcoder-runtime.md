
# Transcoder Runtime — Teaching Dossier

---

## 1. WHAT

The transcoder is a standalone Rust microservice that converts video files into
HLS (HTTP Live Streaming) format on demand. When a user presses Play on a movie
or TV episode, the backend asks the transcoder to start a "session." The
transcoder spawns an ffmpeg process that reads the source file and writes a
playlist file (`index.m3u8`) plus small video segments (`seg_00000.ts`,
`seg_00001.ts`, …) into a temporary directory. The player fetches those segments
one by one over HTTP while ffmpeg is still producing them. Every 30 seconds
without a heartbeat ping the session is automatically shut down and its disk
space reclaimed. The transcoder can also route video encode work to the
NAS's Intel integrated GPU instead of burning the NAS's weak 6-core CPU — the
GPU encodes H.264 video while the CPU is barely involved, so multiple streams
can play simultaneously without starving the Plex Media Server sharing the same
box.

---

## 2. WHY

**Why `-re` pacing for live streams?**
`-re` tells ffmpeg to read the input at the same speed as the wall-clock (one
second of video per one real second). For an IPTV/live channel, the HLS muxer
is configured with a sliding window (`-hls_list_size 8 -hls_flags
delete_segments`) that keeps only the eight most recent segments on disk.
Without `-re`, ffmpeg would sprint through the content, write segments far
faster than the player consumes them, and the sliding window would delete
segments before the player ever fetched them — resulting in 404 errors. For
local VOD (movies/episodes), `-re` is deliberately NOT used; the encoder runs
as fast as hardware allows so the player can buffer far ahead and seek anywhere
that has already been encoded.

**Why a supervisor task, not just "spawn and forget"?**
ffmpeg can crash mid-encode (driver glitch, OOM, corrupt packet). If the
process dies and nothing notices, the player keeps requesting segments that will
never arrive. The supervisor is a lightweight async loop that owns the ffmpeg
`Child` object exclusively. On an unexpected (non-zero) exit it waits a short
exponential backoff and respawns ffmpeg from where the encode left off. It also
listens on a control channel so that seek and stop commands reach the real
process; without exclusive ownership, two code paths could both try to kill the
process, with one racing into a stale handle.

**Why hardware encode on a weak 6-thread NAS CPU?**
The NAS also runs Plex Media Server. A single libx264 software re-encode easily
drives the 6-thread CPU to 100%, starving Plex and making the SSH connection
sluggish. The Intel Alder Lake iGPU has a fixed-function H.264 encoder
(VDEnc / `h264_vaapi -low_power 1`) that processes video with almost zero CPU
load. Hardware encode lets multiple video sessions run concurrently while the
CPU stays idle enough for Plex and system tasks. The full-HW pipeline
(`-hwaccel vaapi -hwaccel_output_format vaapi` + `tonemap_vaapi`/`scale_vaapi`
+ `h264_vaapi`) also skips the CPU-to-GPU memory copy on decode, so even 4K
HDR sources barely register on the CPU meters.

**Why two separate concurrency caps (global + CPU)?**
Not all sessions are equal. A copy-remux (HEVC container → fMP4, audio re-encode
only) uses negligible CPU because ffmpeg just rewraps existing compressed video.
A software libx264 re-encode of a 4K HDR source can saturate all 6 cores. A
global cap of 4 allows four lightweight remux sessions at once; a CPU cap of 1
ensures that at most one real software-encode is running at any time. Without
the two-tier design, a household watching two shows could silently 503 a third
lightweight stream.

---

## 3. MAP

**Key files**

| File | Lines | Role |
|------|-------|------|
| `crates/transcoder/src/main.rs` | 1–115 | Boot sequence: detect encoders, probe VAAPI full-HW, sweep scratch, start sweeper, bind HTTP |
| `crates/transcoder/src/session.rs` | 1–1174 | All session lifecycle: `SessionManager`, `spawn_child`, supervisor task, idle sweeper, seek/stop |
| `crates/transcoder/src/concurrency.rs` | 1–165 | `Limiter` + `Permit` — two-tier atomic counters for global and CPU caps |
| `crates/transcoder/src/encoders.rs` | 1–216 | Boot-time encoder detection (`ffmpeg -encoders` parse), smoke-test, `vaapi_full_hw_supported` probe |
| `crates/transcoder/src/args.rs` | 1–665 | Pure ffmpeg argument assembly: HLS flags, `-re` vs VOD, filtergraph, bitrate ladder |
| `crates/transcoder/src/routes.rs` | 1–397 | Axum HTTP surface: `/grant`, `/session/{id}/index.m3u8`, `/session/{id}/{segment}`, heartbeat, seek, stop |

**One complete session walkthrough**

1. **Grant** (`POST /api/transcode/grant` — `routes.rs:283`).
   The backend sends the file's probe metadata (codec, height, audio tracks)
   plus the client's declared capabilities. `plan_transcode()` decides whether
   to copy, re-encode, or direct-play. For a transcode plan, `sessions.start()`
   is called.

2. **`sessions.start()` — `session.rs:626`**.
   - Path-confinement check: the source file must be inside `TRANSCODER_MEDIA_ROOT`.
   - Concurrency check: `limiter.try_acquire(cpu_charge)` returns a `Permit` or
     `Busy`. If busy, the route returns `503 transcoder_busy`.
   - Session ID minted: `tx:movie:7:plex:42:1718012345-0`.
   - A temp directory is created under `TRANSCODER_TMP_DIR` (e.g.
     `/scratch/tx_movie_7_plex_42_1718012345-0/`).
   - `spawn_child()` builds the ffmpeg argument vector via `ffmpeg_args_for()`
     (`args.rs:239`) and spawns the process with `kill_on_drop(true)`.
   - A control channel (`mpsc::unbounded_channel`) is created. The `Session`
     struct stores the sender end; the supervisor task owns the receiver.
   - `spawn_supervisor()` is called with the `Child`. The supervisor is the
     **sole owner** of the ffmpeg process for the session's entire lifetime.

3. **ffmpeg runs**.
   - For VOD: `ffmpeg -fflags +genpts -i /media/movie.mkv -map 0:v:0 … -f hls
     -hls_list_size 0 -hls_flags append_list -hls_playlist_type event
     -hls_segment_filename /scratch/…/seg_%05d.ts /scratch/…/index.m3u8`
   - Segments appear as ffmpeg finishes encoding each 2-second chunk.
   - ffmpeg stderr is drained into `tracing::warn!` on a detached task so a
     full stderr pipe never blocks ffmpeg.

4. **Client fetches segments**.
   - Player fetches `GET /api/transcode/session/{id}/index.m3u8`.
   - Route reads the file from disk (`routes.rs:413`). If ffmpeg hasn't written
     it yet, returns `503 manifest not ready`.
   - Player fetches `GET /api/transcode/session/{id}/seg_00000.ts` etc.
   - Route validates the segment name against an allowlist (`is_safe_segment_name`)
     to prevent path traversal, then reads the file from disk.
   - Client POSTs `POST /session/{id}/heartbeat` every ~10 seconds to keep the
     session alive.

5. **Session ends: idle reap or /stop**.
   - **Idle reap**: `spawn_sweeper()` runs every 5 seconds. Any session whose
     `last_seen` is more than 30 seconds ago is passed to `stop()`.
   - **`/stop`**: route calls `sessions.stop(id)`. The map entry is removed, a
     `Shutdown` command is sent to the supervisor, and after the supervisor
     confirms the process is dead, the temp directory is deleted.
   - **Clean ffmpeg EOF** (VOD finishes encoding): supervisor sees exit status 0
     and parks the session in `ChildSlot::Completed`. Segments stay on disk for
     the player to drain. The idle reaper eventually collects it.
   - In all cases the `Permit` is dropped with the `Session`, freeing the
     concurrency slot.

---

## 4. PREREQUISITES

**What a process is (ELI5)**
A process is a running program. When Rust calls
`tokio::process::Command::new("ffmpeg").spawn()`, the OS creates a new
process — a separate program with its own memory — that runs ffmpeg. Your Rust
code gets back a `Child` handle that lets it wait for the process to finish,
read its output, or kill it. When `kill_on_drop(true)` is set, dropping the
`Child` object automatically kills the process, so no zombie process can be
left running if the Rust code crashes or panics.

**What a GPU encoder is (ELI5)**
Modern CPUs have a separate fixed-function chip on the same die as the processor
cores — the integrated GPU (iGPU). While CPU cores are general-purpose and
expensive to run at 100%, the iGPU has dedicated circuitry for one specific job:
encoding video. It can compress a 1080p H.264 video stream while consuming
almost no CPU cycles because it is not using the CPU cores at all. `h264_vaapi`
is the Linux API that lets ffmpeg talk to the Intel iGPU's video encoder
(`/dev/dri/renderD128` is the device file on disk). `-low_power 1` activates the
"VDEnc" pipeline — the only H.264 encoding path Alder Lake supports (the older
"full-rate" pipeline is absent on this generation).

**What HLS is (ELI5)**
HTTP Live Streaming splits a video into small files (segments) of a few seconds
each, plus a plain-text playlist file that lists them in order. The player
fetches the playlist to learn what segments exist, downloads them sequentially,
and decodes each one. Because each segment is a normal HTTP download, HLS works
through firewalls, CDNs, and Cloudflare tunnels without any special streaming
protocol.

**What Tokio async means**
Tokio is Rust's async runtime. Instead of blocking a thread while waiting for
ffmpeg to write a file or a network request to arrive, Tokio parks the task and
runs other tasks on the same thread. `tokio::spawn(async move { … })` creates a
lightweight "green thread" (a task) that Tokio schedules cooperatively. This is
how the supervisor, the idle sweeper, and hundreds of HTTP requests can all be
"running" without needing one OS thread each.

**What an Arc<Mutex<…>> is**
`Arc` is a reference-counted pointer that lets multiple tasks share the same
data. `Mutex` is a lock: only one task can access the data at a time. The
`sessions: Arc<Mutex<HashMap<SessionId, Session>>>` field means every clone of
`SessionManager` shares the same underlying map — cloning the manager is cheap
(just increments the reference count) — and the lock ensures two concurrent
grant requests never corrupt the map.

---

## 5. GOTCHAS & WAR STORIES

**Racing copy-remux to EOF → sliding window deleted segments → 404**
Early IPTV sessions used the live HLS sliding window (`delete_segments`) but
did NOT use `-re`. ffmpeg read the source file at full disk speed — hundreds of
times faster than real-time — and wrote all segments instantly. The sliding
window kept deleting old segments as new ones arrived. By the time the player
fetched `seg_00000.ts` it had already been deleted. Fix: `-re` paces ffmpeg to
wall-clock speed so segments arrive at the same rate the player consumes them.

**Clean ffmpeg exit treated as crash (restart-loop)**
The supervisor originally treated any ffmpeg exit as a crash and immediately
respawned. For live streams this was fine (ffmpeg only exits when the upstream
dies). For a local movie, ffmpeg exits cleanly with status 0 when it reaches
the end of the file. The supervisor would then re-spawn ffmpeg from segment 0,
overwriting the completed playlist and re-encoding the whole title. The player
saw the playlist reset and was confused. Fix: on `status.success()` (exit code
0), the supervisor transitions to `ChildSlot::Completed` and parks, keeping
segments for the player to drain (session.rs:995–1000).

**static-ffmpeg couldn't dlopen iHD → CPU-only until Debian ffmpeg +
intel-media-va-driver**
The first ffmpeg binary was the `static-ffmpeg` crate, which bundles a
statically-compiled ffmpeg. VAAPI hardware encode requires the iHD driver (a
shared library), which static-ffmpeg couldn't load because static binaries can't
`dlopen()` at runtime. Every session silently fell back to CPU libx264. Fix:
switch to Debian's stock `ffmpeg` package, which is dynamically linked and can
load `libva-drm.so` + `iHD_drv_video.so` from the system at runtime.

**10-bit P010 surface fails the VAAPI encoder (graph must end NV12)**
When ffmpeg decodes a Main-10 (10-bit) HEVC source with full-hardware VAAPI
decode (`-hwaccel_output_format vaapi`), the decoded frames are in the P010 pixel
format (10-bit YUV). The Intel Gen12 VDEnc H.264 encoder expects 8-bit NV12.
Feeding P010 directly caused ffmpeg to fail with "No usable encoding profile
found." The VAAPI filtergraph must always end with `scale_vaapi=format=nv12`
(or `tonemap_vaapi=format=nv12` for HDR) to explicitly convert to 8-bit NV12
before the encoder sees the frames (args.rs:643–651).

**/scratch colons → underscores + mode=1777 tmpfs**
Session IDs contain colons (`tx:movie:7:plex:42:…`). When used as a directory
name, a colon is legal on Linux but caused path confusion and subtle bugs in
shell scripts and docker compose volume mounts. Fix: `sanitize()` in session.rs
replaces any non-alphanumeric character (including colons) with underscores
before creating the temp directory. Separately, the `/scratch` tmpfs was
mounted as root:root with mode 0755, so the non-root ffmpeg process couldn't
write to it. Fix: mount with `mode=1777` (world-writable sticky, like `/tmp`).

**`-re` sessions run the full title unless stopped → pile-up = fake 503s**
A `-re`-paced live session runs in real-time — a two-hour movie takes two hours
to encode. If the user navigates away without the player calling `/stop`, the
session keeps running, holding its concurrency slot. With only 1 CPU slot or 4
global slots, a handful of leaked sessions filled all slots and every new play
returned `503 transcoder_busy`. The 30-second idle reaper is the cleanup
mechanism, but during debugging sessions (where heartbeats were minted manually)
the reaper never fired. Workaround: restart the transcoder container to drain all
sessions. Long-term fix: wire the stop URL into the player's unload/close path.
Note: VOD sessions are NOT `-re` and finish quickly; this was only acute for
live IPTV paths.

---

## 6. QUIZ BANK

**Q1.** A user seeks to 45 minutes into a movie. Trace the code path from the
HTTP request to the moment a new ffmpeg process is running at the 45-minute
mark. Which component is responsible for killing the old ffmpeg, and why can't
the HTTP handler do it directly?

**A1.** `POST /api/transcode/session/{id}/seek?to=2700` arrives at
`session_seek()` (routes.rs:518). It calls `sessions.seek(id, 2700)`.
`seek()` (session.rs:747) updates `s.start_secs = 2700` and sends
`SessionCmd::Restart { ack }` on the control channel. The supervisor is the
sole `Child` owner — the session map holds only a channel sender, never the
`Child` — so it is the only code that can call `child.kill()` or `child.wait()`.
The supervisor receives the Restart command (session.rs:1009), calls
`kill_child()`, then calls `respawn(id, RespawnMode::Seek)` which reads
`start_secs` (now 2700) and spawns a new ffmpeg with `-ss 2700`. The ack fires
with `true` and `seek()` returns `true` to the HTTP handler.

**Q2.** The NAS has 6 CPU threads and runs Plex alongside the transcoder. A
user starts playing two movies simultaneously. Movie A is HEVC in an MKV
container with AAC audio (copy-remux plan — no video re-encode). Movie B is HEVC
with EAC3 5.1 audio (must re-encode audio, and also re-encode video). Will
either session be rejected with 503? Why or why not?

**A2.** Movie A is a copy-remux: `plan.reencodes_video()` returns false, so
`cpu_charge = false`. It acquires only a global slot (of 4). Movie B re-encodes
video. If the VAAPI full-HW pipeline is active and the source codec is HEVC
(decodable), `uses_full_hw_pipeline()` returns true, so `cpu_charge = false`
again — GPU handles everything. Both sessions use global slots only. Neither
hits the CPU cap (which only triggers when `cpu_charge = true`). So both start
fine. If the GPU were absent and the resolved encoder were CPU libx264, Movie B
would set `cpu_charge = true`, hit the `max_cpu = 1` cap, and the second
CPU-encode attempt in a household would return 503.

**Q3.** Explain what happens when the supervisor sees ffmpeg exit with status 0
versus status 1. What is `HEALTHY_RUN_RESET` and why does it matter for a
two-hour movie?

**A3.** Exit 0 (clean EOF): the supervisor moves to `ChildSlot::Completed`
and stops watching for unexpected exits. Segments stay on disk; the idle reaper
will collect the session after 30 seconds of no heartbeats. Exit 1 (error):
the supervisor moves to `ChildSlot::Crashed`, applies exponential backoff
(100ms × 2^(attempt-1), capped at 2s), then calls `respawn()` in
`RespawnMode::Crash`. `HEALTHY_RUN_RESET` (60 seconds) is the threshold for
resetting the restart budget. Without it, three transient driver glitches spread
over a 2-hour movie would permanently terminate the session on the third crash
(each adds to `s.restarts`). With it, any child that ran for ≥60s before dying
resets `s.restarts` to 0, so only consecutive short-lived children (a real crash
loop) accumulate toward the `MAX_RESTARTS = 3` cap.

**Q4.** The VAAPI full-hardware pipeline is gated by four conditions. Name them
and explain why each one is necessary.

**A4.** In `uses_full_hw_pipeline()` (session.rs:542):
(1) `self.vaapi_hw_decode` — set only after `vaapi_full_hw_supported()` passes
at boot. Without this, a GPU-less box or a broken driver would fail every
session mid-encode instead of gracefully falling back at startup.
(2) `matches!(self.encoder, HwEncoder::Vaapi)` — only VAAPI can use VAAPI
hardware decode; NVENC/QSV have different device APIs.
(3) `source_codec.is_some_and(is_vaapi_hw_decodable)` — `-hwaccel_output_format vaapi`
has NO software fallback. If the source codec (e.g. MPEG-4/DivX) can't be
decoded by the iGPU, ffmpeg hard-fails rather than silently switching to CPU
decode.
(4) `VideoOp::EncodeH264 { burn_subtitle_index: None, .. }` — subtitle burn-in
uses libass, which operates on CPU frames. If the plan requires burn-in, the
frames must come back to the CPU, making the full-HW path impossible.

**Q5.** A new engineer accidentally removes the `kill_on_drop(true)` flag when
spawning ffmpeg. What happens to the ffmpeg process if the transcoder service
crashes (e.g., OOM killed by Docker)?

**A5.** Without `kill_on_drop(true)`, the `Child` handle is dropped when the
Rust process exits, but the OS does not send a signal to the child process.
ffmpeg becomes an orphan — its parent PID changes to 1 (init/PID 1 in Docker),
and it keeps running. It continues writing segments to `/scratch`, consuming
CPU/GPU, and holding the `/dev/dri/renderD128` device open. On a subsequent
transcoder restart, the orphaned ffmpeg may conflict with new sessions writing
to the same scratch directory or hold the GPU device. The `boot-sweep` call
(`sweep_scratch_on_boot`) would clean stale directories but cannot kill the
still-running orphan process.

**Q6.** The `force_key_frames` flag is added to every re-encode but NOT to
copy-remuxes. Why does it matter for HLS, and why is it absent from copy-remux?

**A6.** HLS can only split a segment at a video keyframe (an I-frame that
doesn't reference prior frames). The hardware encoder's default GOP (group of
pictures) can be tens of seconds long. Under the real-time `-re` pace, a 10-14
second GOP means the FIRST segment can't close for 10-14 seconds of wall-clock
time, which is longer than the backend's manifest-readiness probe window
(24 × 500ms = 12s). The player gets a 503 "manifest not ready" and shows a grey
rectangle. `force_key_frames expr:gte(t,n_forced*2)` forces a keyframe every 2
seconds (matching `-hls_time 2`), so the first segment always closes in under 2
seconds. Copy-remux uses `-c:v copy` — it passes through the source's compressed
bitstream unchanged, so there is no encoder to instruct about keyframe cadence;
HLS cuts at whatever keyframes the source already has.

---

## 7. CODE-READING EXERCISE

**File: `crates/transcoder/src/session.rs`**
**Focus: the supervisor task (lines 963–1153)**

This exercise walks through the supervisor without running the code. Read the
`spawn_supervisor` function and answer the questions as you go.

**Step 1 — Why is `Child` not in the `Session` struct?**
Look at the `Session` struct (lines 138–165). You will notice there is no
`child: Child` field. The only link to the running process is `ctl:
mpsc::UnboundedSender<SessionCmd>`. Now look at the comment on `SessionCmd`
(lines 167–179). Why is this architecture safer than storing the `Child` in the
map?

*Expected insight:* if the `Child` were in the map, both the HTTP handler (via
`seek()`) and the supervisor could hold a reference to it and attempt to kill it
concurrently. The supervisor could `wait()` the process (consuming the handle)
while the handler holds a stale handle. Single ownership in the supervisor means
every kill goes through one code path.

**Step 2 — Trace a crash recovery.**
Locate `ChildSlot::Crashed` (line 1076). Follow the logic:
- How does `effective_restart_count()` decide whether to reset or increment
  `s.restarts`?
- What is the backoff formula? What is the maximum delay?
- What happens if a seek command arrives DURING the backoff sleep?

*Expected answers:*
- `effective_restart_count`: if the crashed child ran for >= `HEALTHY_RUN_RESET`
  (60s), returns 0 (reset); otherwise returns `prev` unchanged.
- Backoff: `100ms × 2^(attempt-1)`, capped at 2,000ms. So: 100ms, 200ms, 400ms
  (then the cap holds at 2s if `MAX_RESTARTS` is raised).
- During backoff, `tokio::select!` races the sleep against the control channel.
  A `Restart` command during backoff sets `pending_ack` and breaks out of the
  sleep. The subsequent `respawn()` uses `RespawnMode::Seek` (honoring the new
  target) instead of `RespawnMode::Crash`.

**Step 3 — Trace a concurrent stop-during-respawn race.**
In `respawn()` (lines 891–961) there are TWO checks for whether the session
still exists in the map: one before clearing the directory (line 916) and one
after spawning the child (line 949). Why are both needed?

*Expected insight:* The first check prevents work for a session that was removed
while we were reading segment indices. The second check catches a `stop()` that
raced in between `create_dir_all` and the `spawn_child` call — without it, a
freshly spawned ffmpeg process would be left running with no supervisor watching
it and no session map entry to track it (an orphan encoder holding a concurrency
slot and `/scratch` space).

**Step 4 — Find the "monotonic segment numbering" invariant.**
Search for `start_number` in session.rs. How does `respawn()` compute the
next `start_number`? Why does this matter for a player that has the old playlist
cached?

*Expected answer:* `next_number = max_segment_index(&dir).await.map_or(prev_number, |m| m.saturating_add(1).max(prev_number))`.
It finds the highest segment index already on disk and uses the next number.
ffmpeg is launched with `-start_number next_number`. This means a new ffmpeg
after a seek or crash never reuses the name `seg_00000.ts`. A player caching
the old playlist would see `seg_00000.ts` as the same file it already has; with
monotonic numbering it sees a new segment name (`seg_00031.ts`) and knows it is
genuinely new content.

---

