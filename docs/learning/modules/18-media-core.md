
# Teaching Dossier: crates/media-core

---

## 1. WHAT

`media-core` is a self-contained Rust HTTP service that owns the local media library for The Emerald Exchange. It does four things: (1) walks configured filesystem directories to find video files, (2) runs `ffprobe` on each new or changed file to extract codec/audio/subtitle metadata, (3) stores everything in a SQLite database (`media.db`) with tables for movies, TV shows, episodes, and raw file metadata, and (4) serves that catalog to the Node backend over an authenticated internal HTTP boundary, including a "play grant" decision — `direct_play: true` if the browser can handle the file as-is, or `transcoderRequired: true` if the file needs conversion first. When a transcode is needed, media-core forwards the request to the sibling transcoder service and proxies back its HLS stream URL. Think of it as a smart librarian that catalogs your collection and decides whether you can read the book in place or whether it needs to be translated first.

---

## 2. WHY

**Why a separate Rust service at all?**

The Node/TypeScript backend handles auth, recommendations, IPTV, *arr integrations — all I/O-bound work that fits Node's async model perfectly. But the library scanner is different: on a large collection it must walk thousands of directories, `stat()` every file, and fork `ffprobe` once per new or changed file. These are blocking system calls that would starve Node's single-threaded event loop. Rust gives us `tokio::task::spawn_blocking` to push blocking FS work off the async runtime, plus zero-cost concurrency for the probe phase.

**Why fault isolation?**

A scan error on one corrupt file must never bring down the API that serves 800 other movies. Because `media-core` is a separate process, a panic or OOM in the scanner cannot crash the Node backend. The two communicate over HTTP, not shared memory.

**Why SQLite and not the main Postgres/Node DB?**

The Node backend is deployed on Netlify (frontend) and Cloudflare (tunnel); the media library lives physically on the NAS. SQLite lives on the same box as the files — no network round-trip to catalog 800+ movies. The Node backend reads it read-only via the HTTP API, never touching the file directly in production.

**Future native clients:** The internal HTTP API (with stream tokens and the play-grant decision) is already the contract a native iOS/tvOS client would speak. Centralizing `decide()` here means every client — web, mobile, Apple TV — gets the same routing logic.

---

## 3. MAP

### Key files

| File | Lines | Purpose |
|------|-------|---------|
| `crates/media-core/src/lib.rs` | 1-171 | `AppState`, `build_router`, `spawn_scheduler`, `run_guarded_scan` — the process glue |
| `crates/media-core/src/main.rs` | 1-107 | Boot: reads config, opens DB, starts scheduler, binds TCP, handles SIGTERM+SIGINT |
| `crates/media-core/src/scanner.rs` | 1-992 | `scan_once` and all helpers: walk → ffprobe → upsert into DB |
| `crates/media-core/src/probe.rs` | 1-820 | Spawns `ffprobe`, parses its JSON output into a `FileProbe` struct |
| `crates/media-core/src/capability.rs` | 1-557 | `decide(file, caps)` — the direct-play vs transcode gate |
| `crates/media-core/src/routes.rs` | 1-700+ | All HTTP handlers: list/get movies/shows/episodes, `play_grant`, `stream_file` |
| `crates/media-core/src/models.rs` | 1-269 | Shared data types: `MediaFileRow`, `MovieRow`, `AudioTrack`, `FileProbe`, etc. |
| `crates/media-core/src/db.rs` | 1-200+ | SQLite connection pool, WAL mode, embedded migration runner |
| `crates/media-core/src/filename.rs` | — | Parses raw filenames into `ParsedName::Movie { title, year }` or `ParsedName::Episode { show, season, episode }` |
| `crates/media-core/src/tmdb.rs` | — | Best-effort TMDB enrichment (poster, overview, canonical title) — never fails a scan |
| `crates/media-core/src/config.rs` | — | Reads env vars into `Config` (library roots, port, DB path, principal mode) |
| `crates/media-core/src/auth.rs` | — | Axum middleware layer enforcing the internal-principal Bearer token |
| `crates/media-core/src/error.rs` | — | `AppError` enum mapped to HTTP status codes |

### Walkthrough: a file goes from disk to the browser

**Step 1 — Walk (scanner.rs:90-247, `walk_roots`)**

On boot (or at a periodic interval, or on `POST /api/media/scan`), the scanner calls `walk_roots`. This runs in `tokio::task::spawn_blocking` because `WalkDir` issues blocking `stat()` syscalls. It recursively enumerates every configured library root, skipping non-video files (`.mkv`, `.mp4`, `.m4v`, `.mov`, `.avi`, `.ts`, `.webm`), skipping non-UTF-8 paths, and skipping symlinks that resolve outside the configured roots (they would be unservable).

