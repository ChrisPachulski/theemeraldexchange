# IPTV "Unwatchable Hiccups" — Root-Cause Diagnosis

Date: 2026-05-30
Lead: diagnosis
Scope: live `.ts` playback path (desktop Chrome/Firefox/Edge → mpegts.js). Safari/iOS remux path is secondary.

---

## 1. Bottom Line

**The single biggest cause is the transport: every live video byte is relayed through one Cloudflare Free Tunnel + Cloudflare edge as a single long-lived, unbounded chunked HTTP response.** That path has no bandwidth SLA, is subject to Cloudflare fair-use shaping (and a ToS Section 2.8 violation for sustained video on a non-Stream/non-Enterprise plan), and inserts a mandatory CF-POP round-trip even for on-LAN/same-region viewers. This is a hard throughput/latency **ceiling**.

**The already-applied player-buffer fix (`IptvPlayer.tsx:299-306`: enable stash 1 MB + widen latency-chasing to 8.0s max / 2.0s min remain) is a MITIGATION, not a fix.** It buys ~8s of slack that masks jitter up to the buffer depth, then underruns once the upstream rate cap or a coincident loop stall outlasts the buffer. Worse, the same change makes the player's periodic stutter **bigger**: `liveBufferLatencyChasing:true` (`IptvPlayer.tsx:304`) hard-**seeks** the playhead (`mpegts.js` chaser → `_on_direct_seek`), so widening the window to 8s means the player now yanks ~6s forward in one MSE-flushing jump every time latency grows. The buffer fix feeds the stutter mechanism it was meant to cure.

You cannot beat an upstream rate cap with a client buffer. The durable fixes are (a) take video off the tunnel for reachable clients, and (b) switch the player from seek-based chasing to playbackRate-based `liveSync`.

---

## 2. Ranked Root-Cause Table

