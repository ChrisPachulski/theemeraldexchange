
# Part 0: Web Fundamentals — Teaching Dossier

---

## 1. WHAT

This module climbs a single ladder: from "what is a computer doing when it runs code" all the way to "what happens when you click Play on The Emerald Exchange." Each rung is the minimum needed to make the next rung make sense. You will not write code yet — you will learn to *read* what is already here and understand why each piece exists. By the end you can trace a real request from the browser button click, through the network, into the backend, through the database, and back to the screen — using actual lines from this repository as your map.

---

## 2. CONCEPT LADDER

### Rung 1 — What is a computer program?

**ELI5:** A program is a list of instructions written in a language the computer can follow, one step at a time. The computer has no judgment — it does exactly what it is told, nothing more. When a program starts, the computer loads those instructions into memory and begins executing them in order.

**Repo anchor:** `server/index.ts:1-13` — the comment at the top of this file describes the program's job: "Hono backend entry point." When the NAS starts the backend container, the computer loads this file and begins executing it line by line.

**Why you need this:** Every file in this repo is a program or a fragment of one. Understanding that a program is just a sequential set of instructions stops the magic-box thinking.

---

### Rung 2 — Client vs. Server

**ELI5:** A *server* is a computer that sits somewhere waiting to answer questions. A *client* is whatever is asking the questions — usually a browser on your laptop or phone. The server is always on; the client connects only when it needs something.

**Repo anchor:** `root-README.md:14-17`:
```
- Web client (src/) — React 19 + Vite + TypeScript SPA. Entry src/main.tsx … Served as a static bundle (Netlify in prod) that talks to the backend over /api/*.
- Backend (server/) — Hono + TypeScript … Owns auth, authorization, the IPTV core …
```

In this project: your browser downloads the web client (a bundle of HTML/CSS/JavaScript) from Netlify. That client then talks to the backend running on the NAS at home.

**Why you need this:** Every question about "where does this code run?" is answered by knowing which side of the client/server line it lives on.

---

### Rung 3 — What is HTTP? (Request and Response)

**ELI5:** HTTP is the agreed-upon language that clients and servers use to talk. Every conversation is exactly two messages: the client sends a *request* ("give me the health status"), and the server sends back a *response* ("here it is, and everything is fine").

A request has:
- A **method** — the verb (GET means "give me data," POST means "create or change something").
- A **path** — the address of the resource (`/api/health`).
- Optional **headers** — metadata (what kind of response you want, who you are).
- An optional **body** — the data you are sending (POST requests carry a body; GET usually do not).

A response has:
- A **status code** — a number that summarizes the outcome.
- **Headers** — metadata about the response.
- A **body** — the actual data returned.

**Repo anchor — the health route:** `server/app.ts:91-98`:
```typescript
app.get('/api/health', (c) => {
  try {
    serverDb().raw.prepare('SELECT 1').get()
    return c.json({ ok: true })           // 200 OK — everything is fine
  } catch (e) {
    return c.json({ ok: false, reason: 'db_unavailable' }, 503)  // 503 — server can't serve
  }
})
```

When the browser (or the Docker health-check) sends `GET /api/health`, the server replies with `200 OK` and `{"ok":true}` if the database is reachable, or `503 Service Unavailable` if not.

**Why you need this:** Every interaction with the backend is an HTTP request/response pair. Knowing the method and path tells you what is being asked; the status code tells you what happened.

---

### Rung 4 — HTTP Status Codes

**ELI5:** Status codes are the server's shorthand for "how did that go?" They are grouped by the first digit:
- **2xx** = success (200 OK, 201 Created)
- **4xx** = the *client* did something wrong (400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found)
- **5xx** = the *server* had a problem (500 Internal Server Error, 503 Service Unavailable)

**Repo anchor — 401 from auth middleware:** `server/middleware/auth.ts:65-76`:
```typescript
export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const r = await loadReconciledSession(c)
  if (!r.ok) {
    return c.json({ error: 'unauthenticated' }, 401)
  }
  // ... otherwise let the request through
}
```

Any route that uses `requireAuth` will return `401 Unauthorized` if you have no valid session. The browser receiving a 401 knows: "I need to log in."