**Step 2 — Change detection (scanner.rs:281-295)**

For each candidate file, the scanner checks the DB: `SELECT size_bytes, mtime FROM media_files WHERE path = ?`. If the stored `(size_bytes, mtime)` matches the current stat, the file is unchanged — only TMDB metadata backfill runs, no `ffprobe` re-probe.

**Step 3 — Probe (probe.rs:50-130, `ffprobe`)**

For new or changed files, `probe::ffprobe` spawns the system `ffprobe` binary as a child process (`tokio::process::Command`) with a 30-second timeout. If the process hangs (corrupt file or stalled NAS mount), `kill_on_drop` reaps it and the scan logs an error and moves on. The stdout JSON is parsed by the pure `parse_ffprobe_json` function into a `FileProbe` struct containing container, codec, height, HDR format, and all audio/subtitle tracks.

**Step 4 — Classify and upsert (scanner.rs:307-627)**

`filename::classify` parses the file's name into `ParsedName::Movie { title, year }` or `ParsedName::Episode { show, season, episode }`. Then `index_file` upserts the `media_files` row using `INSERT ... ON CONFLICT(path) DO UPDATE` (never `INSERT OR REPLACE` — that would delete and re-insert, cascading to movie/episode rows and orphaning watch-state progress). The movie or episode row is then upserted, keyed on TMDB id to collapse multiple rips of the same title onto one row.

**Step 5 — TMDB enrichment (scanner.rs:583-626, tmdb.rs)**

Best-effort only. If `tmdb.match_movie(title, year)` returns a match, the canonical title, poster path, and overview are stored. If TMDB is unreachable or the key is absent, the filename-derived row is kept and the scan succeeds.

**Step 6 — Play grant (routes.rs:394-418, `play_grant`)**

When the SPA wants to play a title, it `POST`s to `/api/media/play/{kind}/{id}/grant` with a JSON body containing the client's `ClientCaps` (what containers, codecs, max height, HDR capability, and audio codecs the browser supports). The handler resolves the `media_files` row via the movie/episode's `file_id`, then calls `capability::decide(file, caps)`.

**Step 7 — decide() (capability.rs:129-229)**

`decide` runs a sequential gate. It checks container support (with family normalization: `mov` ↔ `mp4`), then video codec, then H.264 10-bit profile (hard-deny regardless of caps), then height, then bitrate, then HDR, then audio codec. If any gate fails, it returns `PlayDecision { direct_play: false, reason: "..." }`. If all pass, `direct_play: true`.

Matroska (`.mkv`) always gets `direct_play: false` even when the client advertises `mkv` support — no browser engine can progressive-play matroska in a `<video src>` tag, so the server fails closed and routes to the remux path.

**Step 8 — Serve or hand off**

- `direct_play: true`: the response includes `streamUrl: /api/media/stream/{kind}/{id}`. When the browser GETs that endpoint, `stream_file` acquires a semaphore permit (capped at 16 concurrent streams), verifies the path is inside a library root, and streams the raw file via `tower_http::services::ServeFile` with Range-request support.
- `direct_play: false`: media-core forwards the request to the transcoder's `POST /api/transcode/grant` with the file metadata and client caps, minting a fresh internal-principal Bearer. The transcoder returns an HLS manifest URL that the SPA loads.

---

## 4. PREREQUISITES

Before studying media-core, a learner needs to be comfortable with:

1. **Basic Rust** — ownership, borrowing, `Result`/`Option`, `async`/`await`. The scanner and capability module are excellent Rust for beginners: pure logic, no unsafe, extensive tests.
2. **Tokio async runtime** — why `spawn_blocking` exists (blocking calls block the thread, which starves other async tasks sharing it), and what a `JoinHandle` is.
3. **HTTP fundamentals** — request/response, status codes (200, 404, 503), JSON bodies, Bearer tokens.
4. **SQLite basics** — what a table, row, and primary key are. Understanding `ON CONFLICT DO UPDATE` (upsert) vs `INSERT OR REPLACE` (delete-then-insert) is essential for Section 3's walkthrough.
5. **Axum** — Rust's most common async web framework. Specifically: `State` extractor for shared app state, `Path`/`Query` extractors for URL params, and middleware layers. The `router()` function in `routes.rs` is a good first Axum program to read.
6. **Docker networking** — why media-core runs as a separate container and how the Node backend reaches it at an internal hostname.
7. **ffprobe** — what it is (a command-line tool that reports metadata about media files), what its JSON output looks like. The test fixtures in `probe.rs` are the fastest orientation.

