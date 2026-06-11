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

`auth`, `auth/device`, `auth/passkey`, `me`, `version`, `limits`, `devices`,
`admin/devices`, `admin/invites`, `admin/members`, `sonarr`, `radarr`, `sab`,
`tmdb`, `iptv`, `users`, `plex`, `notifications`, `grabs`, `suggestions`,
`feedback`, `usage`, `recommender`, `telemetry`, and (when
`USE_MEDIA_CORE=1`) `media` + `transcode` (the HLS playback proxy for
non-direct-play files). CORS is an explicit allowlist
(`env.allowedOrigins`); state-changing requests are Origin-gated
(`requireSafeOrigin`).

## Local development

```bash
npm install
npm run dev        # vite + tsx backend (concurrently)
```

`npm run dev` runs the SPA (Vite, port 5173) and the backend together; Vite
proxies `/api/*` to the backend so requests are same-origin in dev. Backend
secrets live in `.env` (gitignored) — never commit API keys, tokens, or DSNs.

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
Cloudflare Tunnel; the SPA ships to Netlify. Crash/error telemetry is per-self-hoster Glitchtip (§15), with the DSN
distributed server → client at boot. See [DEPLOY.md](./DEPLOY.md).

## Project docs

- [docs/README.md](./docs/README.md) — the doc map: which docs are current source-of-truth vs historical archive. Start here when unsure.
- [TODO.md](./TODO.md) — high-level worklist; start here for what's outstanding.
- [docs/ROADMAP-STATUS.md](./docs/ROADMAP-STATUS.md) — honest per-milestone state (M1–M6).
- [PRODUCT.md](./PRODUCT.md) — audience, principles, scope.
- [DESIGN.md](./DESIGN.md) — Impeccable design contract (palette, type, motion).
- [DEPLOY.md](./DEPLOY.md) — NAS setup and ongoing deploys.
- [docs/PRODUCTION-READINESS-2026-05-30.md](./docs/PRODUCTION-READINESS-2026-05-30.md) — historical review ledger; re-verify rows before planning.

## Roadmap

The backend track is largely shipped; the client track is hard-blocked on Apple
tooling (Xcode + Developer Program). Honest per-milestone detail with status and
percentages lives in [docs/ROADMAP-STATUS.md](./docs/ROADMAP-STATUS.md).

- **M1 — IPTV core:** shipped and live.
- **M1.5 — cross-service contract:** ratified/locked; Rust↔TS↔Python byte
  parity enforced in CI.
- **M3 — Rust media-core:** live on the NAS in enforce mode (library
  scan / metadata / serve).
- **M4 — transcoder:** deployed; real-library HEVC→H.264 transcode proven
  played end-to-end in a real browser over the public path, hardware-encoded
  via Intel VAAPI on the NAS iGPU. Remaining: stress/bench evidence and a
  seek-latency re-measurement.
- **M2 / M5 / M6 — Apple clients, native playback + offline downloads, the
  Plex-Pass-equivalent tier:** not started, blocked on the Apple gate.

Until the first binary is distributed the repository stays private; third-party
redistribution is not granted.
