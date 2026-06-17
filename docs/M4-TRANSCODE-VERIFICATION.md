# M4 Transcoder — Verification Status & Real-ffmpeg Gate

**Status label (authoritative): the deployed transcoder is now PROVEN (2026-06-07) to transcode a real non-direct-play library file and serve `ffprobe`-validated, decodable H.264/AAC HLS end-to-end over its authenticated surface — see the proof section below. SUPERSEDED 2026-06-08: the "real client" step has since shipped and been proven — the web SPA consumes this path via `src/lib/api/media.ts` + `MediaPlayer`, verified in real Chrome over the public Cloudflare path (see ROADMAP-STATUS.md). The host share-permission issue (`/media/Movies` 0700) is also fixed (0755). This document remains as the M4 server-side proof record.**

Do not read the green default `cargo test -p transcoder` run as "deployed playback works."

## Deployed real-library proof (2026-06-07)

The deployed transcoder was driven against a **real library file** through its
**authenticated (enforce-mode) HTTP surface** — not a fixture, not a stub. A
minted internal-principal token (`hkdf_internal_principal` + `internal_principal_encrypt`,
kid `internal-v1`) was POSTed to `POST /api/transcode/grant` with the real probe
row media-core stores; the resulting HLS session was served and `ffprobe`-validated
(manifest + segment serving + output-codec validation — not a real client playing it).

File: `/media/tv_shows/3 Body Problem/Season 1/…S01E01…x265…mp4` — **HEVC 1080p, mov/mp4 container**.

| Measurement | Result |
|---|---|
| Plan | `EncodeH264` (HEVC→H.264) + audio `Copy`, reason "container mov not supported by client" |
| Time to first segment | **2.6 s** |
| Resource cost (mid-transcode) | **CPU ~300–330%** (libx264, ~3 cores of the 3.0 cap), **mem ~520 MiB / 3 GiB** |
| Served segment | real **4.3 MB** `.ts` over the authed path |
| Seek (`?to=1800`) | first post-seek segment in **~23–27 s** (kill+respawn+re-encode) |
| Output validation (`ffprobe`) | **video h264 High, 1920×1080, yuv420p (8-bit SDR), bt709**; **audio aac copy, 48 kHz 6ch** |

This proves the full deployed path: auth → plan → real ffmpeg session → HLS
manifest + segment serving → seek lifecycle → valid playable H.264/AAC output.

### Two deployment bugs found (the reason "unverified" mattered)

1. **`/scratch` tmpfs was not writable by the container uid → every real
   transcode died with `failed to prepare session: Permission denied`.** Health
   checks and unit tests never write `/scratch`, so this was invisible. Root
   cause: the compose `tmpfs: /scratch:size=2g` mount masks the image's `chown`,
   and a tmpfs mount *with options* defaults to `root:root 0755` (not the
   container user — the transcoder Dockerfile comment asserting otherwise was
   wrong). **FIXED:** compose now mounts `/scratch:size=2g,mode=1777` (matches
   `/tmp`); applied on the NAS and re-verified on a fresh container with no
   manual intervention. Dockerfile comment corrected.

2. **The hardened service uids cannot read `/media/Movies`.** That host dir is
   `drwx------ uid 99` (0700, owner-only), so neither media-core (uid 10002) nor
   transcoder (uid 10003) can read anything under Movies — only `tv_shows`
   (0755) is reachable. This is a **host share-permission issue, not a
   transcoder bug** (it reproduces identically for media-core). It needs an ops
   decision — loosen the Movies share to be group/world-traversable, or run the
   media services as the media-owning uid — and is flagged separately, not
   silently changed.

## What the default test suite actually proves

`cargo test -p transcoder` is **hermetic by design**. Every session/route test
injects a shell stub via `TRANSCODER_FFMPEG_BIN` (`session.rs::write_stub`,
`routes.rs::write_stub`) that writes a fake `index.m3u8`, a 3-byte `seg_00000.ts`
(`printf 'seg'`), and sleeps. The HLS surface tests assert the literal stub
output — e.g. `routes.rs` `assert_eq!(&body[..], b"seg")`. The module doc in
`session.rs` states this openly:

> tests point at a shell stub that writes a fake playlist and sleeps —
> exercising the full start -> heartbeat -> seek (kill+respawn) -> stop lifecycle
> and orphan cleanup WITHOUT a real transcode.

So the green default suite certifies the **session state machine + ffmpeg argv strings**.
It does **not** certify:

- hardware-encoder selection against a real binary,
- tonemap / scale / subtitle burn-in correctness,
- ffmpeg failure modes (OOM/segfault) under load,
- playback in a real player.

## What closes the gap (added in this change)

1. **Feature-gated integration test** — `crates/transcoder/tests/real_ffmpeg.rs`,
   behind the new `requires-ffmpeg` cargo feature (OFF by default so normal
   `cargo test` stays hermetic). It:
   - generates a ~1s fixture with `ffmpeg -f lavfi -i testsrc`,
   - assembles the **production** argv via the crate's real
     `transcoder::args::ffmpeg_args(...)`,
   - runs REAL ffmpeg with it,
   - asserts `index.m3u8` is valid HLS **and** a `seg_*.ts` segment is
     ffprobe-demuxable as a real video stream (decoded media, not the 3 stub
     bytes).
   - SKIPs cleanly (does not fail) if ffmpeg/ffprobe are absent, so enabling the
     feature on a bare host is not a false failure.

   Run it locally with a real ffmpeg on PATH:

   ```sh
   cargo test -p transcoder --features requires-ffmpeg -- --nocapture
   ```

2. **CI job** — `.github/workflows/transcoder-ffmpeg.yml` runs the gated test
   against the same statically-linked ffmpeg 7.1 build pinned in
   `crates/transcoder/Dockerfile`.

## Human decision required (do not silently adopt)

- **CI budget / runner image.** The gate is committed but inert until GitHub
  Actions is enabled for this repo. Adopting it costs runner minutes + an image
  pull on every transcoder change. That is a product/infra call. Until the gate
  is green in CI, CI does not independently prove the real-ffmpeg path.
- **Fixture fidelity.** The committed test uses a synthetic `testsrc` fixture
  (no binary media in-repo). A higher-fidelity matrix (HDR tonemap, PGS burn-in,
  HEVC->H.264, DTS->AAC) needs real sample files and is the multi-month long
  pole the `session.rs` module doc already names. The synthetic gate is the
  smallest honest proof that the production argv yields playable HLS; it is not
  full codec-matrix coverage.

## Related fix in the same change

`crates/transcoder/src/main.rs` now traps **SIGTERM** in addition to SIGINT in
`shutdown_signal()`. Docker `stop`/compose `down` deliver SIGTERM, which the old
`ctrl_c()`-only handler never awaited — so the graceful path never fired in prod
and in-flight ffmpeg children were hard-aborted by SIGKILL after the stop grace.
`docker-compose.yml` sets `stop_grace_period: 20s` on the transcoder service so
the SIGTERM -> grace -> SIGKILL child escalation (KILL_GRACE = 5s in
`session.rs`) has time to flush before Docker hard-kills the container.

> NOTE: `crates/media-core/src/main.rs` has the identical SIGINT-only
> `shutdown_signal()` defect. It is a separate subsystem and is intentionally
> **not** touched here; flag it to the media-core owner.

## Stress / bench on NAS hardware (2026-06-14)

The "non-optional per spec" stress/bench evidence now exists. Harness:
`scripts/m4-stress-bench.sh [concurrency] [duration_secs]` — runs ON the NAS,
auto-selects N real HEVC files from `media.db`, grants N **concurrent
HEVC→H.264 re-encode** sessions through the authenticated transcoder surface
(forced `h264/mp4/SDR` caps so none degrade to a copy-remux), heartbeats each
session like a real player, samples box CPU (`/proc/stat` deltas) + load + Plex
health every few seconds under a watchdog that stops every session the instant
the box or Plex degrades, and reports per-session real-time sustain + post-seek
TTFS. An EXIT trap stops all sessions on any exit so a `-re` session can't leak.

**Run: `N=4`, 60 s sustained window, NAS = 6-thread x86 + Intel VAAPI iGPU, 2 s
segments. Plex stayed `healthy` the entire run; box load peaked 0.56 (0.09/core).**

| Criterion | Target | Measured | Verdict |
|---|---|---|---|
| crit-3 concurrency cost | 4 concurrent under 80% box CPU | **peak 48% / avg 18%** box CPU; transcoder container 92.6% (≈<1 core — VAAPI offloads encode to the iGPU) | **PASS** |
| crit-2 real-time sustain (NAS-side) | ≥ 1.0× playback | **3.17×–4.00×** per session across all 4 | **PASS** |
| crit-6 seek latency | < 2 s | **0.54 s** post-seek time-to-first-segment | **PASS** |
| cold concurrent startup | — | **1.72–1.74 s** TTFS, 4 concurrent cold starts | — |

