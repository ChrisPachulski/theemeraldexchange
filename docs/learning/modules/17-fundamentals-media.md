
# Part 0: Media Streaming Fundamentals

*Source material for the theemeraldexchange teaching syllabus — true beginner audience.
All examples are grounded in the actual repo at `/Users/cujo253/Documents/theemeraldexchange`.*

---

## 1. WHAT — The Concept Ladder

Before you can understand a single line of the transcoder, you need to hold a mental model of
seven nested ideas: a video file is a *container* (a box) holding separate *streams* encoded
with *codecs* (compression algorithms). Browsers can only decode a small subset of codecs
natively. When a browser cannot play a file directly, the server must *transcode* (re-encode)
or *remux* (repackage without re-encoding) the streams into something the browser can handle.
The server does that work with ffmpeg, and it delivers the result not as a single file but as
HLS — a playlist pointing to short numbered *segments*. Hardware acceleration (VAAPI on the
NAS Intel iGPU) offloads the expensive re-encoding from the CPU. HDR video stores colours in
a wider range than most monitors show, so an SDR monitor needs a *tonemap* step that compresses
those colours back into standard range. Subtitles are their own stream category with two
incompatible families (text and bitmap) that require completely different handling.
Everything in `crates/transcoder` and `crates/media-core` exists to make these decisions
correctly and cheaply for every file in the library.

---

## 2. CONCEPT LADDER

### Rung 1 — Container vs Codec

**ELI5.**
Think of a container (`.mkv`, `.mp4`) as a ZIP file for video. It holds multiple separate
tracks — one for picture, one for sound, sometimes one for subtitles — neatly packaged
together. The codec (H.264, HEVC, AAC) is the *compression algorithm* that was used to shrink
each track. The container does NOT determine the codec. A `.mkv` file can hold H.264 video or
HEVC video or VP9 video. These are completely independent choices.

**Concrete example from this repo.**
`crates/media-core/src/capability.rs` line 102–110: the `container_family()` function maps
ffprobe's container name string ("matroska", "mov", "mp4", …) to a canonical family token.
`crates/transcoder/src/plan.rs` lines 279–283 read `file.video_codec` and `file.container`
separately because they are separately probed facts.

**Why needed.**
The server must decide "can this browser play this file?" that question has TWO sub-questions:
can the browser handle the container? can it decode the codec? Either one failing forces a
transcode.

---

### Rung 2 — Why Browsers Can't Play Everything

**ELI5.**
Web browsers ship with a fixed list of decoders they support. Chrome and Firefox decode
H.264 (the most common video codec) and AAC (the most common audio codec) natively. They do
NOT decode HEVC (H.265), DTS, AC-3/E-AC-3 (Dolby), or most container formats except MP4 and
WebM. If you hand Chrome a `.mkv` file with HEVC video and EAC-3 audio, Chrome shows a black
screen and reports an error — it simply cannot decode it.

**Concrete example.**
`crates/media-core/src/capability.rs` line 33–36, 52–58: `ClientCaps.audio_codecs` defaults
to `["aac"]` — just one codec. Every other audio format (EAC-3, DTS, AC-3) is rejected unless
the client explicitly probes and advertises system-level decode support. Line 52: `fn
default_audio_codecs() -> Vec<String> { vec!["aac".to_string()] }`.

**Why needed.**
This is why 90% of the transcode code exists. The server probes each file's actual codecs and
compares them against what the client declared it can handle.

---

### Rung 3 — Transcoding vs Remuxing

**ELI5.**
*Remuxing* means taking the compressed picture and sound tracks out of one container box and
putting them into a different box — no quality change, very fast, barely any CPU.
*Transcoding* means actually decompressing and re-compressing the video, which takes significant
CPU (or GPU) time and does involve quality loss.

