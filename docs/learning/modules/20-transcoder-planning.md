
# Transcoder Planning Layer — Teaching Dossier

---

## 1. WHAT

When a user hits Play on a movie, the backend must decide whether the file can be sent straight to the browser as-is, or whether ffmpeg must repackage it. The planning layer makes that decision in `crates/transcoder/src/plan.rs`. It is a pure function: it takes two inputs — a snapshot of what is in the file (video codec, resolution, HDR flag, audio codec and channel count, subtitle tracks) and a description of what the client browser has proven it can decode (the `ClientCaps` struct) — and it returns a `TranscodePlan` enum value with three fields describing what to do with video, audio, and subtitles. No network calls, no disk I/O, no side effects. The rest of the transcoder (session management, ffmpeg argument assembly, HLS segment writing) is entirely downstream of this plan. Getting the plan wrong — copying a stream the browser cannot decode — produces a grey rectangle at 0:00 with no error message and a perfectly healthy session on the server. The planning rules are therefore conservative: when in doubt, re-encode.

---

## 2. WHY — each rule traced to its real constraint

**Rule: DirectPlay short-circuits everything.**
`media_core::capability::decide()` is consulted first. If the container, video codec, resolution, and audio are all already browser-safe, no ffmpeg runs at all. Reason: the fastest transcode is no transcode.

**Rule: Video copy requires codec, profile, deliverability, no scale, no tone-map, and no burn-in.**
Each gate exists because a different failure mode was hit in production:
- Codec accepted but PROFILE unsafe: 10-bit H.264 (Hi10P) has the codec string `h264`, but browsers only decode 8-bit 4:2:0 profiles. Codec-only copy produced a grey box.
- Codec accepted but DELIVERY format wrong: HEVC in MPEG-TS segments is rejected by hls.js's TS transmuxer (it only demuxes H.264). HEVC copy is only legal in fMP4 segments, gated on the `hls_fmp4_hevc` cap bit.
- VP9/AV1: no HLS segment container in the player stack can carry them; re-encode unconditionally.

**Rule: HEVC copy uses fMP4 segments (SegmentFormat::Fmp4).**
HLS spec and hls.js both require fMP4 for HEVC delivery. MPEG-TS is the safe default for everything else because the entire serving path is proven on it.

**Rule: Audio copy only when codec is accepted AND (for AAC) channels <= aac_max_channels.**
Chrome and Firefox MSE reject a >2-channel AAC SourceBuffer append even though `isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` returns true. The append error kills the entire fragment and the player freezes grey at 0:00. This was the root cause of the American Dad! S02E03 grey-box (the 10-bit HEVC source was a red herring). The safe default cap is 2 channels. A client that probed real 6-channel decode via MediaCapabilities decodingInfo advertises `aac_max_channels: 6` and keeps surround.

**Rule: AAC re-encode always gets -ac 2 (stereo downmix) in the args builder.**
The plan decides to re-encode; the args builder always forces stereo. A multichannel re-encode without -ac 2 would produce a >2ch AAC track, re-triggering the MSE append failure.

**Rule: Multichannel source downmixed at 256k, native stereo at 192k.**
A 5.1 fold-down to 2.0 carries more spectral content than a native stereo track. 192k smears it; 256k is perceptually transparent for AAC-LC at 2.0.

**Rule: Non-AAC codecs (EAC3, DTS, AC-3) are re-encoded to AAC for browser MSE clients.**
Chrome and Firefox MSE decode only AAC in HLS. These codecs reach copy only when the client explicitly advertised them (Safari/Edge with real system decode). For everyone else, copying an EAC3 track produces silent video — not a crash, just dead audio, proven on American Dad! S01E07.

**Rule: plan_subtitle always returns SubtitleOp::None.**
Two reasons, both learned in production:
1. Under -re (real-time pacing used for live streams), the HLS muxer holds a segment open until ALL mapped streams reach the boundary. A sparse subtitle stream whose first cue is late held the first video segment ~9s (measured: 13s with WebVTT map, 4.5s without). The backend polls for manifest readiness with a 12s timeout; blowing past it produces a 503.
2. Even when it did write, ffmpeg put the WebVTT rendition in a separate `index_vtt.m3u8` (because no `-master_pl_name` was set), which nothing referenced. The subtitle was always orphaned.
Subtitles are dropped from the live stream entirely. Sidecar .vtt delivery via `<track>` is the planned follow-up.

