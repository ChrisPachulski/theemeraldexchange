
# Security Posture — Teaching Dossier

---

## 1. WHAT — Threat Model (ELI5)

The Emerald Exchange is a personal streaming and media app that lives on a home NAS. The people who might attack it fall into two rough groups. First, random strangers on the internet who find the public URL: they want to get in without an account, stream your media library for free, or pivot from the server to reach other devices inside your home network (like your router or Plex server). Second, a person who has a valid Plex account or even a Plex share on your server but was never explicitly invited to the app: they authenticated to Plex fine, but the app adds its own layer of access control that Plex alone does not satisfy. The most dangerous thing any attacker could do is (a) reach your home IP address directly — bypassing the Cloudflare proxy that hides it — or (b) convince the server to fetch a URL it controls that secretly points at your NAS's internal network (an "SSRF" attack), letting them poke at services that are only supposed to be reachable from inside the house.

---

## 2. WHY — Each Defense Layer, Why-Chained to the Attack It Blocks

**Cloudflare proxy hides the home IP.**
If the NAS were reachable directly from the internet, any attacker who found the IP could try to hit unproxied services, brute-force SSH, or enumerate containers. By routing all traffic through Cloudflare's edge, the NAS's real IP never appears in DNS — an attacker scanning the internet sees a Cloudflare edge node, not your home. The `exposure-monitor.sh` script (scripts/security/exposure-monitor.sh) runs on a schedule and fires a macOS alert the moment any hostname resolves to an IP outside the known Cloudflare/Netlify ranges, catching configuration drift before it becomes an incident.

**Plex Remote Access disabled (PublishServerOnPlexOnlineKey=0).**
Plex has a built-in feature to publish your server's WAN IP to plex.tv so remote clients can find it. That turns the NAS IP into public information. In the 2026-06-04 incident the `PublishServerOnPlexOnlineKey=1` flag combined with a manual router port-forward on 32400 effectively negated the Cloudflare hiding. Disabling remote access (verified value=0) and removing the port-forward plugs this hole. The exposure-monitor script checks this key on every run.

**Origin gating + CORS allowlist blocks cross-site request forgery.**
A hostile website open in the same browser as the app cannot silently issue state-changing requests (start a transcode, add a Radarr download, delete a membership) because the backend checks the HTTP `Origin` header against a compile-time allowlist (`env.allowedOrigins` in `server/middleware/csrf.ts`). Only origins in that list are accepted. An empty or mismatched Origin is rejected with a `bad_origin` error before the request handler ever runs. This prevents a scenario where a user visits `evil.com` and an invisible iframe submits a forged POST to `api.theemeraldexchange.com`.

**Bearer-only exemption for native apps.**
Mobile/native clients can't send cookies (cross-origin cookie rules are different), but they do send a `Authorization: Bearer <token>` header that an attacker-controlled webpage cannot. The `isBearerOnly` check in csrf.ts exempts such requests from the Origin check — but only when there is NO Cookie header at all. This means native app writes work without a CSRF token while browser-based CSRF attacks (which always carry cookies) still require a correct Origin.

**Invite allowlist as the authentication/authorization gate.**
Just because someone authenticated (via Plex or Apple Sign-In) does not mean they are authorized. The `authorizeOrRedeem` function in `server/auth.ts` runs a membership check on every login. An account that has never been granted an invite gets a 403 `no_invite` response regardless of whether their Plex account is valid. This is the single shared gate for both auth providers (Plex and Apple/passkey) — no password to crack, no account to register; you are either on the list or you aren't.

**No-password design (SIWA + Passkeys + Plex OAuth).**
Traditional passwords are a major attack surface: users reuse them, databases leak them, brute-force works. The app has no password fields at all. Sign-In with Apple uses Apple's servers to verify identity (Apple's JWKS signature is required); passkeys use WebAuthn hardware keys; Plex login goes through plex.tv's OAuth PIN flow. The backend never stores or compares a password hash.

