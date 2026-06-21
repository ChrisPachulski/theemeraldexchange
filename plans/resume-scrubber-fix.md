# Resume scrubber fix — full-timeline VOD + on-demand back-seek (Option B)

## Problem
Resuming a movie/episode on iPhone/Apple TV: the native AVPlayerViewController
scrubber shows the resume point as **0:00** and total length as **remaining**,
not the absolute position / full duration.

## Root cause (confirmed, cross-repo)
- Apple client uses `AVPlayerViewController` (native scrubber). For HLS VOD,
  AVPlayer derives the timeline from the **media playlist** (cumulative
  `#EXTINF`), not segment PTS.
- Transcoder seeks server-side with `-ss start_secs` (before `-i`, re-bases
  output time to 0) and the synthesized VOD manifest
  (`crates/transcoder/src/vod_manifest.rs`) lists **only** `[start_secs, end]`,
  `MEDIA-SEQUENCE:0`, segments numbered from 0 → scrubber reads 0:00 / remaining.
- Companion latent bug: client `currentSeconds` is 0-based on HLS, so
  watch-progress persists relative positions and drifts. The full-timeline fix
  makes `currentSeconds` absolute → auto-fixes drift, **no client change**.

## Design
Serve a **full `[0, total]` timeline** manifest (native clients only — the
`is_native_hls_client` gate already exists in `routes.rs:544`), segments numbered
by **absolute index**, plus `#EXT-X-START:TIME-OFFSET=start_secs` to position
playback at the resume point. Transcode still `-ss`-seeks for instant resume, but
writes segments at their absolute index.

**Re-encode path (forced keyframes on a clean grid):**
- Quantize the seek to the segment grid: `seek = ⌊start_secs/seg⌋·seg`.
- `-start_number = ⌊start_secs/seg⌋` so the first on-disk segment lands at its
  absolute slot.
- `EXT-X-START:TIME-OFFSET = start_secs` (true resume point, inside that segment).

**Copy-remux path (ragged source keyframes):**
- Aligns naturally — segments cut at real keyframes. `base` = keyframe ≤ start.
- `-start_number = ordinal(base)` in the FULL cut-point list (from base 0).
- Manifest = full cut-point list `[0, total]`, EXT-X-START = start_secs.
- TARGETDURATION over ALL segments (copy segments can be ~5× seg).

**Back-seek before the resume point (on-demand):**
- Segments `[0, start_number)` were never produced. When `session_segment`
  (`routes.rs:606`) is asked for an absent index `< session.start_number`,
  spawn a transient one-shot ffmpeg (precedent: `spawn_sidecar_subtitle`
  `session.rs:745`) seeked to that index's grid time, `-start_number index`,
  writing **segments only** into the session dir (NOT a competing `index.m3u8`),
  bounded count, charged against the concurrency `Limiter`. Existing native
  wait-loop (`routes.rs:634-650`) then serves the file once written.

## Phases (verify each before next)
1. **Re-encode manifest + seek quantize + start_number.** Pure logic.
   - `vod_manifest::synthesize` → full timeline + absolute index + EXT-X-START.
   - `session.rs` start: quantized `-ss` + `start_number = ⌊start/seg⌋` for native
     re-encode VOD.
   - Rewrite unit tests. Gate: `cargo test -p transcoder` (local, no NAS).
2. **Copy-remux** `synthesize_copy` → full timeline + absolute ordinal index +
   start_number = ordinal(base). Rewrite golden-keyframe tests. Local cargo test.
3. **On-demand back-seek** serving (transient ffmpeg child + concurrency + scratch
   collision avoidance). Local tests for index math; real behavior on NAS.
4. **NAS validation + deploy.** `cargo test --features requires-ffmpeg` (real
   ffmpeg, in CI container / NAS), ffprobe first-segment PTS + manifest sanity,
   then `nas-safe-build` discipline for the deploy. Device verification (user):
   resume a movie + episode, confirm scrubber shows absolute position + full
   length, and back-seek works.

## Guardrails
- Full-timeline manifests stay **native-only**; web/hls.js keeps its existing
  client-side offset compensation (`src/components/media/playbackSession.ts`)
  which would double-count otherwise.
- No new SPM/cargo deps. No signing/CI/secret changes.
- Each NAS deploy via `nas-safe-build` (Plex co-resident, weak CPU).
- Copy-remux changes validated against real ffmpeg before trusting (CoreMediaError
  -4 risk if synthesized boundaries drift from on-disk).

## Status
- [ ] Phase 1 (re-encode)  ← in progress
- [ ] Phase 2 (copy-remux)
- [ ] Phase 3 (on-demand back-seek)
- [ ] Phase 4 (NAS validate + deploy + device verify)