---

## 5. GOTCHAS AND WAR STORIES

**The silent-audio bug: 204/1130 files direct-playing with no sound**

The original `decide()` checked container, codec, height, and HDR — but completely ignored the audio track. A `.mp4` file with H.264 video would get `direct_play: true` even if its audio track was EAC-3 (Dolby Digital Plus) or AC-3. Browsers can only decode AAC natively in a `<video>` element, so those files played with a black audio bar — no error, no warning, just silence. 204 out of 1130 files in the library were affected. The fix added the audio gate to `decide()` (capability.rs:218-224): check `file.audio_tracks().first()`, and if the codec is non-empty and not in `caps.audio_codecs` (which defaults to `["aac"]`), deny and route to the transcoder which re-encodes to AAC. The lesson: a direct-play grant hands the raw file to `<video>` — every track must be browser-decodable, not just the video.

**The Movies directory was `0700` — nobody could read it**

The `/media/Movies` directory on the NAS had permissions `0700` (owner-only read/execute). The `media-core` container runs as a different UID than the NAS user that owns the directory, so the scanner's `WalkDir` calls returned permission denied for every file under it. The library appeared empty. Fix: `chmod a+rX /media/Movies` (755). The symptom was `files_seen: 0` in the scan report combined with an I/O error count matching the expected file count. Always check directory permissions when a library root enumerates zero files but the directory exists.

**Grant and inspect must be one atomic call — the 30-second reap**

The transcoder reaps a granted session after 30 seconds of idle (no segments fetched). If you grant a session and then wait more than 30 seconds before fetching the first HLS segment, the session is gone and you get a 404. This matters when debugging: you cannot call `POST /grant` in a terminal, pause to look at the response, and then try to play the returned URL in a browser — the session will have been reaped. In tests, the grant POST and the first segment GET must happen in the same script without a human pause.

**`INSERT OR REPLACE` vs `ON CONFLICT DO UPDATE` — watch-state orphan catastrophe**

An early version of `index_file` used `INSERT OR REPLACE` to upsert a media file. SQLite's `REPLACE` is syntactic sugar for DELETE-then-INSERT: it deletes the conflicting row, which cascades through `movies.file_id ON DELETE CASCADE`, deleting the movie row and reissuing a new autoincrement id. Any `media_watch_state` row keyed on the old movie id is now orphaned — the user's watch progress is silently lost on every rescan of a changed file. The fix (scanner.rs:546-574) uses `INSERT INTO ... ON CONFLICT(path) DO UPDATE SET ...` which updates in place, preserving the row id and all downstream foreign keys.

**Scheduled scans vs manual `POST /scan` — the `AtomicBool` guard**

If a large library scan takes 5 minutes and the periodic scheduler fires at the 4-minute mark, you'd have two concurrent scans both writing to the DB. The `scanning` `AtomicBool` in `AppState` prevents this: `compare_exchange(false, true)` atomically claims the slot; a second caller finds it already `true` and returns `false` without starting a scan. The guard is always released in `run_guarded_scan`, even if the scan panics (the scan runs on its own spawned task so a panic surfaces as `Err` rather than unwinding past the guard release).

**Container family mismatch — why no mp4 ever direct-played**

Every real `.mp4` file reports `format_name = "mov,mp4,m4a,3gp,3g2,mj2"` from ffprobe. The probe stores only the first token: `"mov"`. But the SPA's `browserCaps` advertises `containers: ["mp4"]`. Without the `container_family()` normalization in `capability.rs`, every mp4 in the library got `direct_play: false` because `"mov" != "mp4"`. The fix: both `"mov"` and `"mp4"` normalize to the same family token before comparison (capability.rs:102-111).

---

## 6. QUIZ BANK

**Q1.** You add a new 4K HDR HEVC film to the NAS library. An hour later it still doesn't appear in the SPA. List three distinct causes that could each independently explain the absence.

**A1.** (Any three of:) (a) The periodic scan interval hasn't fired yet and no `POST /scan` was issued — trigger a manual scan. (b) The directory permissions are wrong (`0700` or similar) — the scanner gets permission-denied on walk and logs I/O errors but doesn't fail fatally. (c) The file has a non-UTF-8 character in its name or path — it lands in `files_skipped_non_utf8` with no error, just a count. (d) The file is in a directory that is a symlink resolving outside the configured `MEDIA_LIBRARY_PATHS` — it lands in `files_skipped_outside_roots`. (e) `ffprobe` timed out on the file (corrupt, or the NAS was under load) — logged as a scan error, file skipped. Check `POST /api/media/scan/status` or the scan log output for counts.

