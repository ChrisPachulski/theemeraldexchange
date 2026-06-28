# The Emerald Exchange

An invite-only, self-hosted streaming platform — a Plex-style media experience
the household owns end to end. Members sign in, browse the library, watch live
and on-demand, and request new titles; the owner curates and administers. The
web client is the reference surface; native iOS/tvOS clients are the
distribution target.

This repository is proprietary. See [LICENSE](./LICENSE).

## Architecture

Four runtimes, one product:

- **Web client** (`src/`) — React 19 + Vite + TypeScript SPA. Entry
  `src/main.tsx`; app shell in `src/App.tsx`. Served as a static bundle
  (Netlify in prod) that talks to the backend over `/api/*`.
- **Backend** (`server/`) — Hono + TypeScript (run with `tsx`). Process entry
  `server/index.ts`; the app is assembled in `server/app.ts`. Owns auth,
  authorization, the IPTV core, the *arr/SAB bridges, recommender and
  media-core proxies, telemetry distribution, and the SQLite data layer.
- **Rust workspace** (`crates/`) — `emerald-contracts` (cross-language token
  crypto, with `-napi` and `-pyo3` bindings), `media-core` (M3 library
  scan/metadata/serve), and `transcoder` (M4 ffmpeg-HLS sessions).
- **Recommender** (`recommender/`) — Python FastAPI + sqlite-vec scoring
  sidecar. Local-first: household signals never leave the NAS.

## Authentication & authorization

There is no homegrown password store. Identity comes from three parallel
providers, all converging on a single invite/members allowlist:

- **Plex OAuth** (PIN flow)
- **Sign in with Apple** (RS256, alg/aud/iss/nonce-pinned) for the device-pair
  bearer flow
- **WebAuthn passkeys** (cross-platform, password-free)

A user is authorized only if their identity is on the members allowlist, which
the owner manages via invites. The Plex token is encrypted at rest (JWE);
invite redemption is atomic and race-safe.

## Backend surface (`/api`)

Everything the SPA needs hangs off `/api`, mounted in `server/app.ts` (the
authoritative route list): auth (`auth`, `auth/passkey`, `auth/device`) and
identity (`me`, `devices`, `admin/*`), the *arr / SAB / IPTV / DVR bridges,
TMDB and recommender proxies, telemetry, and — when `USE_MEDIA_CORE=1` —
`media` + `transcode` (the HLS playback proxy for non-direct-play files). CORS
is an explicit allowlist (`env.allowedOrigins`); state-changing requests are
Origin-gated (`requireSafeOrigin`).

## Local development

```bash
npm install
npm run dev        # vite + tsx backend (concurrently)
```

`npm run dev` runs the SPA (Vite, port 5173) and the backend together; Vite
proxies `/api/*` to the backend so requests are same-origin in dev. The
backend loads its config from `.env.local` (gitignored); copy `.env.example`
to `.env.local` and fill it in — never commit API keys, tokens, or DSNs.

### Local full-stack development

The sidecars are opt-in: with their flags off, `npm run dev` alone gives you
the SPA + backend (auth, search, *arr bridges pointed at whatever
`.env.local` says). To run the full stack locally alongside it:

- **Recommender** (FastAPI, port 8000):

  ```bash
  cd recommender
  make install && make migrate            # creates ./data/exchange.db
  TMDB_API_KEY=... make ingest-bootstrap  # one-time catalog ingest
  make featurize
  RECOMMENDER_EVENT_SECRET=local-dev-secret make serve
  ```

  Then wire the backend via `.env.local`: `USE_LOCAL_RECOMMENDER=1`,
  `RECOMMENDER_URL=http://localhost:8000`, and the same
  `RECOMMENDER_EVENT_SECRET` (required whenever the flag is on).