Example: an `.mkv` file with H.264 video and AAC audio that Chrome wants as MP4 → just
remux (change the box, keep the contents). An `.mkv` with HEVC video → must transcode
(re-encode HEVC to H.264 because Chrome can't decode HEVC).

**Concrete example.**
`crates/transcoder/src/plan.rs` lines 326–341: the `video` decision tree. `VideoOp::Copy`
("remux the video stream untouched") is chosen when codec, profile, deliverability, scale, and
tone-map all pass. `VideoOp::EncodeH264 { … }` ("transcode") is the fallback.

`TranscodePlan::reencodes_video()` at lines 145–153 explicitly separates these two cases
because a copy-remux barely uses CPU (so multiple streams are fine concurrently) while a
re-encode does.

**Why needed.**
Remuxing is essentially free. Transcoding costs real CPU/GPU. The concurrency limits in the
transcoder (`concurrency.rs`) charge a session against the stricter CPU cap ONLY when
`reencodes_video()` is true.

---

### Rung 4 — HLS: Manifest + Segments

**ELI5.**
HLS (HTTP Live Streaming) is a trick for streaming video over plain HTTP. Instead of one
giant file, the server slices the video into short chunks (usually 4–6 seconds each) called
*segments*. It then creates a text file called a *manifest* (or playlist, `index.m3u8`) that
lists all the segment filenames in order. The player (hls.js in the browser) downloads the
manifest first, then fetches segments one at a time, buffering a few ahead. This means
playback can start almost immediately and seeking jumps to the right segment instead of
downloading the whole file.

MPEG-TS (`.ts`) and fMP4 (fragmented MP4, `.mp4` segments) are the two HLS segment formats.
hls.js can only demux H.264 from MPEG-TS; HEVC must use fMP4 segments.

**Concrete example.**
`crates/transcoder/src/plan.rs` lines 99–111 define `SegmentFormat`:

```rust
pub enum SegmentFormat {
    #[default]
    MpegTs,
    Fmp4,
}
```

Lines 346–350 pick fMP4 only when the plan is an HEVC copy — "HEVC must arrive already in
fMP4 for hls.js/MSE." Every other plan stays on the proven MPEG-TS path.

**Why needed.**
The player technology (hls.js) determines what segment format is legal for a given codec.
Getting this wrong (HEVC in a TS segment) produces the grey-box-at-0:00 failure with a
"healthy" session log — one of the most confusing failure classes in the project.

---

### Rung 5 — Direct Play

**ELI5.**
If a file is ALREADY in exactly the right format for the browser (MP4 container, H.264 video,
AAC audio, SDR, within the browser's resolution/bitrate limits), the server can hand the raw
file URL directly to the browser's `<video>` tag. No ffmpeg, no segments, no HLS. This is
"direct play." It is the fastest possible path — no processing latency, no quality loss.

**Concrete example.**
`crates/media-core/src/capability.rs` lines 129–228: the `decide()` function. It checks
container, codec, profile, height, bitrate, HDR flag, and audio codec one by one. If every
check passes it returns `PlayDecision { direct_play: true, reason: "direct play" }`. The
unit test at line 268 is the baseline: `h264/mp4/1080p/SDR/AAC → direct play`.

`crates/transcoder/src/plan.rs` line 266–270: `plan_transcode()` calls `decide()` first; if
it returns `direct_play: true` the function immediately returns `TranscodePlan::DirectPlay`
without touching ffmpeg.

**Why needed.**
Direct play is always the goal. Every transcode check is trying to figure out whether direct
play is safe. A wrong direct-play grant (giving the browser a file it can't play) shows as a
silent black screen; a wrong transcode denial wastes CPU unnecessarily.

---

### Rung 6 — Client Capabilities (caps)

**ELI5.**
The server needs to know what the browser can handle BEFORE deciding what to send. The SPA
(browser app) runs a capability probe using the `MediaCapabilities` API, then sends a JSON
object (`ClientCaps`) to the server with facts like:
- `containers: ["mp4"]` — "I can play MP4 files"
- `video_codecs: ["h264"]` — "I can decode H.264 video"
- `hdr: false` — "my screen is not HDR"
- `hls_fmp4_hevc: true` — "I probed real HEVC hardware decode AND an fMP4-capable player"

The server makes every transcode decision from these caps; it never guesses.

**Concrete example.**
`crates/media-core/src/capability.rs` lines 15–75: the full `ClientCaps` struct. Each field
has a doc comment explaining its semantics and default. `aac_max_channels` at line 42 defaults
to 2 — "Chrome/Firefox MSE reject a >2-channel AAC SourceBuffer append even though the codec
string reports as supported."

**Why needed.**
Different browsers have genuinely different capabilities (Safari can decode HEVC and EAC-3;
Chrome cannot without special hardware). A single fixed decode policy would either break on
Chrome or transcode unnecessarily on Safari. Caps let the server tailor the plan to each client.

---

### Rung 7 — Audio Codecs and the MSE Trap

**ELI5.**
Audio has its own codec problem. The most common audio codecs in movie files are:
- AAC — the baseline; every browser decodes it
- EAC-3 (Dolby Digital Plus) — most .mkv movie rips; Chrome/Firefox CANNOT decode it via MSE
- DTS — cinema format; no browser support via MSE
- AC-3 (Dolby Digital) — older; same MSE rejection as EAC-3

The tricky part: browsers report that they "support" AAC regardless of channel count, but
Chrome and Firefox MSE (the streaming path used by hls.js) silently REJECT an AAC audio
buffer with more than 2 channels (5.1 surround). The append appears to succeed, but the
fragment fails, the player stalls, and the screen stays grey. You cannot trust
`isTypeSupported()` alone.

**Concrete example.**
`crates/transcoder/src/plan.rs` lines 367–421: `plan_audio()`. The key logic at lines
400–409: even if `codec_accepted` is true (AAC is in the caps list), `channels_safe` must
ALSO be true — `track.channels <= caps.aac_max_channels.max(2)`. If channels are unknown, we
re-encode conservatively ("a wrongly-copied 5.1 track is a silent total playback failure,
whereas a needless stereo re-encode merely costs a little CPU"). Downmix bitrate at line 97:
256 kbps vs the normal 192 kbps, because folding 5.1 to stereo carries more spectral content.

**Why needed.**
The American Dad! S02E03 grey-box bug was entirely caused by this. HEVC video decoded fine,
the ffprobe on the segment looked correct, the server reported success — yet the browser
showed a grey rectangle. The bug was in the audio append path on the browser, not the server.

---

### Rung 8 — HDR and Tonemapping

**ELI5.**
HDR (High Dynamic Range) video stores colours that are much brighter and more vivid than a
standard (SDR) monitor can display. HDR10 is the most common format in 4K Blu-ray rips. If
you play an HDR video on an SDR monitor without conversion, the picture looks washed-out and
pale — the brightest whites and the deepest blacks are all crushed together.

Tonemapping is the conversion step: a filter analyzes the HDR metadata and mathematically
remaps the wide HDR colour range into the narrower SDR range, preserving relative contrast and
colour relationships as best it can. The NAS runs this conversion on the Intel GPU using the
`tonemap_vaapi` ffmpeg filter.

**Concrete example.**
`crates/media-core/src/capability.rs` lines 199–204: the HDR gate in `decide()`. If the file
has a non-empty `hdr_format` (e.g. "HDR10") and the client's `hdr` flag is false, deny direct
play with reason "hdr requires tone-map."

`crates/transcoder/src/plan.rs` lines 314–319: `tone_map` is set to true when
`is_hdr && !caps.hdr`. The `EncodeH264 { tone_map: true, … }` variant tells the ffmpeg args
builder to add the `tonemap_vaapi` filter to the hardware filtergraph.

**Why needed.**
An HDR file played on an SDR monitor without tonemapping looks terrible. A file played with
tonemapping on an HDR monitor loses HDR quality unnecessarily. The caps bit `hdr` lets the
server route each user to the correct path.

---

### Rung 9 — Hardware Encoding (VAAPI / Intel iGPU)

**ELI5.**
Video re-encoding (transcoding) is computationally expensive. Doing it entirely on the CPU
("software encode") uses several CPU cores for seconds per minute of video. The NAS's Intel
processor has a built-in GPU (iGPU) with a dedicated video encoding circuit called VAAPI
(Video Acceleration API on Linux). When VAAPI is available, ffmpeg uses `h264_vaapi` instead
of `libx264` — the GPU handles the encoding in its own silicon, using almost no CPU, and the
result is available much faster.

The NAS is a low-powered box that also runs Plex. CPU encoding under load has previously
brown-outed the whole box (load ~73 on a 6-thread CPU, starving Plex and even SSH). VAAPI
encoding avoids this.

**Concrete example.**
`crates/transcoder/src/encoders.rs` (not read in full, but referenced throughout plan.rs):
the boot-time probe resolves whether `vaapi`, `qsv`, or `nvenc` is available. The plan
branches on this at the args-building stage.

`crates/media-core/src/capability.rs` line 48–49: `hls_fmp4_hevc` on the ClientCaps is the
client-side signal that HEVC hardware decode is available — the client probes this via
`navigator.mediaCapabilities.decodingInfo()` and the result gates the HEVC copy-remux path
(which requires both server-side VAAPI AND client-side HW decode).

**Why needed.**
The box cannot sustain multiple simultaneous CPU re-encodes. VAAPI is not optional on this
hardware — it is what makes multi-user streaming possible.

---

### Rung 10 — Subtitles: Text vs Bitmap

**ELI5.**
Subtitles come in two completely different formats:

*Text subtitles* (SRT, ASS, WebVTT, SubRip) store the text of each line plus timestamps. They
can be rescaled, restyled, and extracted to a standalone `.vtt` sidecar file.

*Bitmap/image subtitles* (PGS, VOBSUB, DVD subtitles) store a small image for each subtitle
line — a picture of the text, not the text itself. To display them, you must composite
("burn") the image ON TOP of the video frames. This requires a completely different ffmpeg
filtergraph — the libass subtitle filter that renders text subs cannot render bitmap subs.

Both types add significant complexity to the transcode pipeline. Inline subtitle handling
(during HLS streaming, under the `-re` realtime flag) was discovered to stall the first video
segment by up to 9 seconds, causing the grey-box failure. The current code drops both types
from the live stream and plans to restore text subs via a pre-extracted sidecar.

**Concrete example.**
`crates/transcoder/src/plan.rs` lines 36–52: `TEXT_SUBTITLE_CODECS` and
`IMAGE_SUBTITLE_CODECS` constants. Lines 210–260: `plan_subtitle()` — the function currently
always returns `(SubtitleOp::None, None)` regardless of what subtitles the file has. The
doc comment explains why: "Under `-re` the HLS muxer holds a segment open until every mapped
stream including the sparse subtitle stream reaches the segment boundary. On a title whose
first subtitle cue is late, that delays the FIRST video segment by ~9s of wall-clock."

**Why needed.**
Getting subtitle handling wrong was a root cause of the American Dad! S01E07 grey-box bug.
Understanding the text/bitmap distinction explains why there is no single universal subtitle
approach.

---

## 3. MAP — Repo Files with Path:Line Anchors

| File | What it contains | Key anchors |
|---|---|---|
| `crates/media-core/src/capability.rs` | ClientCaps struct, `decide()` direct-play gate | L15–75 (struct), L129–228 (`decide`), L52–58 (default AAC) |
| `crates/transcoder/src/plan.rs` | Full transcode planning logic, VideoOp/AudioOp/SubtitleOp enums | L1–26 (module doc), L54–130 (enums), L186–196 (`video_profile_copy_safe`), L241–260 (`plan_subtitle`), L263–362 (`plan_transcode`), L367–421 (`plan_audio`) |
| `crates/transcoder/src/plan.rs` (tests) | Unit test matrix for every decision branch | L425–1225 |
| `crates/transcoder/src/concurrency.rs` | CPU cap vs global cap logic | (referenced in plan.rs L145–153) |
| `crates/media-core/src/models.rs` | `MediaFileRow`, `AudioTrack`, `SubtitleTrack` structs | (the data the planner reads) |
| `.planning/burn-it-all/syllabus-2026-06-11/inputs/context/docs-M4-TRANSCODE-VERIFICATION.md` | Deployed proof record; real-ffmpeg measurement | L1–100 |

---

## 4. PREREQUISITES — Beginner Misconceptions to Preempt

**"A `.mkv` file IS a codec."**
No. `.mkv` (Matroska) is a container — it says nothing about what video codec is inside. A
`.mkv` can contain H.264, HEVC, VP9, AV1, or even H.263. The extension tells you the box;
you must probe the inside to know the codec.

**"If the browser says it supports H.264, it supports ALL H.264."**
No. H.264 has profiles. "High 10" (Hi10P, common in anime rips) is technically H.264 by codec
name but no browser hardware decoder supports it. The planner checks both codec AND profile
(`plan.rs::video_profile_copy_safe`, L186–196).

**"If `isTypeSupported('audio/mp4; codecs=mp4a.40.2')` returns true, I can append AAC."**
Not for 5.1. Chrome/Firefox's MSE path accepts stereo AAC but silently fails on 6-channel
AAC appends. The result is a grey screen with no error message visible to the user. The
`aac_max_channels` caps field (default 2) exists for this exact reason.

**"HEVC is just H.264 but more efficient."**
HEVC/H.265 is a completely different codec. The only browser that can decode it natively
(without plugins) is Safari on Apple hardware. Chrome and Firefox cannot. The HLS delivery
path also differs: HEVC requires fMP4 segments; H.264 uses MPEG-TS. These are non-trivial
differences.

**"Transcoding and remuxing are the same thing — both use ffmpeg."**
They use the same tool but do fundamentally different work. Remuxing moves compressed data
from one container to another (nearly instant, no quality loss). Transcoding decompresses then
recompresses — takes seconds/minutes, uses significant CPU or GPU, and always incurs some
quality loss.

**"The server handles subtitle display, so I don't need to worry about subtitle types."**
The server cannot display subtitles — it can only embed them in the stream or extract them to
a sidecar. Whether a subtitle can be extracted without re-encoding the video depends entirely
on whether it is text-based or image-based. Image subs require burning onto the video frames
(which is a full re-encode); text subs can be extracted to a `.vtt` file independently.

**"HDR just means brighter."**
HDR (High Dynamic Range) is a different colour encoding standard (BT.2020 colour space,
PQ/HLG transfer functions) that requires either an HDR display OR a tonemapping step. Without
tonemapping on an SDR display, an HDR video looks faded and low-contrast — the encoding math
is wrong for that display type.

---

## 5. GOTCHAS & WAR STORIES

### The Grey Box at 0:00 — Four Independent Causes

The project hit the "grey rectangle at time 0" failure class repeatedly, and EACH time it had
a different root cause. This is important because "the symptoms look identical but the cause is
different each time" is the defining characteristic of media streaming bugs.

**Cause 1: Keyframe cadence (American Dad! S01E07, fix `0cda2f4`)**
The HEVC→H.264 re-encode had no `-g` (keyframe interval) argument. The GPU encoder chose its
own GOP (group of pictures) size — around 14 seconds. HLS cuts segments at keyframes; with a
14-second GOP, the first segment arrived 14 seconds into real-time input (the `-re` flag),
well after the server's 12-second manifest-readiness timeout. The player received a "503 Not
Ready" manifest, which hls.js does not retry. Fix: `-force_key_frames expr:gte(t,n_forced*N)`
pins keyframes at every HLS segment boundary.

**Cause 2: Inline subtitle stall (American Dad! S01E07, fix `f091d41`)**
Having a WebVTT subtitle extraction mapped under `-re` delayed the first video segment by ~9
seconds (13s vs 4.5s without it). Under realtime input pacing, the HLS muxer holds a segment
open until all mapped streams reach the boundary — the subtitle stream's first cue was far into
the title, starving video. Fix: disable all inline subtitle extraction on the live stream.

**Cause 3: EAC-3 audio copied without re-encoding (`977f892`)**
204 out of 1,130 files that were being served had EAC-3 audio. The plan was copying EAC-3 into
the HLS segments. Chrome and Firefox cannot decode EAC-3 — the video played fine but audio was
silent, which manifested as a grey box in some playback paths. Fix: copy audio ONLY when it is
AAC.

**Cause 4: Multichannel AAC rejected by MSE (American Dad! S02E03, fix `d1fc9a7`)**
The server was sending correctly-encoded H.264 video and AAC audio in valid HLS segments. The
ffprobe on the segments showed everything fine. Yet the browser was grey. Chrome-Playwright
investigation revealed: `audio SourceBuffer error. MediaSource readyState: ended`. The audio
was 5.1 (6-channel) AAC. Chrome and Firefox MSE reject >2-channel AAC appends silently. Fix:
`-ac 2` stereo downmix for any AAC re-encode, and `plan_audio` only copies AAC when ≤2 channels.

**Lesson:** A valid manifest + valid segments + ffprobe-clean output does NOT mean the browser
will play it. You must verify with a real browser (and the real browser's MSE path, not
Playwright's bundled Chromium which lacks H.264/AAC support).

---

### The 5.1 AAC "I support it" Lie

`navigator.mediaCapabilities.decodingInfo({ audio: { contentType: 'audio/mp4; codecs=mp4a.40.2' } })`
returns `{ supported: true, smooth: true, powerEfficient: true }` on Chrome regardless of
channel count. The API does not expose the MSE append channel limit. The only way to know that
Chrome rejects 5.1 AAC appends is to empirically test it or find it in browser source code.
This is why `ClientCaps.aac_max_channels` defaults to 2 and is only raised when a deeper probe
confirms the specific client can handle it.

---

### HEVC in MPEG-TS: The Invisible Error

hls.js's MPEG-TS transmuxer only demuxes H.264. If the server copies an HEVC elementary stream
into `.ts` segments and sends those to hls.js, the player appends the buffer to MSE but MSE
cannot decode HEVC from a TS container. The player stalls grey at 0:00. The session log shows
200 OK everywhere. This is the "HEVC never copies without fMP4 capability" test at
`plan.rs:L989`. The fix is `SegmentFormat::Fmp4` for HEVC copy plans, gated on
`caps.hls_fmp4_hevc`.

---

### The tmpfs `/scratch` Silent Kill

The transcoder writes HLS segments to a tmpfs-mounted `/scratch` directory. Docker compose
mounts tmpfs as `root:root 0755` by default, overriding the Dockerfile's `chown` — the
container's non-root uid cannot write. Every real transcode session died immediately with
"Permission denied" while the unit tests (which use a shell stub that writes to `/tmp`) passed
green. Fix: `mode=1777` in the compose tmpfs mount. Lesson: `exit code 0` and "green tests"
do not mean "it works on the deployed box."

---

## 6. QUIZ BANK

**Q1.** A user's library has a file: `movie.mkv` / HEVC video / AAC stereo audio / SDR / 1080p.
The browser's caps are `containers: ["mp4"]`, `video_codecs: ["h264"]`, `hdr: false`.
Walk through what `decide()` returns, and then what `plan_transcode()` decides for each stream.

*Answer:* `decide()` returns `direct_play: false` for two reasons: (1) matroska container
always denies direct-play (`capability.rs` L146), (2) codec HEVC not in client's `video_codecs`
list anyway. In `plan_transcode()`: video → `EncodeH264` (HEVC not in caps, no fMP4 either);
audio → `Copy` (AAC stereo is accepted and ≤2ch); subtitles → `None`. Segment format →
`MpegTs` (re-encode output is H.264, not HEVC copy).

---

**Q2.** A file has H.264 "High 10" (Hi10P) video inside an MP4 container with stereo AAC.
The browser cap is `containers: ["mp4"], video_codecs: ["h264"]`. Why does this NOT direct-play
even though the container and codec string both match?

*Answer:* `capability.rs` L169–176 has a hard deny for H.264 with a profile string containing
"10" — Hi10P is unsupported by every browser's hardware decoder. The codec string "h264"
matches but the profile "High 10" fails the profile gate. `plan_transcode` will produce
`VideoOp::EncodeH264` because `video_profile_copy_safe("h264", Some("High 10"))` at
`plan.rs:L186` only allows "Baseline"/"Main"/"High"/"Constrained Baseline"/"Constrained High".

---

**Q3.** The server has a file with HEVC video and EAC-3 5.1 audio in MKV. The client
advertises `hls_fmp4_hevc: true` (probed HEVC hardware decode). What does the plan produce,
and what is the segment format?

*Answer:* `decide()` denies (matroska never direct-plays). In `plan_transcode()`: codec is
HEVC, profile check: `video_profile_copy_safe("hevc", …)` passes for "Main" or "Main 10".
`hls_copy_deliverable` is true (client has `hls_fmp4_hevc`). No scale, no tone-map, no
burn-in → `VideoOp::Copy`. Audio: EAC-3 is not in the default `audio_codecs: ["aac"]` list
→ `AudioOp::EncodeAac { bitrate_kbps: 256 }` (5.1 downmix). Segment format: HEVC copy →
`SegmentFormat::Fmp4`. This is the zero-loss "Play Direct" path for HEVC content.

---

**Q4.** Why does the transcoder not extract subtitles inline during the HLS session, even when
the file has text subtitles?

*Answer:* Two reasons (from `plan_subtitle()` doc comment, `plan.rs:L211–260`): (1) Under
`-re` (realtime input pacing), the HLS muxer holds a segment open until ALL mapped streams
reach the segment boundary. A sparse subtitle stream whose first cue appears late in the title
delays the first video segment by ~9 seconds — past the manifest-readiness timeout, causing a
grey box. (2) Even when it worked, ffmpeg wrote subtitles to a separate `index_vtt.m3u8` with
no master playlist referencing it — the extracted subs were orphaned and never shown. The
planned fix is pre-extracting to a sidecar `.vtt` file in a separate (non-`-re`) ffmpeg pass.

---

**Q5.** A deployed session shows 200 OK for the grant, 200 OK for the manifest, and 200 OK
for every segment. The user sees a grey rectangle. What are the three most likely causes to
check, and how do you distinguish them?

*Answer:* (1) **Multichannel AAC append rejection** — check the browser console for
`audio SourceBuffer error. MediaSource readyState: ended` and `bufferAppendError`. Run a
real-Chrome Playwright probe, NOT bundled Chromium (which lacks H.264/AAC support and gives
false negatives). (2) **HEVC in MPEG-TS segments** — inspect the segment container with
`ffprobe seg_00000.ts`: if `codec_name=hevc` in a `.ts` file, this is the cause. The fix is
ensuring `hls_fmp4_hevc` is false unless the client truly supports it. (3) **Keyframe cadence**
— check how long after the grant the manifest appeared. If it took >12 seconds, the first
keyframe came too late. Look at ffmpeg's `-g` argument and segment timestamps.

---

**Q6.** The `reencodes_video()` method (`plan.rs:L145–153`) returns false for a copy-remux
and true for an EncodeH264 plan. Why does this distinction matter operationally?

*Answer:* The NAS has limited CPU. A copy-remux (changing only container/audio codec) barely
loads the CPU — it moves compressed bytes from one box to another with minimal computation.
A video re-encode drives libx264 or VAAPI at full speed. The concurrency system (`concurrency.rs`)
uses `reencodes_video()` to charge sessions against different caps: re-encodes against the
strict `MAX_CONCURRENT_CPU_TRANSCODES` (or VAAPI equivalent), while remuxes use the much
larger global cap. Without this distinction, a box with software-only encoding would allow only
ONE concurrent stream even when two users are watching files that only need a container change.
This was a real production 503 bug before the fix.

---

## 7. CODE-READING EXERCISE — Walking `plan_transcode()` from Input to Output

This exercise walks you through a single call to `plan_transcode()` in `plan.rs`.
The file is: MKV container / HEVC video / HDR10 / 1080p / EAC-3 5.1 audio / SRT subtitle.
The client caps are: `containers: ["mp4"], video_codecs: ["h264"], max_height: 1080, hdr: false`.

**Step 1: Direct-play gate (L267–271)**

```rust
let decision = decide(file, caps);
if decision.direct_play {
    return TranscodePlan::DirectPlay { reason: decision.reason };
}
```

Open `capability.rs`, `decide()`, line 129. Trace through:
- Container "matroska" → `container_supported` fails (client lists "mp4") → deny. Actually,
  `container_family("matroska")` returns "mkv" (L107). Client's "mp4" normalizes to "mp4".
  "mkv" ≠ "mp4" → `container_supported` returns false → `deny(format!("container…"))`.
  But WAIT — we then hit L146: "Matroska NEVER direct-plays, no matter what the client
  advertises." Even a `containers: ["mkv"]` client would be denied. Result: `direct_play: false`.

We do NOT return early; the plan continues.

**Step 2: Subtitle plan (L276)**

```rust
let (subtitle, burn_index) = plan_subtitle(file);
```

`plan_subtitle()` always returns `(SubtitleOp::None, None)`. The SRT subtitle is detected (it
is a text subtitle in `TEXT_SUBTITLE_CODECS`), a debug log is emitted, but the function still
returns None. `burn_index = None`.

**Step 3: Video op (L279–341)**

```rust
let video_codec = "hevc";
let codec_ok = contains_ci(&caps.video_codecs, "hevc"); // caps has only "h264" → false
```

`codec_ok` is false. We skip to the `else` branch immediately — video will be `EncodeH264`.

But let's see what WOULD happen if codec_ok were true (useful for understanding the full
logic):
- `profile_ok`: `video_profile_copy_safe("hevc", Some("main"))` → true ("main" is in the HEVC
  allowlist at L193)
- `hls_copy_deliverable`: HEVC → requires `caps.hls_fmp4_hevc` which is false here → `false`
- `needs_scale`: cap `max_height: 1080`, file `video_height: 1080` → `1080 > 1080` is false →
  no scale needed
- `tone_map`: `hdr_format = "HDR10"` → `is_hdr = true`; `caps.hdr = false` → `tone_map = true`

So even if the codec were accepted, `hls_copy_deliverable` is false AND `tone_map` is true →
still `EncodeH264`. The actual result: `VideoOp::EncodeH264 { scale_to_height: None, tone_map: true, burn_subtitle_index: None, source_height: Some(1080) }`.

**Step 4: Segment format (L346–350)**

```rust
let segment_format = if is_hevc && video == VideoOp::Copy {
    SegmentFormat::Fmp4
} else {
    SegmentFormat::MpegTs
};
```

`video` is `EncodeH264`, not `Copy` → `SegmentFormat::MpegTs`. The output is H.264, so
MPEG-TS is correct.

**Step 5: Audio op (L353, calls `plan_audio()`)**

In `plan_audio()` (L367–421):
- First audio track: EAC-3 5.1
- `codec = "eac3"`
- `codec_accepted = caps.audio_codecs.contains_ci("eac3")` → caps has only "aac" → `false`
- Since `codec_accepted` is false, fall to the `else` branch: `EncodeAac`
- `is_downmix`: `track.channels = Some(6)` → `6 > 2` → `true` → `bitrate_kbps = 256`

Result: `AudioOp::EncodeAac { bitrate_kbps: 256 }`.

**Final plan:**

```
TranscodePlan::Transcode {
    video: VideoOp::EncodeH264 { scale_to_height: None, tone_map: true, burn_subtitle_index: None, source_height: Some(1080) },
    audio: AudioOp::EncodeAac { bitrate_kbps: 256 },
    subtitle: SubtitleOp::None,
    segment_format: SegmentFormat::MpegTs,
    reason: "container matroska cannot progressive-play in browsers; remux required",
}
```

In plain English: ffmpeg will re-encode HEVC→H.264 with tonemapping (HDR→SDR), downmix
EAC-3 5.1 to stereo AAC at 256 kbps, ignore the subtitle, and deliver standard MPEG-TS
segments. The SRT subtitle is currently not shown; it will return via a future sidecar `.vtt`.

---

