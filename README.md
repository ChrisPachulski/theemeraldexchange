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

Plus one out-of-band tool, not part of the product runtime:

- **Autoloop** (`scripts/autoloop/`, state in `.autoloop/`) — an autonomous,
  convergent codex mesh that improves the repo while you're away. Runs on
  **codex** (flat-rate; never `claude -p`), gated by `.autoloop/CONTROL.md`
  (`MASTER: ON/OFF`) with a `.autoloop/STOP` kill-switch. See
  [scripts/autoloop/README.md](./scripts/autoloop/README.md). P0–P1 landed;
  P2–P5 pending.

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

`auth`, `auth/device`, `auth/passkey`, `me`, `version`, `devices`,
`admin/devices`, `admin/invites`, `admin/members`, `sonarr`, `radarr`, `sab`,
`tmdb`, `iptv`, `users`, `plex`, `notifications`, `grabs`, `suggestions`,
`feedback`, `usage`, `recommender`, `telemetry`, and (when
`USE_MEDIA_CORE=1`) `media`. CORS is an explicit allowlist
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
( cd recommender && pytest )
```

## Deploy

Self-hosted on the NAS (`root@theemeraldexchange.local`, Unraid) via
`docker-compose` (~15 services) behind a Cloudflare Tunnel; the SPA ships to
Netlify. Crash/error telemetry is per-self-hoster Glitchtip (§15), with the DSN
distributed server → client at boot. See [DEPLOY.md](./DEPLOY.md).

## Project docs

- [TODO.md](./TODO.md) — high-level worklist; start here for what's outstanding.
- [docs/ROADMAP-STATUS.md](./docs/ROADMAP-STATUS.md) — honest per-milestone state (M1–M6).
- [PRODUCT.md](./PRODUCT.md) — audience, principles, scope.
- [DESIGN.md](./DESIGN.md) — Impeccable design contract (palette, type, motion).
- [DEPLOY.md](./DEPLOY.md) — NAS setup and ongoing deploys.
- [docs/PRODUCTION-READINESS-2026-05-30.md](./docs/PRODUCTION-READINESS-2026-05-30.md) — historical review ledger; re-verify rows before planning.

## Roadmap

M1 (IPTV core) shipped. M1.5 is the cross-service contract gate. M2 brings the
Apple clients (the App-Store target), M3 the Rust media-core, M4 the
transcoder, M5 the native clients. Until the first binary is distributed the
repository stays private; third-party redistribution is not granted.