**Repo anchor — 403 from admin gate:** `server/middleware/auth.ts:96-98`:
```typescript
  if (r.session.role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'admin_only' }, 403)
  }
```

403 means "you are logged in, but you are not *allowed* to do this." That is the difference between 401 (who are you?) and 403 (I know who you are, and the answer is no).

**Why you need this:** When something goes wrong, the status code is the first thing you look at. A 401 means "go log in." A 403 means "you lack permission." A 500 means "the server crashed."

---

### Rung 5 — What is JSON?

**ELI5:** JSON (JavaScript Object Notation) is a simple text format for sending structured data over the wire. It uses curly braces for objects, square brackets for lists, quotes for strings, and plain numbers for numbers. Both the browser and the server can read and write it.

**Repo anchor:** `server/app.ts:91-98` (same snippet as above). The response body `{ ok: true }` is JSON. The server calls `c.json(...)` which serializes a JavaScript object to JSON text and sets the `Content-Type: application/json` header so the client knows how to parse the reply.

A real `/api/limits` response looks like:
```json
{
  "minFreeGb": 5,
  "maxMovieGb": 50,
  "iptvEnabled": true,
  "mediaEnabled": true
}
```

**Why you need this:** Nearly every API response in this project is JSON. You will read JSON constantly when debugging.

---

### Rung 6 — What is an API?

**ELI5:** An API (Application Programming Interface) is a menu of things the server is willing to do for you. Each item on the menu has an address (path), a method (GET/POST/etc.), and a description of what you send and what you get back. You do not need to know how the kitchen works — just what to order and what will arrive.

**Repo anchor:** `root-README.md:43-52` lists the backend's API surface: `auth`, `me`, `version`, `limits`, `media`, `transcode`, `suggestions`, `feedback`, and more. Each is a path under `/api/`.

In this project the SPA (your browser) calls the backend API to: log you in, list movies, request a transcode, submit a rating, or check your profile.

**Why you need this:** The entire relationship between the web client and the backend is an API contract. "The frontend" does not reach into the database directly — it asks the API.

---

### Rung 7 — What does a browser do with HTML/CSS/JavaScript?

**ELI5:**
- **HTML** is the skeleton — it describes *what* is on the page (a heading, a button, a list).
- **CSS** is the skin — it describes *how things look* (colors, fonts, layout).
- **JavaScript** is the muscles — it makes things *move and respond* (click a button, fetch new data, update what you see without reloading).

When you navigate to `https://theemeraldexchange.com`, Netlify sends your browser a tiny HTML file. That file tells the browser to download JavaScript bundles. Those bundles contain the entire React app. React then builds the page in the browser's memory and displays it. All subsequent navigation happens in JavaScript — no full page reloads.

**Repo anchor:** `root-README.md:15-16`:
```
Web client (src/) — React 19 + Vite + TypeScript SPA. Entry src/main.tsx; app shell in src/App.tsx. Served as a static bundle (Netlify in prod) …
```
"SPA" means Single-Page Application — the browser loads once and JavaScript handles everything after that.

**Why you need this:** Understanding that the frontend is code running in your browser (not on the NAS) explains why auth cookies, CORS, and same-origin rules exist.

---

### Rung 8 — What is a database?

**ELI5:** A database is an organized filing cabinet for data that needs to survive after the program stops. Without a database, every time the server restarts, all users, movies, and ratings would disappear. The server asks the database questions ("give me all movies rated above 7") using a query language called SQL, and the database returns the matching rows.

**Repo anchor:** `server/app.ts:91-94`:
```typescript
app.get('/api/health', (c) => {
  try {
    serverDb().raw.prepare('SELECT 1').get()   // Ask the database one trivial question
    return c.json({ ok: true })
```

`SELECT 1` is the simplest possible SQL query — it asks the database "are you awake?" and expects back the number 1. This project uses SQLite, a database stored in a single file on the NAS (`/app/data/server.db`). It is fast, requires no separate server process, and is perfect for a household-scale application.

**Why you need this:** When an endpoint returns unexpected data (or no data), the database is often where to look. The health check shows exactly how the server validates the database is alive.

