
# Teaching Dossier — Backend Media Playback Routes

**Scope:** The Node/Hono layer that grants playback, proxies HLS, and manages
session lifecycle. Rust internals (media-core, transcoder) belong to sibling
agents.

---

## 1. WHAT

When a user presses Play on a movie or TV episode in the web app, the browser
does not talk directly to the media storage or the transcoder. Instead, the
Hono/TypeScript backend acts as a **trusted middleman**. The browser sends one
authenticated POST (the "grant"), the backend decides — by asking the media-core
Rust service — whether the file can be delivered as-is ("direct play") or needs
to be re-encoded on the fly ("transcode"). If transcoding is needed, the backend
waits until the transcoder produces its first video segment, then hands the
browser a signed URL it can use to pull an HLS (HTTP Live Streaming) playlist
and its individual video chunks. Every request for a chunk goes back through the
backend too, which quietly swaps in an internal authentication credential before
forwarding the request to the transcoder. To the browser, there is one uniform
`/api/media` and `/api/transcode` surface; the multi-service plumbing behind it
is invisible.

---

## 2. WHY

**Why a grant step?**

A browser's `<video>` element has very different decoding abilities depending on
the device and browser version. A 4K HEVC movie with HDR plays fine in Safari on
an Apple TV but is completely undecodable by Chrome on a mid-range laptop.
Without a grant step, the server would have to either always transcode everything
(slow, wasteful) or always send the raw file (broken on half of devices). The
grant lets the client advertise exactly what it can decode (containers, codecs,
max resolution, HDR support), and the media-core Rust service applies that
capability matrix to the actual file's codec/resolution/container to decide the
cheapest delivery path.

**Why proxy HLS instead of exposing the transcoder directly?**

Three interlocking reasons:

1. **Authentication without cookies.** A browser's `<video>` element and hls.js
   make dozens of HTTP requests for each video segment. These are "no-cors" media
   requests that cannot carry a session cookie. The backend solves this by minting
   a short-lived, URL-bound stream token (`?t=`) at grant time and rewriting
   every segment line in the HLS manifest to carry it. The transcoder itself never
   sees session cookies; it only sees the backend's internal-principal JWT, which
   the backend mints per-request.

2. **Internal service isolation.** The transcoder runs on the same Docker network
   as media-core and is not exposed to the internet. Cloudflare Tunnel terminates
   at the backend. Exposing the transcoder's port publicly would bypass the entire
   auth stack.

3. **Manifest rewrite.** hls.js resolves segment URIs relative to the manifest URL
   and drops the manifest's query string, so a token baked into the manifest URL
   does NOT automatically reach every segment fetch. The backend's transcode proxy
   buffers the small `.m3u8` playlist text and rewrites every segment line to
   append `?t=<token>` before the browser ever sees it.

---

## 3. MAP

### Key files

| Path | What it does |
|------|-------------|
| `server/routes/media.ts:126` | `POST /api/media/playback/:kind/:id` — the grant endpoint |
| `server/routes/media.ts:249` | READY_POLLS loop — waits for the transcoder's first segment before responding |
| `server/routes/media.ts:298` | Catch-all proxy to media-core for direct-play `/stream` bytes |
| `server/routes/transcode.ts:77` | Catch-all proxy for HLS manifest + segments |
| `server/routes/transcode.ts:140` | Manifest rewrite — appends `?t=` to every segment line |
| `server/routes/transcode.ts:165` | `appendTokenToManifest()` — exported for unit tests |
| `server/services/mediaStreamToken.ts:27` | `MEDIA_DIRECT_KIND` = `'vod'`, `MEDIA_HLS_KIND` = `'remux'` |
| `server/services/mediaStreamToken.ts:41` | `signMediaToken()` — wraps the shared IPTV token signer |
| `server/services/upstream.ts:24` | `fetchWithTimeout` — buffers the whole body, enforces a total-transfer deadline (used for JSON control-plane calls) |
| `server/services/upstream.ts:81` | `fetchStreamWithConnectTimeout` — only bounds TTFB, streams body straight through (used for video bytes) |
| `server/services/internalPrincipal.ts` | `mintInternalPrincipal()` — mints a 60s JWE the Rust services enforce |
| `server/app.ts:203` | `if (env.useMediaCore)` guard — both routes are only mounted when `USE_MEDIA_CORE=1` |

