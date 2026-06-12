
# Teaching Dossier: server/middleware — The Bouncer Layer

---

## 1. WHAT

Every HTTP request that arrives at theemeraldexchange's Hono backend passes through a stack of middleware functions before any route handler ever sees it. Think of middleware as a row of bouncers at a nightclub door: each one checks one thing, stamps your hand or turns you away, then passes you to the next. In this codebase the line-up is: (1) a CORS preflight handler that tells browsers which origins are allowed to talk to the API; (2) `requireSafeOrigin`, which blocks forged cross-site write requests by checking the `Origin` header; (3) `requireAuth` (or `requireAdmin`), which reads and validates an encrypted session cookie or a device Bearer token and attaches a `session` object to the request context; and (4) `rateLimit`, applied on expensive individual routes to prevent a single authenticated user from hammering indexer searches or triggering runaway disk I/O. A request that gets past all four bouncers finally reaches the handler, which can trust that `c.var.session` is populated, the caller came from a trusted origin, and they haven't exceeded their request budget. A request that fails any check gets a plain JSON error and an HTTP status code (401, 403, or 429) — the handler code is never invoked.

---

## 2. WHY

**Why Origin-gate writes (not reads)?**
Session cookies are set with `SameSite=None` in production because the SPA lives on Netlify (e.g., `app.theemeraldexchange.com`) while the API lives on the NAS (`api.theemeraldexchange.com`) — two different origins. `SameSite=None` means the browser *automatically attaches the cookie to every cross-origin request*, even from a hostile third-party page. An attacker can embed `<img src="https://api.theemeraldexchange.com/api/radarr/movies" />` and the browser helpfully sends the victim's cookie. The defence is to check the `Origin` header: browsers always send it on cross-origin requests, and they don't let JavaScript forge it. For GET/HEAD (reads) the worst-case leak is data the user could already see by visiting the SPA, so only a few GET routes with server-side write side-effects (like the recommender's recently-shown log) are gated. All POST/PUT/PATCH/DELETE routes are always gated.

**Why is Bearer auth exempt from the Origin check?**
CSRF is a *cookie-riding* attack. The attack works because the browser silently attaches the victim's cookie. An `Authorization: Bearer <token>` header is *never* automatically attached by the browser — JavaScript on an attacker's page cannot read the token from the victim's device (it's in Keychain), and even if it could construct the header, it would need the token value, which it doesn't have. So for requests that carry a Bearer and no Cookie there is nothing for CSRF to exploit: the Origin check is skipped. If a request carries *both* a Bearer and a Cookie, the Cookie is still a CSRF vector, so Origin is still checked.

**Why the 15-minute membership revalidation cache?**
Session cookies live for 30 days. Without revalidation, a user whose Plex share was revoked at day 1 would keep accessing the dashboard until day 30. But calling `plex.tv` on every single request would (a) add ~100–500 ms latency to every API call, (b) make the whole app depend on plex.tv uptime, and (c) burn plex.tv rate limits. The cache gives a 15-minute window: fast for normal requests, quick enough to lock out a revoked user without hammering an external API. A 5xx or network timeout from plex.tv keeps the user signed in (fail-open) — a plex.tv outage shouldn't lock out an entire household.

**Why encrypt the session cookie (JWE) instead of just signing (JWT)?**
The cookie payload contains the user's Plex authentication token. A signed-but-unencrypted JWT is base64-readable by anyone who captures a cookie from a log, browser devtools, or a proxy. JWE (JSON Web Encryption) makes the cookie opaque even if intercepted.

**Why in-process token buckets for rate limiting (not Redis)?**
The deployment target is a single NAS process. An in-memory `Map` is zero-latency and zero-dependencies. The code comments explicitly call out that this must move to a shared store if the service ever runs as multiple replicas (the same comment references the M5 multi-replica milestone).

---

## 3. MAP

### Key files

| File | Line range | What it does |
|------|-----------|--------------|
| `server/app.ts` | 57–82 | Mounts CORS middleware (prod only) then `requireSafeOrigin` globally on `*` |
| `server/middleware/csrf.ts` | 1–92 | `requireSafeOrigin` + `requireTrustedOrigin`; `isBearerOnly` exemption |
| `server/middleware/auth.ts` | 1–101 | `requireAuth` + `requireAdmin`; `loadReconciledSession` dispatches Bearer vs cookie |
| `server/middleware/deviceTokenAuth.ts` | 1–76 | `tryBearerAuth`; JWE decrypt via Rust crate + time-window + reconcile |
| `server/middleware/rateLimit.ts` | 1–111 | Token-bucket factory; per-sub keyed buckets; lazy refill |
| `server/session.ts` | 64–84 | `Session` type; `readSession` reads + decrypts the cookie |
| `server/services/sessionGate.ts` | 58–225 | `reconcileSession`; 15-min membership cache; role recompute; cascade revoke |
| `server/env.ts` | 101–407 | `allowedOrigins` parsed from `ALLOWED_ORIGINS` env var |

