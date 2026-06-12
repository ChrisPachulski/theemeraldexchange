
# Teaching Dossier: IPTV Live-TV Core

Scope: channel catalog ingest (M3U/Xtream), live stream proxy, SSRF guard.
Key files (12): `server/routes/iptv.ts`, `server/services/iptvHlsProxy.ts`, `server/services/ssrfGuard.ts`, `server/services/iptvHlsRewrite.ts`, `server/services/iptvCatalog.ts`, `server/services/iptvConcurrency.ts`, `server/services/iptvPlaylist.ts`, `server/services/iptvStreamToken.ts`, `server/services/iptvRemux.ts`, `server/services/iptvLiveRemuxMap.ts`, `server/services/iptvDb.ts`, `server/services/iptvDbSingleton.ts`.

---

## 1. WHAT

The IPTV core is the part of the backend that lets signed-in users watch live TV channels. The channels come from a third-party "Xtream-Codes" panel (a commercial IPTV provider, accessed via a username/password credential stored in environment variables). Internally, the backend downloads the full channel list from that panel and stores it in a local SQLite database. When a user clicks a channel, their browser asks the backend for permission to play (a "grant" request); the backend checks the user is signed in, checks there is a free connection slot, mints a short-lived signed token, and hands back a URL. The browser then fetches that URL. Every video byte flows through the backend, which pipes data from the upstream provider to the browser. The browser never talks to the provider directly, never sees the provider credentials, and cannot request any URL of its own choosing — only signed, validated ones.

---

## 2. WHY

**Why proxy at all?**

Three real constraints force every live video byte through the backend proxy instead of having the browser fetch the provider directly:

1. **Credentials stay secret.** The Xtream panel URL looks like `https://mybunny.tv/live/{username}/{password}/12345.ts`. If the browser fetched that directly, the username and password would appear in browser network logs, be visible to any script on the page, and be leaked in Referer headers. By proxying, the backend injects the credentials server-side; the client never sees them.

2. **CORS blocks direct browser fetch.** IPTV providers do not set the `Access-Control-Allow-Origin` header. Browsers enforce the Same-Origin Policy, so a fetch from `theemeraldexchange.com` to `mybunny.tv` would be blocked before a single byte arrives. A server-side proxy has no such restriction — node's `fetch()` is not subject to CORS.

3. **Control: slots, tokens, heartbeats, and kill-switches.** By making all bytes flow through the backend, the system can enforce a connection cap (providers cap simultaneous streams), track which user is watching what, immediately free a slot when the player tab closes, and let admins forcibly eject a session. None of that is possible if the browser talks to the provider directly.

**Why a two-step grant-then-stream pattern?**

The grant step (`POST /stream/live/:id/grant`) requires a session cookie — it proves the user is authenticated. But the actual `<video>` element fetch (`GET /stream/live/:id.ts`) is cross-origin (SPA at `theemeraldexchange.com`, API at `api.theemeraldexchange.com`), so the browser does not attach cookies to it. The solution: the grant returns a short-lived HMAC-signed URL token (`?t=…`). The stream endpoint verifies that token instead of a cookie. This keeps auth strong without cookie sharing.

**Why the SSRF guard?**

SSRF (Server-Side Request Forgery) is an attack where a server is tricked into making an HTTP request to an internal address. In this system the risk is concrete: segment URLs come from provider-controlled HLS manifests. A compromised or malicious provider could put `http://169.254.169.254/latest/meta-data/` (cloud metadata) or `http://recommender:8000/` (the internal Python recommender container) into a manifest line. Without a guard, the backend would faithfully fetch that internal address and relay the response to the attacker. The guard makes two checks: (a) a fast string check rejecting RFC-1918, loopback, link-local, and internal hostnames; (b) a DNS resolution check refusing any hostname whose A/AAAA record resolves to a private address, closing the DNS-rebinding gap. Every redirect hop is re-validated because an upstream 30x redirect is just as attacker-influenceable as the original URL.

---

## 3. MAP

**Key files and line anchors**