- **media-core** (Rust, port 8002):

  ```bash
  MEDIA_CORE_PORT=8002 MEDIA_DB_PATH=./data/media.db \
    MEDIA_LIBRARY_PATHS=/path/to/your/media \
    cargo run -p media-core
  ```

  Backend wiring: `USE_MEDIA_CORE=1`, `MEDIA_CORE_URL=http://localhost:8002`.
  With `MEDIA_INTERNAL_PRINCIPAL_MODE` unset the principal gate defaults to
  `off`, so no shared secret is needed in dev (prod runs `enforce` with
  `INTERNAL_PRINCIPAL_SECRET`).

- **media-core mock** (no Rust, fixtures only — the fastest path for SPA/UI
  work on the library, continue-watching, and playback flows):

  ```bash
  npm run dev:media-mock        # localhost:8095, run alongside npm run dev
  ```

  A fixture-backed stub that speaks media-core's HTTP surface (12 movies,
  3 shows, a seeded watch store; direct-play only). Backend wiring:
  `USE_MEDIA_CORE=1`, `MEDIA_CORE_URL=http://127.0.0.1:8095`, and any 32+ char
  `INTERNAL_PRINCIPAL_SECRET` placeholder — the proxy fails closed without one,
  the mock ignores it. Builds the library UI without the Rust binary or a real
  `/media` library. The real proxy is unchanged; the mock is reached purely
  through `MEDIA_CORE_URL`.

- **Transcoder** (Rust, port 8003; needs `ffmpeg` on PATH, or set
  `TRANSCODER_FFMPEG_BIN`):

  ```bash
  TRANSCODER_PORT=8003 cargo run -p transcoder
  ```

  Point media-core at it with `MEDIA_TRANSCODER_URL=http://localhost:8003`
  (unset, media-core answers transcode-required files with 503).

What honestly needs the NAS: hardware VAAPI encode (the Intel iGPU at
`/dev/dri` — on a dev laptop the boot probe demotes to software x264, which
is correct but slow), the real Sonarr/Radarr/SAB/IPTV upstreams, the
Glitchtip stack, and the Cloudflare tunnel. The compose file
(`docker-compose.yml`) is the authoritative env reference for every service;
local processes are the fast loop, `docker compose` on the NAS is the real
topology.

## Build & test

```bash
npm run build      # tsc -b && vite build && tsc -p server/tsconfig.json
npm test           # vitest run
npm run build:napi # build the emerald-contracts N-API binding

cargo test -p emerald-contracts -p media-core -p transcoder
( cd recommender && uv sync --extra dev && uv pip install --python .venv/bin/python maturin && .venv/bin/maturin develop --release -m ../crates/emerald-contracts-pyo3/Cargo.toml && uv run pytest )
```

## Deploy

Self-hosted on the NAS (`root@theemeraldexchange.local`, Unraid) via
`docker-compose` (9 services: backend, recommender, media-core, transcoder,
cloudflared, and the 4-container Glitchtip telemetry stack) behind a
Cloudflare Tunnel; the SPA ships to Netlify. Crash/error telemetry is
per-self-hoster Glitchtip, with the DSN distributed server → client at boot.
See [DEPLOY.md](./DEPLOY.md).

## Project docs

- [PRODUCT.md](./PRODUCT.md) — audience, principles, scope.
- [DESIGN.md](./DESIGN.md) — the design contract (palette, type, motion).
- [DEPLOY.md](./DEPLOY.md) — NAS setup and ongoing deploys.

## Status

The backend track is shipped and running on the NAS: the IPTV core, the locked
cross-service contract (Rust↔TS↔Python byte parity enforced in CI), the Rust
media-core (library scan / metadata / serve), and the ffmpeg transcoder
(HEVC→H.264, hardware-encoded via Intel VAAPI on the NAS iGPU). The Apple client
track — native playback, offline downloads, the Plex-Pass-equivalent tier — is
hard-blocked on Apple tooling (Xcode + Developer Program) and not started.

Until the first binary is distributed the repository stays private; third-party
redistribution is not granted.
