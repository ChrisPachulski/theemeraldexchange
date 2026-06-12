
# Sessions & Tokens — Teaching Dossier
## Scope: cookie sessions, per-request auth, stream tokens for media playback

---

## 1. WHAT

When you log into the Emerald Exchange web app (via Plex, a passkey, or Apple Sign-In), the server creates an encrypted **session cookie** called `eex.session` and places it in your browser. Every time your browser makes a normal API call — checking your library, loading recommendations, opening settings — it sends this cookie automatically and the server decrypts it to know who you are. The cookie contains your user ID, role (`admin` or `user`), and your Plex auth token, all encrypted so nobody who intercepts the cookie can read those values. However, when you actually *watch* a video, the `<video>` HTML element and the HLS.js player need to make dozens of requests to fetch media segments — and browser security rules block cookies on those cross-origin fetch requests. To solve that, when you hit "Play", the server mints a short-lived **stream token** (a signed blob of text) and bakes it directly into the video URL as a `?t=` query parameter. The video player carries its credential in the URL itself rather than in a cookie header, so every byte-range and segment fetch authenticates itself without needing cookie access. There is also a third credential — the **device token** — a long-lived encrypted bearer token for native Apple TV/iOS clients that cannot use browser cookies at all, but that is M2 scope and less central to today's web playback path.

---

## 2. WHY

**Why three credentials?**

The web browser enforces CORS (Cross-Origin Resource Sharing). The SPA is served from Netlify (`theemeraldexchange.com`) while the API and media streams come from `api.theemeraldexchange.com`. This cross-origin split breaks cookie auth for media in two ways:

1. **`<video src="…">` is a no-cors request.** The browser fetches media URLs using a "no-cors" internal request mode that *strips credentials* — no cookies are sent.
2. **Credentialed cross-origin fetches with `Range:` headers trigger CORS preflight.** An `XMLHttpRequest` or `fetch()` with `credentials: 'include'` and a `Range` header fires an `OPTIONS` preflight on every segment. For HLS, which fires potentially hundreds of segment requests per session, this doubles the network round-trips and introduces unacceptable latency.

**Why stream tokens solve it:**

A stream token is just a compact signed string. The server bakes it into the URL: `/api/media/stream/movie/7?t=<token>`. The `<video>` element or HLS.js fetches that URL — no special header needed. The server reads `?t=` from the query string, verifies the HMAC signature and time window, confirms the token's `rid` (resource ID) matches the exact movie or session being requested, and allows the fetch.

**Why the session cookie can't just be in the URL:**

Session cookies carry your Plex auth token inside the JWE. If that appeared in a URL it would land in server logs, browser history, and referer headers — a serious credential leak. Stream tokens contain *no secrets about you* — just your `sub` (user ID), the resource ID (`media:movie:7`), and an expiry — so URL exposure is safe.

**The causal chain:** login creates cookie → cookie authenticates the playback grant POST → grant POST signs a stream token → stream token authenticates every subsequent segment fetch.

---

## 3. MAP — Key Files & Login-to-Segment Walkthrough

### Key files

| File | Role |
|---|---|
| `server/session.ts` | `createSession` (JWE encrypt), `verifySession` (decrypt), `setSessionCookie`, `readSession` |
| `server/middleware/auth.ts` | `requireAuth` / `requireAdmin` — per-request gate; tries Bearer first, falls back to cookie |
| `server/middleware/deviceTokenAuth.ts` | `tryBearerAuth` — verifies `Authorization: Bearer` device token |
| `server/services/sessionGate.ts` | `reconcileSession` — recomputes role from env.admins + revalidates Plex membership |
| `server/services/mediaStreamToken.ts` | `signMediaToken` / `verifyMediaToken` — stream tokens for local media |
| `server/services/iptvStreamToken.ts` | `signStreamToken` / `verifyStreamToken` — base stream token machinery (HMAC, ULID, canonical JSON) |
| `server/services/tokenReplayCache.ts` | In-process jti replay cache — enforces single-use (`segment`) vs multi-use (`vod`, `remux`) |
| `server/routes/media.ts` | `POST /playback/:kind/:id` — the grant endpoint; `mediaAuth` middleware for `?t=` token gate |
| `crates/emerald-contracts/src/stream_token.rs` | Rust canonical HMAC-SHA256 signer — JS delegates here via N-API |