| # | Cause | Dimension | How much it matters | Fix | Effort | Risk |
|---|-------|-----------|--------------------|-----|--------|------|
| 1 | All live bytes relayed through single CF Free Tunnel + CF edge as one unbounded chunked response — no SLA, fair-use shaping, mandatory POP hop. Hard throughput/latency ceiling. `iptv.ts:734`, `base.ts:9`, `docker-compose.yml:243-252` | transport-cloudflared | **DOMINANT** — the ceiling the buffer can only paper over | Split video byte-path off the tunnel: serve `/stream/*` from a VPS reverse-proxy edge (real TLS, WireGuard backhaul to the NAS) — see corrected §4; keep `/api/*` JSON on the tunnel | medium | medium |
| 2 | `liveBufferLatencyChasing:true` hard-SEEKS the playhead; widened to 8.0s/2.0s the seek jump is now ~6s, flushing MSE+decoder = visible freeze every N seconds. Buffer fix made it worse. `IptvPlayer.tsx:304-306` | player | **HIGH** — directly produces the periodic stutter; trivial to fix | `liveBufferLatencyChasing:false`; `liveSync:true`, `liveSyncMaxLatency:8.0`, `liveSyncTargetLatency:5.0`, `liveSyncPlaybackRate:1.1` (smooth drain, no seek) | trivial | low |
| 3 | Error-recovery does synchronous `unload()+load()` with no backoff, capped at 5; a short NETWORK_ERROR burst on a jittery tunnel burns all 5 in seconds → permanent "re-open the channel" error. Counter never resets. `IptvPlayer.tsx:319-337` | player | **HIGH** — turns a transient blip into a terminal error | Exponential backoff (`500ms*2^n`) before unload/load; only full reload on MEDIA_ERROR; reset `recoveries` after sustained `playing` | small | medium |
| 4 | No `waiting`/`stalled` handler on the video element — a silent bandwidth underrun (the literal "hiccup") just freezes; ERROR handler never fires for it. `IptvPlayer.tsx:147-149` | player | **MED-HIGH** — the most common failure mode has zero recovery | Add debounced `waiting`/`stalled` listener that nudges to last buffered range + `play()`; surface soft "reconnecting" | small | low |
| 5 | Local concurrency cap (`IPTV_MAX_CONCURRENT_STREAMS` default 4) ignores upstream `max_connections` (fixtures = 2); grants over-subscribe the provider line → provider refuses/throttles surplus → drops. `env.ts:511`, `iptvConcurrency.ts:78`, `iptv.ts:461` | upstream-source | **MED** — silent provider-side throttling under multi-viewer | Clamp cap to `min(env, upstream.maxConnections)`; default env to 2 until real cap confirmed | small | low |
| 6 | mpegts recovery reopens a fresh upstream `.ts` per NETWORK_ERROR; on a 2-slot line the old socket lingers → retry double-occupies the cap → retry fails → feedback loop ("hiccups at insane rate"). `IptvPlayer.tsx:325-336`, `iptv.ts:720` | upstream-source | **MED** — self-inflicted thundering herd, amplifies #1 | Backoff on recovery (ties to #3); server-side tee a single upstream fetch to same-channel viewers keyed by streamId | medium | medium |
| 7 | Single Node event loop relays ALL video bytes AND serves recommender/LLM/TMDB/sync; a heavy `/api/suggestions` or sync burst queues the per-chunk read→write callbacks → loop stall drains the jitter buffer → underrun. `app.ts:35-166`, `index.ts:72`, `iptv.ts:734` | backend-relay | **MED** — intermittent, correlated with API activity | Move stream relay to a dedicated Node process (only `/stream/*` + segment proxy); or move LLM/sync to a worker_thread | medium | medium |
| 8 | Live `.ts` slot swept after 30s idle but player sends NO concurrency heartbeat — an actively-watching slot is released locally → next grant over-subscribes the real line → drops on the still-open stream. `iptvConcurrency.ts:101-104,115` (never wired) | upstream-source | **MED** — over-subscription on long views | Add `POST /stream/session/:id/heartbeat` + 10s client ping; or refresh `lastSeen` from the stream handler itself | small | low |
| 9 | Global `fetch` (undici) uses stock dispatcher: untuned pool, no per-origin socket budget, no pipelining → concurrent segment/VOD fetches serialize on a small socket set (head-of-line). No `setGlobalDispatcher` anywhere. `iptv.ts:720,653,859,1035` | backend-relay | **MED** (segment/VOD), low (single live `.ts`) | `setGlobalDispatcher(new Agent({connections:16, keepAliveTimeout:60_000, connect:{timeout:8_000}, headersTimeout:15_000, bodyTimeout:0}))` at boot | small | low |
| 10 | Sustained video through a CF Free tunnel violates Cloudflare ToS §2.8 — a policy ceiling; CF can throttle/flag the zone, and no client buffer beats that. `docker-compose.yml:250`, `DEPLOY.md:24-34` | transport-cloudflared | **MED** (latent) — resolved by #1 | Resolved by moving video off the tunnel; document tunnel as API-only | small | low |
| 11 | `cloudflared` pinned to `:latest` — QUIC transport behavior can silently shift under a base-image bump and regress playback with no code change. `docker-compose.yml:244` | transport-cloudflared | **LOW** — reproducibility/regression guard | Pin to a specific released tag | trivial | low |
| 12 | Live `.ts` sets `Connection: keep-alive` (forbidden hop-by-hop header in HTTP/2 → ignored) and `X-Accel-Buffering: no` (nginx-only, cloudflared does NOT honor it). Stated anti-buffering intent is unverified. `iptv.ts:739-740` | backend-relay | **LOW** — corrects a false assumption | Drop the `Connection` header; verify tunnel isn't buffering via cloudflared ingress config + first-chunk-latency capture | small | medium |
| 13 | Per-request overhead on the hot byte path: `logger()` on `app.use('*')` does 2 synchronous `console.log`s per request incl. `/stream/*`; for the per-segment HLS cadence this recurs and competes with the relay for loop time. `app.ts:35`, `iptv.ts:568-597` | backend-relay | **LOW** — free win | Exclude `/api/iptv/stream/*` from `logger()` | trivial | low |
| 14 | Grant-time source-precedence probe hits upstream `player_api.php` (15s budget) before every slot acquire → slows channel changes, adds load to the contested line. `sourcePrecedence.ts:56-73`, `upstream.ts:21`, `iptv.ts:451` | upstream-source | **LOW** — aggravates cap pressure / switch latency | Cache the account-level probe ~10-30s; or short WAN timeout | trivial | low |
| 15 | Remux/ffmpeg path is single-process, no respawn; an upstream blip kills ffmpeg → `410 session_gone` → ≥4s gap + up to 8s cold start. **Safari/iOS only** — not the reported (desktop) hiccup. `iptvRemux.ts:140-149`, `iptv.ts:811-816` | remux-ffmpeg | **MINOR** (off hot path) | Add `-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2`; auto-respawn into same dir with `append_list` | medium | medium |
| 16 | ABR/level switching — audited and RULED OUT. Live `.ts` is single-bitrate (no levels); hls remux path sets `lowLatencyMode:false` + generous retries. `IptvPlayer.tsx:221-232,295-313` | player | **NONE** — confirmed not a contributor | No change | trivial | low |

