# Deploying The Emerald Exchange (V2)

Two tracks (plan 006):

- **Self-host (LAN, easy)** — anyone standing up their own Emerald server. Pull-based
  multi-arch images, no accounts/domain/build. Lives in
  [`selfhost/`](./selfhost/) — the quickstart is at the top of the README. Nothing below
  applies to you.
- **Owner full deployment** — this document: the original operator setup with every profile
  on (Cloudflare Tunnel, Netlify SPA, IPTV, Glitchtip telemetry). It is ONE
  configuration of the same product; the self-host track gives up none of the member
  experience.

V2 splits the dashboard across two hosts. The SPA lives on Netlify; the backend (the Rust gateway, `crates/gateway`) lives on the NAS behind a Cloudflare Tunnel.

```
theemeraldexchange.com           ──▶ Netlify (SPA)              ◀── git push triggers redeploy
api.theemeraldexchange.com       ──▶ Cloudflare Tunnel
                                  ──▶ cloudflared on NAS (shares backend netns)
                                  ──▶ 127.0.0.1:3001
                                  ──▶ exchange-backend (eex-gateway, Rust)
                                       ├─▶ Sonarr / Radarr / SAB on the LAN
                                       ├─▶ exchange-recommender   (FastAPI, internal net; loopback :8001)
                                       │    └─ SQLite at /mnt/user/appdata/exchange-backend/recommender-db/exchange.db
                                       ├─▶ exchange-media-core    (Rust, library scan/serve; loopback :8002)
                                       │    └─▶ exchange-transcoder (Rust + ffmpeg/VAAPI HLS; loopback :8003)
                                       └─▶ glitchtip (+ -db, -redis, -worker) — telemetry; loopback :8100
```

`docker-compose.yml` defines **10 services**: `backend`, `recommender`,
`media-core`, `transcoder`, plus the profile-gated `cloudflared`
(`remote-cloudflare`), `tailscale` (`remote`), and the Glitchtip four
(`telemetry`). The owner deployment sets
`COMPOSE_PROFILES=remote-cloudflare,telemetry` in `.env.production`
(deploy-nas.sh appends it if missing). One deploy script
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

Open it and fill the required rows plus whichever optional integrations you use:

| Var | Where it comes from |
|---|---|
| `TUNNEL_TOKEN` | The `eyJhI…` you copied above. |
| `SESSION_SECRET` | Generate fresh: `openssl rand -base64 48`. Must be ≥32 bytes and not a placeholder — the deploy script hard-fails otherwise. **Different from dev** so the two environments can't share sessions. |
| `STREAM_TOKEN_SECRET` | `openssl rand -base64 48`. Signs IPTV/media stream tokens (HMAC-SHA256). |
| `DEVICE_TOKEN_SECRET` | `openssl rand -base64 48`. IKM for the device-token JWE (Apple device pairing). Must be distinct from every other secret. |
| `INTERNAL_PRINCIPAL_SECRET` | `openssl rand -base64 48`. IKM for the internal-principal JWE the backend mints toward recommender/media-core/transcoder. Distinct from every other secret. |
| `RECOMMENDER_EVENT_SECRET` | `openssl rand -base64 48`. Shared secret signing backend → recommender calls. |
| `ADMIN_SUBS` | Your own provider sub (`workos:user_…`, `apple:…`, `google:…`): the owner bootstrap, admin with no invite. |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI` *(optional)* | WorkOS dashboard → API keys. Redirect URI is `https://api.theemeraldexchange.com/api/auth/workos/callback`, registered verbatim in the dashboard. Turn "Sign up" off there; add your `workos:user_…` id to `ADMIN_SUBS` for owner access. |
| `ALLOWED_ORIGINS` | `https://theemeraldexchange.com` |
| `SONARR_URL`, `SONARR_API_KEY` | Existing Sonarr install. |
| `RADARR_URL`, `RADARR_API_KEY` | Existing Radarr install. |
| `SAB_URL`, `SAB_API_KEY` | Existing SAB install. |
| `MIN_FREE_GB` | Default 100. |
| `GLITCHTIP_SECRET_KEY`, `GLITCHTIP_DB_PASSWORD`, `GLITCHTIP_DOMAIN` | **Set BEFORE the first `compose up`** (`openssl rand -base64 48` for the secret key, `openssl rand -hex 24` for the DB password). The DB password must be hex (base64 characters break the `DATABASE_URL`); the domain needs an `http(s)://` scheme. |
| `EEX_TELEMETRY_DSN` | Optional GlitchTip browser/client ingestion DSN. Leave unset to run telemetry-off; configure later without blocking a healthy app deploy. |