### Walkthrough: login → cookie → play button → segment fetch

**Step 1: Login**
User authenticates (Plex PIN, passkey, etc.). The auth handler calls `setSessionCookie(c, session)` in `server/session.ts`. This calls `createSession(payload)` which uses `jose`'s `EncryptJWT` with AES-256-GCM to encrypt `{ sub, username, role, plexAuthToken, ... }` into a compact JWE string. The cookie is set `HttpOnly; Secure; SameSite=None` (prod) with a 30-day `maxAge`. The browser stores it; no JS can read it.

**Step 2: Every regular API request**
`server/middleware/auth.ts` runs `loadReconciledSession(c)`. It first tries `tryBearerAuth(c)` — looks for an `Authorization: Bearer` header (device tokens). If none, it calls `readSession(c)` which reads the `eex.session` cookie, passes it to `verifySession(token)` which decrypts the JWE. If valid, it calls `reconcileSession(decoded)` to recompute role from current `env.admins` and periodically revalidate Plex membership. The result is stored in Hono's `c.set('session', ...)` for the downstream handler.

**Step 3: Play button pressed**
The SPA POSTs to `POST /api/media/playback/movie/7` with a JSON body containing the client's playback capabilities (which codecs, max resolution, etc.). This endpoint is protected by `mediaAuth` — since this is a `/playback/` path (not `/stream/`), `mediaAuth` falls through to `requireAuth`, which validates the session cookie as above.

**Step 4: Grant + stream token mint**
Inside `server/routes/media.ts:126`, the handler:
1. Calls `media-core`'s internal `/api/media/play/movie/7/grant` to decide if direct-play or transcode is needed.
2. If **direct-play**: calls `signMediaToken({ sub, rid: 'media:movie:7', kind: 'vod' })`. Returns `{ delivery: 'progressive', url: '/api/media/stream/movie/7?t=<token>' }`.
3. If **transcode needed**: starts a transcoder session, polls until the first segment exists (`/\.(?:ts|m4s)/` regex in the manifest body), then calls `signMediaToken({ sub, rid: 'media:session:<sid>', kind: 'remux' })`. Returns `{ delivery: 'hls', url: '/api/media/stream/session/<sid>/index.m3u8?t=<token>', stopUrl: ..., heartbeatUrl: ... }`.

`signMediaToken` calls `signStreamToken(env.streamTokenSecret, { kind, resourceId, sub, ttlSecs })` which builds the canonical claim JSON `{"exp":...,"iat":...,"jti":"<ULID>","k":"remux","nbf":...,"rid":"media:session:<sid>","sub":"plex:494190801","v":1}` and computes HMAC-SHA256 via the Rust crate, returning `base64url(claims).base64url(hmac)`.

**Step 5: Segment fetch**
HLS.js fetches `/api/media/stream/session/<sid>/index.m3u8?t=<token>`. The manifest comes back with segment lines like `seg_00000.ts?t=<same_token>` (the backend rewrites them). For each segment, the browser fires a plain HTTP GET — no cookie needed. The server's `mediaAuth` middleware matches the `/stream/` path, reads `?t=`, calls `verifyMediaToken(token, { kinds: ['remux'], rid: 'media:session:<sid>' })`:
- `verifyStreamToken` checks HMAC signature and time window (+30s nbf skew, -5s exp skew)
- `verifyMediaToken` checks the `rid` starts with `media:` and matches exactly
- `checkReplay` records the `jti` in the in-process map; `remux` is multi-use so subsequent segments with the same token are allowed

If everything passes, `c.set('session', sessionFromSub(v.sub))` synthesizes a minimal session and the request proceeds.

---

## 4. PREREQUISITES