### Walkthrough: an authenticated POST /api/radarr/movies (add a movie)

```
Browser (Netlify SPA, origin: https://app.theemeraldexchange.com)
  │
  │  POST /api/radarr/movies  HTTP/1.1
  │  Origin: https://app.theemeraldexchange.com
  │  Cookie: eex.session=<JWE>
  │  Content-Type: application/json
  │
  ▼
[app.ts:52] logger() — logs the incoming request
  │
  ▼
[app.ts:57-76] cors() — POST is not an OPTIONS preflight, so CORS just
  sets response headers (Access-Control-Allow-Origin, etc.). Passes through.
  │
  ▼
[app.ts:82] requireSafeOrigin (csrf.ts:61-75)
  ├─ Method is POST → STATE_CHANGING → must check
  ├─ isBearerOnly()? No (Cookie present, no Authorization header)
  ├─ checkOrigin("https://app.theemeraldexchange.com")
  │     env.allowedOrigins includes this origin → { ok: true }
  └─ next() ✓
  │
  ▼
[routes/radarr.ts] app.use('/api/radarr/*', requireAuth)
  ↓
[auth.ts:65-81] requireAuth → loadReconciledSession(c)
  ├─ tryBearerAuth(c) → no Authorization header → returns null
  ├─ readSession(c) → getCookie("eex.session") → verifySession(JWE)
  │     jwtDecrypt with HKDF key → Session { sub, username, role, plexAuthToken }
  ├─ reconcileSession(decoded)   [sessionGate.ts:138-225]
  │     ├─ roleFor(username, sub) — recomputes role from env.admins right now
  │     ├─ memberStatus(sub) — checks invite/members allowlist → 'allowed'
  │     ├─ authMode is 'plex' + plexServerId + plexAuthToken present
  │     ├─ cache.get(sub) → MISS (or > 15 min old)
  │     ├─ checkMembership(plexAuthToken) → probeResources() → plex.tv HTTP call
  │     │     → 'member'
  │     ├─ setCached(sub, { status:'member', checkedAt:now, tokenFingerprint })
  │     └─ returns { ...session, role: 'user' }
  ├─ c.set('session', reconciledSession)
  └─ next() ✓
  │
  ▼
[routes/radarr.ts] rateLimit({ name:'radarr-mutate', capacity:10, ... })
  ├─ key = "sub:plex:494190801"
  ├─ bucket has 9 tokens remaining → consume 1 → 8 left
  └─ next() ✓
  │
  ▼
Route handler: reads c.var.session, calls Radarr API, returns 200
```

---

## 4. PREREQUISITES

A beginner needs these concepts before tackling this code:

- **HTTP request/response model** — status codes (200/401/403/429), headers (Origin, Cookie, Authorization), methods (GET vs POST).
- **Cookies** — what they are, how the browser attaches them automatically, what `HttpOnly`, `Secure`, and `SameSite` mean.
- **JWT basics** — the three-part structure, the difference between signing (JWT) and encrypting (JWE), what `sub`/`exp`/`iat` claims mean.
- **Middleware pattern** — the idea that a web framework chains functions that each call `next()` or short-circuit with a response.
- **CSRF attacks** — how a hostile page can trick a browser into making credentialed requests to a different site, and why `SameSite=None` re-opens the door for cross-origin apps.
- **CORS** — what preflight requests are, why browsers enforce the same-origin policy, how `Access-Control-Allow-Origin` lets a server opt in to cross-origin access.
- **Closure / factory pattern in JavaScript** — `rateLimit(opts)` returns a middleware function; understanding why the inner function closes over `opts`.
- **TypeScript generics / branded types** — `MiddlewareHandler<Env>` lets `c.var.session` be typed throughout the app.

---

## 5. GOTCHAS & WAR STORIES

### The CSRF bearer-exemption incident (device writes 403'd in prod)

When the iOS/tvOS native app was first wired up (M2 device-token work), every write it attempted returned 403 `bad_origin`. The native app correctly sends `Authorization: Bearer <JWE>` — but the early version of `requireSafeOrigin` had no Bearer exemption. The middleware saw a POST with no matching Origin and rejected it. The fix (`isBearerOnly` check in `csrf.ts:38-42`) was straightforward once the root cause was clear: a Bearer-only request has no ambient cookie credential, so CSRF cannot apply. The invariant is now explicit in the code comment: "a request that presents BOTH a bearer and a cookie is still gated — the cookie remains a CSRF vector regardless of the bearer."