`.env.production.example` carries an annotated list of the common keys, but it is
**not** complete — the backend reads a number of keys that never appear in it,
including `USE_MEDIA_CORE`, `USE_LOCAL_RECOMMENDER`, `MEDIA_LIBRARY_HOST_PATH`,
and `ANTHROPIC_OPTIMIZER_KEY`, all four of which the procedures below tell you to
set. `crates/auth/src/config.rs` and `crates/gateway/src/config.rs` are the
authoritative list. The deploy script validates all required keys (and the
`SESSION_SECRET` strength gate) before anything ships.

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
up with everything else. **Generate the three values
first** (see the `GLITCHTIP_*` rows in the table above) — that step sets `GLITCHTIP_SECRET_KEY` / `GLITCHTIP_DB_PASSWORD` /
`GLITCHTIP_DOMAIN`, which must exist in `.env.production` before the first
`docker compose up`, and walks the admin-account + DSN minting steps.

### 5. First NAS deploy

```bash
cd ~/Documents/theemeraldexchange
./scripts/deploy-nas.sh
```

What the script actually does (`./scripts/deploy-nas.sh --help` prints its own summary):

1. **Refuses to run on a dirty tree.** The payload is always `git archive HEAD`,
   so uncommitted tracked edits would silently not ship. `--allow-dirty`
   overrides with a loud warning; a HEAD ≠ `origin/main` drift is warned, not
   blocked.
2. Validates `.env.production` has every required key and mirrors the
   backend's `SESSION_SECRET` strength gate, so a bad env fails here instead
   of as a container crash loop.
3. Stages the payload from `git archive HEAD` into a temp dir and rsyncs — from
   that stage, never the working tree — `Dockerfile`, `docker-compose.yml`,
   `.dockerignore`, `recommender/`, `crates/`, and the root
   `Cargo.toml`/`Cargo.lock`/`LICENSE` to
   `/mnt/user/appdata/exchange-backend/` on the NAS.
4. Ships `.env.production` → NAS as `.env`, chmod 600.
5. Pre-creates + chowns the sidecar DB bind-mount dirs (`recommender-db` →
   uid 10001, `media-core-db` → uid 10002, `iptv` → uid 10004) so a fresh
   volume doesn't crash-loop the `cap_drop: ALL` sidecars. It refuses to go on
   while `data/iptv.db` still sits in the backend's dir (see section 8).
6. Tags every currently-deployed image (`backend`, `recommender`, `media-core`,
   `iptv`, `transcoder`) as **`:rollback-<UTC timestamp>`** — one generation per run,
   the last 2 kept, and any legacy bare `:rollback` tag pruned. Then pulls the
   CI-built `:sha-<commit>` image for each service from GHCR and retags it to
   the compose name — nothing compiles on the NAS. Only `--build-on-nas`
   builds each service sequentially through `nas-safe-build.sh`, whose
   detached load, memory, timeout, and Plex-health watchdogs abort before a
   compile can brown out the NAS.
7. Recreates the stack with `docker compose up -d --no-build`, then
   force-recreates `exchange-cloudflared` (it shares the backend's netns; only
   recreation rebinds it to a new backend container).
8. Installs the cloudflared stale-netns watchdog cron.
9. **Health-gates the whole stack** (~150s ceiling): backend + recommender +
   media-core + iptv + transcoder must all report docker-healthy. On failure it
   restores the newest `:rollback-<ts>` generation, re-ups, and prints
   per-container log and manual-rollback commands.