**JWE-encrypted tokens at rest (session cookies and device tokens).**
The session cookie is a JWE (JSON Web Encryption), not a plain JWT. The difference: a plain JWT is signed but readable by anyone. A JWE is encrypted with an AES-256-GCM key derived from `SESSION_SECRET` using HKDF — the contents (user sub, role, etc.) are opaque to the browser and to any network observer who intercepts the cookie. Device tokens (long-lived bearer tokens for native apps) are similarly JWE-encrypted using the Rust `emerald-contracts` crate and verified byte-for-byte against cross-language test vectors. Even if a cookie leaked, an attacker without the server's secret key cannot read or forge the payload.

**SSRF guard on all outbound fetches.**
The IPTV feature involves the server fetching M3U playlists, HLS manifests, and video segments from URLs provided by third-party providers — or potentially by a compromised panel. If the server blindly followed any URL it was given, an attacker who controlled a provider could redirect it to `http://10.0.0.1/admin` (the home router) or `http://192.168.1.x:8080` (another NAS container). The SSRF guard (`server/services/ssrfGuard.ts`) blocks this: it checks that the destination hostname resolves to a public IP (not RFC-1918 private ranges), runs the same check on every 30x redirect, and rejects any fetch that would land on a private/loopback address. The live "loads forever" incident (2026-05-30) was actually caused by this guard being too strict in the *other* direction (requiring HTTPS on every hop, but a legitimate CDN 301-redirected from HTTPS to HTTP). The fix was to allow HTTP to verified-public hosts while keeping the private-IP block absolute.

**Container hardening (cap_drop ALL + no-new-privileges).**
Every container in `docker-compose.yml` drops all Linux capabilities (`cap_drop: [ALL]`) and sets `no-new-privileges: true`. Capabilities are what allow a process to do privileged things (bind port 80, change file ownership, load kernel modules). A stock Docker container keeps a large default capability set; dropping ALL means that even if an attacker compromises the Node process inside the backend container, they cannot escalate to root within the container or break out to affect other containers. The recommender and Glitchtip sidecars that need to `chown` files (because they start as root to set up the file system) explicitly add back only `SETUID`/`SETGID`/`CHOWN` — nothing more.

**No secrets in the repo.**
API keys, session secrets, and internal-principal secrets are all injected via environment variables at deploy time (docker-compose `${VAR}` syntax). The `.env` file is gitignored. The audit confirmed zero tracked `.pem`/`.key`/`.env` files in the repository history.

---

## 3. MAP — Defense-in-Depth Table

| Layer | Attack Blocked | Where in Code / Docs |
|---|---|---|
| Cloudflare proxy (DNS hides origin IP) | Direct NAS access, DDoS, port scanning | `scripts/security/exposure-monitor.sh`; `ops-cloudflare-tunnel.md` |
| Plex Remote Access disabled | Home WAN IP published to plex.tv | `exposure-monitor.sh` checks `PublishServerOnPlexOnlineKey`; memory: project_home_ip_exposure_lockdown |
| CSRF Origin gate (`requireSafeOrigin`) | Cross-site request forgery from hostile pages | `server/middleware/csrf.ts` lines 44–87 |
| Bearer-only CSRF exemption (`isBearerOnly`) | Allows native-app writes without breaking browser CSRF | `server/middleware/csrf.ts` lines 38–42 |
| Invite/members allowlist (`authorizeOrRedeem`) | Valid-but-uninvited auth provider users | `server/auth.ts` lines 292–415; `server/services/membership.ts` |
| No-password (SIWA + Passkeys + Plex OAuth) | Password brute-force, credential stuffing, DB password leak | `server/auth.ts` (Apple handler), `server/routes/passkey.ts` |
| JWE session cookies (AES-256-GCM, HKDF) | Cookie forgery, session content leakage | `server/session.ts` lines 1–47 |
| JWE device tokens (Rust emerald-contracts) | Long-lived bearer token forgery | `crates/emerald-contracts/src/device_token.rs`; `server/session.ts` lines 183–260 |
| SSRF guard (`guardedFetch` / `assertResolvesPublic`) | Server fetching internal NAS services via provider-controlled redirects | `server/services/ssrfGuard.ts`; called from `server/routes/iptv.ts`, `server/services/iptvHlsProxy.ts` |
| Internal-principal JWE auth (Rust HKDF) | Unauthenticated access to media-core / transcoder on docker bridge | `crates/emerald-contracts/src/internal_principal.rs`; `crates/media-core/src/auth.rs` |
| cap_drop ALL + no-new-privileges | Post-compromise privilege escalation within container | `docker-compose.yml` lines 36–37, 190, 276, 358, 455, 503, 573 |
| No secrets in repo | Credential leak via git history | `.gitignore`; `docker-compose.yml` uses `${VAR}` only |
| Exposure monitor (launchd cron) | DNS drift, new 0.0.0.0 port binds, Plex re-enable | `scripts/security/exposure-monitor.sh` |

