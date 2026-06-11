# Deploying The Emerald Exchange (V2)

V2 splits the dashboard across two hosts. The SPA lives on Netlify; the Hono backend lives on the NAS behind a Cloudflare Tunnel.

```
theemeraldexchange.com           ──▶ Netlify (SPA)              ◀── git push triggers redeploy
api.theemeraldexchange.com       ──▶ Cloudflare Tunnel
                                  ──▶ cloudflared on NAS (shares backend netns)
                                  ──▶ 127.0.0.1:3001
                                  ──▶ exchange-backend (Hono)
                                       ├─▶ Sonarr / Radarr / SAB on the LAN
                                       ├─▶ exchange-recommender   (FastAPI, internal net; loopback :8001)
                                       │    └─ SQLite at /mnt/user/appdata/exchange-backend/recommender-db/exchange.db
                                       ├─▶ exchange-media-core    (Rust, library scan/serve; loopback :8002)
                                       │    └─▶ exchange-transcoder (Rust + ffmpeg/VAAPI HLS; loopback :8003)
                                       └─▶ glitchtip (+ -db, -redis, -worker) — telemetry; loopback :8100
```

`docker-compose.yml` defines **9 services**: `backend`, `recommender`,
`media-core`, `transcoder`, `cloudflared`, `glitchtip`, `glitchtip-db`,
`glitchtip-redis`, `glitchtip-worker`. One deploy script
(`scripts/deploy-nas.sh`) ships and health-gates the whole stack.

---

## One-time setup

You need four things in place before the first deploy: a Cloudflare Tunnel, a `.env.production` on this laptop, Netlify connected to the GitHub repo, and Glitchtip secrets generated (§4).

### 1. Cloudflare Tunnel

Create the tunnel in the Zero Trust dashboard. Steps:

1. https://one.dash.cloudflare.com/ → Networks → Connectors → Cloudflare Tunnels → **Create a tunnel**
2. Connector type: **Cloudflared** → Tunnel name: `theemeraldexchange`
3. On the **Install and run a connector** screen, switch the OS picker to **Docker**. The displayed `docker run …` command contains a long `--token eyJhI…` string. **Copy the token.** Don't run the command — `scripts/deploy-nas.sh` will run cloudflared on the NAS for you.
4. **Public Hostnames**: Subdomain `api`, Domain `theemeraldexchange.com`, Service Type `HTTP`, URL `localhost:3001`.
5. Save tunnel.

The tunnel will show **"Inactive"** until the first NAS deploy registers a connector.

### 2. `.env.production` on the laptop

```bash
cp .env.production.example .env.production
```

Open it and fill in:

| Var | Where it comes from |
|---|---|
| `TUNNEL_TOKEN` | The `eyJhI…` you copied above. |
| `PLEX_CLIENT_ID` | Same value as in your `.env.local` (or generate fresh: `node -e 'console.log(crypto.randomUUID())'`). |
| `SESSION_SECRET` | Generate fresh: `openssl rand -base64 48`. Must be ≥32 bytes and not a placeholder — the deploy script hard-fails otherwise. **Different from dev** so the two environments can't share sessions. |
| `STREAM_TOKEN_SECRET` | `openssl rand -base64 48`. Signs IPTV/media stream tokens (HMAC-SHA256). |
| `DEVICE_TOKEN_SECRET` | `openssl rand -base64 48`. IKM for the device-token JWE (Apple device pairing). Must be distinct from every other secret. |
| `INTERNAL_PRINCIPAL_SECRET` | `openssl rand -base64 48`. IKM for the internal-principal JWE the backend mints toward recommender/media-core/transcoder. Distinct from every other secret. |
| `RECOMMENDER_EVENT_SECRET` | `openssl rand -base64 48`. Shared secret signing backend → recommender calls. |
| `ADMINS` | Your Plex username(s), comma-separated. |
| `PLEX_SERVER_ID` | **Required in production** — your home Plex server's machineIdentifier. Without it, any authenticated Plex user can sign in. Discoverable via the SPA's first prod login (in the `discoveredServers` payload). Or query plex.tv directly. For the brief first-deploy bootstrap window before you know the id, set `ALLOW_UNSCOPED_PLEX_LOGIN=1` instead — but remove that opt-in as soon as you copy the id into `PLEX_SERVER_ID`. |
| `ALLOWED_ORIGINS` | `https://theemeraldexchange.com` |
| `SONARR_URL`, `SONARR_API_KEY` | Existing Sonarr install. |
| `RADARR_URL`, `RADARR_API_KEY` | Existing Radarr install. |
| `SAB_URL`, `SAB_API_KEY` | Existing SAB install. |
| `MIN_FREE_GB` | Default 100. |
| `GLITCHTIP_SECRET_KEY`, `GLITCHTIP_DB_PASSWORD`, `GLITCHTIP_DOMAIN` | **Set BEFORE the first `compose up`** — see [docs/operations/glitchtip-setup.md](./docs/operations/glitchtip-setup.md). The DB password must be hex (base64 characters break the `DATABASE_URL`); the domain needs an `http(s)://` scheme. |
| `EEX_TELEMETRY_DSN` | Does NOT exist yet on the first deploy — you mint it from the Glitchtip instance that deploy brings up, then redeploy. See the two-step bootstrap below. |