| File | Role | Key lines |
|------|------|-----------|
| `server/routes/iptv.ts` | All HTTP handlers: grant, stream bytes, sessions, history, favorites, catalog, sync | `iptv.ts:591` grant; `iptv.ts:765` stream bytes; `iptv.ts:1113` segment proxy |
| `server/services/ssrfGuard.ts` | isPublicUpstream (string check), assertResolvesPublic (DNS check), egress loop, guardedFetch / guardedFetchTrustedOrigin | `ssrfGuard.ts:90` isPublicUpstream; `ssrfGuard.ts:156` assertResolvesPublic; `ssrfGuard.ts:247` egress |
| `server/services/iptvHlsProxy.ts` | fetchAndRewriteHlsPlaylist (manifest fetch + sign), proxyRangeableUpstream (VOD range proxy) | `iptvHlsProxy.ts:73` fetchAndRewriteHlsPlaylist; `iptvHlsProxy.ts:134` proxyRangeableUpstream |
| `server/services/iptvHlsRewrite.ts` | rewriteManifest — replaces every segment/sub-playlist URL with a signed proxy URL | `iptvHlsRewrite.ts:9` rewriteManifest |
| `server/services/iptvCatalog.ts` | Read-only queries: listCategories, listLive, listVod, listSeries, getVodDetail, getSeriesDetail | `iptvCatalog.ts:76` listCategories |
| `server/services/iptvConcurrency.ts` | In-memory slot tracker: tryAcquire, release, heartbeat, idle-sweep | `iptvConcurrency.ts:78` cap enforcement |
| `server/services/iptvPlaylist.ts` | Playlist token mint/revoke/authorize + M3U body builder for external players (VLC, TiviMate) | |
| `server/services/iptvStreamToken.ts` | signStreamToken / verifyStreamToken — HMAC JWT for stream auth | |
| `server/services/iptvRemux.ts` | ffmpeg-based remux (MPEG-TS → HLS) for AVPlayer/Safari clients | |
| `server/services/iptvLiveRemuxMap.ts` | Tracks per-user remux sessions, manifest/segment URL rewriting | |
| `server/services/iptvDb.ts` | SQLite wrapper for the IPTV catalog (channels, vod, series, EPG) | |
| `server/services/iptvDbSingleton.ts` | Singleton accessor for iptvDb — ensures one shared DB handle | |

**Channel-play walkthrough: click "CNN" → first video frame**

1. **User clicks channel** in the SPA. The SPA calls `POST /api/iptv/stream/live/12345/grant` with the session cookie.

2. **Grant handler** (`iptv.ts:591`):
   - Validates the session cookie via `requireAuth`.
   - Calls `resolveSourcePrecedence` to probe whether the upstream is reachable (avoids acquiring a slot before knowing the source is up).
   - Calls `streamConcurrency().tryAcquire(...)` to claim one of the `IPTV_MAX_CONCURRENT_STREAMS` slots. Returns 429 if full.
   - Calls `signStreamToken(...)` to mint a short-lived HMAC token (`kind: 'live', resourceId: '12345'`).
   - Returns `{ url: '/api/iptv/stream/live/12345.ts?t=<token>', delivery: 'mpegts', sessionId }`.

3. **SPA hands the URL to mpegts.js**, which opens a streaming `fetch()` to `/api/iptv/stream/live/12345.ts?t=<token>`.

4. **Stream handler** (`iptv.ts:765`):
   - Calls `checkToken(c, 'live', '12345')` — verifies the HMAC, checks expiry and replay cache.
   - Calls `streamConcurrency().heartbeatByResource(...)` to keep the slot alive.
   - Assembles the upstream URL: `${creds.host}/live/${username}/${password}/12345.ts`.
   - Calls `guardedFetchTrustedOrigin(upstreamUrl, ...)` — trusts the operator-configured host but re-validates every 30x redirect hop for SSRF.
   - Wraps the response body in `makeHeartbeatStream(...)` — heartbeats the concurrency slot every 5 seconds so a long live view does not get idle-swept.
   - Wires the client's `AbortSignal` to call `streamConcurrency().releaseByResource(...)` on tab-close.
   - Returns the upstream byte stream directly to the browser with `Content-Type: video/mp2t`.

5. **mpegts.js** in the browser demuxes the MPEG-TS stream and feeds decoded frames to the `<video>` element.

---

## 4. PREREQUISITES

Before studying this module a beginner needs to understand:

- **HTTP request/response basics** — what a GET and POST are, what headers and body are, what a streaming response is versus a buffered one.
- **Same-Origin Policy and CORS** — why a browser fetch to a different domain is blocked, what `Access-Control-Allow-Origin` does, and why a server-side proxy bypasses it.
- **HLS (HTTP Live Streaming)** — that a `.m3u8` manifest is a text file listing segment URLs (`.ts` files), and that the player fetches segments sequentially.
- **MPEG-TS** — that live TV is delivered as a continuous stream of transport stream packets, not a finite file.
- **Cookies vs. URL tokens for auth** — why a `<video src="">` element cannot carry a session cookie cross-origin and why a signed query-string token is the fallback.
- **HMAC signing** — that a token like `?t=abc123` is an unforgeable cryptographic signature binding the user identity and resource ID, expiring after a set time.
- **DNS basics** — that a hostname like `mybunny.tv` maps to an IP address via DNS, and that the IP may differ from the hostname string.
- **RFC 1918 / private IPv4 ranges** — that `10.x.x.x`, `172.16–31.x.x`, `192.168.x.x`, `127.x.x.x`, and `169.254.x.x` (cloud metadata) are internal addresses that a public server should never fetch on behalf of an external caller.
- **Node.js streams / Web Streams API** — that `ReadableStream`, `pipeThrough`, and `TransformStream` let bytes flow without loading them all into memory.
- **SQLite basics** — that a SQLite database is a single file, that `better-sqlite3` is a synchronous Node binding, and that WAL mode allows concurrent reads.

---

## 5. GOTCHAS & WAR STORIES

**The "loads forever" incident (the canonical SSRF guard war story)**

In commit `9beac45` the SSRF guard was first written with a strict https-only rule: any upstream URL that was not `https:` was rejected. The intention was correct — avoid fetching internal targets — but the implementation was wrong about which property mattered.

The real provider URL chain is: `https://mybunny.tv/live/…/12345.ts` → provider's nginx issues a `301 Moved Permanently` → `http://turbobunny.net/live/…/12345.ts` (a plain-HTTP public CDN). That redirect is normal and deliberate: the panel uses HTTPS for the branded domain but CDN delivery is plain HTTP.

Because the guard required `https:` on every hop, it blocked the redirect. Every live channel returned `400 bad_upstream`. The symptom from the user's perspective was not an error message — the player just kept buffering forever ("loads forever"). The stream handler returned a 400, mpegts.js treated it as a network error, and the recovery loop retried silently until it gave up.

The fix in `87fa8e0` changed the rule from "https required" to "public host required". The comment now in `ssrfGuard.ts:73–88` explains the reasoning precisely: "The SSRF threat is the destination address, not the scheme. An http request to a public host cannot reach an internal target." The https-only rule added no SSRF protection and broke all live playback.

**The lesson**: the right invariant for SSRF defense is "does this resolve to an internal IP address?" not "is the scheme https?". Both checks are present but only the address check is load-bearing. The scheme check is belt-and-suspenders for HLS manifest/segment URLs (where `guardedFetch` is used) but the trusted-origin path (`guardedFetchTrustedOrigin`) never requires https on the initial URL.

**DNS-rebinding TOCTOU residual risk**

The guard resolves the hostname and checks all returned IPs before egress. But the `fetch()` call resolves the same hostname a second time. A clever attacker with control over the authoritative DNS server can answer "public" on the first lookup and "169.254.169.254" on the second. The comment in `ssrfGuard.ts:138–154` documents this explicitly as "ACCEPTED RESIDUAL RISK" — fully closing it would require pinning the connection to the validated IP via an undici dispatcher hook, which is not implemented. The mitigations: the two lookups happen milliseconds apart (the attacker must win a sub-second race), most resolvers clamp TTL-0 upward, every redirect hop is re-validated independently (the dominant attack path), and internal services additionally require internal auth.

**The concurrency heartbeat gap (finding 8-1)**

The live stream endpoint is one long HTTP response that can last hours. The concurrency tracker had a 30-second idle sweep: if no heartbeat was received for 30s, the slot was freed. But nothing was sending heartbeats during live playback — the slot got freed after 30s while the stream was still active. The next viewer's grant would then over-subscribe the provider's connection cap, causing the upstream to throttle or drop packets.