This supersedes the stale single-session `~23–27 s` seek figure above (CPU
libx264 pipeline, pre-VAAPI, pre-2 s-segments): on the VAAPI pipeline a seek
reaches first segment in **~0.5 s**. A 2-concurrent smoke run measured 7.4×
sustain; per-session throughput settles toward 3–4× at 4 concurrent as the
sessions share the iGPU, still comfortably above real-time.

**Still open (not closed by this run):** the *Apple-Silicon* variant of crit-2
(VideoToolbox) is untestable — the deployed target is x86 VAAPI with no AS
transcode host. ~~a formal long-running soak (crit-4) is not yet recorded.~~
**CLOSED 2026-06-16 — see §Long-running soak below.**

Reproduce: `scp scripts/m4-stress-bench.sh root@<nas>:/tmp/ && ssh root@<nas>
'bash /tmp/m4-stress-bench.sh 4 60'`.

## Long-running soak (crit-4) — 2026-06-16

The last open M4 functional bar — a **formal long-running soak** proving
*sustained reap/cleanup under load over time, with no leak* — is now recorded.
The 60 s stress/bench above does **not** prove crit-4: it heartbeats every
session for its whole window, so nothing is ever idle-reaped mid-run and no
slow leak has time to surface. A dedicated harness was built for this:
`scripts/m4-soak.sh`. Full run log: [`docs/m4-soak-2026-06-16.log`](./m4-soak-2026-06-16.log).

What the soak does over a **30-minute** window on the NAS (3 concurrent forced
HEVC→H.264 VAAPI re-encodes):

- **Sustains load continuously.** VAAPI runs ~3–4× realtime with no `-re` cap,
  so a session's ffmpeg *exits* when it finishes the whole file (~8 min for a
  30-min movie). The harness **refreshes the pool every 240 s** so N encoders
  are always running — and that recycling is itself repeated grant→stop
  lifecycle churn under load.
- **Forces the idle reaper to fire repeatedly under load.** Every 300 s it
  grants one extra session under a *distinct* `sub` (`local:m4soak-ephem`, so
  the transcoder's `coalesce_key = owner∥kind∥id∥sub∥path` can't fold it onto a
  heartbeated steady session) and then **never heartbeats it** — the 30 s idle
  reaper must kill it. ~45 s later it confirms the session 404s.
- **Watches for leaks.** Samples box CPU/load, Plex health, transcoder RSS and
  the host-side ffmpeg process count every 5 s under a watchdog that stops
  everything the instant Plex or load/core degrades.

**Result — all PASS** (`scripts/m4-soak.sh 3 1800`, NAS = 6-thread x86 + Intel
VAAPI iGPU, 2 s segments):

| Criterion | Target | Measured | Verdict |
|---|---|---|---|
| crit-4 duration held | full window, no abort | **1802 s of 1800 s** sustained, watchdog never fired | **PASS** |
| crit-4 reap under load | idle reaper cleans up every time | **5 / 5 idle-reap cycles** dropped their session (index 404), **0 failed** | **PASS** |
| crit-4 zero leak (procs) | no accumulation; clean teardown | steady baseline 3 ffmpeg, peak 5 w/ ephemeral, **post-stop 0** | **PASS** |
| crit-4 zero leak (memory) | steady-mem floor does not climb | floor **776 MiB → 809 MiB (+4%)** across the two halves (ceiling 25%); peak 1497 MiB | **PASS** |
| lifecycle churn | sustained throughput | **24 sessions** granted+stopped under load over **7 pool refreshes** | — |
| box headroom | Plex stays healthy | box CPU **peak 57% / avg 15%**, load ≤0.69/core, **Plex `healthy` throughout** | **PASS** |

The memory "floor" metric is the leak signal: the *minimum* steady RSS
(warmup-ramp and any ephemeral-in-flight sample excluded) in the first half vs
the second half. A real leak raises the floor; here it moved +4 %, i.e. flat —
no creep over 30 minutes of continuous transcode + 24 session lifecycles + 5
idle-reap cycles, and every ffmpeg child was gone after teardown.

Reproduce: `scp scripts/m4-soak.sh root@<nas>:/tmp/ && ssh root@<nas> 'setsid
bash /tmp/m4-soak.sh 3 1800 > /tmp/soak.log 2>&1 < /dev/null &'` (detached; it
ignores SIGHUP so a dropped monitoring SSH can't kill it).
