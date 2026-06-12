
# SPA Video Players — Teaching Dossier

---

## 1. WHAT

The SPA has two overlapping video player components. `IptvPlayer` is the shared playback engine: it receives a "grant" (a token-bearing URL plus a delivery type) and wires up whichever browser technology is needed — a plain `<video src="...">` for progressive MP4, hls.js driving the browser's Media Source Extensions (MSE) for HLS streams, or mpegts.js also driving MSE for live IPTV. `MediaPlayer` is the local-media layer on top: it asks the backend for a grant (advertising what this specific browser can actually decode), manages heartbeats so the transcoder does not reap the session mid-watch, tracks playback position, and then hands the resulting `StreamGrant` straight into `IptvPlayer`. The two components share one rendering engine by design: IptvPlayer was already battle-tested for IPTV, so rather than building a second player, MediaPlayer reuses it and bolts on the extra lifecycle (heartbeat, stop, resume math) that local transcode sessions need.

---

## 2. WHY

**Why hls.js exists:**
A browser's `<video>` element can play a plain MP4 URL directly — you set `video.src = "movie.mp4"` and the browser fetches the whole file and decodes it natively. HLS is different: the server breaks the stream into small `.ts` or `.mp4` segments (e.g., `seg_00001.ts`, `seg_00002.ts`) and serves an `.m3u8` playlist that lists them. Browsers do not know how to follow an HLS playlist and stitch segments together — they only speak "give me one file." That gap is exactly what hls.js fills. hls.js is a JavaScript library that: (1) fetches and parses the `.m3u8` manifest, (2) downloads segments in order, (3) hands the raw bytes to the browser's Media Source Extensions API — a low-level pipeline that lets JS append raw audio/video chunks into a decoder buffer. The `<video>` element then plays the buffer hls.js keeps feeding it. Safari and iOS do this natively (they understand HLS themselves), so on those devices hls.js is skipped and `video.src = manifest.m3u8` works directly.

**Why probe real capabilities instead of assuming:**
The server has to decide — before a single byte of video is sent — whether this client can decode a given codec, container, channel count, or bit depth. Guessing wrong has hard consequences. If the server optimistically declares a client can decode HEVC but it cannot, the player shows a blank grey box. The classic false-positive that burned this app: `MediaSource.isTypeSupported('video/mp4; codecs="hev1..."')` returns `true` on some browsers even when they have no hardware HEVC decoder and will silently fail to render. `isTypeSupported` checks the MIME type string, not whether actual decoding hardware is present. The same trap with audio: `isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` returns `true` in Chrome even for 6-channel (5.1) AAC, but Chrome's MSE SourceBuffer rejects the actual 6-channel AAC append — audio fails, the fragment is never appended, and the player freezes at 0:00. The solution is `navigator.mediaCapabilities.decodingInfo()`, which is channel-count-aware and hardware-aware. The probe runs once per page load (cached via a singleton Promise), and the resulting `PlaybackCaps` object is sent to the backend with every playback grant request — the backend then picks the best delivery plan for that specific client.

**Why-chained:** `isTypeSupported` lies → silent grey box → need channel/codec-aware probe → `decodingInfo` is the only API that knows the truth → probe caps once, cache, send with every grant request → backend can HEVC-copy-remux or HDR-passthrough only when the client has proven it can decode them.

---

## 3. MAP

**Key files:**

- `src/components/player/IptvPlayer.tsx` — the shared playback engine. Lines 399–527 are the `setup()` async function that branches on `grant.delivery` and wires up the correct engine (progressive / hls.js MSE / mpegts.js). Lines 435–460: hls.js construction with the VOD vs. live configuration divergence. Lines 176–180: `selectHlsEngine()` — MSE wins over native HLS to avoid the Chrome canPlayType lie. Lines 269–318: `createFatalHlsErrorHandler()` — the documented media-error recovery ladder.

- `src/components/media/MediaPlayer.tsx` — the local-media wrapper. Lines 105–246 are the stateful `MediaPlayer`. Lines 128–152: `startPlaybackSession` effect — fetches the grant and starts heartbeating. Lines 181–201: `pagehide`/`visibilitychange` handlers that flush progress and stop the session on tab close. Lines 205–208: `useMemo` on `streamGrant` — keeps the same object reference so IptvPlayer's effect does not teardown and rebuild the HLS engine on every render.

