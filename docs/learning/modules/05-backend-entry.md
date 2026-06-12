
# Teaching Dossier: Backend Process Entry and App Assembly

---

## 1. WHAT

When you run this backend, Node.js executes `server/index.ts` first. That file does a short checklist — confirm ffmpeg exists, initialise crash-reporting (Sentry/Glitchtip), open the main SQLite database, then hand the whole HTTP-handling logic to `@hono/node-server`, which starts listening on port 3001. All of the actual routing rules (which URL does what) live in a separate file, `server/app.ts`, so that test code can import just the routing logic without ever opening a real network socket. `server/env.ts` is loaded even earlier — the moment either of those files imports it, it reads the `.env.local` and `.env` files from disk and validates every expected variable, throwing immediately if something required is missing. The result is a strongly-typed `env` object that the rest of the server reads like a normal JavaScript object: `env.port`, `env.useMediaCore`, `env.allowedOrigins`, and so on. Feature flags like `USE_MEDIA_CORE=1` and `IPTV_DISABLED=1` live in that env object and control which route trees get mounted at startup — if a flag is off, the matching `/api/*` path simply does not exist.

---

## 2. WHY

**Splitting app.ts from index.ts** is a standard Hono/Express pattern. The motivating constraint is testability: `@hono/node-server` binds a real TCP socket, which slows tests, can conflict on CI if ports are reused, and requires teardown. By exporting the raw `app` object from `app.ts`, any test file can call `app.request(new Request('http://localhost/api/health'))` with no network overhead. `index.ts` is the only file that ever calls `serve()`.

**Fail-fast env validation** prevents a class of silent production failures. Without it a typo in `MIN_FREE_GB` would produce `NaN`, and `freeSpace < NaN` is always `false` in JavaScript, silently disabling the disk-space guard that prevents filling the NAS. Every numeric env var is parsed through `positiveNumber()` or `positiveInt()` which throw at boot, not at the moment a request triggers the guard.

**Feature-flag-gated route mounting** (`if (!env.IPTV_DISABLED)`, `if (env.useMediaCore)`) reflects a concrete business constraint: the same Docker image ships to NAS households that have no IPTV subscription and to those that do. Rather than building separate images, a single env var at deploy time determines which surface the image exposes. The App Review submission for iOS uses this: setting `IPTV_DISABLED=1` removes the IPTV tab from the server side for that review build.

**CSRF via Origin-header check** (not a token) is the right trade-off for this topology. Session cookies are `SameSite=None` because the SPA is on Netlify (one origin) while the API is on the NAS via a Cloudflare Tunnel (another origin). `SameSite=Strict` would have been simpler but would block every legitimate SPA request. With `SameSite=None` the browser auto-attaches the cookie to any cross-origin request, so a hidden `<img>` or `<form>` on an attacker page can ride it. The Origin header is the only reliable browser-supplied signal that a state-changing POST came from the trusted SPA tab rather than an attacker page — so CSRF protection is an Origin allowlist, not a double-submit token.

**Separate secrets for separate concerns** (SESSION_SECRET, STREAM_TOKEN_SECRET, DEVICE_TOKEN_SECRET, INTERNAL_PRINCIPAL_SECRET) follow the principle of blast-radius containment. If a stream-token can be used to forge a session cookie, a single token compromise owns the user's account. Keeping them distinct and asserting distinctness at boot means a copy-paste mistake is caught immediately, not discovered after a security audit.

**Graceful shutdown order** (cron → listener → ffmpeg children → Sentry flush → DBs) is the only order that is safe. Stopping the cron first ensures no backup job opens a DB connection after the close call. Draining ffmpeg children before closing DBs ensures a remux session cannot still be writing a temp file to a DB-backed path. Reversing any step can produce a corrupted DB or an orphaned ffmpeg process.

---

## 3. MAP