---

## 3. Ordered Fix Plan

### Tier A — Buildable NOW, low risk (do first, this week)

These are code-only, no infra/architecture decision, and directly attack the felt symptoms. Ship them as one PR; they neutralize the seek-stutter and the false-terminal-error before touching transport.

1. **Player: switch chasing → liveSync (root cause #2).** `IptvPlayer.tsx:304-306`: set `liveBufferLatencyChasing:false`, add `liveSync:true`, `liveSyncMaxLatency:8.0`, `liveSyncTargetLatency:5.0`, `liveSyncPlaybackRate:1.1`. Eliminates the periodic MSE-flushing seek that the buffer widening made worse. **Highest symptom payoff per line changed.**
2. **Player: backoff + smarter recovery (root cause #3, #6).** `IptvPlayer.tsx:319-337`: wrap `unload()+load()` in `setTimeout(500*2^n)`; full reload only on MEDIA_ERROR; reset `recoveries` to 0 after a stable `playing` window. Stops a tunnel-jitter burst from burning the 5-strike budget and from double-occupying a 2-slot upstream line.
3. **Player: stall recovery (root cause #4).** `IptvPlayer.tsx:147-149`: add debounced `waiting`/`stalled` listener → seek to last buffered end, `play()`, surface soft "reconnecting". Catches the silent underrun that today just freezes.
4. **Server (free wins, root causes #9, #13, #11, #12).** Add `setGlobalDispatcher(new Agent({…}))` at boot; exclude `/stream/*` from `logger()`; drop the illegal `Connection` header; pin `cloudflared` to a fixed tag (`docker-compose.yml:244`).
5. **Upstream cap clamp + heartbeat (root causes #5, #8).** Clamp effective cap to `min(env, upstream.maxConnections)` and set env default to 2 until prod is confirmed; wire `streamConcurrency().heartbeat` from the live stream handler so active views don't get swept.

> **Verification gate (per CLAUDE.md "Test Each Change End-to-End"):** before/after, play a live channel while firing an `/api/suggestions` refresh and confirm no underrun (tests root cause #7 too). SSH prod and read `/api/iptv/health` for the real `max_connections`, then `ffprobe` the raw upstream `.ts` to separate provider-quality hiccups from cap hiccups. Owner-supplied unknowns block over-tuning blind.

### Tier B — Needs an infra/architecture decision (the real fix)

6. **Take video off the cloudflared tunnel (root cause #1, #10 — the DOMINANT cause).** This is the only change that removes the throughput/latency/policy ceiling. It is a transport decision, not a code tweak, so it sits behind an owner call (see §4). Tier A makes the symptom tolerable; Tier B is what makes it actually good. Do NOT invest further in client buffers before this — they cannot beat an upstream rate cap.

7. **Relay process isolation (root cause #7).** Run a dedicated Node process mounting only `/stream/*` + segment proxy, so recommender/LLM/sync bursts can't stall the byte pump. Medium effort; pairs naturally with the Tier-B transport split (the stream process can bind the direct hostname).

8. **Safari/iOS remux resilience (root cause #15)** only if iOS clients are also reported hiccuping. Add ffmpeg `-reconnect` flags + same-dir respawn. Lower priority — confirmed off the desktop hot path (`/tmp/iptv-remux` empty in prod = zero live remux sessions).

---

## 4. Transport Recommendation — Does video need to come off the tunnel?

**Yes.** Sustained live video through a Cloudflare Free Tunnel is the dominant ceiling on three independent axes — performance (no SLA, fair-use shaping), policy (ToS §2.8), and topology (mandatory CF-POP round-trip even for a viewer on the same LAN/ISP as the NAS). No client-side buffer or relay tweak can raise that ceiling. Tier A buys tolerable; only this buys good.

> **Correction (2026-05-30, owner pushback):** an earlier draft of this section ranked a **Tailscale / Tailscale-Funnel** hostname as the #1 transport. That was wrong for a product that ships to the App Store. Tailscale requires every *viewer's device* on the tailnet — a non-starter for public/anonymous distribution — and Tailscale **Funnel** routes through Tailscale's DERP relays, is rate-limited, and is explicitly not intended for production high-bandwidth video. So Funnel is *also* not production-grade for sustained streaming. Tailscale's correct role here is **owner-side backhaul only** (the private NAS↔edge link), never the client byte-path. The ranking below is corrected accordingly.

**Recommended approach (ranked):**

1. **BEST — Public edge you control (VPS reverse proxy) + private backhaul to the NAS.** Stand up a small always-on VPS (≈$4–6/mo Hetzner/DO/Vultr) running Caddy/nginx. Public DNS `video.theemeraldexchange.com → VPS`, a real Let's Encrypt cert terminated at the edge, and the VPS reaches the NAS over a private **WireGuard / Tailscale backhaul** (only the two servers on the tailnet — never clients). Clients see plain HTTPS: no VPN, no CF edge, no ToS §2.8 exposure, hardenable at the edge (rate-limit / WAF / fail2ban), and **predictable egress** (a €4 Hetzner box includes 20 TB/mo — thousands of viewer-hours at 5–8 Mbps, versus CF Free's "unlimited until shaped/flagged for video"). This is the pattern commercial self-hosted-but-public media servers use, and it scales straight into the M2/M5 native-client / App-Store story. Keep `/api/*` JSON on the cloudflared tunnel; the grant endpoints (`iptv.ts:461` / the `/grant` response) emit the `video.` host for `/stream/*` while `base.ts:9` keeps JSON on `api.`.

2. **Zero-cost variant — direct port-forward + DDNS + Let's Encrypt on the NAS** (what Jellyfin self-hosters do). Best raw perf, no monthly cost. Cost: exposes the home IP and a public port, is bounded by residential upload, and has no edge hardening. Fine for owner-only; weaker as a shipped product. The dual-key HMAC `checkToken` (`iptv.ts:568-597`) + the SSRF discipline from `9beac45` already gate `/stream/*`, so the auth model carries over to either 1 or 2.

3. **Second dedicated cloudflared tunnel hostname for video** — lowest operational change, isolates a video stall from API calls, but stays *inside* the CF ToS/shaping ceiling. A partial mitigation, not a cure. Pin cloudflared to a fixed tag regardless.

4. **NOT Tailscale-Funnel as client transport, NOT Cloudflare Stream.** Funnel: per-device + DERP-relayed + rate-limited (see correction above). CF Stream: ingests/transcodes CF-managed VOD/live, not arbitrary per-user proxied Xtream `.ts` passthrough, and bills per minute.

5. **Keep the cloudflared tunnel as fallback** only for genuinely remote clients that cannot reach the `video.` edge (grant endpoint can fall back to the `api.` host).

**Recommendation:** Option 1 (VPS reverse-proxy edge with a WireGuard/Tailscale backhaul) is the production-grade answer and the one that survives App-Store distribution. Option 3 (second tunnel hostname) is the stop-gap if a VPS isn't yet provisioned. Tailscale stays in the stack — but as the NAS↔edge backhaul, not the viewer transport. Tier-A player fixes ship in parallel regardless.