---

**Q2.** A user reports that a movie plays with no sound. You check the `play_grant` response and see `directPlay: true`. What's the most likely cause, and what field in the grant response would you inspect to confirm?

**A2.** The most likely cause is that `decide()` approved direct-play but the audio codec is something the browser can't decode (EAC-3, AC-3, DTS, TrueHD). The grant response includes `file.audio_tracks` — check the `codec` field of the first track. If it's `eac3`, `ac3`, `dts`, or `truehd` and the client's `audio_codecs` cap didn't include that codec, `decide()` should have denied. If it returned `direct_play: true` anyway, look for a regression in the audio gate in `capability.rs:218-224`.

---

**Q3.** A `.mkv` file contains 1080p H.264 video and stereo AAC audio — exactly what the client advertises in its caps. `decide()` returns `direct_play: false` with reason "matroska cannot progressive-play in browsers; remux required". Is this correct behavior? Why or why not?

**A3.** Correct. No browser engine demuxes Matroska in a `<video src>` progressive stream. WebM is a constrained sibling format, not an alias — Chrome can play WebM but cannot play arbitrary `.mkv` files. A `direct_play: true` grant would silently fail with `MEDIA_ERR_SRC_NOT_SUPPORTED` (no error UI, just a broken player). The server fails closed: `.mkv` always routes to the transcoder's remux path, which repackages the streams into fMP4 or MPEG-TS HLS segments the browser CAN append via MSE. The client listing `"mkv"` in its caps describes what the transcode path can target, not what `<video>` can progressive-play.

---

**Q4.** You want to add a `max_concurrent_hdr_transcodes` limit to the system — HDR tonemapping is GPU-intensive. Where in the codebase would you add this cap, and what pattern already exists that you should follow?

**A4.** The transcoder already has `MAX_CONCURRENT_CPU_TRANSCODES` and similar caps (in `crates/transcoder/src/`). On the media-core side, the `stream_semaphore` (`AppState`, lib.rs:64) is the existing pattern: an `Arc<Semaphore>` added to `AppState`, a permit acquired at the start of the relevant handler, released on drop. For an HDR-specific limit, you'd add an `hdr_transcode_semaphore: Arc<Semaphore>` to `AppState`, acquire it in the transcoder handoff path in `routes.rs` when `file.hdr_format.is_some()`, and read the cap from a new env var via `config.rs`. Do NOT add a hard-coded constant — the NAS's GPU capabilities change with driver updates.

---

**Q5.** After a scan, `ScanReport` shows `files_seen: 0, errors: 1` for a root that definitely has files. What two specific conditions in the scanner would each produce this exact output independently?

**A5.** (a) The library root directory does not exist or is not a directory — `walk_roots` logs an error, increments `out.errors`, and `continue`s to the next root without walking it (scanner.rs:118-127). (b) The root directory exists but the first `WalkDir` entry immediately returns an I/O error (e.g. permission denied on the directory itself) — `root_errors` is incremented, which feeds `out.errors`, and the walk continues but finds nothing readable. In both cases `files_seen` stays 0. Distinguishing them: case (a) logs `"library root missing or not a directory"`, case (b) logs `"walk error under ..."`.

---

**Q6.** The `upsert_episode` function at scanner.rs:915 has logic to pick between two files for the same `(show, season, episode)` — a 1080p and a 4K rip both pointing at S01E03. Walk through what the code does when the 4K rip is scanned AFTER the 1080p rip is already in the DB.

**A6.** The function queries `SELECT id, file_id FROM episodes WHERE show_id = ? AND season = ? AND episode = ?` and finds the existing row with the 1080p file's id. Since `file_id != existing_file_id`, it fetches `video_height` for both files: `incoming_h = 2160` (the new 4K rip), `existing_h = 1080` (the stored 1080p). `incoming_h.unwrap_or(0) > existing_h.unwrap_or(0)` → `2160 > 1080` → `keep_incoming = true` → `new_file_id = file_id` (the 4K rip). The `UPDATE episodes SET file_id = ?...` replaces the pointer. The 1080p file row in `media_files` remains (nothing deletes it), but the episode now streams from the 4K file. If the 4K rip is scanned first and the 1080p arrives second, `1080 > 2160` is false, `keep_incoming = false`, and the incumbent 4K file is preserved.