Also part of the run, in payload order, though not numbered above: staging the
`bin/eex-ytresolve` binary (fetched with `gh release download` from
`ChrisPachulski/rust-yt-extractor` — **the deploy `exit 1`s if it is missing or
empty, so `gh` must be authenticated**), snapshotting `docker-compose.yml` +
`.env` for config rollback, and rsyncing `deploy/` for the tailscale `remote`
profile.

GlitchTip is optional and reported separately from the core health gate. An
unset DSN never excuses an unhealthy backend or sidecar; every failed core
release is rolled back.

The deploy itself is a pull + recreate; the wait is CI (npm ci + two Rust
release builds) before `ci-gate.sh` lets it proceed.

### 6. Verify end-to-end

```bash
curl -s https://api.theemeraldexchange.com/api/health
# {"ok":true}

# The deployed release must match what you shipped (the script prints this
# exact check with the sha filled in on success):
curl -s https://api.theemeraldexchange.com/api/version
# {... "release":"<short sha of the deployed HEAD>" ...}
```

Then in the browser: https://theemeraldexchange.com → sign-in should work cross-origin.

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

### 8. Moving iptv.db to the iptv service (one time)

Live TV, the guide and DVR now run in their own container (`exchange-iptv`,
`crates/iptv`), which is the only reader and writer of `iptv.db` and the only
process that dials the IPTV provider. The backend keeps the auth, membership,
live-section and rating gates and forwards `/api/iptv/*` and `/api/dvr/*` to it
(`IPTV_SERVICE_URL`, default `http://iptv:8004`). The DB moves from the
backend's `data/` to the iptv volume, `/mnt/user/appdata/exchange-backend/iptv`
(mounted at `/data`; recordings go to `/data/recordings`, nightly snapshots to
`/data/backups`). `deploy-nas.sh` refuses to run until the move is done, so an
iptv container never starts on an empty volume (it would bootstrap-sync against
the provider while the real DB sits stranded). The schema is unchanged.

1. Merge the PR and let main CI go green: it pushes
   `theemeraldexchange-iptv:sha-<commit>` with the other four images.
2. Check the migration ledger. The Rust migrator stops the boot on a checksum
   mismatch, where the Node one only warned. The command reads it through the
   running Node backend, so do this before the step 9 cutover replaces it:

   ```bash
   ssh theemeraldexchange "docker exec exchange-backend node -e \"const D=require('better-sqlite3');const d=new D('/app/data/iptv.db',{readonly:true});for(const r of d.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all())console.log(r.version,r.checksum)\""
   shasum -a 256 crates/iptv/migrations/*.sql
   ```

   All 10 versions should be present with the same hashes. If one differs (or
   reads `(file-not-found)`), add `ALLOW_MIGRATION_CHECKSUM_MISMATCH=1` to
   `.env.production` for this deploy and remove it afterwards.
3. Stop the backend (the API stays down until the step 4 deploy; cloudflared shares its
   netns) and move the DB with its WAL files:

   ```bash
   ssh theemeraldexchange 'docker stop exchange-backend && cd /mnt/user/appdata/exchange-backend \
     && mkdir -p iptv && for f in iptv.db iptv.db-wal iptv.db-shm; do [ -f data/$f ] && mv data/$f iptv/; done \
     && chown -R 10004:10004 iptv && ls -la iptv'
   ```

   DVR is off in prod, so there are no recordings to move. If `DVR_ENABLED` was
   ever on, also move `data/recordings` to `iptv/recordings` and rewrite
   `dvr_recordings.file_path` from `/app/data/recordings/` to
   `/data/recordings/`.
4. `./scripts/deploy-nas.sh`. It pulls the five images, starts `exchange-iptv`
   and the backend, and health-gates both.