### "Press Play Direct" walkthrough

1. **SPA probes capabilities.** Before calling the grant endpoint, the SPA runs
   `MediaCapabilities.decodingInfo()` for each codec/container combination and
   builds a `caps` object — what containers it supports, which video codecs, max
   resolution, whether it can handle HDR and HEVC in fMP4 segments.

2. **POST /api/media/playback/movie/42** with the caps JSON in the body.
   - `mediaAuth` middleware fires. The request has a session cookie (not a `?t=`
     token), so it falls through to `requireAuth` and attaches the session.
   - The route reads and validates the caps, applying `DEFAULT_CAPS` for any
     missing fields (conservative: mp4/h264 only, no HDR).
   - `principalHeader(session)` mints a 60s internal-principal JWE.

3. **Step 1: capability grant.** The backend POSTs to
   `http://media-core/api/media/play/movie/42/grant` with the caps and the JWE.
   `fetchWithTimeout` (15s total-transfer deadline) is used because this is a
   small JSON control-plane response, not a byte stream. media-core consults its
   SQLite library DB and returns `{ directPlay: true/false, file: { duration_secs } }`.

4. **If `directPlay: true`:** The backend signs a `vod`-kind stream token bound to
   `media:movie:42`, returns `{ delivery: 'progressive', url: '/api/media/stream/movie/42?t=<tok>' }`.
   The SPA feeds that URL directly to a `<video src=...>` element.

   - Any subsequent byte-range request from `<video>` hits the catch-all at
     `media.ts:298`, which re-mints an internal principal and proxies the range
     request to media-core via `fetchStreamWithConnectTimeout` (TTFB-only timeout
     so a 2GB file can stream for hours without a deadline abort).

5. **If `directPlay: false` (transcode needed):**
   - **Step 2: start session.** The backend GETs
     `http://media-core/api/media/stream/movie/42?containers=mp4&video_codecs=h264&...`
     (the caps and optional `start_secs` as query params). media-core starts the
     transcoder and returns `{ sessionId, manifestUrl, heartbeatUrl }`.
   - **READY_POLLS loop** (`media.ts:249`): The backend polls the transcoder at
     `http://transcoder/<manifestUrl>` every 500ms up to a 12-second wall-clock
     deadline, checking the manifest text for a `.ts` or `.m4s` segment line.
     Only when a segment appears (meaning ffmpeg has written its first chunk) does
     the loop exit.
   - The backend signs a `remux`-kind token bound to `media:session:<sid>`,
     rewrites the manifest URL, heartbeatUrl, and a derived `stopUrl` to append
     `?t=<tok>`, returns `{ delivery: 'hls', url, heartbeatUrl, stopUrl, durationSecs }`.

6. **hls.js fetches the manifest.** `GET /api/transcode/session/<sid>/index.m3u8?t=<tok>`.
   - `transcodeAuth` validates the `remux` token against `media:session:<sid>`.
   - The catch-all proxy forwards to `http://transcoder/api/transcode/session/<sid>/index.m3u8`.
   - Because the path ends `.m3u8` and a token is present, the proxy buffers the
     manifest text and calls `appendTokenToManifest(text, token)`, rewriting every
     segment line (e.g. `seg_00000.ts` → `seg_00000.ts?t=<tok>`) and the
     `#EXT-X-MAP` init segment URI for fMP4 sessions.
   - The rewritten manifest is returned. hls.js now has token-stamped segment URLs.

7. **Segments.** hls.js GETs `/api/transcode/session/<sid>/seg_00000.ts?t=<tok>`.
   - Same `transcodeAuth` validates token.
   - Path does NOT end `.m3u8`, so no buffering — `fetchStreamWithConnectTimeout`
     pipes the bytes straight through. The TTFB timeout covers the connect; the
     body streams uninterrupted.

8. **Heartbeats.** The SPA POSTs to `heartbeatUrl` (e.g.
   `/api/transcode/session/<sid>/heartbeat?t=<tok>`) every ~10s. The transcoder
   uses heartbeat absence to trigger its 30s idle reaper — without heartbeats,
   an abandoned session frees its concurrency slot.