Memory note: this is logged in project memory as `project_csrf_bearer_exemption` — "Origin gate 403'd all device writes/playback; fixed+deployed (b3b692c)".

### POST-needs-Origin test gotcha

When writing tests or scripts that mint an admin session cookie and fire POST requests directly (e.g., `scripts/m4-transcode-proof.sh`, or the Playwright-driven proofs for media playback), the POST silently returns 403 if you forget to include `Origin: https://app.theemeraldexchange.com`. `fetch()` in a browser sets Origin automatically; `curl` and `node-fetch` in scripts do NOT. The error response is `{"error":"forbidden","reason":"bad_origin"}` with status 403 — easily confused with an auth failure. Always add `-H "Origin: https://app.theemeraldexchange.com"` (or the equivalent in your HTTP client) when testing write endpoints from scripts.

### The plex.tv fail-open vs fail-closed tension

`reconcileSession` fails *open* on plex.tv network errors (the user stays signed in) but fails *closed* on a definitive `401/403` from plex.tv (cookie is cleared + cascade revoke fires). This has been intentionally asymmetric since day one: a plex.tv outage should not log out every household member simultaneously. However, the code went through a significant refactor: the primary authZ decision is now the local invite/members allowlist (`memberStatus(sub)`). The plex.tv probe was *demoted* to an optional defense-in-depth signal that can still fire a cascade-revoke on a definitive auth_revoked signal, but a "not_member from plex.tv" result no longer overrides a present allowlist row. This matters: if you test by removing someone from the Plex server but NOT from the members table, they will remain admitted.

### Bearer-vs-cookie priority and the "explicit beats implicit" rule

`loadReconciledSession` tries Bearer *first*. If a Bearer header is present but invalid (e.g., expired, revoked jti), the middleware returns 401 immediately — it does NOT fall back to the cookie. This is deliberate: a stale or revoked device token is a security signal, and silently falling back to the cookie would let an attacker who somehow captured the cookie bypass a freshly-revoked device token. This surprises developers who test with both headers present.

### The 15-minute cache and "why is this user still logged in?"

If you revoke a user from the members table and they happen to have hit the API 1 minute ago, they will remain authenticated for up to 14 more minutes because `reconcileSession` reads the in-process cache and skips the allowlist re-check. The cache is keyed by `sub` and lives in process memory — a backend restart clears it. `_resetSessionGateCacheForTests()` exists for exactly this reason.

---

## 6. QUIZ BANK

**Q1.** A user's Plex share is revoked at 2:00 PM. They make an API call at 2:01 PM. The cache was last refreshed at 1:55 PM. What happens, and why?

**A1.** The user is admitted. `reconcileSession` reads the cache entry for their sub; `now - cached.checkedAt` is 6 minutes, which is less than `REVALIDATE_TTL_MS` (15 minutes). The stale 'member' result is returned without re-probing plex.tv. They will continue to be admitted until the cache entry is 15 minutes old (i.e., until 2:10 PM), at which point the next request triggers a fresh plex.tv probe that will discover the revocation.

**Q2.** Your iOS app sends `POST /api/radarr/movies` with `Authorization: Bearer <valid-JWE>` and `Cookie: eex.session=<valid-JWE>`. Which credential does `requireAuth` use, and what happens to the Origin check?

**A2.** `requireAuth` calls `loadReconciledSession`, which calls `tryBearerAuth` first — Bearer wins. `isBearerOnly()` in the CSRF middleware returns `false` because a Cookie header IS present alongside the Bearer. The CSRF gate therefore still applies and checks the Origin header. The bearer credential is used for the session, but the origin check is not skipped.

**Q3.** You add a new GET route `/api/suggestions/recent` whose handler writes a `recently_shown` record into the database. Should you apply `requireSafeOrigin` or `requireTrustedOrigin`? Why?

**A3.** `requireTrustedOrigin`. `requireSafeOrigin` only gates `POST/PUT/PATCH/DELETE` methods — it calls `next()` immediately for GET without checking Origin. `requireTrustedOrigin` checks Origin regardless of HTTP method, which is what you need for a GET that has a write side-effect. Without it, a hostile cross-origin page could poison the recently-shown state by embedding a credentialed GET request.

**Q4.** A user makes 11 rapid POST requests to `/api/radarr/movies` within 10 seconds. The `rateLimit` for that route has `capacity:10, refill:10, intervalMs:60000`. What does the 11th request receive, and what header is included in the response?

