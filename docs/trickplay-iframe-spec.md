# HLS Trick-Play (I-frame scrubbing thumbnails) for the transcoder

Status: **IMPLEMENTED behind `TRANSCODER_TRICKPLAY` (default OFF)**, re-encode VOD
path + native (AVPlayer) clients only. This document is both the design record
and the on-device verification guide.

## What "trick-play" means here

`AVPlayerViewController` on tvOS/iOS renders scrubbing-preview thumbnails (the
little frames that ride the scrubber as you scan) **only** when the HLS asset it
loads is a MASTER (multivariant) playlist that advertises an I-frame-only
rendition:

```
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=...,URI="iframe.m3u8"
```

…whose target (`iframe.m3u8`) is a media playlist tagged `#EXT-X-I-FRAMES-ONLY`,
each entry describing a single decodable I-frame. Without this, the scrubber has
no images and the timeline shows none. hls.js in the browser does not render
native scrubbing thumbnails from an I-frame rendition at all, so this feature is
**native-only** by nature.

## The VOD HLS flow as it exists (map)

Grant → session → manifest → segments, all in `crates/transcoder`:

1. **Grant.** `POST /api/transcode/grant` (`routes.rs::grant`, registered at
   `routes.rs:92`). Plans copy-vs-re-encode (`plan.rs`), starts a session, and
   returns JSON with `manifestUrl: "/api/transcode/session/{id}/index.m3u8"`
   (`routes.rs:494`). The backend proxy forwards the client `User-Agent` to the
   transcoder.
2. **Session + ffmpeg.** `session.rs::SessionManager::start` (`session.rs:867`)
   creates a per-session scratch dir and spawns ONE supervised ffmpeg child that
   writes `index.m3u8` (an `EVENT` playlist) + `seg_%05d.ts` (or `.m4s` +
   `init.mp4` for HEVC-copy fMP4). The full ffmpeg argv is built in
   `args.rs::ffmpeg_args_for` (`args.rs:248`); the HLS muxer block is
   `args.rs:654-708`. A re-encode forces a keyframe every `HLS_SEGMENT_SECS` (=2s,
   `args.rs:494`), so re-encode segments are uniform 2s. A precedent for a second,
   detached one-shot ffmpeg pass already exists:
   `session.rs::spawn_sidecar_subtitle` (`session.rs:745`).
3. **Manifest.** `GET …/index.m3u8` → `routes.rs::session_manifest`
   (`routes.rs:552`). It branches on the client:
   - **Native** (User-Agent contains `AppleCoreMedia`/`CoreMedia`,
     `routes.rs::is_native_hls_client` `routes.rs:544`) + **re-encode** → a
     complete finite VOD playlist synthesized in memory by
     `vod_manifest::synthesize` (`vod_manifest.rs:40`), served in place of the
     `EVENT` playlist so AVKit shows a real scrubber instead of a LIVE badge.
   - **Native + copy-remux** → `synthesize_copy` from the source keyframe list
     when the per-file keyframe cache is warm (`vod_manifest.rs:204`,
     `keyframes.rs`), else the on-disk `EVENT` playlist.
   - **Web (hls.js)** → the on-disk `EVENT` playlist, always.
4. **Segments.** `GET …/session/{id}/{segment}` → `routes.rs::session_segment`
   (`routes.rs:637`). Bare filenames resolve to files in the session dir
   (`asset_path`, `session.rs:1373`). Native clients get a short frontier wait
   for a not-yet-written segment (`routes.rs:665`).

There is **no** master playlist and **no** I-frame playlist anywhere in the repo
today — confirmed by grep. The client always receives a single MEDIA playlist URL.

### Does introducing a master break existing clients?

No, because the master is gated **strictly** behind `is_native_hls_client`
(AppleCoreMedia UA) **and** the `TRANSCODER_TRICKPLAY` flag. The web SPA never
sends an AppleCoreMedia UA, so it never receives a master — its `index.m3u8`
stays the on-disk `EVENT` media playlist byte-for-byte. (Even if it did receive
one, hls.js parses multivariant playlists fine and would just pick the single
video variant; the change is safe by construction regardless of the SPA's
player.) With the flag OFF, nothing changes for anyone.

## The two implementation options, evaluated

### (a) Re-encode path — CHOSEN (dedicated thumbnail rendition)