---

## 4. PREREQUISITES — Fundamentals First

A student should understand these concepts before studying this codebase's security posture:

1. **HTTP basics** — what a request/response looks like, what headers are, the difference between GET (safe, idempotent) and POST/PUT/DELETE (state-changing). You need this to understand why CSRF only matters for state-changing requests.

2. **Cookies vs. Bearer tokens** — cookies are sent automatically by the browser on every matching request (cross-site); Bearer tokens must be explicitly added by code. This distinction drives the `isBearerOnly` exemption.

3. **Same-origin policy and CORS** — browsers block JavaScript from reading responses to cross-origin requests by default. CORS headers relax this. CSRF exploits that browsers SEND cross-origin requests even when JavaScript can't READ the response.

4. **Authentication vs. Authorization** — authentication = "who are you?"; authorization = "are you allowed to do this?". The invite allowlist is the authorization layer; Plex/Apple/Passkeys are the authentication layers.

5. **Public-key cryptography basics** — enough to understand that signing (JWT) proves origin, while encryption (JWE) hides content. You don't need to implement AES, but you need to know why "signed but readable" differs from "signed and encrypted."

6. **Docker and Linux capabilities** — containers are isolated processes, not virtual machines. `cap_drop` removes POSIX capability bits that allow privileged operations. `no-new-privileges` means a process can't use setuid binaries to gain capabilities at runtime.

7. **DNS and how it is attacked** — DNS maps hostnames to IPs. If your DNS says `api.example.com → 104.21.x.x` (Cloudflare), traffic goes to Cloudflare, not your home. If a misconfiguration leaks your real IP, the protection is gone.

8. **SSRF (Server-Side Request Forgery)** — a server that fetches URLs supplied by users or third parties can be tricked into fetching internal resources. The attacker doesn't need to make the request themselves; the server does it for them.

---

## 5. GOTCHAS & WAR STORIES

### The Plex Remote Access IP Leak (2026-06-04)

Everything about the Cloudflare setup was correct: the SPA is on Netlify, the API is behind Cloudflare Tunnel, the DNS records point to Cloudflare IPs. But the owner's home IP was still visible to anyone who visited `plex.tv/api/v2/resources` or similar endpoints — Plex's own CDN was publishing it.

The root cause was two-layer: `PublishServerOnPlexOnlineKey="1"` in Plex's `Preferences.xml` (which tells Plex to announce the server to plex.tv's relay infrastructure) combined with a manual router port-forward on TCP 32400 (which actually opened the WAN port). Plex Remote Access is a feature intended for convenience — "reach your Plex from anywhere" — but it directly contradicts the privacy goal of the Cloudflare setup.

The fix was: disable Remote Access in Plex Settings (verified the value flipped to 0), and remove the router port-forward. The exposure-monitor script now checks `PublishServerOnPlexOnlineKey` on every run and fires a macOS notification if it re-enables itself (e.g., after a Plex update that resets preferences). **Lesson:** features built into third-party software on the same box can undo security work done at the application layer.

### The 80-Finding Production-Readiness Review (2026-05-30)

Before any production traffic, a full adversarial 12-dimension review was run against the live code. 90 raw findings were distilled to 80 confirmed (10 were false positives, refuted against actual code). Severities:

- **2 CRITICAL, both fixed:** (1) The device-token poll endpoint bypassed the invite/members allowlist entirely — any Plex account could mint a device token without an invite. (2) The deploy script never restarted cloudflared after recreating the backend, which broke the tunnel and took the public site down after every deploy.
- **7 HIGH, 6 fixed, 1 partial:** Privilege escalation via email local-part (an attacker chose an Apple email like `admin@icloud.com` to get the admin role); streaming proxy buffering the full video into RAM; cap_drop gosu crash-loop; media-core DB crash on fresh volume; no rollback in deploy; concurrency slot reap bug; /api/health always reporting healthy.
- **~64 medium/low still open:** These include things like unbounded TMDB lookups, segment tokens leaking into logs, device-token expiry not enforced, and the recommender Python sidecar having zero telemetry wiring.