- `src/components/media/playbackSession.ts` — framework-free session controller. Lines 45–113: `startPlaybackSession()` — calls `api.playback()`, sets up the heartbeat `setInterval`, and handles 404 (session reaped → `onSessionLost`). Lines 123–128: `playerStartPosition()` — only the progressive path gets a client-side seek; HLS resumes via server-baked `-ss`. Lines 137–152: `absoluteProgress()` — translates the HLS `<video>` element's timeline (which restarts near 0 for every resume) back to absolute title position.

- `src/lib/api/media.ts` — the thin fetch client. Lines 218–228: `browserCaps()` conservative fallback. Lines 255–385: the MediaCapabilities probe functions (`probeVideo`, `probeAudio`, `buildProbedCaps`). Lines 393–396: `probedCaps()` singleton. Lines 598–611: `mediaApi.playback()` — awaits `probedCaps()` and sends the result as the grant request body.

**Playback walkthrough (click to segments rendering):**

1. User clicks "Play" on a movie card. `MediaPlayer` mounts and its `useEffect` fires `startPlaybackSession`.
2. `startPlaybackSession` calls `mediaApi.playback('movie', id)`.
3. `mediaApi.playback` first awaits `probedCaps()` — this runs `buildProbedCaps()` which fires ~10 `decodingInfo()` probes in parallel (HEVC MSE, HEVC 4K, AV1, HDR10, 6-ch AAC, E-AC-3, AC-3). All results are cached.
4. The probed `PlaybackCaps` object (e.g. `{ video_codecs: ['h264','hevc'], hls_fmp4_hevc: true, aac_max_channels: 2, ... }`) is POSTed to `/api/media/playback/movie/{id}`.
5. The backend (Rust media-core + Hono proxy) decides the delivery plan: if the source file is HEVC and `hls_fmp4_hevc: true`, it copy-remuxes (no re-encode); if it is HEVC and the client cannot decode it, it re-encodes to H.264 via VAAPI. The response is a `PlaybackGrant` with `delivery: 'hls'`, a tokenised `url` pointing at the HLS manifest, plus `heartbeatUrl` and `stopUrl`.
6. `startPlaybackSession` stores the grant, sets `stopUrl`, and starts `setInterval` calling `api.heartbeat()` every 10 seconds.
7. `setGrant(grant)` renders `MediaPlayerView`, which renders `<IptvPlayer grant={streamGrant} vodHls autoPlay .../>`.
8. IptvPlayer's `setup()` runs. `grant.delivery === 'hls'`, so it dynamically imports `hls.js`. `selectHlsEngine` checks `Hls.isSupported()` (MSE available?) — on Chrome/Firefox this returns `true`, so engine is `'mse'`.
9. A new `Hls` instance is constructed with `startPosition: 0` and `liveMaxLatencyDurationCount: Infinity` (the `vodHls` path — prevents live-edge snap and catch-up seek).
10. `hls.loadSource(grant.url)` fetches the `.m3u8` manifest. `hls.attachMedia(video)` connects hls.js to the `<video>` element.
11. hls.js fetches `seg_00000.ts`, demuxes it, appends the H.264+AAC bytes to the MSE SourceBuffer. The `<video>` element's decoder begins rendering. `autoPlay` calls `video.play()`.
12. Every 10 seconds the heartbeat fires. If the user closes the modal, `session.dispose()` stops the heartbeat and POSTs to `stopUrl`, freeing the transcoder's concurrency slot immediately.

---

## 4. PREREQUISITES

**Media Source Extensions (MSE) — ELI5:**
Normally a browser's `<video>` element downloads a media file from a URL and manages everything internally. MSE is a browser API that gives JavaScript a "feeding hatch" into the decoder. You call `new MediaSource()`, get a URL pointing to it (`URL.createObjectURL(mediaSource)`), set that as `video.src`, then create a `SourceBuffer` (one for video, one for audio), and push raw binary chunks into it with `sourceBuffer.appendBuffer(data)`. The browser's decoder treats those chunks exactly as if it had downloaded them from a file. hls.js and mpegts.js both work by sitting between the network and these SourceBuffers: they download the real data, re-package it if needed, and feed it into the decoder chunk by chunk.