The full annotated key list lives in `.env.production.example`. The deploy
script validates all required keys (and the `SESSION_SECRET` strength /
`PLEX_SERVER_ID` scoping gates) before anything ships.

This file is gitignored. If you ever lose it, regenerate the secrets and redeploy — every active session resets, which is fine.

### 3. Netlify

1. https://app.netlify.com/start → **Import from Git** → connect GitHub → pick the `theemeraldexchange` repo.
2. Netlify auto-detects `netlify.toml`; build command and publish dir come from there.
3. **Site settings → Environment variables** → add:
   - `VITE_API_BASE_URL` = `https://api.theemeraldexchange.com`
4. **Domain management** → **Add a domain you already own** → `theemeraldexchange.com`.
5. Netlify gives you DNS records to add. Back at https://dash.cloudflare.com/ → DNS → add the records Netlify shows you. Cloudflare's "proxied" toggle should be **OFF (DNS only)** for these records — Netlify handles its own SSL. (Cloudflare proxy in front of Netlify is fine but more moving parts; skip until needed.)
6. Wait ~1 min for DNS propagation, then trigger the first Netlify deploy.

Site loads at https://theemeraldexchange.com but the API isn't there yet — onto the NAS deploy.

### 4. Glitchtip secrets (BEFORE the first compose up)

Telemetry is mandatory and self-hosted; the Glitchtip sidecar stack
(`glitchtip` + `glitchtip-db` + `glitchtip-redis` + `glitchtip-worker`) comes
up with everything else. **Work through
[docs/operations/glitchtip-setup.md](./docs/operations/glitchtip-setup.md)
first** — it generates `GLITCHTIP_SECRET_KEY` / `GLITCHTIP_DB_PASSWORD` /
`GLITCHTIP_DOMAIN`, which must exist in `.env.production` before the first
`docker compose up`, and walks the admin-account + DSN minting steps.

### 5. First NAS deploy (two-step bootstrap)

```bash
cd ~/Documents/theemeraldexchange
./scripts/deploy-nas.sh
```

What the script actually does (`./scripts/deploy-nas.sh --help` prints its own summary):

1. **Refuses to run on a dirty tree.** The payload is always `git archive HEAD`,
   so uncommitted tracked edits would silently not ship. `--allow-dirty`
   overrides with a loud warning; a HEAD ≠ `origin/main` drift is warned, not
   blocked.
2. Validates `.env.production` has every required key, mirrors the backend's
   `SESSION_SECRET` strength gate and the `PLEX_SERVER_ID` /
   `ALLOW_UNSCOPED_PLEX_LOGIN` scoping gate, so a bad env fails here instead of
   as a container crash loop.
3. Stages the payload from `git archive HEAD` into a temp dir and rsyncs — from
   that stage, never the working tree — `Dockerfile`, `docker-compose.yml`,
   `.dockerignore`, `package*.json`, `tsconfig.json`, `server/`, `recommender/`,
   `crates/`, and the root `Cargo.toml`/`Cargo.lock`/`LICENSE` to
   `/mnt/user/appdata/exchange-backend/` on the NAS.
4. Ships `.env.production` → NAS as `.env`, chmod 600.
5. Pre-creates + chowns the sidecar DB bind-mount dirs (`recommender-db` →
   uid 10001, `media-core-db` → uid 10002) so a fresh volume doesn't crash-loop
   the `cap_drop: ALL` sidecars.
6. Tags every currently-deployed image (`backend`, `recommender`, `media-core`,
   `transcoder`) as `:rollback`, then runs `docker compose up -d --build` with
   `EEX_RELEASE=<short sha of HEAD>` — `/api/version` reports that sha as
   `release`, which is how you detect deploy drift.
7. Restarts `exchange-cloudflared` (it shares the backend's netns; a backend
   recreate stales the reference and the public site 502s until the restart).
8. **Health-gates the whole stack** (~150s ceiling): backend + recommender +
   media-core + transcoder must all report docker-healthy. On failure it
   restores every `:rollback` image, re-ups, and prints per-container log and
   manual-rollback commands.

