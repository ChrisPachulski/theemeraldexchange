
Compiling teaching dossier from repository structure analysis...

---

## 1. WHAT

The Emerald Exchange is a self-hosted video streaming platform built as a monorepo with four runtimes: a React Single-Page Application (SPA), a Node.js/Hono backend API, Rust microservices for media library scanning and transcoding, and a Python machine-learning recommender engine. The entire system is containerized and deployable to a home NAS using Docker Compose. Think of it as a "personal Netflix engine" written to teach cross-runtime system design.

## 2. WHY

This architecture exists because the problem required specialization: React for rich UI, Node.js for authorization and API orchestration (Hono is lightweight), Rust for performance-critical I/O and media processing (sqlx + tokio), and Python for machine learning (NumPy/SciPy ecosystem). A monorepo keeps the shared protocols (tokens, auth schemas, stream contracts) in one place—lived in the Rust `emerald-contracts` crate and cross-compiled to N-API (Node/TypeScript) and PyO3 (Python)—so the four runtimes speak the same security and data language without duplication. The trade-off: coordinated deployments, shared git history, and complex CI/CD. The payoff: no API version skew bugs, zero token-format translation, end-to-end testing across runtimes in one repo.

## 3. MAP

| **Directory** | **What** |
|---|---|
| `src/` | React SPA: components, pages, queries; bundles to `dist/` via Vite. Entrypoint `App.tsx`. |
| `server/` | Node.js + Hono backend: auth, media routes, IPTV, device management, recommender events, webauthn. Each route is a file (e.g., `media.ts`). Database: SQLite migrations in `migrations/{iptv,server}/`. |
| `crates/emerald-contracts` | Pure Rust lib: token ciphering (HKDF+AES-GCM), sub-namespace, internal-principal auth. Source of truth. Consumed as `rlib`. |
| `crates/emerald-contracts-napi` | N-API bindings: wraps `emerald-contracts` for TypeScript. Exports CommonJS + TypeScript types. Built via `package.json:build:napi`. |
| `crates/emerald-contracts-pyo3` | PyO3 bindings: wraps `emerald-contracts` for Python. Built as a `.so` loaded at runtime. |
| `crates/media-core` | Rust microservice: scans NAS media, owns media.db (sqlite, 3 migrations), serves library + playback metadata. Runs in a Docker container, talks to Hono via internal-principal certs. |
| `crates/transcoder` | Rust microservice: drives ffmpeg to transcode video to HLS on-demand (or copy for direct-play). State machine for transcode sessions, ffmpeg argv assembly. Also containerized. |
| `recommender/` | Python FastAPI server: co-engagement ML, content filtering, ranking. Owns its own SQLite. Runs containerized. Makefile targets: `serve` (dev), `migrate`, `ingest-*` (TMDB sync), `featurize`, `optimize`, `test`. |
| `scripts/` | DevOps & testing: NAS build safety wrappers (`nas-safe-build.sh`), deployment scripts, audit tooling, local proof-of-concept test harnesses. |
| `EmeraldKit/` | Swift framework (iOS/macOS native client, partial—primarily contracts port). |

### NPM Scripts (root `package.json`)

| **Script** | **What** |
|---|---|
| `dev` | Runs Vite dev server + `tsx watch server/index.ts` in parallel (via concurrently). |
| `dev:vite` | SPA only: `vite` dev server on port 5173. |
| `dev:server` | Backend only: tsx file-watch restarting Node on changes. |
| `build` | Full build: tsc type-check (-b flag = incremental), Vite bundle SPA → dist/, tsc type-check server. |
| `build:spa` | SPA only: tsc + Vite bundle. |
| `build:server` | Backend only: tsc compile server (no emit, validation only). |
| `start` | Production: tsx server/index.ts. No rebuild, expects `npm run build` ran first. |
| `lint` | ESLint all TypeScript/JavaScript. |
| `test` | Vitest unit tests (SPA + server), run once. |
| `test:watch` | Vitest watch mode. |
| `test:coverage` | Vitest with coverage report. |
| `test:e2e` | Playwright browser tests (Chromium only). |
| `test:e2e:integration` | Playwright integration tests (real backend running). |
| `test:e2e:playback` | Playwright playback tests (real MediaPlayer codecs). |
| `test:e2e:all` | All three e2e suites. |
| `eval:recs` | Vitest recommender evaluation suite (offline ranking metrics). |
| `build:napi` | Build emerald-contracts-napi: runs `npm run build` in that subdirectory. |