---

### Rung 9 — Authentication vs. Authorization

**ELI5:**
- **Authentication** = proving who you are ("it's me, Chris, here's my Plex login").
- **Authorization** = deciding what you are allowed to do ("Chris is a member, so he can watch movies; Chris is also an admin, so he can delete titles").

These are two separate questions. You can be authenticated (the server knows who you are) but not authorized (you are not on the allowlist). You cannot be authorized without first being authenticated.

**Repo anchor:** `server/middleware/auth.ts:65-98` — `requireAuth` handles authentication (no session → 401). `requireAdmin` handles authorization (session exists but role is not admin → 403). Two different middlewares, two different questions.

Also from `root-README.md:28-40`:
```
A user is authorized only if their identity is on the members allowlist, which the owner manages via invites.
```

Authentication in this project uses three providers (Plex OAuth, Sign In with Apple, WebAuthn passkeys). Authorization is always the invite allowlist check on top of that.

**Why you need this:** "I can't log in" (authentication failure, 401) and "I logged in but can't see this page" (authorization failure, 403) are completely different bugs with completely different fixes.

---

### Rung 10 — What does "deploying" mean?

**ELI5:** Deploying means taking code that works on your laptop and putting it somewhere that other people (or their devices) can reach it. For this project there are two deployments:

1. **Frontend → Netlify:** Every push to `main` on GitHub triggers Netlify to rebuild the React app into a static bundle of HTML/CSS/JS files and serve those files from Netlify's global CDN. Anyone visiting the URL gets those files.

2. **Backend → NAS container:** A script builds a Docker image (a self-contained package with the Node.js runtime and all the server code), ships it to the NAS, and Docker runs it. The NAS is in the owner's home; a Cloudflare Tunnel makes `api.theemeraldexchange.com` route to it without exposing the home IP.

**Repo anchor:** `server/index.ts:8-11`:
```typescript
// Prod: deployed in the NAS container; SPA on Netlify hits this via
//       https://api.<domain>/ through a Cloudflare Tunnel.
```

**Why you need this:** "It works on my machine" is the universal developer complaint. Knowing that "deploy" means moving code to a different, always-on computer explains why a change to `src/` takes effect after a Netlify build, while a change to `server/` requires rebuilding and restarting the NAS container.

---

## 3. MAP — Repo Snippets Used

| Concept | File | Lines | What It Shows |
|---|---|---|---|
| Program entry point | `server/index.ts` | 1-13 | Boot comment: what the backend process does |
| Client vs. server architecture | `root-README.md` | 14-17 | Four runtimes described plainly |
| HTTP GET + JSON response | `server/app.ts` | 91-98 | `/api/health` — GET, `c.json()`, 200/503 |
| HTTP status codes (401) | `server/middleware/auth.ts` | 65-76 | `requireAuth` returning 401 |
| HTTP status codes (403) | `server/middleware/auth.ts` | 96-98 | `requireAdmin` returning 403 |
| API surface listing | `root-README.md` | 43-52 | Every `/api/*` route enumerated |
| Auth vs. authz | `server/middleware/auth.ts` | 1-4 + 65-98 | File comment + two separate middleware functions |
| Database probe | `server/app.ts` | 91-94 | `SELECT 1` — simplest SQL query |
| Deploy topology | `server/index.ts` | 8-11 | NAS container + Cloudflare Tunnel comment |
| SPA definition | `root-README.md` | 15-16 | "static bundle (Netlify in prod)" |

---

## 4. PREREQUISITES AND COMMON MISCONCEPTIONS TO PREEMPT

This is the floor — there are no prerequisites. However, beginners reliably arrive with these wrong mental models:

1. **"The website lives on my computer."** No. The files your browser shows you were downloaded from Netlify's servers. The data came from the NAS over the network. Your computer is just the display.

2. **"Changing the code changes what I see immediately."** No. Code changes must be deployed. For the frontend, Netlify must rebuild. For the backend, Docker must rebuild and restart the container on the NAS. Until that happens, the live site runs the old code.

3. **"The frontend can access the database directly."** No. The browser runs JavaScript that calls the API. The API (backend) talks to the database. The browser never touches the database.