The key lesson from this review was the **critical #1**: authentication (Plex identity confirmed) was not the same as authorization (invite allowlist checked). The poll endpoint authenticated the Plex user correctly but then skipped the allowlist check, effectively making the app open to all Plex account holders. **One missing function call defeated the entire invitation-only design.** This is a classic "confused deputy" pattern: the device-poll handler trusted that earlier auth was sufficient and skipped the second gate.

The 2026-05-28 honesty audit found a separate pattern: **features built and unit-tested but never wired end-to-end were reported as "live."** TMDB enrichment had 9 passing unit tests but the scanner never called it. The transcode 503 path was defined and matched in error handling but no handler ever constructed it. These are not security bugs per se, but they illustrate the same principle: passing tests in isolation does not mean the system behaves as described.

---

## 6. QUIZ BANK

**Q1.** An attacker has a valid Plex account and is shared on your Plex Media Server. They visit `https://theemeraldexchange.com` and try to log in. Trace the exact chain of checks that stops them if they have never been invited.

**A1.** The browser completes the Plex OAuth PIN flow and the backend receives a valid `X-Plex-Token`. `auth.ts` calls `plexIsServerMember()` — it returns true because the share exists. Then `authorizeOrRedeem()` is called with the namespaced sub (`plex:<accountId>`). `memberStatus()` returns `not_member`. There is no `inviteCode` in the POST body. The auto-admit branch (`isOwnerServerMember`) checks whether the share-type makes auto-admit eligible — if the account was added via the invite-only path rather than auto-admit, it will still be denied. `authorizeOrRedeem` returns `{ allowed: false }`, and the handler returns `c.json({ status: 'denied', reason: 'no_invite' }, 403)`. The user sees a "You need an invite" error; no session is created.

**Q2.** An IPTV provider runs a malicious server. When the backend fetches the M3U playlist URL, the provider responds with a 302 redirect to `http://192.168.1.1/admin` (the home router admin panel). What happens, and which file is responsible?

**A2.** The SSRF guard in `server/services/ssrfGuard.ts` intercepts this. `guardedFetch` follows the redirect and, before connecting, calls `assertResolvesPublic` on the redirect target. `192.168.1.1` is a private RFC-1918 address (`isPrivateIPv4` returns true for `192.168.*`). The guard throws an error, the fetch is aborted, and the backend returns an error to the client. The router is never contacted. The guard runs on every hop of the redirect chain, not just the initial URL, specifically to catch this pattern.

**Q3.** An attacker knows the app uses HTTP cookies for session state and controls a webpage they can get the victim to visit. They try to submit a forged POST to `https://api.theemeraldexchange.com/api/feedback` from the malicious page. Why does this fail even though the victim's browser automatically sends the session cookie?