**Rule: -force_key_frames pinned to HLS_SEGMENT_SECS on re-encodes.**
H.264 encoders (especially h264_vaapi) default to very long GOPs — tens of seconds. The HLS muxer can only cut a segment at a keyframe. Without forced keyframes the first segment does not close until the first native keyframe, which is far past the backend's readiness poll window, producing a 503 and a grey box. The forcing uses the time-based expr `gte(t,n_forced*N)` which is fps- and VFR-safe. Copy-remux does not need this: it cuts at the source's own keyframes.

**Rule: reencodes_video() controls which concurrency cap is charged.**
There are two caps: a global cap (default 4, covers all sessions including remuxes) and a strict CPU cap (default 1, for libx264 sessions which are order-of-magnitude heavier). Before this was fixed: every session, including a copy-remux, was charged against the CPU cap, so a household with no hardware encoder was throttled to ONE concurrent stream even for nearly-free remuxes. A second title 503'd. The fix: only `VideoOp::EncodeH264` charges the CPU cap. `VideoOp::Copy` with audio re-encode is a remux — it changes the container and/or re-encodes audio but puts negligible load on the CPU.

---

## 3. MAP — key files and a worked example

**Key files (all in `crates/transcoder/src/`):**

| File | Role | Load-bearing lines |
|------|------|--------------------|
| `plan.rs` | Planning pure function — the whole teaching scope | 1–1225 |
| `plan.rs:266` | `plan_transcode()` — top-level entry point | 266–362 |
| `plan.rs:367` | `plan_audio()` — audio op decision | 367–422 |
| `plan.rs:241` | `plan_subtitle()` — always returns None, explains why | 241–261 |
| `plan.rs:186` | `video_profile_copy_safe()` — codec+profile allowlist | 186–196 |
| `plan.rs:145` | `TranscodePlan::reencodes_video()` — CPU cap gate | 145–153 |
| `plan.rs:107` | `SegmentFormat` — TS vs fMP4 | 107–111 |
| `args.rs:127` | `HLS_SEGMENT_SECS` const + keyframe forcing context | 119–127 |
| `args.rs:456` | `-force_key_frames` emission | 456–457 |
| `args.rs:508` | `-ac 2` stereo downmix emission | 511–525 |
| `concurrency.rs:101` | `try_acquire(is_cpu)` — two-cap limiter | 101–147 |

**Worked example: 10-bit HEVC MKV, EAC3 5.1, ASS subtitle, SDR client that cannot do fMP4 HEVC.**

File probe data:
- container: `mkv`
- video_codec: `hevc`, video_profile: `Main 10`, video_height: `1080`, hdr_format: `None`
- audio: `eac3`, 6 channels
- subtitle: `ass` (text-based)

Client caps (typical browser):
- containers: `["mp4"]`
- video_codecs: `["h264"]`
- audio_codecs: `["aac"]`
- hls_fmp4_hevc: `false`
- hdr: `false`
- aac_max_channels: `2`
- max_height: `Some(1080)`

Step 1 — `plan_transcode()` calls `decide()`. Container is `mkv` (not in `["mp4"]`), so direct-play is denied. We enter the transcode branch.

Step 2 — `plan_subtitle()`. ASS is a text subtitle. The function finds it, logs a debug trace, returns `(SubtitleOp::None, None)`. burn_index is None.

Step 3 — Video. `video_codec = "hevc"`, not in `caps.video_codecs = ["h264"]` → `codec_ok = false`. Even if it were accepted, `hls_fmp4_hevc = false` → `hls_copy_deliverable = false`. Both gates fail. `needs_scale`: source is 1080, max_height is 1080 → no scale. `tone_map`: hdr_format is None → false.
Result: `VideoOp::EncodeH264 { scale_to_height: None, tone_map: false, burn_subtitle_index: None, source_height: Some(1080) }`.

Step 4 — `segment_format`. `is_hevc = true` but `video != VideoOp::Copy` → `SegmentFormat::MpegTs`.

Step 5 — `plan_audio()`. First track: codec `eac3`, channels `6`. `codec_accepted`: is `eac3` in `["aac"]`? No. Since codec is not accepted, go straight to the else: `is_downmix = true` (channels > 2) → `AudioOp::EncodeAac { bitrate_kbps: 256 }`.