---

## 7. CODE-READING EXERCISE

### Guided walk: `capability.rs`

**Goal:** Understand exactly how media-core decides whether a file can play directly or needs transcoding.

**Setup:** Open `/Users/cujo253/Documents/theemeraldexchange/crates/media-core/src/capability.rs`.

**Step 1 (lines 15-75): Read `ClientCaps`**

This struct is what the SPA sends. Notice two fields with non-obvious defaults:

- `audio_codecs`: defaults to `["aac"]` via `default_audio_codecs()` (line 52-54). If a client sends a JSON body with no `audio_codecs` field, serde calls this function and the client is treated as AAC-only. This is the browser-safe baseline.
- `hls_fmp4_hevc`: defaults to `false`. This tells the transcoder whether it can copy-remux HEVC into fMP4 segments (safe for hls.js with hardware decode) vs forcing a full H.264 re-encode. `decide()` does not use this field — it's purely for the transcoder path.

**Question for the learner:** What happens if a client sends `{}` (empty JSON body) to `play_grant`? What are the effective caps?

*(Answer: `ClientCaps::default()` is used, which gives an empty `containers` and `video_codecs` list. An empty `containers` list means `container_supported()` returns false for every file — `decide()` returns `direct_play: false` for everything. This is intentional: a client that doesn't declare its capabilities gets routed to the transcoder, which normalizes to a known-safe output format.)*

**Step 2 (lines 102-119): `container_family` and `container_supported`**

Read `container_family`. It maps `mov`, `mp4`, `m4a`, `m4v`, `3gp`, etc. all to `"mp4"`, and `matroska`/`mkv` both to `"mkv"`. This is the fix for the "no mp4 ever direct-played" bug described in Section 5.

Notice the comment about `webm`: it is deliberately NOT folded into the `mkv` family. Why? Because ffprobe uses the same demuxer for both matroska and webm — it cannot tell them apart — so the stored `container` value is always `"matroska"`, never `"webm"`. A `webm`-only client must not receive matroska files.

**Question:** `container_supported` takes `caps: &[String]` and `stored: &str`. Trace what happens when `stored = "mov"` and `caps = ["mp4"]`.

*(Answer: `container_family("mov") = "mp4"`. For `"mp4"` in caps: `container_family("mp4") = "mp4"`. `"mp4".eq_ignore_ascii_case("mp4")` → `true`. Returns `true`.)*

**Step 3 (lines 129-229): `decide`**

Read the function from top to bottom. Notice the ordering: container → codec → H.264 10-bit profile → height → bitrate → HDR → audio. Each gate calls `return deny(...)` on failure — there is no early-success path until all checks pass.

Find the audio gate (line 218). Note that it gates on the *first* audio track only (`file.audio_tracks().first()`). Why first? Because the transcoder remuxes/re-encodes the primary track — a file with a TrueHD primary and an AC-3 compatibility track is still denied, because the player will pick the primary track.

**Hands-on:** Look at the test `eac3_audio_denies_direct_play` (line 436). Run just this test:

```
cd /Users/cujo253/Documents/theemeraldexchange
cargo test -p media-core eac3_audio_denies_direct_play
```

Then look at `advertised_eac3_direct_plays_but_dts_still_denies` (line 473). This tests a Safari/Edge client that proved it has system E-AC-3 decode and sent `audio_codecs: ["aac", "eac3"]` in its caps. EAC-3 tracks direct-play; DTS tracks still deny. Run that test too.

**Step 4: Synthesize**

Write, from memory, the answer to: "A file is an `.mkv` with HEVC video, EAC-3 5.1 audio, and HDR10. A Chrome browser sends caps `{containers: ["mp4"], video_codecs: ["h264"], max_height: 1080, hdr: false, audio_codecs: ["aac"]}`. Walk through every gate in `decide()` and identify which gate(s) fire and in what order."

*(Answer: Gate 1 — container: stored `"matroska"`, client has `["mp4"]`. `container_family("matroska") = "mkv"`, `container_family("mp4") = "mp4"`, `"mkv" != "mp4"` → `deny("container matroska not supported by client")`. The function returns here. Gates 2–7 are never evaluated. BUT — wait — there's a second container check at line 146: even if the client had listed `"mkv"` in containers, the `container_family(container) == "mkv"` hard-deny fires next with reason "matroska cannot progressive-play in browsers; remux required". So `.mkv` always denies on the matroska gate regardless of client caps.)*

---