> **The first deploy is a two-step bootstrap.** `EEX_TELEMETRY_DSN` cannot exist
> yet — you mint it from the Glitchtip instance this very deploy brings up. The
> backend crash-loops in that window **by design**, and the script detects the
> unset DSN and skips the rollback instead of tearing down the Glitchtip you
> need. Create the EEX project + DSN
> ([glitchtip-setup.md §4](./docs/operations/glitchtip-setup.md)), set
> `EEX_TELEMETRY_DSN` in `.env.production`, and run `./scripts/deploy-nas.sh`
> again — the second run health-gates normally.

First build takes several minutes (npm ci + two Rust release builds + image
layers). Subsequent deploys are much faster (cached layers).

### 6. Verify end-to-end

```bash
curl -s https://api.theemeraldexchange.com/api/health
# {"ok":true}

# The deployed release must match what you shipped (the script prints this
# exact check with the sha filled in on success):
curl -s https://api.theemeraldexchange.com/api/version
# {... "release":"<short sha of the deployed HEAD>" ...}
```

Then in the browser: https://theemeraldexchange.com → Plex login should work cross-origin.

If `/api/health` 502s, the tunnel is up but the backend isn't reachable: `ssh root@theemeraldexchange.local 'docker logs exchange-backend --tail=30'`.
If it never resolves, the tunnel didn't register: `ssh root@theemeraldexchange.local 'docker logs exchange-cloudflared --tail=30'`.

### 7. Media library + GPU (media-core / transcoder)

`media-core` and `transcoder` both mount the media library read-only at
`/media` from `MEDIA_LIBRARY_HOST_PATH` (compose default is a test dir —
point it at the real share, e.g. `/mnt/user/media`). Two gotchas that have
each caused a real "library invisible / nothing plays" incident:

- **Library permissions.** The services run as dedicated uids (media-core
  10002, transcoder 10003). Every library directory must be world-traversable
  and files world-readable (`chmod -R a+rX` → dirs `0755`); a `0700` share is
  silently unservable even though the mount succeeds.
- **Backend flag.** The backend only proxies `/api/media` + `/api/transcode`
  when `USE_MEDIA_CORE=1` is set in `.env.production`. Until then media-core
  runs idle and the SPA shows no local library.

Hardware transcode: the compose maps `/dev/dri/renderD128` into the
transcoder with `group_add: "18"` (the NAS `video` group) and defaults
`TRANSCODER_HW_ENCODER=vaapi`. The boot smoke-test demotes to software
libx264 automatically if the GPU is absent — playback still works, just on
CPU. Verify after first boot:

```bash
ssh root@theemeraldexchange.local 'docker logs exchange-transcoder 2>&1 | grep -i -m1 encoder'
```

---

## Ongoing deploys

The deploy payload is `git archive HEAD` — **commit first**, then deploy. An
uncommitted edit never ships (the script refuses a dirty tree for exactly this
reason).

| What changed | Command | Effect |
|---|---|---|
| SPA only (anything in `src/`) | `git push` | Netlify auto-builds and deploys. ~30s. |
| Backend (anything in `server/`) | `./scripts/deploy-nas.sh` | NAS rebuild + restart of the backend image. ~30–60s. |
| Rust sidecars (anything in `crates/`, root `Cargo.toml`/`Cargo.lock`) | `./scripts/deploy-nas.sh` | NAS deploy too — `crates/` feeds the media-core + transcoder images AND the backend's napi / recommender's pyo3 contract bindings. Rust release rebuilds take minutes, not seconds. |
| Recommender (anything in `recommender/`) | `./scripts/deploy-nas.sh` | NAS rebuild of the recommender image. |
| Both SPA + NAS | `git push && ./scripts/deploy-nas.sh` | Deploy the **frontend before the backend** when a change spans both (the SPA is the consumer). |
| Env var change in `.env.production` | `./scripts/deploy-nas.sh` | Same script; new `.env` ships and containers restart. |
| `VITE_API_BASE_URL` change | Netlify UI → trigger redeploy | Vite bakes env vars at build time, so a redeploy is required. |