4. **"If I'm logged in I can do anything."** No. Authentication (logging in) and authorization (being allowed) are separate. Being logged in only establishes who you are. What you can do depends on your role.

5. **"A 404 means the server is down."** No. A 404 means the server is up and understood your request, but the resource you asked for does not exist. A 5xx means the server had a problem.

6. **"HTTP is a permanent connection."** No. Each HTTP request is independent. The server handles your request and forgets about you. Session cookies are how the server recognizes you on your next request.

---

## 5. GOTCHAS — Where Beginner Intuitions Break

**"The frontend can be trusted."** It cannot. Any user can open their browser's developer tools, modify JavaScript in memory, forge HTTP requests, or lie about who they are. This is why every protected endpoint runs `requireAuth` on the *server* side. Hiding a button in the UI is cosmetic — real security lives in the backend check. `server/middleware/auth.ts` runs on the server; no amount of browser manipulation can skip it.

**"Logging in gives you a token forever."** Sessions expire. Plex membership can be revoked. `reconcileSession` in `server/middleware/auth.ts:54-61` re-checks Plex membership on every request and drops the cookie if the user was removed. A valid cookie from yesterday may be invalid today.

**"The same code runs everywhere."** React runs in the browser. Hono runs on the NAS. They are different computers, different runtimes, different security contexts. A `console.log` in `src/` appears in the browser's developer console. A `console.log` in `server/` appears in the NAS container's logs.

**"GET requests are harmless."** Mostly true, but: a GET that returns personal data or triggers expensive work can still be a security or performance problem. The distinction is that GET should be *idempotent* (calling it 10 times has the same result as calling it once). POST requests are for actions that change state.

**"JSON is just objects."** JSON is *text*. When the server sends `{"ok":true}`, it is sending a string of characters over the wire. The browser's JavaScript engine parses that text into an actual JavaScript object. Mixing up "the object in memory" and "the JSON text on the wire" is the source of many bugs.

**"Deploying is instant."** Docker images are rebuilt from scratch (Rust crates compiled, npm installed). A full backend rebuild on the NAS can take minutes. The old version serves traffic until the new container starts. There is a brief moment during restart where the site returns 502/503 — that is expected, not a sign of permanent breakage.

---

## 6. QUIZ BANK

**Q1 — Trace a request.**
You open a browser and navigate to `https://theemeraldexchange.com`. You are not logged in. You click the "Browse Movies" button, which calls `GET /api/media/movies`. Describe every step and what status code you expect to receive. What does the browser do with that status code?

*Answer:* The browser sends `GET /api/media/movies` to `api.theemeraldexchange.com`. This reaches the NAS via the Cloudflare Tunnel. The request hits `requireAuth` middleware. Since there is no session cookie, `readSession` returns null, `loadReconciledSession` returns `{ok: false, reason: 'unauthenticated'}`, and the handler returns `c.json({error: 'unauthenticated'}, 401)`. The browser receives HTTP 401. The React app's error handling sees a 401 and redirects to the login screen.

---

**Q2 — Predict the status code.**
The NAS loses power and the SQLite database file becomes corrupt. A Docker health-check fires `GET /api/health`. What status code does it receive? What JSON body?

*Answer:* `server/app.ts:91-98` — the `try` block calls `serverDb().raw.prepare('SELECT 1').get()`, which throws because the DB is corrupt. The `catch` block returns `c.json({ ok: false, reason: 'db_unavailable' }, 503)`. The health-check receives **503** with body `{"ok":false,"reason":"db_unavailable"}`. Docker marks the container unhealthy; Cloudflare stops routing traffic to it.

---

**Q3 — Authentication vs. authorization.**
A member (not an admin) is logged in and sends `DELETE /api/admin/invites/abc123`. The route uses `requireAdmin`. What status code does the member receive, and why is it not 401?

*Answer:* **403 Forbidden**. The member IS authenticated — `requireAdmin` successfully loads their session and finds `r.ok === true`. But then `r.session.role !== 'admin'` is true, so it returns `c.json({ error: 'forbidden', reason: 'admin_only' }, 403)`. A 401 would mean "I don't know who you are." A 403 means "I know exactly who you are, and no."