Final plan:
```
TranscodePlan::Transcode {
    video:   EncodeH264 { scale_to_height: None, tone_map: false, burn_subtitle_index: None, source_height: Some(1080) },
    audio:   EncodeAac { bitrate_kbps: 256 },
    subtitle: None,
    segment_format: MpegTs,
}
```

`reencodes_video()` → true. This session charges the CPU cap (or GPU cap if hw encoder is available) AND the global cap.

In `args.rs`, this plan produces: `-c:v h264_vaapi -low_power 1 ...` (or `libx264 -preset fast`), `-b:v 10000k`, `-force_key_frames expr:gte(t,n_forced*4)`, `-c:a aac -ac 2 -b:a 256k`, no subtitle flags, MPEG-TS segments.

---

## 4. PREREQUISITES — fundamentals first

**What is a container?**
A video file (`.mkv`, `.mp4`, `.ts`) is a container — a box that holds multiple streams packed together: one video stream, one or more audio streams, possibly subtitle streams. The container defines how the streams are interleaved, how to seek, and where the metadata lives. The streams themselves are compressed with codecs (H.264, HEVC, AAC, EAC3). You can have H.264 video in an MKV container, an MP4 container, or an HLS (.ts) container. The codec and the container are separate concerns.

**What is a codec and a profile?**
A codec is an algorithm for compressing video or audio. H.264 has several profiles — sets of features within the codec. The Base/Main/High profiles encode 8-bit 4:2:0 color, which every browser supports. The Hi10P profile encodes 10-bit, which browsers do not decode. Same codec string (`h264`), different capability requirement.

**What is MSE (Media Source Extensions)?**
Browsers play adaptive streaming (HLS) through the Media Source Extensions API. JavaScript (hls.js) fetches segments, appends them to a `SourceBuffer`, and the browser's built-in decoder plays from that buffer. The browser can only append formats it knows how to decode. If an append is rejected, the `SourceBuffer` goes into an error state, hls.js triggers error recovery, and the player often freezes or turns grey.

**What is HLS?**
HTTP Live Streaming. The server writes many short video files (segments, typically 4s each) plus a text playlist file (`.m3u8`) that lists them. The player fetches the playlist, then fetches segments in order. The playlist can be a live sliding window (old segments deleted) or an EVENT playlist (segments accumulate; player can seek backward).

**What is a keyframe?**
In compressed video, most frames are stored as differences from a prior frame. A keyframe (I-frame) is stored completely. Seek points must be keyframes. The HLS muxer can only start a new segment at a keyframe. If keyframes are sparse, segments are long.

**What is fMP4?**
Fragmented MP4. Instead of one monolithic `.mp4` file, the video is stored in small self-contained fragments (`.m4s` files) plus an init segment (`init.mp4`) that carries the codec parameter sets. Required for MSE streaming and required by the HLS spec for HEVC. Regular MPEG-TS containers can only carry H.264.

---

## 5. GOTCHAS & WAR STORIES

**The Grey-Box Four-Fix Saga**

The grey-box-at-0:00 failure class was hit four separate times on American Dad! episodes, each exposing a different planning bug.

**Fix 1 — Keyframe cadence** (commit 0cda2f4).
S01E07 greyed out. Root cause: re-encode with no `-force_key_frames`. h264_vaapi's default GOP is ~14s. Under `-re` (live pacing), the HLS muxer could not close the first segment until the first native keyframe at 14s wall-clock. The backend polls for manifest readiness 24 times at 500ms (12s total). The first segment was still open — poll timed out, manifest not yet written, SPA got a 503, hls.js refused to retry. Fix: `-force_key_frames expr:gte(t,n_forced*N)` pinned to `HLS_SEGMENT_SECS` (4s). The const is shared between `-hls_time` and the keyframe forcing so they cannot drift.

**Fix 2 — Non-AAC audio** (commit 977f892).
Some titles had silent audio. Root cause: the audio plan was copying EAC3 because `decide()` in media-core checked only container and video codec — never audio. EAC3 is not decodable by Chrome or Firefox MSE. Fix: `plan_audio` now gates copy on whether the codec appears in `caps.audio_codecs` (default `["aac"]`).