After any deploy, `curl -s https://api.theemeraldexchange.com/api/version`
must report the `release` sha the script printed — if it doesn't, the NAS is
running stale code.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser: Plex login popup never closes after auth | Cookie isn't being set cross-origin | Check `ALLOWED_ORIGINS` matches the actual frontend origin exactly; check `NODE_ENV=production` is in the backend container env (`docker exec exchange-backend env \| grep NODE_ENV`). |
| `/api/*` returns 503 | Backend not up | `docker logs exchange-backend` — usually a missing required env var. |
| `/api/*` returns 502 / never resolves | Tunnel registered but can't reach backend | The tunnel hostname config is `localhost:3001`; cloudflared joins the backend's network namespace (`network_mode: service:backend`) so `localhost:3001` resolves to the backend's own listener. If broken, check `docker ps` shows both containers Up and (since they share a netns) **restart `exchange-cloudflared` after any backend recreate** — the netns reference breaks otherwise. |
| `/api/*` returns 401 | Session cookie not present | Confirm browser is sending cookies to `api.theemeraldexchange.com`; check DevTools Network tab → Request Headers → Cookie. If missing, the browser blocked it (third-party cookie blocking on Safari is the usual culprit). |
| Tunnel shows "Inactive" in CF dashboard | cloudflared can't authenticate | Wrong `TUNNEL_TOKEN`. Re-copy from the CF dashboard, update `.env.production`, redeploy. |
| Disk-space gate firing for everyone | `MIN_FREE_GB` too high or actually no space | `df -h /mnt/user` on the NAS. The gate applies to admins too — by design. |

---

## Local recommender (replaces per-request Claude)

`recommender/` is a Python + FastAPI sibling container in
`docker-compose.yml`. It owns a SQLite DB (sqlite-vec) at
`/mnt/user/appdata/exchange-backend/recommender-db/exchange.db` and serves
ranked picks to the Hono backend on the internal Docker network. The
`recommender/` *source* dir on the NAS (synced by `deploy-nas.sh`) is
the `build:` context for the image; the DB lives in `recommender-db/`
so the two never collide.

### Roles

* **Per-request scoring** — `POST /score` on every `/api/suggestions/:type`
  refresh. No Claude call, no per-request cost.
* **Optimizer (offline)** — `make optimize` runs nightly via `crontab` on
  the NAS. One Claude call per run reviews the day's outcomes and proposes
  config patches. Auto-promotes only if the patch beats the held-out eval
  set; weight changes clamped to ±20% per night.

### Bootstrap (one-time, multi-hour)

```bash
ssh root@theemeraldexchange.local '
  cd /mnt/user/appdata/exchange-backend
  docker compose up -d recommender
  docker compose exec recommender python -m app.db --migrate
  docker compose exec recommender python -m workers.tmdb_ingest --mode bootstrap
  docker compose exec recommender python -m workers.featurize
'
```

Resumable: if the ingest is killed mid-run, re-run the `bootstrap` command
and it picks up from `ingest_queue` where it left off. Expect ~120k titles
ingested at ~4 req/s = ~8 hours wall-clock.

### Flip the flag

After verifying `curl http://127.0.0.1:8001/health` on the NAS reports
non-zero `titles` and `title_vectors`, edit `.env.production`:

```
USE_LOCAL_RECOMMENDER=1
ANTHROPIC_OPTIMIZER_KEY=sk-ant-...
```

then redeploy with `scripts/deploy-nas.sh`. The backend will now skip
Claude on every refresh and call the recommender instead.

### Nightly optimizer cron

On the NAS, drop into `/etc/cron.d/exchange-recommender`:

```cron
SHELL=/bin/bash
PATH=/sbin:/bin:/usr/sbin:/usr/bin:/usr/local/bin
# Phase A: pull TMDB changes for the day and update the titles rows.
0 4 * * *  root docker exec exchange-recommender python -m workers.tmdb_ingest --mode changes >> /var/log/exchange-ingest.log 2>&1
# Phase B: rebuild embeddings for new + UPDATED rows. featurize picks
# up both never-featurized rows and rows whose titles.fetched_at is
# newer than title_features.computed_at — so changes-mode updates to
# overview/genres/keywords actually flow into retrieval. Without this
# step the changes cron updates the titles table but the embeddings
# stay frozen against pre-revision content.
15 4 * * * root docker exec exchange-recommender python -m workers.featurize >> /var/log/exchange-featurize.log 2>&1
30 3 * * * root docker exec exchange-recommender python -m workers.optimizer >> /var/log/exchange-optimizer.log 2>&1
```

Unraid wipes `/etc/cron.d/` on every reboot, so also drop a copy on the
USB persistence (`/boot/config/`) and have `/boot/config/go` reinstall
it at boot:

```bash
cp /etc/cron.d/exchange-recommender /boot/config/exchange-recommender.cron
cat >> /boot/config/go <<'EOF'
if [ -f /boot/config/exchange-recommender.cron ]; then
  cp /boot/config/exchange-recommender.cron /etc/cron.d/exchange-recommender
  chmod 644 /etc/cron.d/exchange-recommender
fi
EOF
```

