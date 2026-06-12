
# The Emerald Exchange — Master Learning Syllabus

> The complete curriculum for understanding theemeraldexchange from zero programming
> knowledge to full comprehension of every runtime, subsystem, and war story. This is
> the document a `/teach-me` tutor session loads to teach a TRUE BEGINNER.
>
> **44 modules**, organized into Part 0 (fundamentals) + Parts 1–9 (the codebase),
> a cross-module capstone exam, and an honest coverage appendix.

---

## HOW TO USE THIS SYLLABUS WITH `/teach-me`

You are a tutor. Your learner may know nothing about programming, or may be the owner
returning to deepen mastery (she is at **B+**, spine mastered — see "Owner alignment" below).
Run every module the same disciplined way:

1. **Load the module's dossier** from `docs/learning/modules/<NN>-<slug>.md` (every module entry
   below links its dossier directly). The dossier is your
   source of truth: it has the ELI5, the guided code walk, the real file/line anchors, and the
   quiz bank. NEVER teach a module from memory — open its dossier first.

2. **Stage the teaching as problem → solution → broader context.** Always open with the *problem*
   this module exists to solve ("the browser can't play this MKV — now what?"), THEN reveal the
   solution the code implements, THEN zoom out to why it matters system-wide. Never lead with the
   answer.

3. **Elicit the learner's restatement FIRST.** Before you explain a concept, ask them to say what
   they *think* is happening in their own words. Teach into the gap between their model and the
   real one. This is the single most important rule — a passive lecture teaches nothing.

4. **Quiz via `AskUserQuestion` using the module's quiz bank.** Pull questions from the dossier's
   quiz section (the `_quiz-audit.md` upgrades have already replaced every weak recall question
   with an apply/trace question — use the upgraded versions). Rules: keep the **answer hidden until
   they submit**, **vary the position of the correct option** (never always "B"), and **mix
   difficulty**. A question must make them *trace* or *predict a breakage*, never just recognize a
   definition.

5. **Dial depth on request.** Support `eli5` (zero jargon, kitchen analogies), `eli14` (a sharp
   teenager — real terms, gentle pace), and `elii` (explain-like-an-intern — engineer-adjacent,
   fast, assumes the fundamentals). Offer "why?" drill-downs at any point, and show/run the real
   code when words stop working.

6. **Do not advance until mastery.** A module is complete only when the learner can (a) restate
   the problem and solution unprompted AND (b) pass the module's quiz. If they miss, re-teach the
   specific gap and re-quiz — do not move on to satisfy a schedule. The session ends when they
   understand, not when the clock runs out.

**Owner alignment (existing progress).** The owner already mastered Stages 0–5 of her personal
checklist. Those map onto this syllabus as: **Stage 0 → Part 1**; **Stage 1–2 → Part 2**;
**Stage 3 → Part 3**; **Stage 4 → Part 6**; **Stage 5 → Part 8**. Her chosen next order is
Rust crypto → Telemetry → IPTV → *arr/SAB. For a returning owner, you may skip the Part-0
fundamentals and the already-mastered spine, and jump straight to the modules she hasn't done —
but still **cold-quiz** before assuming mastery, especially on the *arr/SAB module where she is
self-described "highly confident (perhaps erroneously)."**


---

# PART 0 — ABSOLUTE FUNDAMENTALS

No codebase yet. Part 0 builds the mental scaffolding that every later module assumes. It is a
single **concept ladder** — each rung is the minimum needed for the next to make sense — grouped
into seven teachable **lessons**. A beginner does every lesson. The owner (Stages 0–5 mastered)
can skim, but should still glance at the "invisible prerequisites" (cross-check) and the
misconception bank, because those are where confident learners trip.

## The Ladder (foundational → domain-specific)

**Tier 0 — What a program even is**
1. **A program is a recipe** the computer follows line by line. Written in TypeScript/Rust/Python,
   turned into runnable instructions by a compiler or interpreter. *Unlocks:* four programs running at once.
2. **Source code vs. a running process.** Code is the recipe text on disk; a process is the meal
   actually cooking. Same recipe → many simultaneous processes. *Unlocks:* containers, concurrency caps, "code exists ≠ feature live."

**Tier 1 — Networks & communication**
3. **Client/server model.** Browser = client (makes requests); server = answers them. The server
   never starts the conversation. *Unlocks:* everything — the four-runtime architecture.
4. **HTTP request/response.** `METHOD URL HEADERS body` → status code (200 OK, 401 not-logged-in,
   403 forbidden, 404 not-found, 503 too-busy) + body. *Unlocks:* reading errors, auth failures, stream tokens.
5. **What a URL is** — scheme / host / path / query string. `?t=` is a query parameter. *Unlocks:* tokens-in-URLs, proxying.
6. **DNS** — the phone book turning `api.theemeraldexchange.com` into an IP. *Unlocks:* Cloudflare tunnel hiding the home IP, SSRF guard.
7. **Same-origin policy & CORS.** A page at `a.com` can't read data from `b.com` unless `b.com`
   opts in via CORS headers. *Unlocks:* why cookies fail for video, why CSRF is possible, `credentials:'include'`.
8. **JSON** — `{"name":"Fight Club","year":1999}`. The data format every API call uses. *Unlocks:* reading API responses and token payloads.
9. **REST API** — the published set of URLs (GET/POST/DELETE) that is the *only* channel between the
   untrusted browser and the trusted NAS. *Unlocks:* the trust boundary, route handlers, middleware.

**Tier 2 — Browsers & web pages**
10. **HTML / CSS / JavaScript** — skeleton / skin / muscles. Here JS does almost everything; HTML is ~20 lines.
11. **Single-Page Application (SPA)** — ONE page loads; JavaScript rewrites the screen as you
    navigate (via the `#/movies` hash). The server never sends a new page. *Unlocks:* hash routing, why Netlify serves static files.
12. **React — components & hooks.** Functions returning JSX describe the screen; "state" changes
    trigger re-draws; hooks (`useState`, `useEffect`, `useContext`) give components powers. *Unlocks:* the rec-strip stability, query caching.