The fix: `makeHeartbeatStream` wraps the upstream response body in a `TransformStream` that calls `streamConcurrency().heartbeatByResource(...)` every 5 seconds as data flows through. The stream also wires the client's `AbortSignal` to immediately release the slot on tab-close instead of waiting for the sweep.

**The segment proxy memory bomb**

The code in `iptvHlsProxy.ts:32–54` reads a manifest response body into memory with `readBoundedText`. Without the `maxBytes` bound, a malicious or misconfigured upstream could return a gigabyte of data as a "manifest" and exhaust the server's heap. The bound (configured by `IPTV_MANIFEST_MAX_BYTES`) refuses any manifest larger than the cap. This is why the live `.ts` byte stream path uses a streaming response (`Response(upstream.body)`) while only the manifest path buffers to a string.

---

## 6. QUIZ BANK

**Q1.** A user reports that clicking "Play" on a channel results in the player spinning indefinitely but no error message. The backend logs show a 400 response with `{ "error": "bad_upstream" }`. Walk through the code path that produces this 400. What are the two most likely causes?

**A1.** The 400 comes from `iptv.ts:1144–1146` (segment proxy) or `iptvHlsProxy.ts:84` (manifest fetch), both of which call `isPublicHttpsUpstream(url)`. The two likely causes: (a) the SSRF guard rejected the URL because it resolved to a private IP (e.g., the provider's CDN CDN host has a bad DNS record or the provider redirected to an internal address); (b) the URL scheme is not `http:` or `https:` (e.g., it is `rtmp:`). To diagnose: log the actual URL being passed to `isPublicHttpsUpstream` before the check. The historic third cause — the provider's https→http redirect being rejected — was the "loads forever" bug fixed in `87fa8e0`.

**Q2.** The owner has two Xtream panel connections (`max_connections: 2`). Three users are watching simultaneously. User C just clicked a channel and got a 429 response. The SPA shows a modal listing two active sessions. User A's session shows IP `10.0.0.5` and User B's shows IP `10.0.0.7`. If User A closes their browser tab, what sequence of events frees their connection slot and allows User C to retry?

**A2.** When User A closes the tab, the browser aborts the in-flight streaming fetch, which fires the `abort` event on `c.req.raw.signal`. The listener registered at `iptv.ts:784` calls `streamConcurrency().releaseByResource(v.sub, 'live', streamId)`, immediately freeing the slot. User C can now re-POST to `/stream/live/:id/grant`; `tryAcquire` finds a free slot, mints a new token, and returns a stream URL.

**Q3.** Explain why `guardedFetch` and `guardedFetchTrustedOrigin` exist as two separate functions. In what situation would using `guardedFetch` for the live `.ts` byte path break legitimate playback?

**A3.** `guardedFetch` validates the initial URL itself — it must be `https:` and resolve to a public IP. `guardedFetchTrustedOrigin` trusts the initial URL (the operator-configured Xtream host, which may be plain `http:`) but still guards every redirect. Using `guardedFetch` for the live `.ts` path would break any operator whose Xtream panel runs on plain HTTP (a common self-hosted setup) or whose CDN redirects from HTTPS to HTTP, because the initial URL or the first redirect would be rejected as `http:` even though the destination is a legitimate public server.

**Q4.** The `rewriteManifest` function in `iptvHlsRewrite.ts` transforms every line of an HLS manifest. What would happen if a provider's manifest contained a segment line with a relative URL like `seg_001.ts` versus an absolute URL like `https://cdn.provider.com/seg_001.ts`? Why does the `resolveUrl` helper exist?

**A4.** HLS manifests can contain either relative or absolute segment URLs. Relative URLs must be resolved against the manifest's own URL (the "base URL") to get a fully-qualified address. `resolveUrl(base, ref)` calls `new URL(ref, base)`, which handles both cases: if `ref` is absolute, `base` is ignored; if `ref` is relative (e.g., `seg_001.ts`), it is appended to the base URL's directory path. Without `resolveUrl`, relative segment URLs would be passed verbatim to `signStreamToken`, producing a `rid` of `seg_001.ts` that the segment proxy could not fetch.

**Q5.** The stream token system uses a "replay cache". What attack does the replay cache prevent, and why is it especially important for `segment` tokens, which are marked "strict single-use"?

**A5.** A stream token is a short-lived HMAC credential embedded in a URL. Without a replay cache, an intercepted token (from a shared URL, a leaked log, or a sniffed request) could be reused by anyone who obtained it, even after the original user stopped watching. The replay cache records each `jti` (token ID) after its first use and rejects any re-use before expiry. For segment tokens this matters most because segment URLs can appear in proxy logs, browser history, or CDN access logs — a single-use token limits the exposure window to the instant between the token being issued and being consumed.

**Q6.** The `makeHeartbeatStream` function wraps the upstream response body in a `TransformStream`. Why is heartbeating the concurrency slot done here rather than in a `setInterval` in the grant handler, and why is it throttled to once per 5 seconds instead of on every chunk?

**A6.** A `setInterval` in the grant handler would run even when the stream is stalled or the client has disconnected — it would falsely keep the slot alive when no bytes are actually flowing. Attaching the heartbeat to the byte stream ties slot liveness to actual data transfer: if the upstream stops sending, no heartbeat fires, and the idle sweep eventually frees the slot. The 5-second throttle (HEARTBEAT_THROTTLE_MS) avoids hammering the in-memory concurrency tracker Map on every individual MPEG-TS packet (which arrive many times per second at live TV bitrates); one heartbeat per 5s is sufficient to stay well within the 30-second sweep window.

---

## 7. CODE-READING EXERCISE

**Guided walk: how a segment URL is locked to a user and validated on fetch**

This exercise traces the lifecycle of a single HLS segment URL from manifest rewrite to byte delivery. Read these four locations in order.

**Step 1 — `iptvHlsRewrite.ts:9–29`**

Read the `rewriteManifest` function. It splits the manifest on newlines. For each non-comment line (a segment or sub-playlist URL), it calls `resolveUrl(baseUrl, line)` to get an absolute upstream URL, then calls `signSegment(upstream)` to get a signed token string, then replaces the line with `${proxyPrefix}?u=<token>`.

Ask yourself: what does the manifest look like before this function runs? What does it look like after? Who can read the original provider URL from the rewritten manifest?

**Step 2 — `iptvHlsProxy.ts:104–111`**

Find the `sign` closure inside `fetchAndRewriteHlsPlaylist`. It calls `signStreamToken(env.streamTokenSecret, { kind: 'segment', resourceId: url, sub: opts.sub, ttlSecs: ... })`. The `resourceId` is the raw upstream segment URL. The `sub` is the user's identity.

Ask yourself: what happens if two different users fetch the same manifest? Do they get the same segment tokens? If User A's token were used by User B, what check would catch it?

**Step 3 — `routes/iptv.ts:1113–1180`**

Read the segment proxy handler (`iptv.get('/stream/segment', ...)`). It:
1. Reads the token from `?u=`.
2. Calls `verifyStreamToken` — checks the HMAC signature and expiry.
3. Checks `claims.k !== 'segment'` — wrong token kind rejected.
4. Calls `checkReplay(claims.jti, ...)` — single-use enforcement.
5. Parses `claims.rid` as a URL.
6. Calls `isPublicHttpsUpstream(url)` — SSRF string check.
7. Calls `guardedFetch(upstream, ...)` — SSRF DNS check + redirect guard.

Ask yourself: at step 4, what would the replay cache return on a second request with the same token? At step 6, what would happen if the provider's manifest had contained `http://169.254.169.254/meta-data`?

**Step 4 — `ssrfGuard.ts:247–284`**

Read the `egress` function. Notice `redirect: 'manual'` in the `fetch()` call. The loop checks `res.status >= 300 && res.status < 400`, reads the `Location` header, and calls `guardHop(currentUrl)` on the new URL before following it.

Ask yourself: why is `redirect: 'manual'` critical here? If the code used `redirect: 'follow'` instead (the default), what would the `assertResolvesPublic` check on the initial URL fail to catch?

**What you should be able to explain after this exercise:**

- Why segment tokens are bound to a specific user (`sub`) and resource (`rid`), and what prevents token sharing between users.
- Why two independent SSRF checks exist (string check in `isPublicHttpsUpstream`, DNS check in `assertResolvesPublic`), and what each one catches that the other misses.
- Why the redirect loop uses `redirect: 'manual'` and re-validates each hop — and what the "loads forever" incident teaches about the relationship between scheme checking and address checking.

---