```
server/env.ts        — line 44:  dotenvConfig() loads .env.local then .env
server/env.ts        — line 47:  required(), csv(), opt(), positiveNumber() helpers
server/env.ts        — line 101: isProd, allowedOrigins, feature-flag booleans computed
server/env.ts        — line 375: `export const env = { … } as const`  ← everything else reads this

server/app.ts        — line 38:  `export const app = new Hono()`
server/app.ts        — line 46:  app.onError(…)     ← global error handler (Sentry capture + 500)
server/app.ts        — line 52:  app.use('*', logger())   ← request/response logging
server/app.ts        — line 57:  app.use('*', cors(…))    ← CORS (only when allowedOrigins non-empty)
server/app.ts        — line 82:  app.use('*', requireSafeOrigin)  ← CSRF gate
server/app.ts        — line 91:  app.get('/api/health', …)  ← liveness probe (probes server.db)
server/app.ts        — line 104: app.get('/api/limits', …)  ← public feature-flag mirror for SPA
server/app.ts        — line 135: route tree mounts (auth, passkey, version, devices, *arr, iptv…)
server/app.ts        — line 170: if (!env.IPTV_DISABLED) app.route('/api/iptv', iptv)
server/app.ts        — line 203: if (env.useMediaCore)   app.route('/api/media', …) + /api/transcode

server/index.ts      — line 36:  validateFfmpegOrExit()       ← boot abort if ffmpeg missing
server/index.ts      — line 44:  Sentry.init(…) or log.warn   ← telemetry init
server/index.ts      — line 64:  ensureServerId()             ← server.db open + server_id upsert
server/index.ts      — line 74:  serve({ fetch: app.fetch, port: env.port }, …)  ← TCP listener
server/index.ts      — line 85:  registerDbBackupSchedule(…) ← cron always registered
server/index.ts      — line 93:  registerIptvSchedule(…)     ← only when IPTV creds present
server/index.ts      — line 117: shutdown()                  ← SIGINT/SIGTERM handler

server/middleware/csrf.ts — line 61: requireSafeOrigin  ← skips GET/HEAD, skips bearer-only
server/middleware/csrf.ts — line 82: requireTrustedOrigin ← also gates GET/HEAD (for side-effectful GETs)
```

**Startup walkthrough (in order):**

1. Node starts. TypeScript has been compiled to `dist/server/index.js` (prod) or tsx/ts-node runs it (dev).
2. `import { env } from './env.js'` triggers `env.ts` module evaluation: dotenv reads `.env.local`, then `.env`; all `required()` calls throw if vars are missing; feature booleans are set; `env` object is frozen as `const`.
3. `import { app } from './app.js'` triggers `app.ts` module evaluation: `new Hono()` is created; `onError`, `logger`, `cors`, `requireSafeOrigin` middleware are attached in order; all static routes are mounted; IPTV and media routes are conditionally mounted based on `env`.
4. Back in `index.ts`: `validateFfmpegOrExit()` — if ffmpeg is absent or too old, `process.exit(1)` now.
5. `Sentry.init(…)` — if `EEX_TELEMETRY_DSN` is set.
6. `ensureServerId()` — opens `server.db`, runs migrations, upserts the server identity row.
7. `serve({ fetch: app.fetch, port: env.port }, …)` — TCP socket opens, server is live.
8. Cron tasks registered (DB backup always; IPTV sync only when creds present).
9. `process.once('SIGINT', shutdown)` and `SIGTERM` registered.

**Data-flow for an API request:**

```
Browser/app
  → (Cloudflare Tunnel in prod, Vite proxy in dev)
  → TCP :3001
  → @hono/node-server (passes Request to app.fetch)
  → app.onError  [wraps entire chain]
  → logger middleware  [logs method + path]
  → cors middleware    [adds CORS headers if prod]
  → requireSafeOrigin [403 if POST/PUT/DELETE from wrong origin]
  → matched route handler
  → Response back through the chain
```