**Other prerequisites before this module:**
- How a `<video>` element works: `src`, `controls`, `currentTime`, `duration`, `play()`/`pause()`, `timeupdate` event.
- What HLS is: an Apple-invented streaming format where a `.m3u8` text file lists short video segment URLs, updated as the live stream grows.
- What a React `useRef` is and why it is used for DOM elements and mutable values that should not trigger re-renders.
- What React's `useEffect` cleanup function does (the `return () => { ... }` pattern) — critical here because every player teardown lives in cleanup.
- What a dynamic `import()` is (hls.js is loaded on demand, not in the initial bundle).
- CORS basics: the SPA on Netlify calls an API on a different domain; tokens in URLs replace cookies for cross-origin `<video>` elements.

---

## 5. GOTCHAS & WAR STORIES

**VOD-vs-live-edge seek bugs (commits ac09b40, b7dd248)**

The HLS transcoder serves local media as an HLS "EVENT" playlist — segments appear as they are transcoded, and the playlist grows until an `#EXT-X-ENDLIST` tag signals the title is done. hls.js sees a growing playlist and treats it as a live stream. That triggers two live-stream behaviors that are wrong for a finite movie:

1. **Live-edge start (ac09b40):** By default hls.js starts playback near the "live edge" — the most recently added segment. For a live TV channel that is exactly what you want. But a copy-remux runs at I/O speed, far faster than real-time. By the time the player attaches, the transcoder may have already written 30 minutes of a 2-hour movie into segments. hls.js snapped to that edge and the movie opened 30 minutes in. Fix: `startPosition: 0` in the hls.js config when `vodHls === true`. The resume offset is baked server-side into ffmpeg's `-ss` argument, so the session timeline always starts at position 0 from the player's perspective.

2. **Catch-up seek (b7dd248):** hls.js has a `liveMaxLatencyDurationCount` setting. When latency behind the live edge exceeds this cap, hls.js force-seeks the playhead toward the edge. For a copy-remux this means: the transcoder is writing segments 20 minutes ahead of where the viewer is watching; once the gap exceeds the cap, hls.js jumps the playhead forward mid-watch (observed: `0:00 → 7:48` jump during normal viewing). Fix: `liveMaxLatencyDurationCount: Infinity` for VOD — disables the forced catch-up seek entirely. IPTV keeps `liveMaxLatencyDurationCount: 16` so it still auto-heals from late-joining a live channel.

**The 6-channel AAC MSE append rejection (grey box)**

This was the most deceptive bug. Symptom: certain episodes (e.g., American Dad! with EAC3 5.1 audio transcoded to AAC) showed a grey box immediately. Every server-side check looked green — the transcoder produced valid H.264+AAC HLS segments, the manifest returned 200, ffprobe confirmed 6-channel AAC audio in the segments.

The actual cause: Chrome and Firefox's MSE `SourceBuffer` silently rejects appends of 6-channel (5.1) AAC audio. The fragment append fails, hls.js emits `MEDIA_ERROR`, and the player freezes at 0:00. The treacherous detail: `MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` returns `true` in Chrome even for 6-channel audio — it does not check channel count. So the "is this format supported?" check passed, but the actual `appendBuffer()` call failed. Verified only by running a real Chrome (not Chromium, which lacks H.264/AAC) via Playwright and checking `bufferAppendError` in the console.

Fix — two parts:
1. Server side: transcode audio to stereo (`-ac 2`) when the client advertises `aac_max_channels: 2`. Only pass through multi-channel AAC when `aac_max_channels: 6`.
2. Probe side: `buildProbedCaps` explicitly probes 6-channel AAC via `decodingInfo` with `channels: '6'` and `type: 'media-source'`. On Chrome this returns `false`, correctly advertising `aac_max_channels: 2`. On Safari/Edge with native 5.1 MSE support it returns `true`.

The lesson: "manifest 200 + valid segment ffprobe does not equal plays." Verify the browser MSE append in a real browser.