---

**Q4 — Client vs. server.**
A developer adds a `console.log('user clicked play')` in `src/components/media/MediaPlayer.tsx` and another `console.log('transcode started')` in `server/routes/transcode.ts`. Where does each message appear?

*Answer:* The first appears in the browser's DevTools console (open with F12) — it is client-side code running in the user's browser. The second appears in the Docker container logs on the NAS (visible via `docker logs exchange-backend`) — it is server-side code running on the NAS.

---

**Q5 — Deploy.**
You fix a bug in `server/routes/media.ts`. You commit and push to `main`. Twenty minutes later a user reports the bug is still present on the live site. What are the two most likely explanations?

*Answer:* (1) The backend container on the NAS has not been rebuilt and restarted — the NAS is still running the old image. Pushing to `main` does NOT automatically deploy the backend (unlike the frontend which Netlify auto-builds). A manual `nas-safe-build.sh` + `docker compose up -d` is required. (2) The user's browser is serving a cached version of the frontend bundle. A hard refresh (Cmd+Shift+R) or cache clear would rule this out, though a backend bug fix would not be affected by frontend caching.

---

**Q6 — JSON and APIs.**
You call `GET /api/limits` and receive this JSON body:
```json
{"minFreeGb":5,"maxMovieGb":50,"iptvEnabled":true,"mediaEnabled":false}
```
What does `mediaEnabled: false` mean for what you see in the browser?

*Answer:* From `server/app.ts:130-132`, `mediaEnabled` is `true` only when `USE_MEDIA_CORE=1` is set in the environment. The SPA (from `root-README.md:126-131`) uses this flag to decide whether to show the "Media Library" tab. With `mediaEnabled: false`, the Media Library tab is hidden from the UI entirely — the backend has the `/api/media` routes unmounted, so there is nothing to show. This is a legitimate use of the API to communicate configuration to the client.

---

## 7. CODE-READING EXERCISE — Follow One Fetch from Browser to Database

**The scenario:** You are logged in and the SPA calls `GET /api/health` to check if the backend is up.

**Step 1 — The browser sends a request.**
The JavaScript in the browser executes something like:
```javascript
fetch('https://api.theemeraldexchange.com/api/health')
```
This is an HTTP GET request. The browser adds headers automatically (like `Cookie: eex.session=...` from your login). The request travels over the internet to Cloudflare, through the Tunnel, to the NAS container.

**Step 2 — The backend receives it.**
`server/index.ts` is already running. The Node.js HTTP server inside it receives the incoming request and hands it to the Hono router.

**Step 3 — Middleware runs first.**
Before any route handler runs, every request passes through `app.use('*', logger())` (line 52 of `server/app.ts`) which logs the request, and then `app.use('*', requireSafeOrigin)` (line 82) which checks the Origin header. `/api/health` is a GET — the CSRF guard passes it through.

**Step 4 — The route handler runs.**
Hono matches the path `/api/health` and method `GET` to the handler at `server/app.ts:91`. The handler calls `serverDb().raw.prepare('SELECT 1').get()` — this is a SQL query to the SQLite file at `/app/data/server.db`. SQLite executes `SELECT 1` and returns the number 1 in about a microsecond.

**Step 5 — The response is built.**
The `try` block succeeds. `c.json({ ok: true })` serializes the JavaScript object `{ok: true}` to the JSON text `{"ok":true}`, sets status code 200, sets the `Content-Type: application/json` header, and returns the response.

**Step 6 — The browser receives the response.**
The response travels back through the Tunnel and Cloudflare to the browser. The JavaScript `fetch()` call resolves. The code that called `fetch()` checks `response.ok` (true for 2xx codes) and reads `response.json()` to get `{ok: true}`. The SPA knows the backend is healthy.

**What to notice:**
- The browser never touched the database. It called an API endpoint.
- The server never trusted the browser to tell it if the database was healthy. It checked itself.
- The entire conversation was two messages: one request, one response.
- The status code (200 vs 503) is how the browser knows whether to show a healthy or error state — it does not parse the body text to figure out what happened.

---