### Cookies ELI5
A cookie is a small string the server sends to the browser in a `Set-Cookie` response header. The browser automatically attaches it to every subsequent request to the same domain using a `Cookie` header. `HttpOnly` means JavaScript cannot read it (`document.cookie` sees nothing) — only the browser kernel sends it. `Secure` means it only travels over HTTPS. `SameSite=None` is required for cross-site cookies (Netlify SPA → NAS API on a different origin).

### Why JWE (encrypted JWT) instead of a session table
A plain database session table stores a random ID; every request hits the database to look it up. JWE is *stateless*: the entire session payload (user ID, role, Plex token) is encrypted into the cookie itself. The server just decrypts it — no database round-trip. The cost: you cannot invalidate one session without rotating the entire `SESSION_SECRET` (which logs everyone out). For a single-household app that's acceptable.

### Signed tokens (HMAC) ELI5
HMAC-SHA256 is a one-way "fingerprint" that requires a secret key. To sign: compute `HMAC(secret, message)` and append it to the message. To verify: recompute `HMAC(secret, message)` and compare. Without the secret you cannot forge a valid token — if even one character changes, the HMAC won't match. Stream tokens use this: the token is `base64url(claims_json).base64url(hmac)`. The server holds `STREAM_TOKEN_SECRET`; the browser only ever sees the signed token, never the secret.

### Key separation
The session cookie uses `SESSION_SECRET` (JWE, AES-256-GCM). Stream tokens use `STREAM_TOKEN_SECRET` (HMAC-SHA256). These are different secrets on purpose — a leaked stream token cannot be used to forge a session cookie and vice versa. The code explicitly comments on this at `server/services/iptvStreamToken.ts`: "key separation, §5.4."

---

## 5. GOTCHAS & WAR STORIES

**`k:remux` is a TOKEN KIND, not a transcode plan.**
In `StreamClaims`, the field `k` (kind) can be `'remux'`. This means "this token grants access to a multi-use HLS session (manifest + all its segments)." It does NOT mean the video is being remuxed without re-encoding. A 10-bit HEVC source with EAC3 5.1 audio will re-encode the video through VAAPI H.264 and downmix the audio to stereo AAC — but the token still carries `k:'remux'`. To know the actual transcode plan, read the live ffmpeg command line on the NAS. Confusing the token kind with the transcode plan cost real debugging time.

**Minting test cookies requires an `Origin` header.**
The backend's CSRF guard rejects session-setting POSTs from clients that don't send an `Origin` header matching the allowed list. When writing test scripts that POST to `/api/auth/...` to mint a session, you must include `Origin: https://theemeraldexchange.com` (or the local dev origin). Without it you get a 403. Test scripts that omit the header silently fail authentication. The test recipe: `tsx server/session.ts` equivalent via `docker exec` to call `createSession({sub:'plex:494190801',role:'admin'})` with an Origin header.

