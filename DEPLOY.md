# Deploying The Emerald Exchange (V2)

V2 splits the dashboard across two hosts. The SPA lives on Netlify; the Hono backend lives on the NAS behind a Cloudflare Tunnel.

```
theemeraldexchange.com           ──▶ Netlify (SPA)              ◀── git push triggers redeploy
api.theemeraldexchange.com       ──▶ Cloudflare Tunnel
                                  ──▶ cloudflared on NAS (host net)
                                  ──▶ 127.0.0.1:3001
                                  ──▶ exchange-backend (Hono)
                                  ──▶ Sonarr / Radarr / SAB on the LAN
                                  ──▶ exchange-recommender (Python+FastAPI, internal net only)
                                       └─ SQLite at /mnt/user/appdata/exchange-backend/recommender-db/exchange.db
```

The legacy **V1 nginx-static container** (`exchange-dashboard` on port 8085) and its DEPLOY.md recipe are superseded. Tear it down once V2 is verified working.

---

## One-time setup

You need three things to be working before the first deploy: a Cloudflare Tunnel, a `.env.production` on this laptop, and Netlify connected to the GitHub repo.

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
| `SESSION_SECRET` | Generate fresh: `openssl rand -base64 48`. **Different from dev** so the two environments can't share sessions. |
| `ADMINS` | `ChrisPachulski` (or whatever Plex usernames). |
| `PLEX_SERVER_ID` | **Required in production** — your home Plex server's machineIdentifier. Without it, any authenticated Plex user can sign in. Discoverable via the SPA's first prod login (in the `discoveredServers` payload). Or query plex.tv directly. For the brief first-deploy bootstrap window before you know the id, set `ALLOW_UNSCOPED_PLEX_LOGIN=1` instead — but remove that opt-in as soon as you copy the id into `PLEX_SERVER_ID`. |
| `ALLOWED_ORIGINS` | `https://theemeraldexchange.com` |
| `SONARR_URL`, `SONARR_API_KEY` | Existing Sonarr install. |
| `RADARR_URL`, `RADARR_API_KEY` | Existing Radarr install. |
| `SAB_URL`, `SAB_API_KEY` | Existing SAB install. |
| `MIN_FREE_GB` | Default 100. |

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

### 4. First NAS deploy

```bash
cd ~/Documents/theemeraldexchange
./scripts/deploy-nas.sh
```

The script:
1. Validates `.env.production` has all required keys.
2. Rsyncs `Dockerfile`, `docker-compose.yml`, `package*.json`, `tsconfig.json`, and `server/` to `/mnt/user/appdata/exchange-backend/` on the NAS.
3. Ships `.env.production` → NAS as `.env`, chmod 600.
4. SSHs in and runs `docker compose up -d --build`.

First build takes ~2 min (npm ci + image layers). Subsequent deploys are faster.

### 5. Verify end-to-end

```bash
curl -s https://api.theemeraldexchange.com/api/health
# {"ok":true}
```

Then in the browser: https://theemeraldexchange.com → Plex login should work cross-origin.

If `/api/health` 502s, the tunnel is up but the backend isn't reachable: `ssh root@theemeraldexchange.local 'docker logs exchange-backend --tail=30'`.
If it never resolves, the tunnel didn't register: `ssh root@theemeraldexchange.local 'docker logs exchange-cloudflared --tail=30'`.

---

## Ongoing deploys

| What changed | Command | Effect |
|---|---|---|
| SPA only (anything in `src/`) | `git push` | Netlify auto-builds and deploys. ~30s. |
| Backend only (anything in `server/`) | `./scripts/deploy-nas.sh` | NAS rebuild + restart. ~30–60s. |
| Both | `git push && ./scripts/deploy-nas.sh` | In any order. SPA and backend redeploy independently. |
| Env var change in `.env.production` | `./scripts/deploy-nas.sh` | Same script; new `.env` ships and containers restart. |
| `VITE_API_BASE_URL` change | Netlify UI → trigger redeploy | Vite bakes env vars at build time, so a redeploy is required. |

---

## Tearing down V1

Once V2 is working end-to-end:

```bash
ssh root@theemeraldexchange.local '
  docker rm -f exchange-dashboard 2>/dev/null
  rm -rf /mnt/user/appdata/exchange-dashboard
'
```

That frees host port 8085. The `nginx/` directory in the repo is dead code at that point — safe to delete in a follow-up commit.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser: Plex login popup never closes after auth | Cookie isn't being set cross-origin | Check `ALLOWED_ORIGINS` matches the actual frontend origin exactly; check `NODE_ENV=production` is in the backend container env (`docker exec exchange-backend env \| grep NODE_ENV`). |
| `/api/*` returns 503 | Backend not up | `docker logs exchange-backend` — usually a missing required env var. |
| `/api/*` returns 502 / never resolves | Tunnel registered but can't reach backend | The tunnel hostname config is `localhost:3001`; cloudflared runs `network_mode: host` so this should hit the backend's `127.0.0.1:3001`. If broken, check `docker ps` shows both containers Up and `ss -ltn 'sport = :3001'` on the NAS shows the port bound. |
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

```bash
# Backend → recommender connectivity
ssh root@theemeraldexchange.local 'docker exec exchange-backend curl -s http://recommender:8000/health'

# Recommender directly (from NAS loopback)
curl -s http://127.0.0.1:8001/health
```

---

## Notes on architecture decisions

- **Netlify for SPA, NAS for backend**: Sonarr/Radarr/SAB live on the LAN and aren't reachable from a Netlify Function. The backend has to be where the services are.
- **Cloudflare Tunnel** instead of port forwarding: free SSL, no router config, no exposing the NAS to the public internet, revocable from the dashboard if compromised.
- **Backend runs as Docker on the NAS** (not bare metal): matches Unraid's pattern for everything else (Sonarr/Radarr/SAB/Plex are all containers), keeps env vars scoped to the container, easy to redeploy.
- **`network_mode: host` for cloudflared**: simplest way to keep the tunnel's "service URL" config as `localhost:3001`. The backend stays bound to `127.0.0.1` (LAN-invisible); only the tunnel can reach it.