5. Verify: `curl -s https://api.theemeraldexchange.com/api/health`, the
   `/api/version` release sha, then tune one live channel in a client.
   `ssh theemeraldexchange 'docker logs exchange-iptv --tail=30'` shows
   `iptv listening` and no bootstrap sync (`last_sync` in the moved DB is
   fresh). In-memory state (remux sessions, dead-feed memory, the concurrency
   tracker) starts empty, which costs one re-tune.

Rollback: if the health gate fails, `deploy-nas.sh` restores the previous
images and compose file and, because that compose has no `iptv` service, moves
`iptv.db` back to `data/` before bringing the stack up. By hand: stop
`exchange-iptv`, move `iptv/iptv.db*` back to `data/` (`chown 10001:10001`),
retag the `:rollback-<ts>` images and `docker compose up -d --no-build`.

### 9. Cutover to the Rust gateway: deploy, then re-key the owner off Plex (one time)

The backend is now the Rust gateway. CI's docker-build job builds it from
`Dockerfile` and pushes **`ghcr.io/chrispachulski/theemeraldexchange-backend:sha-<commit>`**
(and `:main`) after booting it to `/api/health`. It is the same `backend`
compose service (`exchange-backend`, port 3001, healthcheck `/api/health`) and
carries two binaries: `eex-gateway` (the default command) and `eex-rekey`
(source `crates/auth/src/rekey.rs`). There is no Node in the image.

Plex sign-in is gone with the Node backend. The owner's household data
(members row, invites, watch state, favorites, playlists, feedback, watchlist,
policies, recommender history, usage and grab logs) is keyed on her `plex:`
sub, and `eex-rekey` moves it to the identity she signs in with from then on.
It is an identity change: the owner runs and confirms every step below
herself. Never run it from a workflow or with the stack up.

What the re-key does: one `VACUUM INTO` backup (`<db>.pre-rekey-<stamp>`) and
then one transaction per SQLite file. Data rows move to the target, and where
the target already has the same item, the target's copy is kept. The target's
members row gets the source's access (admin wins); the source row is revoked
and kept for audit. Invites move. Device tokens and playlist tokens are
revoked, because the sub is sealed inside them. Device-link codes the source
claimed are deleted. The stored Anthropic key is re-encrypted under the new
sub when `--session-secret-file` is given, and deleted otherwise. JSON files
are merged (target entries kept) and JSONL `sub` fields are rewritten; each
changed file is copied to `<file>.pre-rekey-<stamp>` first. It is a dry run
unless you pass `--apply`. Running it again after an apply changes nothing.

Order:

1. **Before merging**, while the Node stack still serves prod: choose the
   target sub. It must be one that can sign in: `workos:`, `apple:` or
   `google:` (it warns on `local:`; nothing signs in as local today). Issue
   yourself an owner invite (Admin, Invites, role admin) and redeem it by
   signing in with the target provider. Then read the target sub from Admin,
   Members. The source sub is the `plex:` value in `ADMIN_SUBS`.
2. **Merge the stacked PRs and deploy together.** Netlify publishes the SPA as
   soon as main moves, and that SPA has no Plex sign-in, so do this step in
   one sitting. In `.env.production` set `ADMIN_SUBS` to the target sub and
   delete `ADMINS` and every `PLEX_*` line (the gateway reads none of them).
   Wait for CI to go green on the merge commit, then run
   `scripts/deploy-nas.sh`: it pulls the `:sha-<commit>` images (no NAS
   compile), recreates the stack and health-gates it. The gateway is up, but
   the owner's data still sits under the `plex:` sub until step 4.
3. Stop the stack and back up the four data dirs. Record their owners, because
   the re-key runs as root:

   ```bash
   ssh theemeraldexchange 'cd /mnt/user/appdata/exchange-backend && docker compose stop \
     && stat -c "%u:%g %n" data iptv media-core-db recommender-db \
     && tar czf /mnt/user/appdata/pre-rekey-$(date +%Y%m%d).tgz data iptv media-core-db recommender-db'
   ```