**Fix 3 — Inline subtitle** (commit f091d41).
After Fix 1+2, the first segment was still arriving late (~13s instead of ~4.5s). Root cause: `-c:s webvtt` was mapped onto the live stream under `-re`. The HLS muxer held the first segment open waiting for ALL streams — including the sparse subtitle stream whose first cue was several seconds in. Additionally, ffmpeg wrote the subtitle rendition to `index_vtt.m3u8` with no master playlist referencing it — always orphaned. Fix: `plan_subtitle` unconditionally returns None. Grant time dropped from ~12s to ~4.5s.

**Fix 4 — Multichannel AAC MSE append** (commit d1fc9a7).
S02E03 (10-bit HEVC + EAC3 5.1) still greyed out after all three fixes. After Fix 2, audio was re-encoded to AAC — but without `-ac 2`. Result: 6-channel AAC. Chrome's MSE rejected the SourceBuffer append. On the server everything looked healthy: segments ffprobed as valid H.264 + AAC 6ch. In the browser: `bufferAppendError: audio SourceBuffer error`, fragBuffered=0, currentTime stayed at 0. Fix: the args builder always emits `-ac 2` when the audio op is `EncodeAac`. Lesson: manifest 200 + valid ffprobe does NOT prove the player can play it. Must verify with a real browser (Playwright real-Chrome, not bundled Chromium which lacks H.264/AAC).

**The CPU-cap 503-on-2nd-title bug.**
Before `reencodes_video()` was added, `try_acquire(is_cpu)` used `encoder.is_cpu()` — charging the CPU cap whenever the machine had no hardware encoder. On a software-only box, every session including a copy-remux charged the CPU cap (default 1). A second concurrent stream 503'd even though remuxes are nearly free. Fix: `is_cpu` is now `plan.reencodes_video() && encoder.is_cpu()`. Copy-remux charges only the global cap (default 4).

---

## 6. QUIZ BANK — application-style questions with answers

**Q1.** Source: H.264 Main profile, 1080p, SDR, AAC stereo, MKV container. Client caps: `video_codecs: ["h264"]`, `containers: ["mp4"]`, `max_height: Some(1080)`, `aac_max_channels: 2`. What does `plan_transcode` return and why?

**A1.** `TranscodePlan::Transcode { video: Copy, audio: Copy, subtitle: None, segment_format: MpegTs }`. `decide()` denies direct-play (MKV not in `["mp4"]`). Video: h264 accepted, Main profile in allowlist, h264 is deliverable in MPEG-TS, no scale, no tone-map → Copy. Audio: aac accepted, 2 channels <= cap 2 → Copy. `reencodes_video()` is false — only the global cap charges. This is a container-only remux.

**Q2.** Same file but audio is EAC3 5.1. Client has `audio_codecs: ["aac"]`. What changes?

**A2.** Audio becomes `EncodeAac { bitrate_kbps: 256 }`. `eac3` is not in `["aac"]` → codec not accepted → re-encode. `channels: 6 > 2` → `is_downmix = true` → 256k. The args builder emits `-c:a aac -ac 2 -b:a 256k`. Video is still Copy. `reencodes_video()` is still false — audio re-encode + container change is a remux.

**Q3.** Source: HEVC Main 10, 1080p, SDR, AAC stereo, MKV. Client: `video_codecs: ["h264", "hevc"]`, `hls_fmp4_hevc: true`, `audio_codecs: ["aac"]`. What is the plan and what segment format is used?

**A3.** Video: hevc is in accepted codecs, Main 10 is in `video_profile_copy_safe`'s hevc allowlist, `hls_fmp4_hevc: true` → deliverable → Copy. `segment_format`: is_hevc + video==Copy → `Fmp4`. Audio: AAC stereo → Copy. Args builder emits fMP4 segment flags and tags the stream `hvc1`. `reencodes_video()` → false.

**Q4.** Same file but `hls_fmp4_hevc: false`. How does the plan change and why?

**A4.** Video flips to `EncodeH264`. Even though codec and profile pass, `hls_copy_deliverable = false` (HEVC cannot ride MPEG-TS). Must re-encode to H.264 to deliver in MPEG-TS. `segment_format` stays MpegTs. `reencodes_video()` → true.

**Q5.** A copy-remux session (VideoOp::Copy, AudioOp::EncodeAac) is running. A second user starts a real H.264 re-encode. `MAX_CONCURRENT_CPU_TRANSCODES=1`, software encoder only. Does the second session 503?

