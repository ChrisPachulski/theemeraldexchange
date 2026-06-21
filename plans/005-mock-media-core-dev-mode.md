# Plan 005: Mock media-core dev mode — one-command SPA development against a fixture library

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4132b9a..HEAD -- server/routes/media.ts server/env.ts server/app.ts src/lib/api/media.ts package.json .env.example`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (dev-only surface)
- **Depends on**: plans/003-reconcile-env-example.md (so the env vars land in a current template; soft dependency — proceed if 003 is BLOCKED)
- **Category**: direction (DX / M5 prework)
- **Planned at**: commit `4132b9a`, 2026-06-12

## Why this matters

The roadmap (docs/ROADMAP-STATUS.md, M5 critical path) names "M5 UI in
parallel against a mocked media-core API" as the only M5 work possible
before the Apple toolchain gate clears — but no mock exists. Today a
developer who wants to build or iterate media-library UI (browse,
continue-watching, playback flows) must run the full Rust `media-core`
binary plus a real `/media` library, or nothing. A fixture-backed stub that
the existing Hono proxy points at makes `USE_MEDIA_CORE=1` development a
one-command affair, with deterministic data — also useful for UI tests and
for reproducing playback-flow bugs without the NAS.

Design principle: the backend proxy (`server/routes/media.ts`) must not
learn about the mock at all. The mock is a separate process that speaks
media-core's HTTP surface; the backend reaches it through the existing
`MEDIA_CORE_URL` env var. Zero prod-path changes.

## Current state

- **Gate + URL**: `server/env.ts:138` — `const useMediaCore = process.env.USE_MEDIA_CORE === '1'`;
  `server/env.ts:524-525` — `mediaCoreUrl: opt('MEDIA_CORE_URL') ?? <default>`.
  `server/app.ts:127-132` exposes `mediaEnabled: env.useMediaCore` to the
  SPA (which gates its media tab on it).
- **What the backend proxy calls upstream** (`server/routes/media.ts`):
  1. `POST {mediaCoreUrl}/api/media/play/{kind}/{id}/grant` (line 180) with
     a JSON caps body (`containers`, `video_codecs`, `max_height`, `hdr`,
     `audio_codecs`, `aac_max_channels`, `hls_fmp4_hevc` — lines 184-192).
     Expected response shape (line 177):
     `{ directPlay?: boolean; file?: { duration_secs?: number | null } }`.
     404 upstream → backend 404 `not_found`; non-OK → 502 (lines 197-198).
  2. When `directPlay && !forceHls` (line 209): the backend mints a stream
     token itself and answers
     `{ delivery: 'progressive', url: '/api/media/stream/{kind}/{id}?t=…', durationSecs }`
     (lines 215-219). The actual bytes are later fetched through the
     catch-all proxy (below) at `GET {mediaCoreUrl}/api/media/stream/{kind}/{id}`.
  3. Transcode path (only when NOT direct-play):
     `GET {mediaCoreUrl}/api/media/stream/{kind}/{id}?{capsQuery}` (line 229)
     expecting `{ sessionId?, manifestUrl?, heartbeatUrl? }` (line 225),
     then polls `{transcoderUrl}{manifestUrl}` for segment readiness
     (lines 260-282). **The mock will not implement this path** — it
     always answers direct-play (see scope cut below).
  4. Catch-all `media.all('/*')` (line 309) forwards everything else to
     `{mediaCoreUrl}/api/media{subpath}` (line 318), stripping the `?t=`
     token and forwarding Range/conditional headers
     (`FORWARD_REQUEST_HEADERS`, lines 23-28) and copying back
     content-type/length/range/etag/etc. (`FORWARD_RESPONSE_HEADERS`,
     lines 31-43). This carries the JSON list routes AND the direct-play
     bytes.
- **Auth toward upstream**: every upstream call sends an
  internal-principal Bearer minted via `principalHeader(session)`; if
  minting throws, the proxy fails closed with 502 `principal_mint_failed`
  (`media.ts:163-169`, same pattern at 320-325). So the DEV RECIPE must set
  `INTERNAL_PRINCIPAL_SECRET` to any placeholder ≥ the loader's minimum so
  minting succeeds; the mock simply ignores the header (it is the
  fail-open dev double of a fail-closed prod boundary — acceptable only
  because the mock binds to localhost and serves fixtures).
- **What the SPA consumes** (`src/lib/api/media.ts:577-640`, `mediaApi`):
  `movies(q?)`, `shows(q?)`, `allMovies()`/`allShows()` (paged),
  `episodes(showId)`, `scan()`, `playback(kind, id, caps?, startSecs?, forceHls?)`,
  `watch()`, `saveWatch(entry)`, `flushWatch(entry)` (keepalive POST).
  List endpoints return `{ items, total }`; watch rows are snake_case
  (`media_kind`, `media_id`, `position_secs`, `duration_secs`, `completed`).
  For exact row fields, mirror the `Raw*Row` types in that file
  (`RawMovieRow`/`RawShowRow`/`RawEpisodeRow`/`RawWatchRow`) — read them
  before writing fixtures.
- **Paging**: `allMovies`/`allShows` page with `limit`/`offset` query
  params via `fetchAllPages` (read its implementation in
  `src/lib/api/media.ts` for the exact param names and stop condition —
  the mock's list endpoints must honor them or the SPA loops/undercounts).
- Conventions: backend code is Hono + TypeScript ESM with `.js` import
  suffixes (see any `server/routes/*.ts`); scripts run via `tsx`;
  dev server is `npm run dev` (`concurrently` vite + `tsx watch server/index.ts`,
  package.json scripts block).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `npm ci`                 | exit 0              |
| Typecheck | `npx tsc -b` and `npm run build:server` | exit 0 |
| Tests     | `npm test`               | all pass            |
| Lint      | `npm run lint`           | exit 0              |
| Mock (new)| `npm run dev:media-mock` | stub listening, logs its port |

## Scope

**In scope** (the only files you should modify/create):
- `server/mocks/mediaCoreMock.ts` (create — the stub server)
- `server/mocks/fixtures.ts` (create — the fixture catalog; data only)
- `server/mocks/mediaCoreMock.test.ts` (create)
- `package.json` (add the `dev:media-mock` script)
- `.env.example` (add the recipe block: `USE_MEDIA_CORE`, `MEDIA_CORE_URL`,
  `INTERNAL_PRINCIPAL_SECRET` placeholder note, `MEDIA_CORE_MOCK_PORT`)
- `README.md` (extend "Local full-stack development" with the mock recipe)

**Out of scope** (do NOT touch, even though they look related):
- `server/routes/media.ts`, `server/app.ts`, `server/env.ts` — the whole
  point is that the real proxy is mock-agnostic. If the mock seems to need
  a backend change, the mock is wrong.
- `crates/media-core/` — the real service is the contract's source of
  truth, not a thing to edit.
- `src/` — the SPA must work unmodified against the mock.
- `docker-compose.yml` — the mock never ships to the NAS.
- The transcode/HLS handoff path and `/api/transcode` proxy — see the
  deliberate scope cut in Steps.

## Git workflow

- Branch: `advisor/005-media-core-mock`
- Conventional commits (e.g. `feat(dev): fixture-backed media-core mock for SPA development`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fixture catalog

`server/mocks/fixtures.ts`: ~12 movies and ~3 shows with ~6 episodes each,
shaped exactly like media-core's list responses as consumed by
`src/lib/api/media.ts`'s `RawMovieRow`/`RawShowRow`/`RawEpisodeRow` (read
those types first; include enough variety — a couple of titles with
`poster`/`tmdb` metadata absent, long titles, year edge cases — to make UI
states exercisable). Include one in-memory watch-row store (a `Map`) seeded
with two partially-watched titles so continue-watching UI has data on first
load.

**Verify**: `npx tsc -b` (or `npm run build:server` if the mocks dir is
outside the SPA tsconfig) → exit 0.

### Step 2: The stub server

`server/mocks/mediaCoreMock.ts`: a small Hono app (match backend import
conventions) listening on `MEDIA_CORE_MOCK_PORT` (default pick a free-ish
dev port, e.g. 8095 — choose one and document it; verify nothing in the
repo claims it: `grep -rn '<port>' .env.example docker-compose.yml README.md`).
Routes, all under `/api/media`:

- `GET /movies`, `GET /shows` — `{ items, total }` honoring `q`
  (substring, case-insensitive) + the `limit`/`offset` paging contract
  from `fetchAllPages`.
- `GET /shows/:id/episodes` — `{ items, total }`.
- `POST /scan` — `{ status: 'started' }` (matches `ScanStarted` in
  `src/lib/api/media.ts:144`).
- `GET /watch` — `{ items: [...] }` from the in-memory store;
  `POST /watch` — upsert into the store, `{ ok: true }`. Mirror the
  snake_case field names from `RawWatchRow`/`WatchUpsertBody`.
- `POST /play/:kind/:id/grant` — always
  `{ directPlay: true, file: { duration_secs: <fixture duration> } }`;
  404 JSON for unknown ids (the backend maps it to `not_found`,
  `media.ts:197`).
- `GET /stream/:kind/:id` — serve the sample video file (Step 3) with
  Range support. Easiest correct path: read the file, honor a single
  `bytes=a-b` range with 206 + `Content-Range`/`Accept-Ranges`, else 200 —
  `<video>` seeking needs real 206 handling; don't fake it.
- Everything else: 404 JSON `{ error: 'mock_unimplemented', path }` so a
  gap is loud, not silent.

The mock ignores Authorization entirely (dev fail-open double of the
fail-closed prod boundary) and must bind to `127.0.0.1`, not `0.0.0.0`.

**Verify**: `npm run dev:media-mock` (after Step 4 wires it) starts and
`node -e "fetch('http://127.0.0.1:<port>/api/media/movies').then(r=>r.json()).then(j=>console.log(j.total))"`
prints the fixture count. (Reminder: `curl` is not available in this
sandbox; use `node` for HTTP checks.)

### Step 3: Sample media file

Generate a small (~10-30s) H.264+AAC mp4 at
`server/mocks/fixtures/sample.mp4` using ffmpeg's synthetic sources
(`-f lavfi -i testsrc=...`, `-f lavfi -i sine=...`), committed to the repo
(keep it under ~1 MB). If `ffmpeg` is unavailable in your environment,
STOP (see STOP conditions) rather than checking in a binary obtained from
the network. All fixture titles point at this one file; durations in
fixture metadata may still vary (the player pins duration from the grant).

**Verify**: `ffprobe server/mocks/fixtures/sample.mp4` (or
`npx tsx -e` probing via the file size) → h264 video + aac audio; file size
< 1 MB; the file plays in `<video>` (covered end-to-end in Step 6).

### Step 4: Wiring

- `package.json`: `"dev:media-mock": "tsx watch server/mocks/mediaCoreMock.ts"`.
- `.env.example`: a short recipe block —
  ```
  # ── Media library WITHOUT the Rust stack (SPA/UI development) ──
  # 1. USE_MEDIA_CORE=1
  # 2. MEDIA_CORE_URL=http://127.0.0.1:<port>
  # 3. INTERNAL_PRINCIPAL_SECRET=<any 32+ char placeholder — the mock ignores it,
  #    but the backend proxy fails closed without one>
  # 4. npm run dev:media-mock   (alongside npm run dev)
  ```
  (If plan 003 restructured the file, put this in its media-core section.)
- `README.md`: 4-6 lines in "Local full-stack development" presenting the
  mock as the lightweight alternative to running the real media-core.

**Verify**: `npm run dev:media-mock` runs from a clean checkout after
`npm ci`.

### Step 5: Tests

`server/mocks/mediaCoreMock.test.ts` (vitest, follow the style of an
existing server test such as `server/services/iptvEpgQuery.test.ts` —
in-process `app.request(...)` against the Hono app, no listening socket):

1. `GET /api/media/movies?limit=5&offset=10` → 5 items, `total` = full
   fixture count (paging contract).
2. `q` filter narrows.
3. `POST /api/media/play/movie/<id>/grant` → `{ directPlay: true, file: { duration_secs } }`;
   unknown id → 404.
4. watch upsert round-trip: POST then GET reflects the row.
5. `GET /api/media/stream/movie/<id>` with `Range: bytes=0-99` → 206,
   `content-range` present, body length 100.

**Verify**: `npm test -- mediaCoreMock` → all pass.

### Step 6: End-to-end smoke through the real proxy

With `.env.local` set per the Step-4 recipe, run `npm run dev` +
`npm run dev:media-mock`. Then, against the BACKEND (port 3001), verify the
full chain (backend auth applies — mint or reuse a dev session per the
repo's normal dev login; if no session is obtainable headlessly, do this
step in the running SPA in a browser):

1. the SPA's `/api/me`-adjacent config shows `mediaEnabled: true`;
2. `mediaApi.movies` path: `GET /api/media/movies` through the backend
   returns the fixtures;
3. a playback grant for a fixture movie returns
   `{ delivery: 'progressive', url: '/api/media/stream/...?t=...' }`;
4. fetching that URL with a `Range` header returns 206 video bytes.

**Verify**: all four observed; record the outputs in your report.

### Step 7: Full gate

```bash
npm test && npx tsc -b && npm run lint && npm run build:server
```

**Verify**: all green.

## Test plan

Steps 5 (unit, in-process) and 6 (live smoke through the real proxy).
Model unit tests on `server/services/iptvEpgQuery.test.ts`'s structure.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run dev:media-mock` starts a localhost-only stub; `GET /api/media/movies` answers with fixtures
- [ ] `npm test` exits 0 including `mediaCoreMock.test.ts` (≥5 tests per Step 5)
- [ ] Step-6 smoke: grant → progressive URL → 206 Range bytes, all through the unmodified backend proxy
- [ ] `git diff --name-only -- server/routes server/app.ts server/env.ts src crates docker-compose.yml` is EMPTY (prod path untouched)
- [ ] `server/mocks/fixtures/sample.mp4` < 1 MB and ffprobe-valid h264+aac
- [ ] `npx tsc -b`, `npm run lint`, `npm run build:server` exit 0
- [ ] `.env.example` + README carry the recipe
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (especially the upstream call shapes in `server/routes/media.ts` —
  if those drifted, the mock contract must be re-derived, not guessed).
- `ffmpeg` is not available to generate the sample mp4 — do NOT download a
  video from the internet or fabricate bytes; report and let the operator
  supply the fixture.
- The backend proxy rejects the mock for a reason that seems to require
  changing `server/routes/media.ts` or `server/env.ts` — the prod path is
  out of scope; report the mismatch.
- Making the SPA's playback work appears to require implementing the
  HLS/transcoder handoff — that is the deliberate scope cut (the mock is
  direct-play only); report rather than building a transcoder mock.

## Maintenance notes

- The mock is a CONTRACT DOUBLE of media-core's HTTP surface. When
  media-core's routes change (`crates/media-core/src/routes.rs`), the mock
  drifts silently — its `mock_unimplemented` 404 makes new-route gaps loud,
  but SHAPE changes to existing routes won't be caught. Reviewers of
  media-core API changes should grep `server/mocks/` and update it in the
  same PR.
- Deliberately not implemented: the transcode/HLS handoff (always
  direct-play). If M5 UI work later needs HLS-path states (stall
  escalation, 503 transcoder-busy UX), that is a new plan — it needs a
  manifest+segment fixture server and the `{transcoderUrl}` probe, not a
  quick patch here.
- The mock ignores auth by design; never bind it to non-localhost and
  never reference it from docker-compose.