ffmpeg's `hls` muxer **cannot** itself emit `EXT-X-I-FRAME-STREAM-INF` /
`EXT-X-I-FRAMES-ONLY` playlists. Two ways to produce one:

- **Byte-range I-frame playlist over the existing segments.** Needs per-segment
  keyframe **byte-offset** analysis of every `.ts`/`.m4s` to emit
  `#EXT-X-BYTERANGE` entries. Heavy (parse every segment), and the offsets only
  exist after each segment is written — rejected.
- **Dedicated low-fps, all-keyframe thumbnail rendition.** A second cheap ffmpeg
  pass samples the source at a fixed cadence (`fps=1/N`, `scale=320:-2`, `-g 1`)
  and HLS-segments it so **each segment holds exactly one frame** (`-hls_time N`
  == the sample interval ⇒ one frame per segment). Every such segment is a single
  clean I-frame, so the hand-built `#EXT-X-I-FRAMES-ONLY` playlist references each
  **whole** `thumb_%05d.ts` file with **no** `EXT-X-BYTERANGE`. This is
  spec-legal — RFC 8216 §4.3.3.6: "each Media Segment in the Playlist describes a
  single I-frame" — and lets the I-frame playlist be a **pure function of the
  duration** (`ceil(duration / interval)` entries), synthesized up front exactly
  like `vod_manifest::synthesize`, with thumbnails streamed on demand. Chosen.

Why re-encode only: a re-encode already runs an encoder and produces the uniform,
keyframe-aligned media playlist the master's video variant points at, so adding a
tiny parallel sampler is incremental. The sampler mirrors the proven
`spawn_sidecar_subtitle` pattern (detached, one-shot, best-effort, never blocks
`start`).

### (b) Copy-remux path — NOT tractable cheaply; deliberately excluded

A copy-remux session runs **no encoder** — its whole point is to avoid CPU. A
thumbnail rendition still requires decode + scale + encode of the sampled frames,
i.e. exactly the CPU the copy path exists to avoid. There is no byte-range-free
way to get an I-frame rendition out of a copy session without that fresh pass, so
copy-remux is out of scope. (A future option: reuse the already-cached source
keyframe list in `keyframes.rs` to build a byte-range I-frame playlist over the
copy segments — but that needs the per-keyframe byte offsets too, which the cache
does not store. Documented here as future work, not built.)

## What was implemented

New module **`crates/transcoder/src/trickplay.rs`** (registered `lib.rs`,
`mod trickplay;`) — pure, unit-tested:

- `enabled()` / `is_truthy()` — reads `TRANSCODER_TRICKPLAY` (`1/true/yes/on`).
- `master(bandwidth_bps, resolution)` — the MASTER playlist: one
  `EXT-X-STREAM-INF` → `media.m3u8`, one `EXT-X-I-FRAME-STREAM-INF` →
  `iframe.m3u8`. `RESOLUTION` is omitted rather than fabricated (source aspect
  isn't carried at the serving point; the variant plays fine without it).
- `iframe_playlist(total_duration_secs)` — the `#EXT-X-I-FRAMES-ONLY` playlist,
  `ceil(duration / TRICKPLAY_INTERVAL_SECS)` whole-file `thumb_%05d.ts` entries.
- `thumb_args(input, dir, interval, width)` — the sampler's ffmpeg argv.
- Constants: `TRICKPLAY_INTERVAL_SECS=10`, `THUMB_WIDTH=320`,
  `MEDIA_PLAYLIST_NAME="media.m3u8"`, `IFRAME_PLAYLIST_NAME="iframe.m3u8"`.

Wiring:

- `session.rs`:
  - `SessionManager::trickplay_master(id)` / `trickplay_iframe(id)` — build the
    playlists for a session (re-encode + known duration gate, mirroring
    `vod_manifest`).
  - `SessionManager::spawn_trickplay_thumbs(id, input, dir)` — the detached
    sampler (mirrors `spawn_sidecar_subtitle`), kicked from `start()` only when
    `trickplay::enabled() && plan.reencodes_video()`.
- `routes.rs`:
  - `session_manifest` serves the MASTER at `index.m3u8` when
    `enabled() && is_native_hls_client && trickplay_master(id).is_some()`;
    otherwise unchanged.
  - `session_segment` intercepts `media.m3u8` (→ the synthesized VOD media
    playlist, same bytes native `index.m3u8` serves today) and `iframe.m3u8`
    (→ `trickplay_iframe`) when `enabled()`; otherwise unchanged. `thumb_*.ts`
    segments are served by the existing on-disk asset read and 404 gracefully
    until the sampler writes them (a momentary blank preview, which AVPlayer
    tolerates on an I-frame rendition).

### URL shape after the change (native, flag ON, re-encode)

```
GET …/session/{id}/index.m3u8     → MASTER  (STREAM-INF media.m3u8 + I-FRAME-STREAM-INF iframe.m3u8)
GET …/session/{id}/media.m3u8     → synthesized finite VOD media playlist (seg_%05d.ts)
GET …/session/{id}/iframe.m3u8    → #EXT-X-I-FRAMES-ONLY playlist (thumb_%05d.ts)
GET …/session/{id}/seg_00000.ts   → main video segment (unchanged)
GET …/session/{id}/thumb_00000.ts → one-frame thumbnail segment (new; 404s until written)
```

The grant URL is unchanged (`…/index.m3u8`); only its native-re-encode *response*
becomes a master. All sub-URLs are same-directory relative, so the player
resolves them correctly.

## Why default OFF (honest caveats)

1. **A second ffmpeg process per session on a Plex-co-tenant box.** The sampler is
   tiny at the encoder (320px, 0.1 fps) but the `fps` filter still **decodes**
   every source frame to pick one per interval, so on a long 4K title it is real
   decode CPU competing with the main encode. Per the repo's NAS-safety rules,
   that warrants opt-in, not default-on.
2. **On-device acceptance is unverified here.** Whole-file (no-byterange)
   single-I-frame TS segments in an `EXT-X-I-FRAMES-ONLY` playlist are spec-legal,
   but Apple's own `mediafilesegmenter` emits **byte-range** entries into larger
   segments, and only a real Apple TV / iOS device can confirm AVPlayer renders
   the whole-file form. This environment has no such device.

## On-device verification steps (before considering default-on)

1. Deploy the transcoder image with `TRANSCODER_TRICKPLAY=1`.
2. Play a title that **re-encodes** (e.g. an HEVC-that-must-transcode or a forced
   re-encode) from the Apple TV client. Copy-remux titles will not show
   thumbnails (by design).
3. Confirm `curl -H 'User-Agent: AppleCoreMedia' …/index.m3u8` returns a MASTER
   with both `EXT-X-STREAM-INF` and `EXT-X-I-FRAME-STREAM-INF`, and that
   `…/iframe.m3u8` and `…/media.m3u8` both return 200.
4. On the Apple TV, scrub the timeline and confirm thumbnails appear.
   - If **no** thumbnails but playback is fine: whole-file iframe segments are
     likely being rejected — switch to **byte-range** mode (see below).
   - If playback breaks: check the master's `BANDWIDTH`/variant; fall back by
     unsetting the flag (instant, no redeploy of behavior).
5. Watch the box: `…/api/health` and Plex responsiveness during a first play of a
   long title, to confirm the sampler's decode load is acceptable. If not,
   raise `TRICKPLAY_INTERVAL_SECS` (fewer frames) or gate the sampler to idle.

### Byte-range fallback (if whole-file segments don't render)

Change the sampler to write a single `thumb.ts` (or per-GOP segments) and record
each frame's `(offset, length)` (e.g. from `-hls_segment_type` sizes or an
`ffprobe -show_packets` pass), then emit `#EXT-X-BYTERANGE:<len>@<off>` per entry
in `iframe_playlist`. This is the Apple-canonical form; it costs the byte-offset
bookkeeping the whole-file form avoids. Left unbuilt until on-device testing shows
it is needed.

## Tests

`crates/transcoder/src/trickplay.rs` unit tests (10): flag truthiness (pure, no
env mutation), master with/without resolution, I-frame playlist shape
(`EXT-X-I-FRAMES-ONLY`, VOD, ENDLIST, no `EVENT`), `ceil` count, remainder tail,
no byte-range, EXTINF-sums-to-duration, and the sampler argv (one keyframe per
segment, no `-ss`, correct output paths). Full suite: `cargo test -p transcoder`
(204 pass) and `cargo test --all` green.
