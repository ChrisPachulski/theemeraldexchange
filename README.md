<div align="center">

<img src="public/brand/mark-3em.svg" alt="The Emerald Exchange" width="88" />

# The Emerald Exchange

**An invite-only, self-hosted streaming platform your household owns end to end** — a
Plex-style experience for live and on-demand media, built to ship as native iOS/tvOS apps.

![Web](https://img.shields.io/badge/web-React_19_+_Vite-61dafb?style=flat-square)
&nbsp;![API](https://img.shields.io/badge/api-Hono_+_TypeScript-f59e0b?style=flat-square)
&nbsp;![Core](https://img.shields.io/badge/media--core-Rust-dea584?style=flat-square)
&nbsp;![Recs](https://img.shields.io/badge/recommender-FastAPI-009688?style=flat-square)
&nbsp;![License](https://img.shields.io/badge/license-Proprietary-111111?style=flat-square)

</div>

Members sign in, browse the library, watch live and on-demand, and request new titles; the
owner curates and administers. The plumbing underneath — the \*arr stack, SAB, IPTV providers,
the transcoder — is implementation detail, never visible from inside the experience.

<!-- screenshot: add a hero screenshot of the web client here once captured —
     ![The Emerald Exchange](public/screenshot.png) -->

## Features

- **You own the box** — self-hosted on your NAS; household signals never leave it.
- **Live + on-demand** — an IPTV core with smoothed live cable, alongside a scanned,
  metadata-rich media library.
- **Four ways in, one allowlist** — Plex OAuth, Sign in with Apple, Sign in with Google,
  and WebAuthn passkeys, all converging on a single owner-controlled invite list.
- **Hardware transcoding** — HEVC→H.264 via Intel VAAPI on the NAS iGPU, software fallback off-box.
- **Local-first recommendations** — a FastAPI + sqlite-vec scoring sidecar; your taste never
  leaves the NAS.
- **Built to ship native** — the web client is the reference surface; native iOS/tvOS is the
  distribution target.

## Run your own Emerald server

Like running a Jellyfin server: prebuilt multi-arch images (amd64 + arm64), no accounts, no
domain, no build. On any box with Docker:

```bash
mkdir emerald && cd emerald
curl -fsSL https://raw.githubusercontent.com/ChrisPachulski/theemeraldexchange/main/selfhost/install.sh | sh
docker compose up -d
```

The installer generates every secret and asks for your media folder. After startup, retrieve the
one-time setup token with `docker compose logs backend | grep -A3 unclaimed`, then **claim the
server** from a WebAuthn-secure address:

- On a machine that runs Docker and has a browser, open `http://localhost:3001`.
- For a headless NAS, create a tunnel from your laptop with
  `ssh -N -L 3001:127.0.0.1:3001 <user>@<host>`, then open `http://localhost:3001` locally.
- Or enable the Tailscale profile and use its HTTPS URL.

Register a passkey with the setup token and you're the owner — invite your household from the
Users tab.

Everything else is opt-in, one flag each:

| Capability | Turn it on with |
|---|---|
| Remote access (private, via your [Tailscale](https://tailscale.com) tailnet) | `COMPOSE_PROFILES=remote` + `TS_AUTHKEY` |
| Remote access (public, via Cloudflare Tunnel + your domain) | `COMPOSE_PROFILES=remote-cloudflare` + `TUNNEL_TOKEN` |
| Richer metadata & discovery | `TMDB_READ_ACCESS_TOKEN` (free key) |
| Requests & downloads (existing Sonarr / Radarr / SAB) | `SONARR_API_KEY` / `RADARR_API_KEY` / `SAB_API_KEY` |
| Live TV (your Xtream/IPTV provider) | `XTREAM_HOST` / `XTREAM_USERNAME` / `XTREAM_PASSWORD` |
| Plex login as an extra sign-in provider | `PLEX_CLIENT_ID` (+ `PLEX_SERVER_ID`) |
| Sign in with Apple | `APPLE_CLIENT_ID` (`ENABLE_APPLE_SIGN_IN=1` is an optional fail-fast assertion) |
| Sign in with Google | `GOOGLE_CLIENT_ID` (`ENABLE_GOOGLE_SIGN_IN=1` is an optional fail-fast assertion) |
| Error telemetry (self-hosted Glitchtip) | `COMPOSE_PROFILES=telemetry` + `TELEMETRY_ENABLED=1` |

With everything off you still get the core product: library browsing + playback, passkey
sign-in, owner-controlled invites, and local-first recommendations. Passkeys require HTTPS or
the browser's loopback exception (`http://localhost`); plain HTTP on a LAN IP or `.local`
hostname is not a secure context. Use the localhost/SSH-tunnel path above or the Tailscale HTTPS
URL.

**Platforms.** Images are multi-arch (linux/amd64 + linux/arm64) and boot-verified on both
after every publish (`verify-images`):

- **Linux** (Ubuntu, Debian, …) — amd64 and arm64 (Raspberry Pi 5 class), native.
- **macOS** — Docker Desktop (or OrbStack/colima); Apple Silicon runs the arm64 images at
  native speed, Intel Macs the amd64 ones. Claim at `http://localhost:3001` on the Mac itself.
- **Windows** — Docker Desktop with the WSL2 backend; run the installer **inside a WSL
  (Ubuntu) shell**, not PowerShell — it's a POSIX script. `MEDIA_PATH` can point at
  `/mnt/c/...`, though a path inside WSL's own filesystem scans faster.

**Apple `container` and Microsoft WSL Containers (`wslc`).** Both new first-party runtimes
run our images — they're standard OCI, and the backend is verified live on Apple `container`
1.0 (macOS 26, Apple Silicon): `container run` of the GHCR image boots healthy with the SPA
and claim flow working. What neither runtime has yet is **Compose**, which the multi-service
bundle needs (inter-service DNS, health-ordered startup): Apple `container` resolves
container names only after a sudo `container system dns` setup, and `wslc` (public preview,
GA fall 2026) doesn't list Compose at all. Until they do, use a Compose-capable runtime for
the full stack; single-image runs on either are fully supported.

arm64 boxes transcode on CPU (Intel VAAPI hardware encode is x86-only) and fall back to
yt-dlp for trailers — everything else is identical across platforms.

## Quick start (development)

```bash
npm install
npm run dev        # SPA on :5173 + backend together; Vite proxies /api/* in dev
```

Copy `.env.example` to `.env.local` (gitignored) and fill it in — never commit API keys,
tokens, or DSNs. The media sidecars are opt-in: with their flags off, `npm run dev` alone gives
you the SPA + backend (auth, search, \*arr bridges). For the full local stack, see
**[Full-stack development](#full-stack-development)**.

## Architecture

Four runtimes, one product:

- **Web client** (`src/`) — React 19 + Vite + TypeScript SPA. Entry `src/main.tsx`, shell in
  `src/App.tsx`. Static bundle (Netlify in prod) talking to the backend over `/api/*`.
- **Backend** (`server/`) — Hono + TypeScript (run with `tsx`). Entry `server/index.ts`,
  assembled in `server/app.ts`. Owns auth, authorization, the IPTV core, the \*arr/SAB bridges,
  recommender and media-core proxies, telemetry distribution, and the SQLite data layer.
- **Rust workspace** (`crates/`) — `emerald-contracts` (cross-language token crypto, with
  `-napi` and `-pyo3` bindings), `media-core` (library scan / metadata / serve), and
  `transcoder` (ffmpeg-HLS sessions).
- **Recommender** (`recommender/`) — Python FastAPI + sqlite-vec scoring sidecar. Local-first:
  household signals never leave the NAS.

## Authentication

No homegrown password store. Identity comes from four parallel providers, all converging on a
single invite/members allowlist:

- **Plex OAuth** (PIN flow)
- **Sign in with Apple** (RS256, alg/aud/iss/nonce-pinned)
- **Sign in with Google** (RS256, issuer/audience-pinned across configured web/native clients)
- **WebAuthn passkeys** (cross-platform, password-free)

A user is authorized only if their identity is on the members allowlist, which the owner
manages via invites. The Plex token is encrypted at rest (JWE); invite redemption is atomic and
race-safe, and provider success is confirmed against the browser's `/api/me` session before the
dashboard trusts it.

## Backend surface (`/api`)

Everything the SPA needs hangs off `/api`, mounted in `server/app.ts` (the authoritative route
list): auth (`auth`, `auth/passkey`, `auth/device`) and identity (`me`, `devices`, `admin/*`),
the \*arr / SAB / IPTV / DVR bridges, TMDB and recommender proxies, telemetry, and — when
`USE_MEDIA_CORE=1` — `media` + `transcode` (the HLS playback proxy for non-direct-play files).
CORS is an explicit allowlist (`env.allowedOrigins`); state-changing requests are Origin-gated
(`requireSafeOrigin`).

## Full-stack development

The sidecars are opt-in. With their flags off, `npm run dev` gives you the SPA + backend with
the \*arr bridges pointed at whatever `.env.local` says. To run the full stack locally:

<details>
<summary><strong>Recommender</strong> — FastAPI, port 8000</summary>

```bash
cd recommender
make install && make migrate            # creates ./data/exchange.db
TMDB_API_KEY=... make ingest-bootstrap  # one-time catalog ingest
make featurize
RECOMMENDER_EVENT_SECRET=local-dev-secret make serve
```

Wire the backend via `.env.local`: `USE_LOCAL_RECOMMENDER=1`,
`RECOMMENDER_URL=http://localhost:8000`, and the same `RECOMMENDER_EVENT_SECRET` (required
whenever the flag is on).
</details>

<details>
<summary><strong>media-core</strong> — Rust, port 8002</summary>

```bash
MEDIA_CORE_PORT=8002 MEDIA_DB_PATH=./data/media.db \
  MEDIA_LIBRARY_PATHS=/path/to/your/media \
  cargo run -p media-core
```

Backend wiring: `USE_MEDIA_CORE=1`, `MEDIA_CORE_URL=http://localhost:8002`. With
`MEDIA_INTERNAL_PRINCIPAL_MODE` unset the principal gate defaults to `off`, so no shared secret
is needed in dev (prod runs `enforce` with `INTERNAL_PRINCIPAL_SECRET`).
</details>

<details>
<summary><strong>media-core mock</strong> — no Rust, fixtures only (fastest path for SPA/UI work)</summary>

```bash
npm run dev:media-mock        # localhost:8095, run alongside npm run dev
```

A fixture-backed stub that speaks media-core's HTTP surface (12 movies, 3 shows, a seeded watch
store; direct-play only). Backend wiring: `USE_MEDIA_CORE=1`,
`MEDIA_CORE_URL=http://127.0.0.1:8095`, and any 32+ char `INTERNAL_PRINCIPAL_SECRET`
placeholder — the proxy fails closed without one, the mock ignores it. Builds the library UI
without the Rust binary or a real `/media` library.
</details>

<details>
<summary><strong>Transcoder</strong> — Rust, port 8003 (needs <code>ffmpeg</code> on PATH)</summary>

```bash
TRANSCODER_PORT=8003 cargo run -p transcoder
```

Point media-core at it with `MEDIA_TRANSCODER_URL=http://localhost:8003` (unset, media-core
answers transcode-required files with 503). Set `TRANSCODER_FFMPEG_BIN` if `ffmpeg` isn't on PATH.
</details>

What honestly needs the NAS: hardware VAAPI encode (the Intel iGPU at `/dev/dri` — on a dev
laptop the boot probe demotes to software x264, correct but slow), the real Sonarr/Radarr/SAB/IPTV
upstreams, the Glitchtip stack, and the Cloudflare tunnel. The compose file
(`docker-compose.yml`) is the authoritative env reference for every service.

## Build & test

```bash
npm run build      # tsc -b && vite build && tsc -p server/tsconfig.json
npm test           # vitest run
npm run build:napi # build the emerald-contracts N-API binding

cargo test -p emerald-contracts -p media-core -p transcoder
( cd recommender && uv sync --extra dev && uv pip install --python .venv/bin/python maturin && .venv/bin/maturin develop --release -m ../crates/emerald-contracts-pyo3/Cargo.toml && uv run pytest )
```

## Deploy

Two tracks (see **[DEPLOY.md](./DEPLOY.md)**):

- **Self-host (LAN, easy)** — `selfhost/`: pull-based multi-arch images, 4 core services,
  optional profiles. The quickstart at the top of this README.
- **Owner full deployment** — the same images/compose with every profile on: NAS
  (`docker-compose` with `COMPOSE_PROFILES=remote-cloudflare,telemetry` → backend, recommender,
  media-core, transcoder, cloudflared, and the 4-container Glitchtip stack) behind a Cloudflare
  Tunnel, SPA on Netlify, Plex login enabled. One configuration of the same product — nothing
  the self-host track gives up is lost here.

## Docs

- **[PRODUCT.md](./PRODUCT.md)** — audience, principles, scope.
- **[DESIGN.md](./DESIGN.md)** — the design contract (palette, type, motion).
- **[DEPLOY.md](./DEPLOY.md)** — NAS setup and ongoing deploys.

## Status

The **backend track is shipped and running on the NAS**: the IPTV core, the locked cross-service
contract (Rust↔TS↔Python byte parity enforced in CI), the Rust media-core (library scan /
metadata / serve), and the ffmpeg transcoder (HEVC→H.264, hardware-encoded via Intel VAAPI).
The **Apple client track** — native playback, offline downloads, the Plex-Pass-equivalent tier
— is hard-blocked on Apple tooling (Xcode + Developer Program) and not started.

## License

Proprietary. Until the first binary is distributed the repository stays private; third-party
redistribution is not granted. See **[LICENSE](./LICENSE)**.