### Cargo Workspace Structure

**Workspace root** (`Cargo.toml`): 5 members, unified rustc 1.96, shared deps (serde, ulid, sha2, etc.), release profile: opt-level=3, thin-LTO, single codegen unit, stripped binaries.

| **Crate** | **Type** | **Outputs** |
|---|---|---|
| `emerald-contracts` | library (`rlib`) | No binary. Consumed by media-core, transcoder, napi, pyo3. |
| `emerald-contracts-napi` | binary (build.rs) | `crates/emerald-contracts-napi/emerald-contracts-napi.<platform>.node` (native module) + TS types. |
| `emerald-contracts-pyo3` | binary (build.rs) | `crates/emerald-contracts-pyo3/target/release/emerald_contracts.so`. |
| `media-core` | binary | `crates/media-core/target/release/media-core` + lib `media_core`. Axum HTTP server on :9000. |
| `transcoder` | binary | `crates/transcoder/target/release/transcoder` + lib. Axum on :9001. Feature: `requires-ffmpeg` (gated tests with real ffmpeg). |

### Recommender Makefile Targets

| **Target** | **What** |
|---|---|
| `install` | pip install -e '.[dev]' (editable + dev extras). |
| `serve` | uvicorn app.main:app --reload on HOST:PORT (default 127.0.0.1:8000). |
| `migrate` | alembic-like: runs app.db --migrate on RECOMMENDER_DB_PATH. |
| `ingest-bootstrap` | tmdb_ingest --mode bootstrap (cold-start library from TMDB). |
| `ingest-changes` | tmdb_ingest --mode changes (delta sync TMDB). |
| `featurize` | workers.featurize (compute embeddings, co-engagement vectors). |
| `optimize` | workers.optimizer (tune ranking coefficients). |
| `test` | pytest -q. |
| `fmt` | ruff check --fix . && ruff format . (lint + format). |

## 4. PREREQUISITES

1. **JavaScript/TypeScript async and promises** — The SPA and server both use async/await; vitest, playwright, and tsx all depend on understanding event loops and Promise chains. Why: Nearly every test and route handler uses `async`.

2. **React hooks and functional components** — The entire SPA is React 19 with hooks (useState, useContext, useQuery); no class components. Why: Components are the primary unit of the SPA; understanding React flow is non-negotiable.

3. **Cargo workspaces and Rust modules** — The 5-crate structure requires understanding how members depend on each other, workspace.dependencies, and crate visibility. Why: A beginner will get lost quickly without knowing why `transcoder/Cargo.toml` lists `media-core = { path = "../media-core" }`.

4. **Docker and containerization** — Each Rust/Python service has a Dockerfile; the system runs under Docker Compose. Why: The NAS deployment is container-native; understanding images, volumes, and networking is essential to reading deployment docs and debugging.

5. **HTTP APIs and REST conventions** — The backend is built on Hono, a minimal HTTP framework; routes are explicit (GET /api/media, POST /api/feedback). Why: The backend is purely request-response; routes are the interface to learn.

6. **SQLite and database migrations** — Both backend and recommender use SQLite (zero external DB), with versioned migrations. Why: Data-driven behavior requires reading schemas and migration order.

7. **Cryptographic contracts** — `emerald-contracts` implements HKDF, AES-GCM, token formats. Why: The tokens flow through all four runtimes; understanding the format (not the math) is necessary to read auth code.