9. **Stop.** When the user closes the player, the SPA POSTs to `stopUrl`
   (`/api/transcode/session/<sid>/stop?t=<tok>`). The transcoder kills ffmpeg
   immediately, freeing the concurrency permit (CPU slot or GPU slot) right away
   instead of waiting 30s.

---

## 4. PREREQUISITES

A student needs to understand these fundamentals before this material will land:

**HTTP & REST basics**
- HTTP methods (GET, POST), status codes (200, 401, 503, 504), request headers,
  query parameters, response body.
- What a "proxy" is: a server that forwards requests to another server on your
  behalf.

**Browser video fundamentals**
- What a `<video src=...>` element does: the browser makes byte-range requests
  (HTTP 206 Partial Content) for the video file.
- What HLS (HTTP Live Streaming) is: instead of one giant file, the server
  produces a text playlist (`.m3u8`) listing short video chunks (`.ts` or `.m4s`),
  which the player fetches sequentially. Enables adaptive bitrate and live
  streaming.
- Why hls.js exists: Safari understands HLS natively, but Chrome/Firefox need a
  JavaScript library to decode the HLS playlist and feed chunks to the
  MediaSource Extensions (MSE) API.

**Authentication concepts**
- Session cookies: set by the server on login, sent automatically by the browser
  on every same-origin request.
- Why cookies fail for cross-origin media: "no-cors" fetches (used by `<video>`)
  strip credentials. A query-parameter token (`?t=`) is the standard workaround.
- JWT / signed tokens: a blob of JSON claims plus a cryptographic signature.
  The server can verify it without database lookup.

**TypeScript / Node basics**
- `async/await` and `Promise`.
- What Hono is: a lightweight HTTP framework for Node.js/Cloudflare Workers,
  analogous to Express. `app.post('/path', handler)` registers a route.

**Docker networking**
- Services on the same Docker Compose network reach each other by service name
  (e.g. `http://media-core:8080`). They are NOT reachable from the public internet.

---

## 5. GOTCHAS & WAR STORIES

### The grey-box 503 — READY_POLLS exhausted before the first segment

**Symptom:** User presses play, the player shows a grey rectangle, network tab
shows the grant POST returned 200 but then the manifest URL returned 503.

**Cause chain:**

- `media.ts:249` polls the transcoder manifest until it sees a `.ts` or `.m4s`
  segment line. The poll deadline is 12 seconds.
- If ffmpeg takes longer than 12 seconds to write its first segment (slow GPU
  init, large keyframe interval, inline subtitle burn-in holding the mux), the
  deadline expires and the backend returns the manifest URL to the SPA anyway.
- hls.js fetches the manifest, gets a 503 (transcoder not ready), and **does not
  retry a 503**. The player is permanently stuck.
- This is distinct from a network error: the grant POST succeeded (200), so the
  SPA thinks playback started.

**Fixes applied in this repo:**
- Keyframe cadence: added `-force_key_frames expr:gte(t,n_forced*N)` so HLS can
  cut a segment boundary within the first few seconds, not at a ~14s natural GOP.
- Inline subtitle removal: `-c:s webvtt` under `-re` held the first video segment
  9+ seconds; subtitle track moved to a sidecar, not burned in.
- Wall-clock deadline (replacing "24 × 500ms sleep"): the old code bounded only
  the sleep count — a slow-but-responding transcoder could still stretch the wait
  far beyond 12s.

**The signature to recognize it:** grant POST 200, then manifest 503, player
grey-boxes silently. Always check the actual ffmpeg command in the transcoder's
log, not just "is the process running."

---

### Heartbeat POST needs Origin header or the CSRF guard 403s it

The backend CSRF middleware checks `Origin` on all POST requests from cookie-
authenticated sessions. When writing integration tests or calling the heartbeat
from a non-browser context (e.g., `curl`, a test script), you must include an
`Origin` header matching the expected host, or the middleware returns 403 before
the route handler ever runs. This looks like an auth failure but is actually a
CSRF rejection. The SPA sends Origin automatically (it is a browser); non-browser
callers forget it.

---

### Grant and inspect must be one atomic call — the 30-second reap