---

## 4. PREREQUISITES

- **JavaScript module system (ESM `import`/`export`)** — every file uses ESM; understanding that module evaluation is eager (runs top-to-bottom when first imported) explains why `env.ts` validation fires at startup, not at first use.
- **`process.env` and `.env` files** — env vars are the primary configuration mechanism; without knowing what `process.env.FOO` is, none of the env loading makes sense.
- **TypeScript `as const` and object shapes** — `env` is exported `as const`; TypeScript will report a type error if any consumer reads a key that doesn't exist, which is how the contract test can catch mock drift.
- **HTTP methods and headers (GET vs POST, Origin, Authorization, Cookie)** — the CSRF middleware's logic is entirely about which headers browsers set automatically; without this, the "SameSite=None + Origin check" rationale is opaque.
- **What middleware is in a web framework** — the `app.use('*', fn)` calls run before every matching route; understanding that the order of `app.use` calls is the order of execution is the prerequisite for the quiz questions about middleware ordering.
- **SIGINT and SIGTERM** — the graceful shutdown handler is registered on these signals; knowing what they are (keyboard Ctrl-C vs docker stop) explains why the server needs to handle both.
- **Basic SQLite / what a database connection is** — the health check and the shutdown teardown sequence both involve opening and closing a DB; a beginner needs to know a DB connection is a resource that must be closed.

---

## 5. GOTCHAS & WAR STORIES

**The trailing-newline PLEX_CLIENT_ID bug (env.ts line 385).** When a developer copies a UUID from a generator into `.env`, some generators append a newline. `process.env.PLEX_CLIENT_ID` then ends in `\n`. Without the `.trim()` call, the header the server sends to plex.tv contains the newline while the URL parameter the browser sends has it percent-encoded as `%0A`. Plex treats them as two different client identifiers; the server polls a PIN that was authorised for `%0A`-version and receives `{authToken: null}` forever. Session just never completes. The fix is a single `.trim()` and a very specific comment.

**The docker-compose empty-string trap (env.ts line 63-69).** `docker-compose` expands `${VAR:-}` (the default-empty syntax) into an empty string `""` rather than removing the variable from the environment. JavaScript's `?? 'fallback'` only triggers on `null` or `undefined` — an empty string is neither, so `process.env.SONARR_URL ?? 'http://nas:8989'` would return `""` (the empty string), not the NAS fallback. The `opt()` helper in env.ts explicitly converts empty strings to `undefined` before the `??` so Docker compose deployments get the correct NAS defaults.

**The env mock drift problem (env.contract.test.ts).** Route tests mock `env.js` wholesale with hand-written objects. When a key is renamed in `env.ts` (say `useMedia` → `useMediaCore`), the route test mock still has the old key, so the mock returns `undefined` for the new key — but the test passes because the mock never threw. `env.contract.test.ts` closes this gap by scanning every test file that calls `vi.mock('../env.js', …)`, extracting the keys from the mock factory, and asserting each still exists on the real `env`. A rename in `env.ts` without updating the mocks will now fail loudly in CI rather than silently in production.

**Bearer-only requests exempt from CSRF (csrf.ts line 38-42).** The iOS/tvOS native app authenticates with a JWT Bearer token and sends no cookie. The entire CSRF rationale is that browsers auto-attach cookies to cross-origin requests — a bearer token is never auto-attached. If you add a new endpoint and forget this distinction, you might add `requireSafeOrigin` to an Apple-client route and 403 every native-app request. The inverse gotcha: a request that sends BOTH a bearer AND a cookie is still gated (the cookie is still a CSRF vector regardless of the bearer).

**`/api/health` probes the DB, not just the process (app.ts line 91-98).** An early version returned `{ok: true}` unconditionally. Cloudflared's `depends_on: service_healthy` and the docker healthcheck both poll this endpoint. When `server.db` was locked or corrupt, every API route returned 500 — but the health endpoint said 200, so cloudflared never failed over and docker never restarted the container. The public site just returned 500 forever. The fix is the `SELECT 1` probe inside a `try/catch`.