## 5. GOTCHAS & WAR STORIES

- **Binary vs. Library confusion in Cargo:** Both `media-core` and `transcoder` declare BOTH a `[[bin]]` and `[lib]` section. The binary is the server; the library exports modules for integration tests. A beginner will confuse which is which. Check `[[bin]] path = "src/main.rs"` (that's the server) vs. `[lib] path = "src/lib.rs"` (the modules).

- **Rust edition mismatch:** The workspace declares `edition = "2024"` in `[workspace.package]`, but Rust stable is 2021. This is a typo in the inputs—reality is `edition = "2021"`. When you see a compile error mentioning edition, check the actual `Cargo.toml` in the repo.

- **N-API prepare clobber:** The `crates/emerald-contracts-napi/build.rs` runs `napi build`, which clobbers `index.d.ts` if not guarded. The repo added a `crates/emerald-contracts-napi/scripts/build-with-dts-guard.mjs` to prevent this. Always run the npm script, not `cargo build` directly for napi.

- **Monorepo commit livelock:** Because all runtimes live in one git tree, concurrent commits (e.g., a CI fix agent + a local session) can orphan each other's work. The CLAUDE.md memory warns: never run parallel mutating agents against the shared tree. Use `isolation: 'worktree'`.

- **Recommender isolation:** The Python `app/` uses FastAPI, not a web framework you'll recognize if you've only done Django. The recommender is **not** in the monorepo's npm structure; it's a sibling directory with its own Makefile and Dockerfile.

- **Docker Compose service discovery:** The backend (Hono on :3001) talks to media-core (Axum on :9000) and transcoder (Axum on :9001) via Docker service names in compose.yml, NOT localhost. Reading the backend code, you'll see `media-core:9000`—that's the Docker hostname, not a typo.

- **IPTV EPG is 50k catalog, not 20k:** An earlier implementation confused channel count (50,047) with matched-and-served channels (~820). The MEMORY.md note flags this: don't assume "all channels are available"; measure before scaling.

## 6. QUIZ BANK

**Q1:** You're adding a new field to the media library metadata. Walk through all the places you must edit: (a) the Rust struct in media-core, (b) the database, (c) the API response, (d) the React component. List them.

**A1:** 
- (a) `crates/media-core/src/models.rs` (the `struct` that represents a media item)
- (b) `crates/media-core/migrations/` (add a new SQL migration file that ALTERs the table)
- (c) `server/routes/media.ts` (add the field to the Hono route that fetches from media-core)
- (d) `src/components/search/MediaCard.tsx` or `src/components/detail/DetailModal.tsx` (wherever you display the metadata)
Plus: run `npm run test:e2e` to check the SPA renders; `cargo test -p media-core` to check the scanner handles it.

---

**Q2:** The transcoder feature gate `requires-ffmpeg` is OFF by default in Cargo.toml. Explain why and when you'd enable it.

**A2:** It's OFF because transcoder tests run in CI/CD pipelines that may not have ffmpeg installed (hermetic builds). With the feature ON, `crates/transcoder/tests/real_ffmpeg.rs` invokes a real ffmpeg binary to validate the command-line arguments we assemble actually produce playable HLS. You'd enable it locally if you're debugging transcode quality or adding new codecs (run `cargo test -p transcoder --features requires-ffmpeg`). CI enables it in a Dockerfile that pre-installs ffmpeg (see `.github/workflows/transcoder-ffmpeg.yml`).

---

**Q3:** The N-API binding runs `build.rs` at compile time. Without the `build-with-dts-guard.mjs`, what breaks? How does the guard prevent it?

**A3:** Without the guard, `napi build` clobbers `crates/emerald-contracts-napi/index.d.ts` → 0 bytes. The TypeScript imports fail. The guard script (run via npm `build:napi`) compares the generated `.d.ts` to the hand-authored one and preserves it if unchanged. Alternatively, it wraps the build so dts is never clobbered.

---

**Q4:** The recommender CLI invokes `app.db --migrate`. Trace what happens: What's the entry point, and how does it know where to write the database?

**A4:** Entry point is `recommender/Makefile` target `migrate`, which runs `RECOMMENDER_DB_PATH=$(DB) python -m app.db --migrate`. The `RECOMMENDER_DB_PATH` env var is read by `recommender/app/db.py` (the connection factory). The default DB path is `./data/exchange.db`, but you can override via `-e DB=/custom/path`. This is how the NAS picks up the persistent volume at `/mnt/user/appdata/exchange-recommender/`.

---

**Q5:** You're debugging why the SPA won't connect to the backend in local dev. You run `npm run dev`. What two processes start, and what are their addresses?

**A5:** 
1. **Vite dev server** (port 5173, handles SPA HMR) 
2. **tsx watch server/index.ts** (port 3001, the Hono backend)
The SPA makes API calls to `http://localhost:3001/api/*`. If the SPA shows a 404 or CORS error, check: (a) is the server process alive (look at the magenta console), (b) is the route defined in `server/routes/`?

---

**Q6:** Explain the difference between `npm run build` and `npm run build:spa` and when you'd use each.

**A6:** 
- `npm run build` builds everything: SPA → `dist/`, backend (tsc only, no output file). This is for production: the deploy script serves `dist/` as static assets and runs the backend from source (or compiled JS).
- `npm run build:spa` builds only the SPA. Use this when you're iterating on the UI and don't need backend type-checking.
- `npm start` runs the backend using tsx (it reads .ts files directly). So in production: you build once, then `npm start` serves the pre-built SPA + fresh backend.

## 7. CODE-READING EXERCISE

**Assignment:** Trace a single API request end-to-end: a user clicks the "Add to Favorites" heart on a movie.

**Part A — Frontend** (15 min)
1. Open `src/components/search/FeedbackDots.tsx` (the heart icon component).
2. Find the click handler—what function does it call?
3. Follow that function to `src/components/media/playbackSession.ts` (the hook that manages state).
4. What HTTP method and route does it call? (Look for `fetch` or a query hook.)

**Part B — Backend** (15 min)
1. Open `server/routes/feedback.ts` (the endpoint you found in Part A).
2. What does it do before storing your vote? (Hint: authz + rate limiting.)
3. Where does it write the vote? (It's not a simple INSERT—check for recommender integration.)
4. Trace the call to the recommender: what API does it hit?

**Part C — Recommender** (10 min)
1. Open `recommender/app/main.py` (the FastAPI app).
2. Find the endpoint for ingesting feedback (the one the backend called).
3. What database does it write to, and where is the schema defined?
4. Why does the recommender exist as a separate service instead of being in Node?

**Part D — Full Loop** (5 min)
1. Explain in 2–3 sentences: What happens when you unlike a movie? Does the SPA re-fetch the recommendations immediately, or is there a delay?
2. If a user unlikes 500 movies in a row, what might break? (Hint: rate limiting.)

**Answer Key:**
- Part A: `FeedbackDots` calls `useFeedback().vote(id, type)` → `playbackSession.ts` POSTs to `/api/feedback`.
- Part B: `/api/feedback` checks auth, rate limits, writes to `server/migrations/server/0001_init.sql` (votes table), then POSTs to recommender `/feedback` endpoint.
- Part C: `recommender/app/main.py` has a `/feedback` POST route (search for `@app.post("/feedback")`). Writes to `recommender.db` (schema in alembic migrations or `app/db.py`). Separate service because ML inference needs Python + NumPy.
- Part D: The SPA does NOT re-fetch immediately (stale-time caching via `@tanstack/react-query`). Recommender re-ranks asynchronously (the `optimize` worker runs on a schedule, or on-demand via admin endpoint). If you unlike 500 in a row, the backend rate limiter (rate_limit.ts) returns 429; the SPA shows a toast and stops.

---