The transcoder's idle reaper kills any session with no heartbeat for 30 seconds.
There is no "warm up" or "reserved" state between the moment media-core starts
ffmpeg and the moment the SPA begins feeding heartbeats.

If you split "start the session" and "verify the session is running" into two
separate requests with any delay between them, the session may be reaped in the
gap. In the real flow this is safe because the grant endpoint returns the
heartbeatUrl synchronously and the SPA starts posting heartbeats before the user
can do anything. In tests or scripts, always start and immediately heartbeat in
the same call sequence.

---

### Stream token kind mismatch

The `?t=` token for the direct-play `/stream` route is `kind: 'vod'` bound to
`media:movie:<id>`. The token for HLS manifest + segments is `kind: 'remux'`
bound to `media:session:<sid>`. These are validated strictly: a `vod` token
cannot authorize a `remux` path and vice versa. If you ever reuse a token from
one flow in the other, you get a 401 with `error: 'token_kind'`.

---

### `fetchWithTimeout` vs `fetchStreamWithConnectTimeout` — use the wrong one and things break

`fetchWithTimeout` buffers the entire response body before returning. Use it for
small JSON control-plane calls (the grant, the handoff, the readiness probe).
**Never** use it for video bytes — it would load the entire file into Node's heap
before the first byte reached the browser, and the 15-second total-transfer
deadline would cut any video longer than ~15 seconds worth of throughput.

`fetchStreamWithConnectTimeout` only bounds time-to-first-byte. The body is a
live stream that the route pipes straight through. Use it for `.ts` segments and
direct-play byte ranges.

---

## 6. QUIZ BANK

**Q1.** A user on a desktop Chrome browser (which cannot decode HEVC) tries to
play an HEVC movie. The grant endpoint is called with `video_codecs: ['h264']`.
Trace exactly what the backend does from grant POST through the first segment
reaching the browser. At what line in `media.ts` does the code branch to
transcode (instead of direct play)?