**A4.** The 11th request receives HTTP 429 with body `{"error":"rate_limited","retry_after_ms":<N>}`. The response also includes the standard `Retry-After` header set to the number of whole seconds until the bucket refills. The bucket drops to 0 tokens on the 10th request; the 11th request finds `bucket.tokens < 1` and returns early without calling `next()`.

**Q5.** A device token's `jti` row exists in `device_tokens` but also appears in `device_token_revocations`. `verifyDeviceToken` is called with this token. What is returned, and what is logged?

**A5.** `verifyDeviceToken` returns `null` and logs `[device-token] jti revoked: <jti>`. The DB check queries both tables: it first confirms the row exists in `device_tokens` with a future `expires_at`, then checks `device_token_revocations`. A hit in the revocations table causes an immediate `null` return regardless of the token's cryptographic validity.

**Q6.** In a local dev environment, `ALLOWED_ORIGINS` is not set. A developer fires `POST /api/feedback` with no `Origin` header. Does it pass the CSRF gate?

**A6.** Yes. `env.allowedOrigins.length === 0` and `env.isProd` is false (since `NODE_ENV !== 'production'`). `checkOrigin` hits the `if (env.allowedOrigins.length === 0)` branch, checks `env.isProd`, finds it false, and returns `{ ok: true }`. In dev, Vite proxies `/api/*` so all real browser requests are same-origin anyway — this branch is "same-origin via Vite proxy, let it through."

---

## 7. CODE-READING EXERCISE

### File: `server/middleware/csrf.ts` — a guided walk

Open `/Users/cujo253/Documents/theemeraldexchange/server/middleware/csrf.ts`.

**Step 1 (lines 1–22): Read the module comment.**
Before looking at any code, read the comment block. Notice it explains *why* `SameSite=None` is required (two different origins), *why* that creates a CSRF exposure, *why* the defence is Origin-checking rather than a token, and *why* reads are exempted. This comment-first style is intentional in this codebase — the code is short, the reasoning is what matters.

**Step 2 (lines 27–27): The STATE_CHANGING Set.**
`const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])`. Ask yourself: why is this a `Set` rather than an `Array`? Answer: `Set.has()` is O(1) vs `Array.includes()` O(n). For a global middleware that runs on every request, micro-efficiency matters. Also notice what is absent: `OPTIONS` is not in the set. Why? Because `OPTIONS` is the CORS preflight method — the browser sends it *before* a real cross-origin request, and it never carries a cookie, so it cannot be a CSRF vector.

**Step 3 (lines 38–42): `isBearerOnly`.**
Read this function carefully. It returns `true` only when BOTH conditions hold: an `Authorization: Bearer ...` header exists AND no `Cookie` header is present. Trace through what happens if only one condition holds:
- Bearer header, no Cookie → `true` (exempt from Origin check)
- Cookie header, no Bearer → `false` (Origin check applies)
- Both Bearer and Cookie → `false` (Origin check applies)
- Neither → `false` (still checked, will fail if origin is wrong)

**Step 4 (lines 44–58): `checkOrigin`.**
Notice the two-layer guard: first check if `allowedOrigins.length === 0` (the dev path), then check if `env.isProd`. Why check `isProd` *inside* the empty-origins branch? Because `env.ts` refuses to boot in prod without `ALLOWED_ORIGINS` set — so reaching `allowedOrigins.length === 0` in prod means something bypassed the startup guard. The comment calls this "belt-and-suspenders." Now trace the prod path: `allowedOrigins` has entries, `origin` header is checked with `includes()`. Why exact string match rather than a regex? Regex origin-matching is famously error-prone (e.g., `https://evil.com?real.com` matching a regex for `real.com`). Exact match is the safe choice.

**Step 5 (lines 61–75 and 82–92): Two exported middlewares.**
`requireSafeOrigin` has the early-exit for non-STATE_CHANGING methods at line 62–65. `requireTrustedOrigin` does NOT have that early-exit — it checks every method. Find a route that uses `requireTrustedOrigin` by grepping: `grep -rn "requireTrustedOrigin" server/routes/`. Notice it is applied to `/api/suggestions/:type` — the GET route that writes the recommender's recently-shown log.

**Reflection questions:**
1. If an attacker's page fires `GET /api/suggestions/new` with the victim's cookie via a background `fetch()`, what prevents their request from poisoning the recently-shown state?
2. If you forgot to add `isBearerOnly` exemption to `requireTrustedOrigin`, what would happen to a tvOS device requesting its suggestion list via Bearer token?
3. Where in the app is `requireSafeOrigin` mounted, and at what scope? (Hint: look at `server/app.ts` lines 78–82.)

---