**Never client-seek HLS resume**

When a user resumes a movie 42 minutes in, the naive approach is: start HLS from the beginning and call `video.currentTime = 2520` when metadata loads. This is wrong for HLS. The HLS window starts at 0 (the first segment the transcoder emitted for this session). Seeking into a timestamp that has no corresponding segment stalls the player indefinitely. The correct approach: send `start_secs: 2520` to the backend; ffmpeg starts with `-ss 2520`, the session timeline begins near 0. `playerStartPosition()` enforces this — it returns `undefined` (no seek) for HLS and only returns the offset for `'progressive'` direct-play. This was the de9411c regression: a concurrent-session fix introduced a client-side seek on HLS, causing all resuming titles to stall at a spinner.

**The Chrome canPlayType HLS lie**

`video.canPlayType('application/vnd.apple.mpegurl')` started returning `'maybe'` in some Chrome versions even though Chrome cannot actually play HLS natively (it silently fails with `MEDIA_ERR_SRC_NOT_SUPPORTED`). `selectHlsEngine()` therefore checks MSE availability first: if `Hls.isSupported()` is `true`, use hls.js — never trust `canPlayType` first. Native HLS is a fallback only for browsers that have no MSE at all (iOS Safari).

---

## 6. QUIZ BANK

**Q1.** A user reports that when they play a movie, playback starts at the 12-minute mark instead of the beginning. The movie has no resume point saved. What is the likely cause, and what does the fix look like?

**A1.** hls.js `startPosition` defaults to the live edge of the growing HLS EVENT playlist. A copy-remux writes segments much faster than real-time, so by the time hls.js attaches, the "live edge" is 12 minutes into the title. Fix: set `startPosition: 0` in the hls.js config when `vodHls === true` (commit ac09b40). The `vodHls` prop on `IptvPlayer` activates this path, as wired by `MediaPlayer` which always passes `vodHls` to `IptvPlayer`.

**Q2.** A user watches a movie with 5.1 surround sound. The backend confirms it transcoded the audio to AAC. The network tab shows HTTP 200 on all segments. Yet the player shows a grey box and never plays. What is happening and where is the fix?

**A2.** Chrome's MSE SourceBuffer rejects 6-channel AAC appends even though `isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` returns `true`. hls.js emits a fatal `MEDIA_ERROR` and the player freezes. The fix: `buildProbedCaps` (in `media.ts`) probes 6-channel AAC via `decodingInfo` with `type: 'media-source'` — on Chrome this returns `false`, so `aac_max_channels: 2` is advertised to the backend. The backend then re-encodes audio to stereo (`-ac 2`).

**Q3.** Suppose you removed the `useMemo` wrapping `streamGrant` in `MediaPlayer.tsx` and instead wrote `streamGrant = grant ? { url: grant.url, delivery: grant.delivery } : null` as an inline expression. What breaks and why?

**A3.** Every re-render of `MediaPlayer` would create a new object literal. `IptvPlayer`'s `useEffect` depends on `grant` — a new object reference (even with identical values) looks like a changed prop to React and triggers the effect cleanup and re-run. That tears down and rebuilds the hls.js engine on every render: the current segment position is lost, a new manifest fetch fires, and playback restarts from the beginning. `useMemo` keeps the same object reference as long as `grant.url` and `grant.delivery` are unchanged.

**Q4.** The heartbeat interval is 10 seconds and the transcoder's idle reaper fires after 30 seconds. A user's laptop sleeps for 25 seconds mid-movie. When they wake up, what happens? What if the laptop slept for 45 seconds?

**A4.** At 25 seconds: at most 2 heartbeat beats were missed. The session is still alive (reaper threshold is 30s). The next heartbeat returns a non-404 status; the stall watchdog may call `startLoad()` if the playhead stalled, and playback continues. At 45 seconds: the transcoder reaped the session. The next heartbeat returns 404. `startPlaybackSession` calls `handlers.onSessionLost()`, which clears the grant and surfaces "Playback session expired" with a "Play again" button. Re-granting restarts the transcoder at the saved resume point.