**A1.** `media.ts:198` — `if (grant.directPlay)` — evaluates to false (media-core
sees that the file's codec is HEVC but the client only supports h264). The
backend falls through to the transcode path at `media.ts:214`. It calls media-core
`GET /api/media/stream/movie/<id>?containers=mp4&video_codecs=h264&...`,
receives `{ sessionId, manifestUrl, heartbeatUrl }`, then enters the READY_POLLS
loop at `media.ts:252`, polling every 500ms until the manifest contains a `.ts`
segment line. Once ready (or up to 12s), it signs a `remux` token, rewrites
the URLs, and returns them to the browser. hls.js fetches the manifest via
`/api/transcode`, the proxy rewrites segment lines with `?t=`, and hls.js begins
fetching segments through the same proxy.

---

**Q2.** hls.js fetches `seg_00003.ts?t=<tok>` from the transcode proxy. The `?t=`
token was originally minted for `media:session:abc123`. The path is
`/api/transcode/session/abc123/seg_00003.ts`. Walk through `transcodeAuth` in
`transcode.ts:60`. What does it check, and what happens if the same token is
presented against `/api/transcode/session/xyz999/seg_00000.ts`?

**A2.** `transcodeAuth` extracts the session id from the path (`abc123`) and calls
`verifyMediaToken(token, { kinds: [MEDIA_HLS_KIND], rid: 'media:session:abc123' })`.
`verifyMediaToken` checks: valid signature + time window, `rid` starts with
`media:`, kind is `remux`, and `rid` matches exactly `media:session:abc123`.
If the same token is presented for session `xyz999`, the `rid` check fails
(`media:session:abc123 !== media:session:xyz999`) and the function returns
`{ ok: false, error: 'token_mismatch' }`, resulting in a 401. One token cannot
unlock another user's session.

---

**Q3.** Why does `appendTokenToManifest` need special handling for `#EXT-X-MAP`
lines, and what happens if that case is omitted?

**A3.** `#EXT-X-MAP` carries the fMP4 initialization segment (e.g., `URI="init.mp4"`).
The player fetches this init segment like any media resource — without the
session cookie and without the manifest's query string. If `appendTokenToManifest`
only rewrites plain URI lines and leaves `#EXT-X-MAP` alone, the init segment
request arrives at the proxy without a `?t=` token, `transcodeAuth` finds no
token (and no session cookie on a cross-origin media request), and the request
gets a 401. The player then cannot parse fMP4 segments at all, and the entire
session grey-boxes — HEVC copy-remux sessions (which use fMP4) would be
permanently broken in browsers.

---

**Q4.** The `DEFAULT_CAPS` object sets `aac_max_channels: 2`. A client sends a
grant with no `aac_max_channels` field. An episode has 5.1 surround EAC3 audio.
What delivery path results, and why would `aac_max_channels: 6` not help even if
Chrome reports it as supported?

**A4.** The missing field causes `DEFAULT_CAPS.aac_max_channels = 2` to be used
(`media.ts:141-144`). The transcoder is told the client supports max 2 AAC
channels, so it will downmix to stereo. Even if Chrome's `isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` returns true for 6-channel AAC, Chrome's MSE
implementation rejects the actual SourceBuffer append of 5.1 AAC data at runtime
(it ignores channels in `isTypeSupported`). The browser reports a
`bufferAppendError: audio SourceBuffer error` that kills the whole fragment and
leaves the player grey. The stereo downmix (`-ac 2`) in the transcoder prevents
this MSE-append failure from ever happening.

---

**Q5.** A test script sends `POST /api/media/playback/movie/1` with a valid session
cookie, no body, and no `Origin` header. The backend returns 200 with a grant.
The test then POSTs to the `heartbeatUrl` returned in the grant. What error does
the heartbeat POST receive, and why?

**A5.** The heartbeat POST gets a 403. The CSRF middleware (applied to all non-GET
routes on cookie-authenticated sessions) checks for an `Origin` header that matches
the expected host. The grant POST succeeded because the test included a session
cookie — but the heartbeat POST also uses a cookie (it was returned with the grant
response), and without `Origin` the CSRF guard fires before the route handler.
Fix: include `Origin: https://theemeraldexchange.com` (or whatever the configured
host is) in the heartbeat POST, or switch to a `?t=` token path (which bypasses
the CSRF guard because it authenticates via the token, not via cookie, and the
token path in `transcodeAuth` is handled before `requireAuth` is ever called).

---

## 7. CODE-READING EXERCISE

**File:** `/Users/cujo253/Documents/theemeraldexchange/server/routes/transcode.ts`

**Goal:** By the end of this exercise, you will be able to explain why a video
that works in Safari's native HLS player can fail in hls.js running in Chrome,
and how the transcode proxy prevents that failure.

**Step 1 — Read lines 1-23 (module header comment).**
In your own words: why does this proxy exist? What would happen if the browser
tried to fetch HLS segments directly from the transcoder's port?

**Step 2 — Read lines 60-73 (`transcodeAuth` function).**
Identify the two authentication branches. Which one is used when hls.js fetches
`seg_00001.ts`? Which one would be used if an admin wanted to list all active
sessions via a cookie-authenticated admin UI? Why are both branches set up to
go through the same catch-all proxy below?

**Step 3 — Read lines 77-156 (catch-all proxy handler).**
Focus on lines 119-156. Notice that the code has an `if` that checks
`token && r.ok && subpath.endsWith('.m3u8')`. What happens for a `.ts` segment
request vs a `.m3u8` manifest request? Why would buffering a `.ts` segment be a
bad idea?

**Step 4 — Read lines 165-183 (`appendTokenToManifest`).**
Trace what happens to each of these four manifest lines:
```
#EXTM3U
#EXT-X-MAP:URI="init.mp4"
seg_00000.m4s
#EXT-X-ENDLIST
```
What does the output look like? (Token = `abc123`)

**Step 5 — Connect the dots.**
A standard browser `<video src="...m3u8">` on Safari sends the session cookie
automatically and does not need a `?t=` token in the segment URLs. hls.js in
Chrome cannot send cookies on media fetches. Explain exactly what problem
`appendTokenToManifest` solves for hls.js, using the words "no-cors" and
"query parameter."

**Expected answers for Step 4:**
```
#EXTM3U                           ← unchanged (comment/tag)
#EXT-X-MAP:URI="init.mp4?t=abc123"   ← URI attribute rewritten
seg_00000.m4s?t=abc123           ← segment URI appended
#EXT-X-ENDLIST                   ← unchanged (tag)
```
