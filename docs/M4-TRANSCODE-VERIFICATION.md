# M4 Transcoder — Verification Status & Real-ffmpeg Gate

**Status label (authoritative): deployed real-library transcode+play is now PROVEN end-to-end on the NAS (2026-06-07) — see the proof section below. Two real deployment bugs were found and one is fixed; the other is a host share-permission issue outside the transcoder.**

Do not read the green default `cargo test -p transcoder` run as "deployed playback works."

## Deployed real-library proof (2026-06-07)

The deployed transcoder was driven against a **real library file** through its
**authenticated (enforce-mode) HTTP surface** — not a fixture, not a stub. A
minted internal-principal token (`hkdf_internal_principal` + `internal_principal_encrypt`,
kid `internal-v1`) was POSTed to `POST /api/transcode/grant` with the real probe
row media-core stores; the resulting HLS session was played and validated.

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
  is green in CI, the deployed playback gap above stands.
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