13. **HTTP cookies** — a string the browser auto-attaches to every request to that server.
    `HttpOnly` (JS can't read), `Secure` (HTTPS only), `SameSite=None` (cross-origin OK). *Unlocks:* session cookies, CSRF, why stream tokens live in URLs instead.

**Tier 3 — Security fundamentals**
14. **Authentication vs. Authorization.** AuthN = "who are you?" (login). AuthZ = "are you allowed?"
    (permission). Valid Plex account = authN; on the invite list = authZ. Skipping the second was Critical bug #1.
15. **CSRF.** A hostile page makes your browser fire a request to a site you're logged into; the
    browser auto-attaches your cookie. *Unlocks:* Origin-header checking, the bearer-only exemption.
16. **Public-key crypto — signing vs. encrypting.** Signing (private key) proves origin; encrypting
    (public key) hides content. *Unlocks:* JWT, JWE, SIWA, passkeys.
17. **HMAC** — a wax seal: message + secret key → short fingerprint only key-holders can forge/verify.
    HMAC-SHA256 signs stream tokens. *Unlocks:* why the browser can't forge a token.
18. **JWTs** — `header.payload.signature`, base64, dot-separated. The payload is *readable by anyone* —
    signed, not secret. *Unlocks:* why JWE (encrypted JWT) is used for session cookies.
19. **Hashing (SHA-256)** — one-way, deterministic fingerprint. *Unlocks:* HMAC, HKDF, checksums.
20. **SSRF.** Attacker gets the *server* to fetch an internal URL (`http://192.168.1.1/admin`) from
    inside your home network. *Unlocks:* the SSRF guard, the "loads forever" war story.

**Tier 4 — Data storage**
21. **A database** — tables (spreadsheets), rows (records), columns (fields), queries (questions). *Unlocks:* SQLite, migrations.
22. **Primary keys, foreign keys, indexes** — unique row ID / pointer to another table's row /
    back-of-the-book lookup. *Unlocks:* JOINs, the media.db schema.
23. **Transactions & ACID atomicity** — all-or-nothing change groups (commit/rollback). *Unlocks:* feedback write-ordering, the EPG poison war story.
24. **SQLite WAL mode** — writes go to a `.db-wal` sidecar so readers see a consistent snapshot;
    DB = `.db` + `.db-wal` + `.db-shm`. *Unlocks:* why backups exclude the WAL, `immutable=1` proof reads.

**Tier 5 — Containers & infrastructure**
25. **Docker containers** — a sealed lunchbox bundling a program with everything it needs. Many per host, isolated.
26. **Images vs. running containers** — cookie-cutter vs. the running instance. Deploy = build new image, restart container.
27. **Docker networking** — containers reach each other by *service name* (`http://exchange-media-core:9000`),
    not IP. *Unlocks:* why `localhost:9000` fails, the cloudflared netns war story.
28. **Linux capabilities (`cap_drop: ALL`)** — fine-grained process permissions; dropping all then
    forgetting to add back `SETUID` crash-loops `gosu`. *Unlocks:* the recommender crash-loop war story.
29. **Environment variables** — runtime sticky-notes (`SESSION_SECRET=…`) set outside the code, so
    secrets never live in the source. *Unlocks:* `.env`, `process.env`.
30. **git basics** — commits (snapshots), branches, push/pull; a push to `main` drives CI/CD. *Unlocks:* CI, git-archive deploys.

**Tier 6 — Media fundamentals**
31. **Containers vs. codecs.** MKV/MP4/.ts = the ZIP wrapper; H.264/HEVC/AAC = the compression of the
    content inside. Independent concerns. *Unlocks:* direct-play vs. transcode, remux.
32. **HLS** — split video into 4–6s segments + a `.m3u8` playlist listing them. VOD = full list; live
    = sliding window. fMP4 segments (not MPEG-TS) are required for HEVC in browsers. *Unlocks:* the whole streaming pipeline.
33. **MSE (Media Source Extensions)** — JS feeds video chunks straight to the browser's decoder buffer.
    A rejected append (wrong codec/channel-count) fails the whole fragment *silently*. *Unlocks:* the grey-box bugs.
34. **Transcode vs. remux vs. direct play.** Re-encode the video (slow) / repackage without re-encoding
    (fast) / serve as-is. Different CPU profiles. *Unlocks:* the concurrency-cap system, `reencodes_video()`.

**Tier 7 — Recommendations & data science**
35. **Vectors & embeddings** — a title's "personality" as 384 numbers; close vectors = similar titles. *Unlocks:* KNN, sqlite-vec.
36. **Collaborative filtering (co-engagement)** — "people who watched X also watched Y"; neighbors of
    what you own are good picks. *Unlocks:* the PMI co-rating step, why TV is harder.

**Tier 8 — Native code & bindings**
37. **Compiled vs. interpreted.** TS/Python interpreted on the fly; Rust compiled to native machine
    code ahead of time, memory-safe by the compiler. *Unlocks:* why Rust handles crypto/media.
38. **Native bindings (N-API / PyO3)** — call compiled Rust from TS or Python as if it were a local
    function (`.node` / `.whl`). *Unlocks:* one crypto crate shared across all four runtimes.

## The Seven Lessons (cluster the ladder)

- **Lesson 0-A — "How the Internet Talks"** (concepts 3–9). *Anchor:* open DevTools Network tab on any
  site; read a GET's URL/status/JSON, find a POST body, see why Netlify→API is cross-origin.
- **Lesson 0-B — "What a Browser Knows About You"** (13–15). *Anchor:* DevTools → Application → Cookies;
  note `HttpOnly`; walk a CSRF scenario (why does the cookie auto-attach to `evil.com`'s POST?).
- **Lesson 0-C — "Secrets and Signatures"** (16–20). *Anchor:* in the console,
  `btoa(JSON.stringify({sub:"plex:123",role:"admin"}))` — you decoded a JWT payload with no key. Signing ≠ hiding.
- **Lesson 0-D — "Where Data Lives"** (21–24). *Anchor:* `sqlite3` a `.db`; `.tables`; `SELECT … LIMIT 5`;
  note the `.db-wal` sidecar; explain why backups exclude it.
- **Lesson 0-E — "Boxes Within Boxes"** (25–30). *Anchor:* `docker ps` on the NAS (nine containers);
  inspect a container's network; see why the backend calls `exchange-media-core:9000` not `localhost`.
- **Lesson 0-F — "Video in a Browser"** (31–34). *Anchor:* play a video, DevTools Network: find the
  `.m3u8`, count the `.ts`/`.m4s` segments, spot the `?t=` token. Add: the `<video>` element is the
  built-in player; **ffmpeg** is the command-line converter (`-c:v`, `-ss`, `-re` flags) that produces the segments.
- **Lesson 0-G — "Recs, Numbers, and Languages"** (35–38, optional-deeper). *Anchor:* plot 6 movies on
  action(x)/darkness(y); find nearest neighbors; extend to 384 dims; see why a centroid of action+rom-com points at neither.

## Invisible Prerequisites (assumed but unlisted — teach these too)

- **(A) React Query / TanStack cache mechanics** (staleTime, invalidateQueries, optimistic updates) —
  teach inside Lesson 0-A/0-B as "browser-side caching." The rec-strip churn is incomprehensible without it.
- **(B) async/await & Promises** — the feedback write-queue is a promise-chain mutex; the API client is all `async`. Add to 0-A.
- **(C) the `<video>` element** (`currentTime`, `play()`, `timeupdate`) — add a half-concept to 0-F.
- **(D) how ffmpeg arguments work** — add to 0-F (see above).
- **(E) Python asyncio & Pydantic type hints** — the ingest worker fires 8 concurrent requests via `asyncio.Semaphore`; models use `@dataclass`/`list[int]`. Add to 0-G.
- **(F) fMP4 vs. MPEG-TS** — folded into concept 32; the HEVC-only-in-fMP4 rule is a critical planning constraint.
- **(G) Rust ownership & `Result`/`Option`** — `Arc<Mutex<>>`, `.await`, error propagation. Add a minimal Rust mental model to 0-G.

## Misconception Bank (preempt these — they bite confident learners)

- **M1 "exit code 0 means it worked."** No — it means it didn't crash. Verify downstream behavior. *(testing-strategy §5, war-stories Pattern 2)*
- **M2 "signed means secret."** Signing proves no-tampering; encrypting hides. JWTs are readable. *(contracts-crypto §4, sessions-tokens §4)*
- **M3 "the `<video>` element handles all formats."** `isTypeSupported` checks the MIME string, not channel count; MSE rejects 6-ch AAC silently. *(spa-player §2/§5)*
- **M4 "200 means the user can watch."** 200 = bytes sent, not decodable by THIS browser. Test in real Chrome. *(war-stories Incident 5)*
- **M5 "the UI gate is the security gate."** `if (role==='admin')` in React is UX; the server enforces on every request. *(spa-auth-admin-ui §2, security-posture §4)*
- **M6 "authentication means authorization."** Forgetting the invite check after the Plex check = Critical bug #1. *(security-posture §5)*
- **M7 "shared data is re-fetched per component."** Same query key = one cached response. *(spa-api-layer §4)*
- **M8 "a container is a VM."** Containers share the host kernel — isolated processes, not separate OSes. *(nas-infra §1)*
- **M9 "staleTime:0 + no window-focus refetch is safe."** A mount still re-fetches a stale query. Only `staleTime:Infinity` stops all auto-refetch. *(spa-recs-ui §5)*
- **M10 "deploy = rebuild = consistent."** A shared-netns container (cloudflared) must be force-recreated after the backend recreates. *(war-stories Incident 2)*
- **M11 "the token kind tells you what ffmpeg is doing."** `k:remux` is an access-control label, NOT the transcode plan; read the live ffmpeg cmdline. *(sessions-tokens §5)*

---

# THE CURRICULUM — PARTS 1–9

44 modules, dependency-ordered into nine parts. Each module entry: **title + hook**, **objectives**,
**dossier link** (`modules/NN-<slug>.md`), **session length**, **prerequisites** (earlier module
numbers), and a **war story to tell**. Never teach a module before its prerequisites are mastered.

---

## PART 1 — What & Why (the orientation)

> *Maps to owner Stage 0. Pure "why this exists" — no code yet.*

### Module 01 — Product Vision: A Private Netflix You Own
**Hook:** Why build a streaming platform when Netflix exists? Because you can't be evicted from software you own.
- Objectives: state the one-sentence elevator pitch; explain invite-only + self-hosted as a trust+independence choice; name the four runtimes and what each owns; articulate "the invite list IS the product."
- Dossier: `modules/01-product-vision.md` · **45 min** · Prereqs: Part 0 (Lesson 0-A)
- War story: the Critical-#1 confused-deputy bug — a valid Plex account is not an invitation; the product's entire value is the second gate.

### Module 02 — Repo Map: Four Runtimes in One Monorepo
**Hook:** One folder, four languages, one machine. Here's the floor plan before you walk the rooms.
- Objectives: locate the SPA / backend / Rust crates / Python recommender in the tree; explain why a monorepo; read `package.json` scripts; know `build` vs `build:spa`.
- Dossier: `modules/02-repo-map.md` · **45 min** · Prereqs: 01, Part 0 (0-E, 0-G)
- War story: `npm run build:spa` deploys the frontend but the new backend route still 404s — the deploy has two halves and you shipped one.

### Module 03 — Git History as Eras: How It Grew
**Hook:** The codebase tells its own story — dashboard → auth → recs → IPTV → media server → transcoder. Each era unblocked the next.
- Objectives: narrate the capability ladder (can't recommend what you don't catalog; can't transcode without the transcoder); place "deployed & live June 2026" correctly; understand why Apple clients are blocked only by tooling.
- Dossier: `modules/03-git-history-eras.md` · **30 min** · Prereqs: 01, 02
- War story: the autoloop scrub — code that "screamed vibe-coded" was deleted *and filter-repo'd out of all history*, a reminder that git history is itself a product surface.

---

## PART 2 — The Four Runtimes & the Request Path

> *Maps to owner Stages 1–2. How a click becomes a result; the trust boundary keystone.*

### Module 04 — Fundamentals: The Web Stack, End to End
**Hook:** Trace one real Play click from button → network → backend → database → screen, using actual repo lines as your map.
- Objectives: read (not write) a request's full journey; identify the trust line (browser untrusted / NAS trusted); connect every Part-0 concept to a concrete file.
- Dossier: `modules/04-fundamentals-web.md` · **60 min** · Prereqs: Part 0 (0-A,0-B,0-D,0-E)
- War story: the upgraded quiz Q6 — a Plex member who passes `plexIsServerMember()` is still bounced by `memberStatus()`; authN ≠ authZ, proven in code.

### Module 05 — Backend Entry: What Happens at Boot
**Hook:** `node server/index.ts` runs a short checklist, then never stops listening. What's on the checklist?
- Objectives: trace boot (ffmpeg check → Sentry init → open SQLite → hand routing to `@hono/node-server` on :3001); explain `env.ts` loading first and validating; understand feature flags gating route trees (`USE_MEDIA_CORE`, `IPTV_DISABLED`).
- Dossier: `modules/05-backend-entry.md` · **45 min** · Prereqs: 04
- War story: a flag is off, so the `/api/*` path simply doesn't exist — a "missing endpoint" that's actually a config decision.

### Module 06 — Backend Middleware: The Row of Bouncers
**Hook:** Four bouncers stand between every request and any handler. Know them and you know the backend's spine.
- Objectives: name the stack in order (CORS preflight → `requireSafeOrigin` → `requireAuth`/`requireAdmin` → `rateLimit`); explain what each rejects and with which status; understand that the handler only runs if all four pass.
- Dossier: `modules/06-backend-middleware.md` · **45 min** · Prereqs: 05, Part 0 (0-B,0-C)
- War story: the bearer-only CSRF exemption — native device writes were 403'd by the Origin gate until `isBearerOnly` (no Cookie header present) exempted them.

### Module 07 — The SPA Shell: One Page, Infinite Screens
**Hook:** The browser loads one HTML file and never loads another. React redraws everything from the `#` hash forward.
- Objectives: explain SPA vs. multi-page; trace hash routing (`#/movies`); read a component tree; understand why Netlify only serves static files.
- Dossier: `modules/07-spa-shell.md` · **45 min** · Prereqs: 04, Part 0 (0-A)
- War story: the View-Transition / animated-favicon polish layer that sits on top of plain hash routing.

### Module 08 — The SPA API Layer: fetch() With Manners
**Hook:** A thin TypeScript wrapper turns raw HTTP into typed objects, adds timeouts, renames snake_case→camelCase, and caches via React Query.
- Objectives: read `src/lib/api/`; explain the three jobs (timeouts/errors, case conversion, React Query feeding); understand why two components sharing a query key fetch once.
- Dossier: `modules/08-spa-api-layer.md` · **45 min** · Prereqs: 07, invisible-prereq A (React Query), B (async/await)
- War story: the upgraded quiz — a resume point lands 14s behind the pause because the throttle window's last save won, not the forced pause-save.

### Module 09 — SPA Tabs & the IPTV Hooks: Where Each Screen Gets Its Data
**Hook:** Six tabs, ten screens, eight IPTV hooks — a state-ownership map of the whole front end.
- Objectives: map which hook feeds each tab (TV→Sonarr, Movies→Radarr, Downloads→SAB+arrs, Live→IPTV); explain the Home tab makes zero API calls; trace the LiveTab play-flow.
- Dossier: `modules/09-spa-tabs-iptv-hooks.md` · **60 min** · Prereqs: 08
- War story: this dossier closed GAP E — nine of twelve tabs had no coverage; the Downloads tab's `GrabActivityPanel` is where the GrabEventType drift-guard bug lived.

---

## PART 3 — Identity & Trust

> *Maps to owner Stage 3. Three providers converge on one allowlist; tokens carry trust across boundaries.*

### Module 10 — Security Posture: Who Attacks This and How
**Hook:** Two attacker classes (random strangers; un-invited Plex-share holders) and two nightmare moves (reach the home IP; SSRF into your LAN).
- Objectives: enumerate the threat model; explain why the Cloudflare proxy hiding the home IP matters; define SSRF in this app's terms; locate the trust boundary.
- Dossier: `modules/10-security-posture.md` · **60 min** · Prereqs: Part 1, Part 0 (0-C)
- War story: the home-IP exposure was *Plex Remote Access*, not the app — the code/DNS were clean; the leak was a setting + a router port-forward.

### Module 11 — Auth (Plex): Delegated Login With No Password
**Hook:** Click "Sign in with Plex," a popup proves who you are to Plex, the app polls every 1.5s until Plex says yes.
- Objectives: trace the PIN flow; explain delegated auth (no password store, no PII liability); understand the two gates (Plex identity + invite allowlist); know the opaque encrypted session cookie.
- Dossier: `modules/11-auth-plex.md` · **45 min** · Prereqs: 10, 06
- War story: PINs are now created *in the browser* — server-side PIN creation leaked the NAS's home IP to plex.tv's device list (commit `d036f28`).

### Module 12 — Invites, Members & Admin: The Allowlist Is the Product
**Hook:** One `members` table decides everyone's fate; invite codes burn in a single transaction so two people can't share one.
- Objectives: explain the allowlist as the authZ layer; trace invite issue→redeem→burn atomicity; understand `ADMIN_SUBS` owner-bypass; locate the admin-gated routes.
- Dossier: `modules/12-invites-members-admin.md` · **45 min** · Prereqs: 11
- War story: race-safe single-use redemption — two simultaneous redemptions of one code must not both succeed; the transaction is the guard.

### Module 13 — Sessions & Tokens: Three Credentials, Three Jobs
**Hook:** A session cookie for normal API calls, a stream token baked into video URLs, a device token for native apps that can't use cookies.
- Objectives: distinguish the three credentials and *why each exists*; explain why `<video>`/hls.js can't use cookies (cross-origin) so the token rides the URL `?t=`; know each uses an independent secret.
- Dossier: `modules/13-sessions-tokens.md` · **60 min** · Prereqs: 11, 06, Part 0 (0-C,0-F)
- War story: `k:remux` is a *token kind*, not the transcode plan — a 10-bit HEVC source full-transcodes despite the label; read the live ffmpeg cmdline.

### Module 14 — Auth (Passkeys): Login With Nothing to Steal
**Hook:** Your device keeps a private key forever; the server stores only a public key and sends a random puzzle. No password, nothing to phish.
- Objectives: explain WebAuthn challenge/signature/verify; understand `local:<ulid>` self-owned identity; know revoking a device token does NOT revoke a passkey (separate rows).
- Dossier: `modules/14-auth-passkeys.md` · **45 min** · Prereqs: 13, Part 0 (0-C)
- War story: stolen-laptop response requires BOTH actions — revoke device token AND delete passkey credential; there is no cross-revocation.

### Module 15 — Auth (Apple) & Device Bearer Flow: Native Without Cookies
**Hook:** Sign in with Apple gives a signed JWT; the backend verifies it against Apple's public keys and mints a long-lived encrypted bearer token for the Keychain.
- Objectives: trace SIWA identity-token verification (signature, audience, invite); explain JWE bearer tokens for phones; understand `Authorization: Bearer` vs. cookie auth.
- Dossier: `modules/15-auth-apple-device.md` · **45 min** · Prereqs: 14, 13
- War story: M2 scope — the flow is built but native clients are blocked on Xcode tooling, not code.

### Module 16 — SPA Auth & Admin UI: The Buttons That Drive the Flows
**Hook:** The login buttons and the settings panel *drive* trust flows but never *are* the trust boundary — the server is.
- Objectives: connect each UI control (Plex/Apple/Passkey buttons, DevicesPanel, InvitesPanel) to its backend flow; explain UI role-gating as UX, not security; know the server re-checks every request.
- Dossier: `modules/16-spa-auth-admin-ui.md` · **45 min** · Prereqs: 11, 14, 15
- War story: the upgraded quiz — set `role='admin'` in DevTools, the form appears, the POST still 403s; the UI gate is theater, the server gate is real.

---

## PART 4 — The Media Pipeline

> *The heart of the system: how any file plays on any device. Heavy Part-0 (0-F) dependency.*

### Module 17 — Fundamentals: Media — Containers, Codecs, HLS, HDR
**Hook:** Seven nested ideas (container, stream, codec, transcode/remux, HLS, hardware accel, tonemap, subtitles) you must hold before reading one transcoder line.
- Objectives: hold the full media mental model; explain why browsers decode only a subset of codecs; distinguish text vs. bitmap subtitles; understand tonemap (HDR→SDR).
- Dossier: `modules/17-fundamentals-media.md` · **60 min** · Prereqs: Part 0 (0-F)
- War story: the grey-box-at-0:00 four-fix saga in miniature — keyframe cadence, non-AAC audio, inline subtitle under `-re`, and 6-ch AAC MSE rejection.

### Module 18 — Media-Core: The Smart Librarian
**Hook:** A Rust service walks your folders, ffprobes each file, stores the catalog in `media.db`, and decides direct-play vs. transcode.
- Objectives: name media-core's four jobs (walk, probe, store, serve+decide); explain the internal authenticated HTTP boundary to the Node backend; understand the play-grant decision.
- Dossier: `modules/18-media-core.md` · **60 min** · Prereqs: 17, Part 0 (0-D,0-G Rust mental model)
- War story: the catalog DB lives *inside a different container* (`exchange-media-core:/data/media.db`) — querying it means `docker cp` then node:sqlite, not a local file.

### Module 19 — Media & Transcode Routes: The Trusted Middleman
**Hook:** The browser never talks to storage or the transcoder. The backend grants, waits for the first segment, then hands back a signed URL.
- Objectives: trace the grant POST → media-core decision → transcoder start → manifest-ready → signed HLS URL; explain why every segment fetch re-enters the backend (internal-credential swap).
- Dossier: `modules/19-media-transcode-routes.md` · **60 min** · Prereqs: 18, 13
- War story: the manifest-readiness race — the backend's READY_POLLS timeout returned a not-ready manifest as 503 and hls.js wouldn't retry it → grey box.

### Module 20 — Transcoder Planning: The Pure Decision Function
**Hook:** `plan.rs` is a pure function: file facts + client caps → a three-field plan (video/audio/subs). Get it wrong and you get a silent grey rectangle.
- Objectives: explain the inputs (file snapshot + `ClientCaps`) and the `TranscodePlan` enum; understand "when in doubt, re-encode"; know fMP4-only-for-HEVC and the AAC ≤2ch copy rule.
- Dossier: `modules/20-transcoder-planning.md` · **60 min** · Prereqs: 17, 19, Part 0 (0-F)
- War story: copying a stream the browser can't decode produces a grey box at 0:00 with a *perfectly healthy server session* — the plan is the only thing wrong.

### Module 21 — Transcoder Runtime: ffmpeg, Sessions & the GPU
**Hook:** A Rust service spawns ffmpeg, writes `index.m3u8` + segments to a temp dir, heartbeats every 30s or reaps, and can offload encoding to the Intel iGPU.
- Objectives: trace session lifecycle (start → ffmpeg → segments → heartbeat/reap); explain VAAPI hardware encode and why it doesn't charge the CPU cap; understand the concurrency caps.
- Dossier: `modules/21-transcoder-runtime.md` · **60 min** · Prereqs: 20, Part 0 (0-E,0-F)
- War story: the `/scratch` tmpfs trap — a `tmpfs:size=3g` mount overlays the Dockerfile's `chown` with fresh `root:root 0755`, so the first real write is `Permission denied` though health checks pass.

### Module 22 — The SPA Player: One Engine, Two Layers
**Hook:** `IptvPlayer` is the battle-tested engine; `MediaPlayer` bolts heartbeats/resume/stop on top and reuses it rather than building a second player.
- Objectives: distinguish the two components; explain the three delivery modes (`<video>` MP4, hls.js+MSE for HLS, mpegts.js for live); understand heartbeat lifecycle and resume math.
- Dossier: `modules/22-spa-player.md` · **60 min** · Prereqs: 19, 21, Part 0 (0-F), invisible-prereq C (`<video>`)
- War story: the 6-channel AAC MSE rejection — `isTypeSupported` said yes, the SourceBuffer append said no, the whole fragment died silently; the fix was `-ac 2` stereo downmix.

---

## PART 5 — Live TV & Acquisition

> *IPTV streaming, the EPG grid, and the *arr/SAB download bridges. **COLD-QUIZ the *arr module.***

### Module 23 — IPTV Core: Live TV Through a Trusted Pipe
**Hook:** Channels come from a commercial Xtream panel; the browser asks for a grant, the backend mints a signed URL, and every video byte flows through the backend.
- Objectives: trace the grant→signed-URL→proxy path; explain why the browser never sees provider creds and can't request arbitrary URLs; understand the connection-slot cap.
- Dossier: `modules/23-iptv-core.md` · **60 min** · Prereqs: 13, 10
- War story: "loads forever" = the SSRF guard 400'd a provider's https→http redirect to a public CDN; the fix allowed http to *public* hosts only.

### Module 24 — EPG: The TV-Guide Grid
**Hook:** A 151 MB XMLTV feed, fetched every 6 hours, parsed into `iptv.db`, sliced into a 4-hour `/epg/grid` window.
- Objectives: explain XMLTV (channels + programmes); trace fetch→parse→store→grid; understand why most of the 50k channels have no programmes but are still tunable.
- Dossier: `modules/24-epg.md` · **45 min** · Prereqs: 23, Part 0 (0-D)
- War story: the SAX-skips-`<channel>` race swept coverage to ~820 channels twice; it's now test-guarded — the fragile `xmlStream.on('data', …)` line.

### Module 25 — TMDB Search: Metadata Without Leaking the Key
**Hook:** A server-side proxy to The Movie Database keeps your API credential off the frontend and backfills cast, trending, and credits.
- Objectives: name the three proxied endpoints (credits, trending movie/tv); understand search happens *upstream in Radarr/Sonarr*, not TMDB; know the server-side-key pattern.
- Dossier: `modules/25-tmdb-search.md` · **30 min** · Prereqs: 08, 05
- War story: the upgraded quiz — cast section empty though TMDB is "configured"; the token was set but the backend wasn't restarted, so the old process has `undefined`.

### Module 26 — *arr / SAB Bridges: The Librarians and the Delivery Truck  ⚠️ COLD QUIZ FIRST
**Hook:** Radarr (movies), Sonarr (TV), SABnzbd (the download truck). The bridge lets the SPA request titles through a controlled, size-capped layer — no direct API access, no exposed keys.
- Objectives: explain each tool's role; trace a "request a movie" through the size-cap layer; understand the GrabEventType state machine; know why an 80GB 4K rip is blocked.
- Dossier: `modules/26-arr-bridges.md` · **60 min** · Prereqs: 09, 25
- **⚠️ COLD QUIZ FIRST:** the owner is self-described "highly confident (perhaps erroneously)" here — open with a quiz BEFORE teaching; untested confidence is where the gaps hide.
- War story: the Radarr add-424 — "no matching releases" was wrongly lumped with "over the size cap" and silently rolled the add back; the fix split `no_matching_releases` from `capped_grab`.

---

## PART 6 — Recommendations

> *Maps to owner Stage 4. Offline eval → ingest/featurize → serving → feedback wiring.*

### Module 27 — Rec Eval & Research: Prove It Before You Ship It
**Hook:** Leave-one-out testing + nDCG@10 told us the winning algorithm scored 10.4× the baseline — *before* a single user saw it.
- Objectives: explain offline evaluation and leave-one-out; read nDCG@10; understand why you measure offline before shipping; name the winning approach (co-engagement retrieval-union + content fusion).
- Dossier: `modules/27-rec-eval-research.md` · **45 min** · Prereqs: Part 0 (0-G)
- War story: the research loop converged on retrieval-union over content-only; the content ceiling on novel/TV is why TV recs are harder.

### Module 28 — Rec Ingest & Features: From TMDB Facts to 384 Numbers
**Hook:** Pull the TMDB catalog, then turn each title into a 384-number fingerprint stored in `sqlite-vec` for millisecond similarity search.
- Objectives: trace the pipeline (migrate → ingest-bootstrap → featurize → ready); explain embeddings + sqlite-vec geometric similarity; understand the 8-concurrent ingest with `asyncio.Semaphore`.
- Dossier: `modules/28-rec-ingest-features.md` · **60 min** · Prereqs: 27, Part 0 (0-D,0-G), invisible-prereq E (asyncio)
- War story: `/score` needs `tmdb_id > 0` — a Sonarr `tmdbId:0` 422'd the whole TV batch into a silent trending fallback.

### Module 29 — Rec Serving: "What Should This Household Watch Next?"
**Hook:** A small FastAPI service scores every candidate against the household's library, likes, dislikes, and vetoes — entirely from local data, no internet at request time.
- Objectives: trace `POST /score`; explain provenance labels (personalized/discover/trending); understand veto as HARD anti-join + SOFT negative-centroid; know the recipe system fires by context.
- Dossier: `modules/29-rec-serving.md` · **60 min** · Prereqs: 28
- War story: PR #107 — the backend's franchise base-name filter nuked 13/20 movies (a *wiring* bug, not data science); lesson: measure the bottleneck before tuning.

### Module 30 — Rec Workers & Migrations: The Async Backbone
**Hook:** A FastAPI scorer up front, async workers ingesting TMDB behind it, events flowing in over HMAC-signed HTTPS, schema evolving via boot-time migrations.
- Objectives: distinguish serving from workers; explain the `RECOMMENDER_EVENT_SECRET` signed event channel; understand boot-time migrations with no downtime.
- Dossier: `modules/30-rec-workers-migrations.md` · **45 min** · Prereqs: 29, Part 0 (0-D)
- War story: the `cap_drop: ALL` crash-loop — the recommender died 948× on `gosu`/`setpriv` until `SETUID`/`SETGID`/`CHOWN` were added back.

### Module 31 — SPA Recs UI: The Strip That Must Not Reshuffle
**Hook:** A horizontal poster strip with red/green dots and a Recommended/Trending toggle — designed to stay *perfectly stable* while you judge cards.
- Objectives: explain the strip's stability requirement; trace the FOUR refetch paths; understand `staleTime:Infinity` and the dislike-only low-water refill; know a like only sets its dot.
- Dossier: `modules/31-spa-recs-ui.md` · **60 min** · Prereqs: 08, 29, invisible-prereq A (React Query) + M9
- War story: four separate churn regressions — a like kept yanking the strip; `useStripAutoRefresh` was deleted entirely, `staleTime:0` → `Infinity`, two `invalidateQueries` removed.

### Module 32 — Suggestions & Feedback: One Click, Two Stores
**Hook:** A red/green dot is `POST /api/feedback` that writes TWO files — `userFeedback.json` (private, per-member) and `rejections.json` (shared household veto) — serialized by a per-item mutex.
- Objectives: trace feedback to both stores + recommender mirror; explain the write-ordering (rejection first); understand the per-item promise mutex under rapid clicks.
- Dossier: `modules/32-suggestions-feedback.md` · **45 min** · Prereqs: 31, 29, invisible-prereq B (Promises)
- War story: a "never suggest again" list is a PERMANENT contract — never FIFO/cap-drop it; bound at the render layer, never at persistence.

---

## PART 7 — Data & the Quiet Machinery

> *The storage layer and the four services that never appear in a stack trace but hold the system together.*

### Module 33 — Data Layer: One File Is the Whole Database
**Hook:** SQLite is a library, not a server — `server.db` is one file the backend reads directly. `iptv.db`, `media.db`, and migrations follow the same discipline.
- Objectives: explain SQLite-as-library; locate the three DBs (two in-process, media.db in another container); understand numbered migrations + checksum drift detection; know WAL's three files.
- Dossier: `modules/33-data-layer.md` · **60 min** · Prereqs: Part 0 (0-D)
- War story: the migrator's SHA-256 checksum warns you if someone edited an already-applied migration — a common silent footgun.

### Module 34 — Backend Hidden Services: The Immune System
**Hook:** Four modules that enforce invariants instead of answering requests — watch-signal, source-precedence, DB-backup, and the legacy Claude path. Miss one and something quietly rots.
- Objectives: explain `watchSignal.ts`'s 40% qualify threshold; understand `sourcePrecedence.ts` (media-core>Plex>IPTV, fallback at grant only); know the `VACUUM INTO` backup + migration gate; survey the BYO-key Claude pipeline.
- Dossier: `modules/34-backend-hidden-services.md` · **60 min** · Prereqs: 32, 29, 33
- War story: this dossier closed GAPs A–D; the source-precedence asymmetry (silent fallback at grant, explicit `source_unavailable` mid-session) exists to protect watch-position attribution.

### Module 35 — Telemetry, Notifications & Misc: Knowing When It Breaks
**Hook:** Glitchtip catches crashes (self-hosted, no data leaves the house), Discord webhooks notify on downloads, usage tracking accounts for BYO Claude cost, and the pairing endpoint advertises server identity.
- Objectives: explain Glitchtip as self-hosted Sentry; understand crash-data islanding (per-self-hoster DSN); trace a Discord download notification; know the test-works-but-real-grabs-silent failure shape.
- Dossier: `modules/35-telemetry-notifications-misc.md` · **45 min** · Prereqs: 05, 26
- War story: the upgraded quiz — the Discord test fires but real grabs go silent because Sonarr's notification fires only on the wrong event type (config, not network).

---

## PART 8 — Operating It For Real

> *Maps to owner Stage 5. Deploy, the NAS, the cross-language Rust crypto core, and bindings.*

### Module 36 — Deploy Pipeline: Two Homes, Two Rhythms
**Hook:** The frontend auto-deploys to Netlify on push to `main`; the backend NEVER auto-deploys — you run `deploy-nas.sh` yourself, every time.
- Objectives: distinguish the two deploy targets and rhythms; trace `deploy-nas.sh` (SSH → git-archive → rebuild → restart → health); understand deployed-vs-HEAD drift via `/api/version`.
- Dossier: `modules/36-deploy-pipeline.md` · **45 min** · Prereqs: 02, 05, Part 0 (0-E)
- War story: `deploy-nas.sh` ships from a clean `git archive`, not your working tree — and a full-stack recreate once surfaced pre-broken sidecars; always check `/api/version`.

### Module 37 — NAS Infrastructure: Nine Containers on a Box That Also Runs Plex
**Hook:** One weak 6-thread NAS runs the whole stack AND Plex. cloudflared is the only front door — an outbound tunnel, no open ports. Every build decision is shaped by "never overwhelm the box."
- Objectives: name the nine containers and their jobs; explain the cloudflared outbound tunnel + Docker private network; understand the NAS-safe-build discipline; know cap_drop hardening.
- Dossier: `modules/37-nas-infra.md` · **60 min** · Prereqs: 36, Part 0 (0-E)
- War story: an uncapped recreate-with-recompile drove load to ~73 and brown-outed Plex + SSH for 13 min — SSH starvation makes the runaway *unkillable*; hence the detached, auto-aborting safe-build.

### Module 38 — Contracts Crypto: One Rust Library Owns Every Secret
**Hook:** `emerald-contracts` mints/verifies all three token kinds, owns HKDF key derivation and the canonical JSON serializer, and parses the identity namespaces. *(Owner's #1 most-wanted.)*
- Objectives: explain the three token kinds and their crypto (HMAC stream, JWE device, internal-principal); understand HKDF (one secret → many purpose-keys); know why canonical JSON guarantees byte-identical output across languages.
- Dossier: `modules/38-contracts-crypto.md` · **60 min** · Prereqs: 13, Part 0 (0-C,0-G)
- War story: the canonical-bytes contract — reorder a field in Rust and `cargo test` may pass but `npm test`'s vector-parity test fails; the test vectors enforce cross-language agreement.

### Module 39 — Contracts Bindings: Same Rust, Three Languages
**Hook:** Two binding crates translate the one Rust crypto crate into a Node `.node` and a Python `.whl` — neither reimplements a single line of logic.
- Objectives: explain N-API and PyO3 as Rust→TS/Python bridges; understand why bindings only delegate (byte-identical output); know the `.node`/`.whl` build artifacts.
- Dossier: `modules/39-contracts-bindings.md` · **45 min** · Prereqs: 38, Part 0 (0-G)
- War story: the N-API `prepare` clobber — raw `napi build` in `prepare` zeroed the hand-authored `index.d.ts`; the dts-guard fix.

---

## PART 9 — Quality & History

> *How the system proves itself, and the encoded scar tissue of every bug that taught a lesson.*

### Module 40 — Testing Strategy: Four Tools, One Truth Document
**Hook:** vitest (TS), pytest (Python), cargo test (Rust), Playwright (real browser) — plus `tests/vectors/` JSON files that pin byte-level crypto output across all languages.
- Objectives: match each tool to its layer; explain the shared test vectors as a cross-language contract; understand why real Chrome (not headless) is required for playback tests; internalize "exit code 0 is not done."
- Dossier: `modules/40-testing-strategy.md` · **45 min** · Prereqs: 38, 22
- War story: a token minted by Rust, verified by TS, accepted by Python must be the same math — the vectors are the only thing that proves it.

### Module 41 — CI Workflows: The Robot at the Door
**Hook:** Every push and PR wakes a robot that tests, lints, scans, and builds the app — and turns red to block a broken merge.
- Objectives: explain CI as an automated safety net; read a workflow's trigger and job matrix; understand path-filters (why a Python-only change shouldn't fail `cargo test`).
- Dossier: `modules/41-ci-workflows.md` · **30 min** · Prereqs: 40, 30
- War story: the upgraded quiz — a Python-only PR fails `cargo test` because there's no `paths:` filter (and an `edition=2024` toolchain mismatch); add the filter.

### Module 42 — Scripts & Tooling: Proof, Not Promises
**Hook:** Proof scripts drive the *deployed* system and capture evidence ("playback starts in N seconds, segments decode"); security monitors detect config drift; utility scripts age-check image pins.
- Objectives: explain the three script purposes (proof / security-monitor / utility); understand "deployed ≠ claimed"; know why exit-code-0 proof scripts still assert business behavior.
- Dossier: `modules/42-scripts-tooling.md` · **45 min** · Prereqs: 36, 40
- War story: a proof script caught that the heartbeat POST needs an Origin header or CSRF 403s it — a test gotcha that masked a "broken" feature that actually worked.

### Module 43 — War Stories: What the System Does When an Invariant Breaks
**Hook:** Tutorials teach the happy path; war stories teach the real one. Each incident is a forgotten invariant biting back — the gap between symptom and cause is what makes an engineer.
- Objectives: simulate the wrong hypothesis for 3–4 incidents and feel the correction; extract the transferable invariant from each (container-loopback, tmpfs-masks-chown, depends-on-orders-only-first-start).
- Dossier: `modules/43-war-stories.md` · **60 min** · Prereqs: most of Parts 2–8 (capstone-adjacent)
- War story: *all of them* — this module IS the war-story collection; teach it last, as synthesis.

### Module 44 — Glossary Builder: The Two-Level Translator
**Hook:** Five technical domains collide in the README's first five minutes; this glossary translates every term at two levels (ELI5 + ELII) and points to where it lives in the repo.
- Objectives: use the glossary as a lookup during every other module; practice dialing a term between ELI5 and ELII; locate each term's home in the code.
- Dossier: `modules/44-glossary-builder.md` · **reference (use throughout)** · Prereqs: none — companion to all
- War story: the JWE-vs-JWT upgraded quiz — a short `SESSION_SECRET` makes the JWE brute-forceable, but a plain JWT leaks identity on interception with zero effort; "signed ≠ secret" made concrete.

---

# CAPSTONE — THE FINAL EXAM

Ten cross-module questions that trace a real user action across the whole stack. Use these only
AFTER the relevant parts are mastered (most require Parts 2–8; C5/C6 require Part 3+8; C9 requires
Part 4). Run them via `AskUserQuestion` with the answer hidden until submission. The answer key is
in a clearly separated block below — **do not reveal it until the learner has committed an answer.**

> Capstone questions (ask these first; keep answers hidden):

- **C1 — Click to Segments (full-stack trace).** A user clicks Play on a 10-bit HEVC 4K MKV with EAC3 5.1 audio in real Chrome. Trace the complete path from button click to the first H.264 segment rendering. Name ≥8 components/functions and one decision at each.
- **C2 — The "Never Suggest Again" chain.** A user clicks the red dot. Trace click → `rejections.json` → recommender sidecar → next `GET /api/suggestions` filtering the title. Name every store written, every HTTP call, every guard.
- **C3 — Deploy drift trap.** You deploy a backend change via `deploy-nas.sh`; `/api/health` is 200, but the SPA still shows old behavior. Trace the three most likely failure modes.
- **C4 — Concurrency cap arithmetic.** `MAX_CONCURRENT_CPU_TRANSCODES=1`, `MAX_CONCURRENT_GLOBAL_TRANSCODES=4`, VAAPI active. Three users start (HEVC→VAAPI re-encode; H.264 remux; IPTV copy), a fourth starts another HEVC→H.264. Will any 503?
- **C5 — The cross-language token contract.** A dev reorders a field in Rust's `canonicalBytes()`; `cargo test` passes; they push. CI runs `npm test`. Which tests fail, why, and what's the correct diagnosis?
- **C6 — Auth round-trip under session rotation.** An admin rotates `SESSION_SECRET` and redeploys only the backend. What happens to: (a) a user watching; (b) a user mid-PIN-login; (c) an iOS device token; (d) the in-flight HLS stream token; (e) a stored passkey?
- **C7 — The rec strip's four refetch paths.** "The strip reshuffles on every like." Name all four refetch paths, identify which one is incorrectly active on like, and give the one-line fix.
- **C8 — Transcript of a security review.** A reviewer claims CSRF can call `POST /api/auth/session` with a stolen Plex authToken to set a session cookie. Is this correct, partially correct, or wrong, and why?
- **C9 — The /scratch tmpfs + permissions trap at a new site.** A self-hoster's transcoder starts (health 200) but the first real play fails `Permission denied` on `/scratch`. Trace root cause, why health passed, and the fix.
- **C10 — The two-phase-commit trap applied to a new pipeline.** A nightly TMDB-enrichment job marks rows enriched (step 2) BEFORE fetching metadata (steps 3–4). The NAS loses power after step 2. What happens next run, and how do you redesign it crash-safe?

<details>
<summary><strong>CAPSTONE ANSWER KEY (do not reveal until the learner answers)</strong></summary>

**C1 — key waypoints:** (1) `MediaPlayer.tsx startPlaybackSession()` mounts. (2) `mediaApi.probedCaps()` awaits the singleton `MediaCapabilities` probe → `hls_fmp4_hevc:true`, `aac_max_channels:2`. (3) `mediaApi.playback('movie',id)` POSTs caps to the backend. (4) `server/routes/media.ts` validates the session via `requireAuth`, proxies to media-core's grant. (5) `media-core routes.rs` reads `media.db`; `capability::decide()` denies direct-play (MKV not in client containers). (6) `transcoder plan.rs`: HEVC + `hls_fmp4_hevc` → VideoOp::Copy + Fmp4; EAC3 not supported → EncodeAac{256}; subs → None. (7) `session.rs start()`: `try_acquire(cpu_charge=false)` (copy-remux uses global cap only); spawns ffmpeg with fMP4 + `-ac 2`. (8) backend polls `index.m3u8`, rewrites segment URLs with `?t=<stream_token>`, returns `{delivery:'hls', url}`. (9) `IptvPlayer.tsx`: hls.js MSE path, `startPosition:0` (vodHls, NOT live edge). (10) Browser MSE appends `seg_00000.m4s` — H.264 + stereo AAC succeed; `currentTime` advances.

**C2:** (1) `FeedbackDots onDislike` → `useSetFeedback.mutate`. (2) `onMutate` optimistic: removes card from all `['suggestions',kind]` caches. (3) `POST /api/feedback` enters `withItemLock(kind,tmdbId)`. (4) `addRejection()` writes `rejections.json` FIRST (atomic .tmp→rename). (5) `setDislike()` writes `userFeedback.json`; if it throws, `anotherUserDislikes` gates rollback. (6) fire-and-forget `postFeedback()` → recommender `/events/feedback`. (7) fire-and-forget `postRejection()` → recommender `/events/rejection`. (8) next `GET /api/suggestions/movie` reads `rejections.json` → `filterRecommenderSafe` drops the id, AND the recommender already anti-joined `household_rejections`. Defense in depth: two layers drop it.

**C3:** (1) SPA not re-deployed — it's on Netlify, not the NAS; a frontend-only change needs a push to `main`. (2) CDN/browser cache of old SPA chunks — if the content-hash filename didn't change (backend-only file), the cached chunk is stale; check `/api/version` `release` vs HEAD. (3) `deploy-nas.sh` shipped a stale image — it uses `git archive HEAD`; compare `/api/version` `release` against `git rev-parse HEAD`; mismatch = stale container.

**C4 — no one 503s:** A (HEVC→VAAPI): `reencodes_video()=true` but `is_cpu()=false` → `cpu_charge=false`, global 1/4. B (remux): VideoOp::Copy → global 2/4. C (IPTV copy): global 3/4. D (another HEVC→VAAPI): `cpu_charge=false`, 3<4 → global 4/4, CPU 0/1. None 503. A *fifth* request would 503 on the GLOBAL cap (4), not the CPU cap. Key insight: VAAPI hardware encode never charges the CPU cap; on a HW-capable box the global cap of 4 is the real bottleneck.

**C5:** If the dev updated the Rust vector file to match the new order, `cargo test` passes. Then `npm test` fails: `iptvStreamToken.test.ts` loads the SAME vector file and checks TypeScript's `canonicalBytes()` output — but the TS template still serializes alphabetically, so its bytes no longer match the updated vector. The cross-language contract catches the one-sided change. Correct fix: update BOTH the Rust impl AND the TS template (or revert to alphabetical and update neither).

**C6:** (a) Watching user — cookie was encrypted with the OLD secret; next `requireAuth` fails to decrypt → 401, logged out. (b) Mid-PIN — completes on plex.tv, backend mints a NEW cookie under the new secret; logs in fine. (c) iOS device token — uses `DEVICE_TOKEN_SECRET`, independent; unaffected. (d) HLS stream token — uses `STREAM_TOKEN_SECRET`, independent; in-flight session keeps serving for its TTL. (e) Passkey — asymmetric WebAuthn keys in SQLite; `SESSION_SECRET` rotation has no effect.

**C7 — four paths:** (1) `staleTime` expiry (fixed: `staleTime:Infinity`). (2) `invalidateQueries(['suggestions',kind])` — could be in `useSetFeedback.onSettled`, `AddMovieModal.onSuccess`, `AddSeriesModal.onSuccess`. (3) explicit `refetch()`. (4) query-key change (`forceTrending`/`mode`/fingerprint). The active bug: `onSettled` calls `invalidateQueries` on EVERY signal including likes. One-line fix: add `if (variables.signal !== 'dislike') return` before the low-water block.

**C8 — partially correct in theory, not exploitable:** `requireSafeOrigin` runs first and checks the `Origin` header against `env.allowedOrigins` — a cross-site `evil.com` request is 403'd. The attacker would also need the valid Plex `authToken` (the phishing page can't silently obtain it). The bearer-only exemption doesn't apply (this is a cookie-setting endpoint with no Bearer header). The CSRF Origin gate is the primary defense and it holds.

**C9 — root cause:** a `tmpfs:size=3g` mount creates a NEW filesystem at `/scratch` with default `root:root 0755`, OVERLAYING the Dockerfile's build-time `chown`. The non-root `transcoder` user can't write. Health passed because the health endpoint never writes to `/scratch` and unit tests use stub ffmpeg. Fix: `tmpfs:/scratch:size=3g,mode=1777` (world-writable + sticky, like `/tmp`), or chown in an entrypoint AFTER the tmpfs mounts, before dropping privileges.

**C10:** After power loss, step 2 committed `tmdb_enriched_at=NOW()` but steps 3–4 never ran. Next run, step 1 returns zero rows for those movies (they look enriched) → permanently skipped with null metadata. Redesigns: (A) move the marker UPDATE to AFTER step 4 (state trails work). (B) add a `..._in_progress` flag with a stale-retry window. (C) make step 1 also skip only rows with non-null enriched fields. General principle (war-stories #8): commit "done" only after the work it represents is durable — never mark done as a precondition for doing.

</details>

---

# COVERAGE APPENDIX — WHAT'S DELIBERATELY THIN

Honesty matters: this curriculum does not cover everything. GAPs A–E (the legacy Claude suggestions
pipeline, the 40% watch-signal threshold, source-precedence arbitration, the automated DB-backup
system, and the SPA tabs + IPTV hooks) were **closed** — they live in **Module 34**
(`backend-hidden-services`) and **Module 09** (`spa-tabs-iptv-hooks`). The following are knowingly
**still thin** (MED relevance, no dedicated dossier). A tutor should name these when a learner wanders
into them, rather than pretend they're covered:

**Backend routes (no dossier):**
- `plex-admin.ts` — Plex remote-access diagnostic (owner token only reads `/:/prefs`).
- `plex-links.ts` — multi-id (tmdb/tvdb/imdb) → Plex ratingKey resolver for "Play in Plex" deep links; in-flight coalescing + TTL cache.
- `users.ts` — admin listing combining PMS owner + accepted Plex shares + pending invites.
- `settings.ts` + `userApiKeys.ts` — per-user BYO Anthropic key storage (encrypted at rest, masked fingerprint, CSRF-gated). Module 34 mentions `appendUsageEvent`/`computeCostCents` but not this storage surface.
- `recommenderEvents.ts` — the 'clicked' signal mirror (SPA-side) vs. server-side 'added'.

**IPTV catalog population (Module 23 covers stream/proxy, NOT ingest):**
- `xtream.ts` (wire-level Xtream protocol client), `iptvSync.ts`, `iptvSyncJobs.ts`, `iptvScheduler.ts`, `iptvRows.ts`, `iptvAvailability.ts` — how the channel catalog actually gets populated.

**Backend scaffolding (LOW individually):**
- `localAvailability.ts`, `mediaLibraryDb*.ts` (Node-side media.db reader), `ffmpeg.ts` (boot ffprobe ≥6 check), `compatWindows.ts` (dated shim registry), `sanitize.ts`, `sub.ts`, `secrets.ts`, `serverDb.ts`, `logger.ts`, `parseLimitedJson.ts`, `streamBridge.ts`.

**SPA components (Module 16 covers auth flows, Module 09 covers tabs — these specific panels are thin):**
- `EpisodePicker.tsx` (+ `useSonarrEpisodes`), `DevicesPanel.tsx`, `InvitesPanel.tsx`, `UserMenu.tsx`, `ApiKeySettings.tsx`, `UsageDashboard.tsx`, `GrabActivityPanel.tsx`, `navTransition.tsx`/`viewTransition.ts`/`animatedFavicon.ts`.

**Recommender internals (Module 29 names only `fused.py`):**
- recipes `baseline_cosine.py`, `cold_start_trending.py`, `item_knn.py`, `mmr_diverse.py`; plus `metrics.py` (funnel), `reasons.py` (human-readable pick reasons), `telemetry.py` (OpenTelemetry), `seed_synthetic.py`.

**Tests & canonical docs (mentioned, not walked):**
- `tests/e2e/` specs (auth, downloads-permissioning, add-movie, core flows) + the integration-server helper; the app-level suites (`app.authz/csrf/iptv-disabled/media-gate/onError.test.ts`); how to read/extend `tests/vectors/`.
- `docs/ui/cutting-edge-spec.md` (P0–P3 UI technique tiers, motion tokens, View Transitions), `docs/superpowers/specs/2026-05-25-cross-service-contract.md` (the canonical M1.5 §4/§9/§14/§15 contract).

**Future (M2, intentionally out of scope now):**
- `EmeraldKit/` — only a privacy manifest exists in-repo; no Swift source yet. Would become HIGH priority when M2 (native Apple clients) starts.

**Terminology note for tutors:** "local recommender" (the Python FastAPI sidecar, `USE_LOCAL_RECOMMENDER=1`) is the LIVE path; the Claude path is the "legacy" one (Module 34). Don't let a learner over-value the Claude-path code — it's bypassed in production.

---


---