**Q5.** Why does `playerStartPosition()` return `undefined` for HLS delivery and only return the resume offset for `'progressive'`? What goes wrong if you pass the resume offset as a client-side seek for HLS?

**A5.** For HLS, the resume offset is baked server-side into ffmpeg as `-ss start_secs`, so the HLS session timeline always starts near 0. If you also seek `video.currentTime = resumeOffset` client-side, you are seeking into a timestamp that has no corresponding segment in the HLS window (which starts at 0, not `resumeOffset`). The player stalls indefinitely waiting for segments that will never arrive. For progressive MP4 the whole file timeline is available and `video.currentTime = resumeOffset` is a normal seek.

**Q6.** A new developer wants to add AV1 codec support. The `probeVideo` call for AV1 uses `type: 'file'` rather than `type: 'media-source'`. What does this mean, and what additional probe would be needed before advertising AV1 in HLS fMP4 segments?

**A6.** `type: 'file'` checks progressive playback (the browser decoding a standalone MP4 file). `type: 'media-source'` checks MSE SourceBuffer append capability — different browsers have different gaps here. An AV1 `type: 'file'` probe being `true` does not guarantee AV1 can be appended via MSE. Before setting an `hls_fmp4_av1: true` flag, a separate `probeVideo('video/mp4; codecs="av01..."', { type: 'media-source' })` probe is needed. Without it, the backend might serve AV1 HLS segments to a browser that cannot MSE-append them, producing the same grey-box failure as the 6-channel AAC bug.

---

## 7. CODE-READING EXERCISE

**File:** `src/components/player/IptvPlayer.tsx`
**Goal:** trace what happens when `vodHls` is `true` and hls.js attaches to a transcoded movie

**Step 1.** Find the `setup()` function (line 399). Notice it is `async` and lives inside a `useEffect`. Identify the three branches: `progressive` (line 404), `hls` (line 411), and the mpegts fallback (line 529). What data in `grant` controls which branch runs?

**Step 2.** Inside the `hls` branch, find `selectHlsEngine` (line 415). Read `selectHlsEngine` at line 176. The first argument is `Hls.isSupported()` — this tests the presence of `MediaSource` in `window`, not a codec string. Why does MSE-first beat native-HLS-first on Chrome?

**Step 3.** Find the `Hls` constructor (line 435). Notice the spread at lines 457–459:
```ts
...(vodHls
  ? { startPosition: 0, liveMaxLatencyDurationCount: Infinity }
  : { liveMaxLatencyDurationCount: 16 })
```
Read the comment above it (lines 444–460). In your own words, what is the difference between a copy-remux at I/O speed and a real live channel, and why does each need different latency settings?

**Step 4.** Find `hls.loadSource(grant.url)` (line 514) and `hls.attachMedia(video)` (line 515). Which one tells hls.js "here is the manifest to parse" and which gives it the decoder target? Does the order matter?

**Step 5.** Find `cleanupEngine` (lines 516–524). This closure runs when the `useEffect` cleanup fires (line 669, when the modal closes). Trace: React runs cleanup → `cancelled = true` → `cleanupEngine()` → stall watchdog listeners removed → `hls.destroy()`. What does `hls.destroy()` do to the SourceBuffers and the ongoing segment fetches?

**Step 6.** Read `createFatalHlsErrorHandler` (lines 269–318). Identify the three-step media error ladder: `recoverMediaError()`, then `swapAudioCodec() + recoverMediaError()`, then `setError + destroy`. The `MEDIA_RECOVERY_WINDOW_MS = 3000` guard resets `mediaRecoverStep` when errors are spaced more than 3 seconds apart. Why is this reset necessary? What would happen to a long session with occasional transient glitches if the step counter never reset?

**Checkpoint questions (answer before looking at the code):**
1. If `grant.delivery` is `'hls'` but `Hls.isSupported()` is `false` and `video.canPlayType('application/vnd.apple.mpegurl')` returns `''` (empty string), what does the user see?
2. Why is the `cancelled` flag checked at the start of the mpegts `recover()` function (line 591)?
3. `safePlay` (line 102) catches the Promise rejection from `video.play()`. When does `video.play()` reject in a real browser?

---