4. Put `SESSION_SECRET` (from `.env.production`) in a root-only file on the
   NAS, e.g. `/root/rekey-secret` (`chmod 600`). Dry-run, read the counts, then
   run the same command with `--apply`. `theemeraldexchange-backend:latest` is
   the image step 2 pulled and retagged:

   ```bash
   A=/mnt/user/appdata/exchange-backend
   docker run --rm --user 0:0 --entrypoint eex-rekey \
     -v $A/data:/rk/data -v $A/iptv:/rk/iptv -v $A/media-core-db:/rk/media \
     -v $A/recommender-db:/rk/rec -v /root/rekey-secret:/rk/secret:ro \
     theemeraldexchange-backend:latest \
     --from plex:<owner id> --to <target sub> \
     --server-db /rk/data/server.db --iptv-db /rk/iptv/iptv.db \
     --media-db /rk/media/media.db --recommender-db /rk/rec/exchange.db \
     --data-dir /rk/data --session-secret-file /rk/secret
   ```

   A second dry run after the apply should show only zeros. Then delete
   `/root/rekey-secret` and give each dir back its recorded owner
   (`chown -R <uid>:<gid> <dir>`; that covers the backups, too).
5. Start the stack and re-join the tunnel (cloudflared shares the backend's
   netns):

   ```bash
   ssh theemeraldexchange 'cd /mnt/user/appdata/exchange-backend \
     && docker compose up -d --no-build && docker compose up -d --no-build --force-recreate cloudflared'
   ```

   Then verify end to end: `/api/health` is 200; `/api/version` shows
   `release` = the deployed short sha; sign in as the target; `/api/me` shows
   role admin and Admin, Members lists the target as admin and the `plex:` row
   as revoked; a Sonarr read (TV tab loads the library); a suggestion strip on
   Home; a library playback grant (Play on a local title); a live grant (play
   a channel on Live).
6. Re-pair each Apple device through the device link (the code the app shows,
   claimed in the SPA while signed in as the target), and re-mint the M3U
   playlist URLs. If the secret file was left out, re-enter the Anthropic key.

Rollback: stop the stack, restore the tarball from step 3 (or copy each
`*.pre-rekey-*` file over its original and delete the `-wal`/`-shm` files), put
the old `.env.production` back, and redeploy the previous sha image (retag its
`:rollback-<stamp>` generation to `:latest` and `docker compose up -d
--no-build`, or run `scripts/deploy-nas.sh` from the previous commit).

---

## Ongoing deploys

The deploy payload is `git archive HEAD` — **commit first**, then deploy. An
uncommitted edit never ships (the script refuses a dirty tree for exactly this
reason).

**CI gates the deploy, and CI builds what ships.** Both `deploy-nas.sh` and
`deploy-image.sh` call `scripts/ci-gate.sh`, which refuses an unpushed HEAD
and waits (up to 25 min, polling GitHub once a minute) for every Actions
check on HEAD to finish; a red or cancelled check aborts the deploy naming the
job. On main the CI `docker-build` job pushes the five images to GHCR as
`:main` and `:sha-<commit>`, and `deploy-nas.sh` pulls the `:sha-` images for
HEAD and retags them to the compose names — the NAS never compiles. So the
working loop is `git push && ./scripts/deploy-nas.sh`: the script idles until
CI is green, then pulls, rolls, and health-gates. `--skip-ci-gate` (or
`SKIP_CI_GATE=1` for either script) ships anyway, with a warning; use it for
a hotfix soak, never as the default. `--build-on-nas` is the legacy on-box
compile for when GHCR is unreachable. The `sha-*` tags accumulate one set per
main push; prune old ones in the GHCR package settings when it matters.

**Before you push**, run `npm run hooks:install` once per clone: the pre-push
hook runs rustfmt/clippy and tsc/eslint on what the push touches, so the
cheap failure classes never reach main. `SKIP_PREPUSH=1 git push` bypasses.