**Middleware order is not cosmetic (app.ts lines 46-82).** `onError` must be first because Hono's error handler is a catch-all that wraps everything registered after it. `logger` should be early so every request (including ones that CSRF-reject) is logged. `cors` must run before `requireSafeOrigin` because a preflight `OPTIONS` request sets the Origin header and expects CORS headers back — if CORS ran after the CSRF gate, OPTIONS preflights would 403. `requireSafeOrigin` must run before route handlers so no business logic executes on a forged-origin POST.

---

## 6. QUIZ BANK

**Q1.** The CORS middleware is only applied when `env.allowedOrigins.length > 0`. A developer working locally never sets `ALLOWED_ORIGINS`. What happens to cross-origin requests in dev — do they get CORS headers? Why or why not, and is that safe?

**A1.** No CORS headers are sent. In dev, the Vite dev server proxies `/api/*` to `:3001`, so from the browser's perspective every request is same-origin (origin `localhost:5173` talking to `localhost:5173` via the proxy). The browser never sees a cross-origin response and never triggers a CORS preflight. This is safe because the Vite proxy is the same-origin boundary — the API is never directly exposed to the browser at a different origin in dev. In production, Netlify and the NAS are different origins, so `ALLOWED_ORIGINS` must be set or CORS headers are missing and the SPA cannot make requests.

**Q2.** A teammate moves the `app.use('*', requireSafeOrigin)` call to be BEFORE `app.use('*', cors(...))` (swaps lines 57-76 and 82). What breaks, and what kind of request triggers it?

**A2.** CORS preflight (`OPTIONS`) requests break. When a browser is about to make a cross-origin POST with credentials, it first sends an `OPTIONS` preflight. That `OPTIONS` carries an `Origin` header. `requireSafeOrigin` only passes methods not in `{POST, PUT, PATCH, DELETE}` — `OPTIONS` is not in that set, so it passes. But wait — actually OPTIONS passes fine through `requireSafeOrigin`. The real breakage: CORS must respond to OPTIONS BEFORE route handlers (including auth-checking route handlers) see it. If cors() runs after requireSafeOrigin, the origin check runs first on OPTIONS and might 403 before cors() ever adds the `Access-Control-Allow-Origin` header — meaning the preflight fails with a CORS error and the real POST is never sent. In practice the ordering matters most when any middleware rejects OPTIONS before cors() can respond to it.

**Q3.** `USE_MEDIA_CORE` is not set in the docker-compose file for a household that only uses IPTV. A user hits `/api/media/library`. What response do they get, and why?

**A3.** HTTP 404. In `app.ts`, the `if (env.useMediaCore)` block at line 203 is evaluated at module load time. `process.env.USE_MEDIA_CORE` is not `'1'`, so `env.useMediaCore` is `false`, so `app.route('/api/media', media)` is never called. Hono's default behaviour for an unmatched path is a 404. The media routes are never registered; they don't exist at runtime.

**Q4.** A developer adds a new env var `WEBHOOK_SECRET` to `env.ts` and changes its key name from `webhookSecret` to `webhook_secret` three days later. Tests all pass in CI. Six weeks later, a production incident reveals the webhook verification is silently accepting all payloads. What went wrong and how would you have caught it earlier?

**A4.** The route test for the webhook handler mocked `env.js` with `{ webhookSecret: 'test-secret' }`. After the rename, the real `env` exports `webhook_secret`, but the mock still has `webhookSecret`. The route test read `env.webhookSecret` from the mock (truthy) and passed. In production, `env.webhookSecret` is `undefined` — so the condition `if (env.webhookSecret && hmac !== expected)` short-circuits and accepts everything. `env.contract.test.ts` would have caught this: it scans every mock file for keys declared on the fake env and asserts they exist on the real env. After the rename, the test would fail with "`route.test.ts: mocks env.webhookSecret, which no longer exists on the real env`".