**Bundled Chromium is H.264-blind — use real Chrome for playback tests.**
Playwright's bundled Chromium ships without proprietary codecs. `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')` returns `false`. HLS.js silently refuses to append segments and the `<video>` element stays grey. Always use `channel: 'chrome'` (system Chrome) in Playwright media tests. Using bundled Chromium produced false negatives that looked like server-side auth failures.

**5.1 AAC MSE append is rejected by Chrome/Firefox.**
Even though `isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` returns `true`, Chrome and Firefox's MSE implementation rejects a 6-channel AAC `SourceBuffer` append. The player stalls at 0:00 with `bufferAppendError: audio SourceBuffer error`. The symptom is identical to a stream token failure — always check browser DevTools MSE errors before assuming the server returned bad auth. The fix is `-ac 2` stereo downmix on all AAC re-encodes.

**`-re` transcoder sessions run forever unless explicitly stopped.**
The transcoder uses `-re` (real-time input rate). A session started with `-re` will not exit until the video's duration has elapsed OR a POST to the `stopUrl` is made. Abandoned sessions pile up, contend for the GPU concurrency slot, and cause spurious 503s on the next play attempt. After any debugging session involving transcoder requests, restart the transcoder container to drain orphaned sessions.

**Bearer auth beats cookie auth — a revoked device token cannot fall through.**
In `server/middleware/auth.ts`, `loadReconciledSession` tries Bearer first. If a `Bearer` header is present but invalid (expired, revoked), the middleware returns 401 immediately and does NOT fall through to try the cookie. If you have a stale `Authorization` header in your HTTP client alongside a valid cookie, the stale Bearer wins and you get 401.

---

## 6. QUIZ BANK

**Q1.** A user logs in and starts watching a movie. The player works for 6 hours but then the video stops loading with an auth error. `STREAM_TOKEN_SECRET` has not changed. What is the most likely cause, and what would fix it?

**A1.** Stream tokens have a TTL (`MEDIA_STREAM_TOKEN_TTL_SECS`, default 6 hours in the env). After 6 hours the token's `exp` claim is in the past and `verifyStreamToken` throws `expired_token`. The fix: the client must call `POST /api/media/playback/:kind/:id` again to get a fresh token — the grant endpoint requires only the *session cookie* to be valid (30-day TTL), so if the user's cookie is still live, re-requesting a grant re-mints a new stream token without requiring re-login.

**Q2.** You're adding a new API endpoint `/api/media/subtitles/:id` that the SPA fetches with `fetch(..., { credentials: 'include' })`. Do you need a stream token or is the session cookie enough? Why?

**A2.** The session cookie is enough. `credentials: 'include'` instructs the browser to send cookies on cross-origin requests. Subtitles are fetched as a controlled `fetch()` call with a CORS preflight — not a `<video>` element no-cors load. The session cookie rides in the `Cookie` header and `requireAuth` decrypts it as normal. Stream tokens are only needed for contexts where cookies cannot be sent.

**Q3.** `signMediaToken` is called twice in the playback grant handler. What are the two different token `kind` and `rid` values, and why are they different?

**A3.** (1) Direct-play path: `kind: 'vod'`, `rid: 'media:movie:7'` — the token is bound to the specific library title. (2) Transcode path: `kind: 'remux'`, `rid: 'media:session:<sid>'` — the token is bound to the transcoder session ID. The difference matters because the `remux` token must authorize an entire HLS session (manifest + every segment), all identified by the session ID. Using a title-bound `vod` token for HLS would fail: when the manifest's segment lines are rewritten with `?t=<token>`, `verifyMediaToken` would check `rid: 'media:movie:7'` against the stream path `/stream/session/<sid>/seg_00000.ts` and reject it as `token_mismatch`.

**Q4.** An operator rotates `SESSION_SECRET` in the compose file and redeploys. What happens to (a) users with active session cookies, (b) stream tokens for currently-playing videos, (c) device tokens on Apple TV clients?

**A4.** (a) All session cookies become unverifiable — `verifySession` fails to decrypt them — so every user is logged out on their next request. (b) Stream tokens are HMAC-signed with `STREAM_TOKEN_SECRET`, not `SESSION_SECRET` — rotating the session secret does NOT invalidate stream tokens. Any in-flight video keeps playing until its own stream token TTL expires. (c) Device tokens use `DEVICE_TOKEN_SECRET`, also independent — Apple TV clients are unaffected.

**Q5.** The replay cache for `segment` tokens is an in-process JavaScript `Map`. If the backend restarts, the replay cache is empty. Is this a security problem?

**A5.** It is an accepted trade-off. Segment tokens have a 60-second TTL. A restart clears the cache, so a `segment` token presented before the restart *could* be replayed after the restart within the same 60-second window. `tokenReplayCache.ts` documents this: "On process restart the cache is empty; this is accepted for short-TTL segment tokens (60s)." For a single-household homelab the window is tolerable. A production mitigation would be a Redis-backed replay cache that survives restarts.

**Q6.** The `reconcileSession` function is called on every authenticated API request. What two things does it do that a simple "decrypt-and-trust" would not?

**A6.** (1) It recomputes `role` from the current `env.admins` list on every request. If an admin is added or removed from the environment variable and the backend redeploys, the role change takes effect on the user's next API call — no re-login required. (2) It periodically re-validates Plex server membership against plex.tv using the stored Plex auth token in the cookie. A user whose Plex share was revoked loses access within `REVALIDATE_TTL_MS`, not after the 30-day cookie expiry.

---

## 7. CODE-READING EXERCISE

**File: `server/services/iptvStreamToken.ts`**

This is the foundation all stream tokens build on. Read it in four passes.

**Pass 1 — The shape of a token (`StreamClaims` interface, near the top)**

Look at the field names: `exp`, `iat`, `jti`, `k`, `nbf`, `rid`, `sub`, `v`. Notice they are short — this is intentional: the token lives in a URL query parameter, so every byte matters. `jti` is a ULID (Universally Unique Lexicographically Sortable Identifier). `v: 1` is the contract version. `rid` is the resource identifier that binds this token to a specific resource (e.g., `media:movie:7` or `media:session:<sid>`).

*Question to answer before continuing:* Which field tells the server what *type* of access this token grants (live TV, VOD, HLS session)?

**Pass 2 — Canonical serialization (the `canonicalBytes` function)**

The HMAC is computed over `canonicalBytes(claims)`, which builds a JSON string with keys in **alphabetical order**, no whitespace. Find the literal template string in the function body. Notice that integer values are bare decimals (no quotes), and the key order is hard-coded. Why does this matter? Because `JSON.stringify(obj)` in JavaScript does not guarantee key order. If two systems (JS and Rust) compute the HMAC over different serializations of the same data, the signatures will never match. The fixed template is the cross-language contract.

*Question:* If you added a new claim field `foo: "bar"` to the `StreamClaims` type but did NOT add it to the `canonicalBytes` template, what would happen at verification time when the Rust crate receives a token minted by the old JS code?

**Pass 3 — Sign and verify delegation**

Both `signStreamToken` and `verifyStreamToken` call `contracts.streamTokenSign(...)` and `contracts.streamTokenVerify(...)`. These `contracts` calls go to the Rust N-API crate (`@emerald/contracts-napi`). By making both sides call the same Rust implementation, the cross-language contract is enforced at runtime — the JS and Rust paths cannot drift.

`verifyStreamToken` calls `streamTokenVerify` first (signature check), then `streamTokenEnforceTimeWindow` separately. Why two calls? Because signature validity and time validity are independent. A token can have a valid HMAC but be expired (`exp < now`). Separating them lets the crate enforce time checks with configurable skew (±30s nbf tolerance, ±5s exp tolerance) as a distinct step that could be overridden in tests.

*Question:* Look at `rethrowAsLegacy`. What error string does an HMAC mismatch produce to the caller? Why is it deliberately opaque rather than saying "HMAC mismatch"?

**Pass 4 — `verifyStreamTokenDualKey` (at the bottom)**

This function accepts `primarySecret` and `fallbackSecret` and "computes both HMACs unconditionally" for timing-attack resistance. When would you use this in production? Answer: during a `STREAM_TOKEN_SECRET` rotation. Deploy with `primarySecret = newSecret, fallbackSecret = oldSecret` — new tokens use the new secret, but tokens minted with the old secret (still within their TTL) still verify. Once the longest token TTL drains (typically 6 hours), remove the fallback. The comment notes no production verify site uses this today.

**Final synthesis question:**
A client presents a `segment`-kind token for the first time, the replay cache records it. One millisecond later the same client presents the same token again (e.g., due to a network retry). Trace which line in `checkReplay` catches the second presentation and what `ReplayCheckResult` is returned. Then: how would the client recover from this error?

*(Answer: `checkReplay` calls `cache.get(jti)` on the second call and finds an existing entry with `singleUse: true`. The condition `if (singleUse)` returns `{ allowed: false, reason: 'token_replay' }`. `verifyMediaToken` returns `{ ok: false, error: 'token_replay' }`. The middleware returns HTTP 401. Recovery: the client must POST to the grant endpoint again to mint a fresh token — there is no retry path for a replayed single-use token.)*

---