| What changed | Command | Effect |
|---|---|---|
| SPA only (anything in `src/`) | `git push` | Netlify auto-builds and deploys. ~30s. |
| Backend (`crates/gateway`, `crates/auth`) | `git push && ./scripts/deploy-nas.sh` | Waits for green CI, pulls the CI-built backend image, restarts. |
| Rust sidecars (anything in `crates/`, root `Cargo.toml`/`Cargo.lock`) | `git push && ./scripts/deploy-nas.sh` | Same path — `crates/` feeds the backend, media-core, iptv and transcoder images AND the recommender's pyo3 contract binding. CI compiles them, not the NAS. |
| Recommender (anything in `recommender/`) | `git push && ./scripts/deploy-nas.sh` | Same path; pulls the CI-built recommender image. |
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
| Browser: sign-in completes but the SPA stays signed out | Cookie isn't being set cross-origin | Check `ALLOWED_ORIGINS` matches the actual frontend origin exactly; check `NODE_ENV=production` is in the backend container env (`docker exec exchange-backend env \| grep NODE_ENV`). |
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
ranked picks to the gateway on the internal Docker network. The
`recommender/` *source* dir on the NAS (synced by `deploy-nas.sh`) supplies the
image's `dockerfile:`; the `build:` context is the appdata root, so the
Dockerfile can reach `crates/emerald-contracts{,-pyo3}` for the PyO3 binding.
The DB lives in `recommender-db/` so the two never collide.

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
inactive proposal and the active model stays put. Note the gate is not
merely "a file exists": the optimizer stays record-only until the set
has **at least 30 usable rows** (`MIN_HOLDOUT_SIZE`,
`recommender/workers/optimizer.py:5`). The set is one
JSON object per line (see `recommender/eval/README.md` for the
schema) and lives at `RECOMMENDER_HOLDOUT_PATH` inside the container,
defaulting to `/data/holdout.jsonl`.

```bash
# Quick start: ship the syntactically-valid example to prove the
# wiring (file shape, env var, mount path), THEN replace it with a
# real generated holdout before relying on auto-promotion. The
# example is 3 synthetic rows — enough to satisfy load_holdout() but
# well under the 30-row floor, so auto-promotion stays OFF until you
# ship a real generated set.
scp recommender/eval/holdout.example.jsonl \
  root@theemeraldexchange.local:/mnt/user/appdata/exchange-backend/recommender-db/holdout.jsonl

# Real holdout: generate from the running recommender DB. The
# generator filters to (sub, kind) pairs with at least one positive
# outcome AND a library of at least 10 titles (MIN_LIBRARY, from
# RECOMMENDER_COLD_START_THRESHOLD) in the last 30 days.
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
# Backend → recommender connectivity (the gateway image ships curl)
ssh root@theemeraldexchange.local \
  'docker exec exchange-backend curl -fsS http://recommender:8000/health'

# Recommender directly (run ON the NAS — curl exists there)
ssh root@theemeraldexchange.local 'curl -s http://127.0.0.1:8001/health'
```

---

## Notes on architecture decisions

- **Netlify for SPA, NAS for backend**: Sonarr/Radarr/SAB live on the LAN and aren't reachable from a Netlify Function. The backend has to be where the services are.
- **Cloudflare Tunnel** instead of port forwarding: free SSL, no router config, no exposing the NAS to the public internet, revocable from the dashboard if compromised.
- **Backend runs as Docker on the NAS** (not bare metal): matches Unraid's pattern for everything else (Sonarr/Radarr/SAB/Plex are all containers), keeps env vars scoped to the container, easy to redeploy.
- **`network_mode: service:backend` for cloudflared**: the tunnel joins the backend's network namespace, so its "service URL" config stays `localhost:3001` (resolves to the backend's own listener) while the backend stays bound to `127.0.0.1` (LAN-invisible). Host networking was deliberately **removed** (audit 9-7): on the host netns a compromised tunnel image could reach every loopback-published admin port (recommender :8001, media-core :8002, transcoder :8003, glitchtip :8100); sharing only the backend's netns closes that. Trade-off: recreating the backend container breaks the netns reference, so cloudflared must be restarted after any backend recreate (the deploy script does this).