### Recovering ingest rows stuck at `status='error'`

Transient TMDB failures (5xx, rate-limit, brief network outage) mark
the row as `status='error'` and the regular drain only selects
`status='pending'` — so stranded rows stay invisible to bootstrap and
changes re-runs (`ON CONFLICT DO NOTHING` is a no-op for existing
rows). To recover:

```bash
# Reset every error row to pending, then drain. Capped to attempts<5
# so permanently-broken titles (removed from TMDB, etc.) don't churn.
docker exec exchange-recommender python -m workers.tmdb_ingest \
  --mode retry-errors --max-attempts 5
```

`--retry-errors` is also available on `--mode bootstrap` and
`--mode changes` if you want the recovery sweep to happen as part of
the regular nightly cron.

### Wiring up the optimizer's eval gate

The optimizer's auto-promotion path is gated by an evaluation set —
without it, every nightly run records the candidate model as an
inactive proposal and the active model stays put. The set is one
JSON object per line (see `recommender/eval/README.md` for the
schema) and lives at `RECOMMENDER_HOLDOUT_PATH` inside the container,
defaulting to `/data/holdout.jsonl`.

```bash
# Quick start: ship the syntactically-valid example to prove the
# wiring (file shape, env var, mount path), THEN replace it with a
# real generated holdout before relying on auto-promotion. The
# example is 3 synthetic rows — enough to satisfy load_holdout() but
# NOT enough to make a meaningful eval signal.
scp recommender/eval/holdout.example.jsonl \
  root@theemeraldexchange.local:/mnt/user/appdata/exchange-backend/recommender-db/holdout.jsonl

# Real holdout: generate from the running recommender DB. The
# generator filters to (sub, kind) pairs with at least one positive
# outcome AND a library of at least 3 titles in the last 30 days.
ssh root@theemeraldexchange.local \
  'docker exec exchange-recommender python -m eval.build_holdout' \
  > /tmp/holdout.jsonl
scp /tmp/holdout.jsonl \
  root@theemeraldexchange.local:/mnt/user/appdata/exchange-backend/recommender-db/holdout.jsonl
```

The Dockerfile intentionally does NOT bake the holdout into the image
and `scripts/deploy-nas.sh` excludes it from rsync — it's operator-
curated history, not source code. Re-run the generator periodically
as `rec_log` + `rec_outcomes` accumulate; the optimizer's evaluation
only gets sharper as the set grows.

### Rolling back

```bash
# .env.production
USE_LOCAL_RECOMMENDER=0
```

then `scripts/deploy-nas.sh`. Backend returns to the original Claude path
on the next refresh. The recommender container stays running (cheap, idle)
so you can flip back without a fresh bootstrap.

### Health check

The backend's Node image does **not** ship `curl` — a `docker exec
exchange-backend curl …` fails with `exec: curl: not found` (this exact
assumption once made the backend permanently "unhealthy" and took the public
site down via cloudflared's `depends_on` gate). Probe through `node`, which is
always present:

```bash
# Backend → recommender connectivity (node-based probe, run on the NAS)
ssh root@theemeraldexchange.local \
  'docker exec exchange-backend node -e "fetch(\"http://recommender:8000/health\").then(r=>r.text()).then(console.log)"'

# Recommender directly (run ON the NAS — curl exists there)
ssh root@theemeraldexchange.local 'curl -s http://127.0.0.1:8001/health'
```

---

## Notes on architecture decisions

- **Netlify for SPA, NAS for backend**: Sonarr/Radarr/SAB live on the LAN and aren't reachable from a Netlify Function. The backend has to be where the services are.
- **Cloudflare Tunnel** instead of port forwarding: free SSL, no router config, no exposing the NAS to the public internet, revocable from the dashboard if compromised.
- **Backend runs as Docker on the NAS** (not bare metal): matches Unraid's pattern for everything else (Sonarr/Radarr/SAB/Plex are all containers), keeps env vars scoped to the container, easy to redeploy.
- **`network_mode: service:backend` for cloudflared**: the tunnel joins the backend's network namespace, so its "service URL" config stays `localhost:3001` (resolves to the backend's own listener) while the backend stays bound to `127.0.0.1` (LAN-invisible). Host networking was deliberately **removed** (audit 9-7): on the host netns a compromised tunnel image could reach every loopback-published admin port (recommender :8001, media-core :8002, transcoder :8003, glitchtip :8100); sharing only the backend's netns closes that. Trade-off: recreating the backend container breaks the netns reference, so cloudflared must be restarted after any backend recreate (the deploy script does this).