**A5.** No. The first session called `try_acquire(is_cpu = false)` because `reencodes_video()` is false for a copy-remux — only the global cap was charged. CPU counter is 0. The second session calls `try_acquire(is_cpu = true)`, finds CPU counter 0 < 1, acquires both slots. Both run concurrently.

**Q6.** A title has a forced ASS subtitle track. Does that affect the video plan or force a burn-in re-encode?

**A6.** No. `plan_subtitle` always returns `(SubtitleOp::None, None)`. `burn_index` is always None. Since `burn_index.is_none()` is always true, subtitles have zero effect on the video op. The video plan is driven solely by codec, profile, deliverability, scale, and tone-map.

---

## 7. CODE-READING EXERCISE — guided plan.rs walk

**Goal:** Follow a plan for a 10-bit HEVC MKV with DTS 7.1 audio, no HDR, client is a basic browser (H.264 only, no fMP4 HEVC, AAC-only, stereo cap).

**Step 1: find the entry point.**
Open `/Users/cujo253/Documents/theemeraldexchange/crates/transcoder/src/plan.rs` at line 266. `plan_transcode` takes `&MediaFileRow` and `&ClientCaps`. The first thing it does is call `decide(file, caps)` — imported from `media_core::capability`. The `decide` function returns a struct with `direct_play: bool`. If true, we return `TranscodePlan::DirectPlay` immediately. Our file is MKV; client accepts only MP4. `direct_play` is false.

**Step 2: subtitle plan.**
Line 276: `let (subtitle, burn_index) = plan_subtitle(file)`. Jump to line 241. Read the doc comment — two numbered reasons for always returning None. Notice it still detects text and image subtitles (for debug logging and to keep the `ExtractWebVtt` op alive for the future sidecar), but line 260 always returns `(SubtitleOp::None, None)`. Back in `plan_transcode`, `burn_index` is `None`.

**Step 3: video op.**
Lines 279–341. `video_codec = "hevc"`. `codec_ok`: is "hevc" in `["h264"]`? No. `profile_ok`: call `video_profile_copy_safe("hevc", Some("Main 10"))` at line 186 — the hevc arm matches `"main 10"` → true. But `codec_ok` is false. `is_hevc = true`. `hls_copy_deliverable`: the hevc arm checks `caps.hls_fmp4_hevc = false` → false. `needs_scale`: 1080 vs max 1080 → false. `tone_map`: hdr_format None → false. The condition at line 326 fails on `codec_ok` → `VideoOp::EncodeH264 { scale_to_height: None, tone_map: false, burn_subtitle_index: None, source_height: Some(1080) }`.

**Step 4: segment format.**
Line 346. `is_hevc = true` BUT `video != VideoOp::Copy` (it is EncodeH264) → `SegmentFormat::MpegTs`. The output is H.264 which rides TS.

**Step 5: audio op.**
Line 353, jump to `plan_audio` at line 367. First track: `dts`, 8 channels. `codec_accepted`: is "dts" in `["aac"]`? No. Go directly to the else: `is_downmix`: channels is `Some(8) > 2` → true → `AudioOp::EncodeAac { bitrate_kbps: 256 }`.

**Step 6: what the args builder does.**
In `args.rs`, EncodeH264 with VAAPI encoder: `-c:v h264_vaapi -low_power 1 -rc_mode QVBR -global_quality 23 -profile:v high ...`. Then at line 456: `-force_key_frames expr:gte(t,n_forced*4)` and `-hls_time 4` (both keyed on `HLS_SEGMENT_SECS = 4`). Audio at line 507: `-c:a aac -ac 2 -b:a 256k`. No subtitle flags.

**Step 7: does this charge the CPU cap?**
`plan.reencodes_video()` at line 145: matches `TranscodePlan::Transcode { video: VideoOp::EncodeH264 { .. }, .. }` → true. `try_acquire(is_cpu = encoder.is_cpu())`. If VAAPI, `is_cpu() = false` → global cap only. If CPU (libx264) → charges both.

**What to read next:**
- `crates/media-core/src/capability.rs` — how `decide()` makes the direct-play/transcode binary decision that this entire layer is downstream of.
- `crates/transcoder/src/session.rs` — how the plan flows into a running ffmpeg child, supervisor restarts, and how the concurrency `Permit` decrements counters on drop.
- `crates/transcoder/src/concurrency.rs` — the two-counter CAS loop that prevents two concurrent grants from both slipping past the last slot.

---