**A3.** The `requireSafeOrigin` middleware runs before the feedback handler. It reads the `Origin` header from the request — the browser automatically sets this to `https://evil.com` (the attacker's site) on cross-origin requests, and browsers will not allow JavaScript to spoof it. `checkOrigin` compares it against `env.allowedOrigins` (which contains only `https://theemeraldexchange.com`). `evil.com` is not in the list, so the middleware returns a 403 `bad_origin` response before any handler logic runs. The cookie was sent, but the origin check blocked the request anyway.

**Q4.** After a deploy, the public site is down (502). No application code changed; only the backend container was recreated. What is the likely cause, and what does it reveal about the security architecture?

**A4.** `cloudflared` (the Cloudflare tunnel daemon) shares the backend container's network namespace via `network_mode: service:backend`. When the backend container is recreated, the network namespace is destroyed and a new one is created. The running `cloudflared` instance still holds a reference to the old namespace — which no longer routes to `localhost:3001`. The fix is to force-recreate `cloudflared` after recreating the backend. The security relevance: cloudflared is the sole inbound path from the internet to the NAS. It runs without any internet-reachable port of its own — it only makes outbound connections to Cloudflare's edge. This is the "no open ports" design that makes the NAS unreachable even without a firewall.

**Q5.** The session cookie is described as JWE, not JWT. Why does this distinction matter for the security of the auth system?

**A5.** A JWT (JSON Web Token) is signed but its payload is base64-encoded and readable by anyone who has the token — the user sub, role, and any other claims are visible to the browser, network observers, and log aggregators that capture the cookie value. A JWE (JSON Web Encryption) is encrypted end-to-end with AES-256-GCM using an HKDF-derived key from `SESSION_SECRET`. The payload is opaque ciphertext. This matters because: (a) the `role` claim (admin/member) cannot be read and replayed or tampered with by a client; (b) even a full cookie value intercepted in a log does not expose user identity or role to the log reader; (c) a forged cookie requires knowledge of `SESSION_SECRET` — without the key, an attacker cannot construct a valid ciphertext.

**Q6.** The production-readiness review found CRITICAL #1: the device-token poll endpoint bypassed the invite allowlist. Explain why this is a "confused deputy" problem, and describe what a correct fix looks like without looking at the actual patch.

**A6.** A confused deputy is when a program with legitimate authority (the backend, which can create device tokens) is tricked into using that authority on behalf of someone who shouldn't have it (an uninvited Plex user). The deputy (backend) confused "this person authenticated successfully via Plex" with "this person is authorized to get a device token." The Plex auth layer confirmed identity; the authorization layer (allowlist) was the missing gate. The fix must call `memberStatus(sub)` (or the full `authorizeOrRedeem` function) inside the poll handler and return a 403 if the result is not `allowed`, before any token minting code runs. The fix should be in the same location as the equivalent gate in the Plex login and Apple login handlers, so all three entry points share the same authorization check.

---

## 7. CODE-READING EXERCISE — Walk Through the CSRF/Origin Gate

**Goal:** Trace a POST request from a malicious page through the CSRF middleware and understand exactly where and why it is rejected.

**Setup:** Open `server/middleware/csrf.ts`. Read it top to bottom. There are two exported middleware functions: `requireSafeOrigin` (for mutating routes) and `requireSafeOriginOnGet` (for GET routes that expose sensitive data).

**Step 1 — Understand `isBearerOnly` (lines ~38–42).**
This function checks: does this request carry an `Authorization: Bearer ...` header AND no `Cookie` header? If yes, it is a native-app request. Ask yourself: why can a native app skip the Origin check, but a browser request cannot? (Hint: can JavaScript on `evil.com` add an `Authorization` header to a cross-origin fetch? Can it prevent the browser from attaching a Cookie?)

**Step 2 — Understand `checkOrigin` (lines ~44–57).**
This function takes the raw `Origin` header value. Trace two paths: (a) what happens when `allowedOrigins` is empty (dev mode — the comment explains the Vite proxy makes everything same-origin); (b) what happens when an `Origin` header is missing entirely (`!origin`) in production — why does a missing Origin result in rejection rather than allow?

**Step 3 — Follow a real forged request.**
Imagine: `origin = "https://evil.com"`, `env.allowedOrigins = ["https://theemeraldexchange.com"]`. Walk `checkOrigin` line by line. What value does it return?

**Step 4 — Find the callers.**
Search the codebase for `requireSafeOrigin` usages (`grep -rn requireSafeOrigin server/`). List three routes it protects. Notice which routes use `requireSafeOriginOnGet` instead — why would a GET route need origin protection at all? (Hint: look at what those routes return.)

**Step 5 — Find the gap.**
Read LOW finding #3 from the production-readiness review: "CSRF Origin gate exempts any request that presents a Bearer header and omits a Cookie." Now look at `isBearerOnly` again. Is there any case where an attacker's JavaScript could present a Bearer header with no Cookie? (Research: can browser `fetch()` set the `Authorization` header on a cross-origin request?) What does your answer imply about whether this gap is exploitable?

**Discussion question:** After completing the exercise, explain in one sentence why the combination of Origin-gating + invite-allowlist + JWE session provides defense-in-depth rather than relying on any single check.

---