**Q5.** The graceful shutdown function drains ffmpeg children (`drainRemuxSessions()`) BEFORE closing the databases, but AFTER `server.close()`. Why does the order relative to `server.close()` matter?

**A5.** `server.close()` stops accepting new HTTP connections but allows in-flight requests to complete. An in-flight `/api/iptv/stream` request may be running an ffmpeg remux child that writes to the iptv temp directory and whose session is tracked in `iptv.db`. If we closed `iptv.db` before draining those children, a still-running ffmpeg could attempt to finalise a segment while the DB handle is closed, causing either a write error or DB corruption. More concretely: `drainRemuxSessions()` sends SIGTERM to every child and waits for exit. Only after all children have exited (no more DB writes can happen) do we close `iptv.db` then `server.db`. `server.close()` running first ensures no new stream requests are accepted while we're draining, which bounds the drain time.

---

## 7. CODE-READING EXERCISE

**File: `server/env.ts` — guided walk**

Open `server/env.ts` at `/Users/cujo253/Documents/theemeraldexchange/server/env.ts`.

**Step 1 (lines 40-45): Loading order.**
Find the two `dotenvConfig(...)` calls. They load `.env.local` first, then `.env`. `dotenv` does not overwrite already-set variables on a second call. Ask yourself: if `SESSION_SECRET` is defined in both `.env.local` and `.env`, which value wins? Why would you put credentials in `.env.local` instead of `.env`? (Answer: `.env.local` is gitignored and never committed; `.env` may be committed with safe defaults.)

**Step 2 (lines 47-96): The four helper functions.**
Read `required()`, `csv()`, `opt()`, and `positiveNumber()`. Notice that `opt()` has special handling for empty strings at line 68 — read the comment above it that starts "docker-compose's ${VAR:-} expansion…". Then look at `positiveNumber()` lines 76-86 and find the comment about `NaN`. Close the file and ask yourself: what would happen if `positiveNumber` just did `return Number(raw)` without the `Number.isFinite` check?

**Step 3 (lines 100-135): Production gates.**
Find the three `if (isProd && …) throw new Error(…)` blocks. The first is for `ALLOWED_ORIGINS` (line 107), the second for `PLEX_SERVER_ID` (line 125), the third for root folder paths (line 149). Notice the escape hatch pattern: `ALLOW_UNSCOPED_PLEX_LOGIN=1` bypasses the PLEX_SERVER_ID requirement. Why is an escape hatch safer than just removing the requirement? (Answer: forcing the operator to set a flag acknowledges they know the risk; a missing requirement would silently allow any Plex user to log in without the operator noticing.)

**Step 4 (lines 263-268): Secret distinctness check.**
Find `assertSecretsDistinct(...)`. Notice it runs in ALL environments, not just prod. Trace one step up and look at what four secrets it receives. Why does a copy-paste of `SESSION_SECRET` as `STREAM_TOKEN_SECRET` matter? If both secrets are the same, a stream token can be used to forge a session cookie (or vice versa) — two separate key-spaces collapse into one.

**Step 5 (lines 375-621): The exported object.**
Scan the `export const env = { … } as const` block. Find `useLocalRecommender` (line 511) and `useMediaCore` (line 523). Notice these are plain booleans, not strings. Trace them back up to lines 137-138 where they're set: `process.env.USE_LOCAL_RECOMMENDER === '1'`. The `=== '1'` comparison means the env var must be exactly the string `"1"` — `"true"` or `"yes"` would not work. Now look at `IPTV_DISABLED` at line 599 — it accepts both `'1'` and `'true'`. Ask yourself: is that inconsistency intentional or accidental? (The comments give a hint: IPTV_DISABLED was added later and the author was more permissive.)

---

