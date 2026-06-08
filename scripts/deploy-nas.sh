#!/usr/bin/env bash
# Deploy the Hono backend + Cloudflare Tunnel sidecar to the NAS.
#
# Architecture (V2):
#   theemeraldexchange.com         → Netlify (SPA)             [auto-deploys on git push]
#   api.theemeraldexchange.com     → Cloudflare Tunnel
#                                   → cloudflared container sharing backend netns
#                                   → 127.0.0.1:3001
#                                   → exchange-backend container (Hono on Node)
#                                   → Sonarr / Radarr / SAB on the LAN
#
# What this script does:
#   1. Validates a local .env.production exists with all required keys.
#   2. Rsyncs Dockerfile, docker-compose.yml, package*.json, tsconfig.json,
#      and the server/ source tree to /mnt/user/appdata/exchange-backend/
#      on the NAS.
#   3. Ships .env.production → NAS as .env (consumed by docker compose).
#   4. SSHs into the NAS and runs `docker compose up -d --build`.
#
# What this script does NOT do:
#   - Build the SPA. That's Netlify's job, triggered by `git push`.
#   - Touch the V1 nginx-static container. Tear that down separately
#     once you've verified V2 works (`docker rm -f exchange-dashboard`).
#
# First-time setup: see DEPLOY.md.

set -euo pipefail

NAS_HOST="${NAS_HOST:-theemeraldexchange.local}"
NAS_USER="${NAS_USER:-root}"
APPDATA="${APPDATA:-/mnt/user/appdata/exchange-backend}"
LOCAL_ENV="${LOCAL_ENV:-.env.production}"

if [[ ! -f "$LOCAL_ENV" ]]; then
  echo "ERROR: $LOCAL_ENV not found at $(pwd)/$LOCAL_ENV" >&2
  echo "       Copy .env.production.example, fill it in, then re-run." >&2
  echo "       (See DEPLOY.md for what each variable means.)" >&2
  exit 1
fi

required=(
  TUNNEL_TOKEN
  PLEX_CLIENT_ID
  SESSION_SECRET
  STREAM_TOKEN_SECRET
  DEVICE_TOKEN_SECRET
  INTERNAL_PRINCIPAL_SECRET
  RECOMMENDER_EVENT_SECRET
  ALLOWED_ORIGINS
  SONARR_API_KEY
  RADARR_API_KEY
  SAB_API_KEY
)
# NOTE: EEX_TELEMETRY_DSN is required by env.ts in prod but is deliberately
# NOT gated here — glitchtip-setup.md §2 runs this deploy once to bring the
# Glitchtip stack up *before* a DSN exists, then redeploys with it set. The
# backend crash-loops in that bootstrap window by design; Glitchtip itself
# has no such dependency and comes up fine.
env_value() {
  local key="$1"
  local line value
  line=$(grep -E "^[[:space:]]*${key}=" "$LOCAL_ENV" | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    return 1
  fi
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}
for key in "${required[@]}"; do
  if ! value=$(env_value "$key"); then
    echo "ERROR: ${key} missing from $LOCAL_ENV" >&2
    exit 1
  fi
  if [[ -z "$value" ]]; then
    echo "ERROR: ${key} in $LOCAL_ENV must not be empty." >&2
    exit 1
  fi
done

# SESSION_SECRET protects every user's encrypted Plex auth token. The
# backend SHA-256s this value to derive the A256GCM key, so a short or
# placeholder secret is equivalent to publishing the AES key. Mirror
# env.ts's prod gate here so deploy fails fast with a clearer message
# than a container crash loop.
session_secret_value=$(env_value SESSION_SECRET)
if [ "${#session_secret_value}" -lt 32 ]; then
  echo "ERROR: SESSION_SECRET in $LOCAL_ENV must be at least 32 bytes (${#session_secret_value} found)." >&2
  echo "       Generate one with: openssl rand -base64 48" >&2
  exit 1
fi
session_secret_lower=$(printf '%s' "$session_secret_value" | tr '[:upper:]' '[:lower:]')
case "$session_secret_lower" in
  changeme|change-me|change_me|placeholder|secret|password|test|test-secret|replaceme|replace-me|replace_me|your-secret-here|session-secret)
    echo "ERROR: SESSION_SECRET in $LOCAL_ENV is a placeholder value." >&2
    echo "       Generate a real secret with: openssl rand -base64 48" >&2
    exit 1
    ;;
esac

# PLEX_SERVER_ID gates sign-in to members of the household's Plex
# server. A blank value turns the app into "any Plex user can sign
# in," so the backend hard-fails at boot in prod unless the operator
# explicitly opted into bootstrap mode. Mirror that check here so
# deploy fails fast with a clearer message than a container crash
# loop.
plex_server_id_value=$(env_value PLEX_SERVER_ID || true)
allow_unscoped_plex_login_value=$(env_value ALLOW_UNSCOPED_PLEX_LOGIN || true)
if [[ -n "$plex_server_id_value" ]]; then
  : # populated — good
elif [[ "$allow_unscoped_plex_login_value" == "1" ]]; then
  echo "[deploy] WARN: PLEX_SERVER_ID is blank and ALLOW_UNSCOPED_PLEX_LOGIN=1 is set." >&2
  echo "         This means ANY Plex account can sign in. Use only for the brief" >&2
  echo "         first-deploy window — discover your machineIdentifier via the SPA's" >&2
  echo "         /api/me discoveredServers payload, set PLEX_SERVER_ID, and remove the" >&2
  echo "         escape hatch immediately." >&2
else
  echo "ERROR: production env needs PLEX_SERVER_ID (your home Plex server's" >&2
  echo "       machineIdentifier) so sign-in is scoped to household members." >&2
  echo "       For the first-deploy bootstrap window, set ALLOW_UNSCOPED_PLEX_LOGIN=1" >&2
  echo "       explicitly to opt into the open mode. See DEPLOY.md." >&2
  exit 1
fi

echo "→ Ensuring ${APPDATA} exists on ${NAS_HOST}"
ssh "${NAS_USER}@${NAS_HOST}" "mkdir -p ${APPDATA}"

echo "→ Syncing build context"
rsync -av \
  Dockerfile docker-compose.yml .dockerignore package.json package-lock.json tsconfig.json \
  "${NAS_USER}@${NAS_HOST}:${APPDATA}/"

echo "→ Syncing server/"
rsync -av --delete \
  --exclude '*.test.ts' \
  --exclude 'middleware/*.test.ts' \
  server/ "${NAS_USER}@${NAS_HOST}:${APPDATA}/server/"

echo "→ Syncing recommender/"
rsync -av --delete \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'data' \
  --exclude '.ruff_cache' \
  --exclude '.pytest_cache' \
  --exclude 'eval/holdout.jsonl' \
  recommender/ "${NAS_USER}@${NAS_HOST}:${APPDATA}/recommender/"

# crates/ feeds two multi-stage image builds:
#   - recommender/Dockerfile compiles the PyO3 wheel from
#     crates/emerald-contracts + crates/emerald-contracts-pyo3.
#   - Dockerfile (backend) compiles the @emerald/contracts-napi
#     linux-x64-gnu .node from crates/emerald-contracts +
#     crates/emerald-contracts-napi.
# The Cargo workspace requires all three members present even when only
# two are built per stage, so we ship every member's manifest. *.node
# files are excluded because each image's builder stage produces a
# fresh artifact for its target triple.
echo "→ Syncing crates/"
rsync -av --delete \
  --exclude 'target' \
  --exclude '**/target' \
  --exclude '.venv' \
  --exclude 'node_modules' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '*.node' \
  crates/ "${NAS_USER}@${NAS_HOST}:${APPDATA}/crates/"

# Cargo.toml + Cargo.lock + LICENSE live at the repo root and are
# required for `cargo build` inside the rust-builder stage. The earlier
# rsync block ships Dockerfile/compose/package*.json but not these.
echo "→ Syncing Cargo workspace manifest"
rsync -av Cargo.toml Cargo.lock LICENSE "${NAS_USER}@${NAS_HOST}:${APPDATA}/"

echo "→ Shipping env"
rsync -av "$LOCAL_ENV" "${NAS_USER}@${NAS_HOST}:${APPDATA}/.env"
ssh "${NAS_USER}@${NAS_HOST}" "chmod 600 ${APPDATA}/.env"

ssh "${NAS_USER}@${NAS_HOST}" "test -f ${APPDATA}/.dockerignore || echo '[deploy] WARN: .dockerignore not present in build context — context will include .env, data/, recommender-db/'"

# Pre-create + chown the sidecar DB bind-mount dirs to their in-container
# service uids BEFORE `compose up`. Docker creates a missing bind-mount source
# as root:root, which MASKS the image-time chown — on a fresh volume the
# media-core (uid 10002) and recommender (uid 10001) services then cannot write
# their sqlite DBs under cap_drop: ALL + read_only and crash-loop. Pre-chowning
# the host dirs makes the first boot writable without granting the containers
# any extra capability. The backend's /app/data is owned by root inside its own
# image, so it needs no chown here.
echo "→ Pre-creating + chowning sidecar DB volumes (fresh-volume crash-loop guard)"
ssh "${NAS_USER}@${NAS_HOST}" "\
  mkdir -p ${APPDATA}/data ${APPDATA}/recommender-db ${APPDATA}/recommender-db/hf-cache ${APPDATA}/media-core-db && \
  chown -R 10001:10001 ${APPDATA}/recommender-db && \
  chown -R 10002:10002 ${APPDATA}/media-core-db"

# Snapshot the currently-deployed backend image as :rollback BEFORE the build
# overwrites :latest, so an unhealthy deploy can be reverted (see post-deploy
# healthcheck below). Best-effort: the first-ever deploy has no prior image.
echo "→ Tagging current backend image as :rollback (revert target)"
ssh "${NAS_USER}@${NAS_HOST}" "docker image inspect theemeraldexchange-backend:latest >/dev/null 2>&1 && docker tag theemeraldexchange-backend:latest theemeraldexchange-backend:rollback || echo '[deploy] no prior backend image to tag (first deploy)'"

echo "→ Building and starting containers"
# Unraid occasionally loses both docker compose forms (plugin + standalone)
# after system updates. To keep deploys working without manual NAS
# intervention, we try them in order and fall back to a direct docker
# build + run that mirrors the docker-compose.yml. Only the backend
# service is recreated this way — cloudflared keeps running across the
# rebuild since its config is in the container, not on the host.
#
# The fallback CANNOT recreate the compose network where
# `http://recommender:8000` resolves, so it would silently downgrade
# USE_LOCAL_RECOMMENDER=1 to trending. When that env is set, refuse
# to fall back: hard-fail so the operator installs docker compose
# instead of shipping a broken-but-running deploy.
ssh "${NAS_USER}@${NAS_HOST}" "cd ${APPDATA} && \
  if docker compose version >/dev/null 2>&1; then \
    docker compose up -d --build; \
  elif command -v docker-compose >/dev/null 2>&1; then \
    docker-compose up -d --build; \
  elif grep -qE '^USE_LOCAL_RECOMMENDER=1' .env 2>/dev/null; then \
    echo >&2; \
    echo '[deploy] FATAL: docker compose is unavailable AND USE_LOCAL_RECOMMENDER=1.' >&2; \
    echo '         The direct-docker fallback cannot wire the backend↔recommender' >&2; \
    echo '         network — suggestions would silently degrade to trending.' >&2; \
    echo '         Install docker compose on the NAS, then re-run.' >&2; \
    exit 1; \
  else \
    echo '[deploy] compose unavailable — rebuilding backend directly'; \
    echo '         (recommender disabled by env, so single-container is OK)'; \
    docker build -t theemeraldexchange-backend:latest . && \
    docker stop exchange-backend 2>/dev/null || true; \
    docker rm exchange-backend 2>/dev/null || true; \
    docker run -d \
      --name exchange-backend \
      --restart unless-stopped \
      -p 127.0.0.1:3001:3001 \
      -v ${APPDATA}/data:/app/data \
      --env-file ${APPDATA}/.env \
      -e NODE_ENV=production \
      -e PORT=3001 \
      -e GRAB_LOG_PATH=/app/data/grabs.jsonl \
      theemeraldexchange-backend:latest; \
  fi"

# cloudflared joins the backend's network namespace (network_mode:
# service:backend), so the tunnel origin (localhost:3001) only resolves while
# the EXACT backend container it first joined is alive. `compose up --build`
# recreates the backend on any image change, staling that netns reference —
# `depends_on` orders the first start but does NOT re-gate a recreate — so the
# public site 502s until cloudflared is restarted. Always restart it after a
# deploy (cheap, idempotent). This has caused a real prod outage before.
echo "→ Restarting cloudflared (re-joins the recreated backend netns; else public 502)"
ssh "${NAS_USER}@${NAS_HOST}" "docker restart exchange-cloudflared >/dev/null 2>&1 || echo '[deploy] WARN: could not restart exchange-cloudflared (not running?)'"

# Post-deploy healthcheck. The 5s log tail this replaces was shorter than the
# container's 20s health start_period, so a crash-looping or boot-failing
# backend (bad migration, env-gate crash, napi ABI mismatch) shipped with an
# "✓ Deployed" and the API was simply down. Poll the backend's health until it
# is actually serving; if it never does, roll back to the :rollback image.
# Bootstrap window: on the very first deploy EEX_TELEMETRY_DSN doesn't exist yet
# (you create it from the Glitchtip instance THIS deploy brings up — see
# glitchtip-setup.md §2). The backend crash-loops by design that one time, so we
# must NOT health-gate/roll-back the whole stack — that would tear down the
# Glitchtip you need to mint the DSN from. Detect the unset DSN and, in that
# window only, skip the rollback with guidance instead.
telemetry_dsn="$(env_value EEX_TELEMETRY_DSN 2>/dev/null || true)"
echo "→ Waiting for backend to report healthy (up to ~90s)"
set +e
ssh "${NAS_USER}@${NAS_HOST}" '
  last=unknown
  for i in $(seq 1 30); do
    s=$(docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" exchange-backend 2>/dev/null || echo missing)
    last="$s"
    if [ "$s" = "healthy" ]; then echo "[deploy] backend healthy"; exit 0; fi
    if [ "$s" = "none" ]; then
      # Direct-docker fallback container has no docker healthcheck — probe the port.
      if curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then echo "[deploy] backend healthy (port probe)"; exit 0; fi
    fi
    if [ "$s" = "missing" ]; then echo "[deploy] exchange-backend container is missing"; exit 2; fi
    sleep 3
  done
  echo "[deploy] backend never became healthy (last status: $last)"; exit 3
'
health_rc=$?
set -e

if [ "$health_rc" -ne 0 ] && [ -z "$telemetry_dsn" ]; then
  echo "→ Backend not healthy, but EEX_TELEMETRY_DSN is unset — this is the" >&2
  echo "  expected Glitchtip bootstrap window, NOT a deploy failure. The stack is" >&2
  echo "  up; create the EEX project + DSN (docs/operations/glitchtip-setup.md §4)," >&2
  echo "  set EEX_TELEMETRY_DSN in .env.production, then re-run this deploy — the" >&2
  echo "  next run health-gates the backend normally. Skipping rollback." >&2
elif [ "$health_rc" -ne 0 ]; then
  echo "✗ Backend unhealthy after deploy (rc=$health_rc) — rolling back to previous image" >&2
  ssh "${NAS_USER}@${NAS_HOST}" "cd ${APPDATA} && \
    if docker image inspect theemeraldexchange-backend:rollback >/dev/null 2>&1; then \
      docker tag theemeraldexchange-backend:rollback theemeraldexchange-backend:latest && \
      ( docker compose up -d --no-build backend 2>/dev/null || docker compose up -d --no-build 2>/dev/null || true ) && \
      docker restart exchange-cloudflared >/dev/null 2>&1 || true; \
      echo '[deploy] rolled back to previous backend image'; \
    else \
      echo '[deploy] FATAL: no :rollback image to restore — backend is down, manual intervention required' >&2; \
    fi"
  echo "✗ Deploy FAILED and was rolled back. Investigate before retrying:" >&2
  echo "    ssh ${NAS_USER}@${NAS_HOST} 'docker logs --tail=80 exchange-backend'" >&2
  exit 1
fi

echo "→ Reclaiming BuildKit cache + dangling images (the docker vdisk creeps ~1GB/deploy otherwise)"
ssh "${NAS_USER}@${NAS_HOST}" "docker builder prune -f >/dev/null 2>&1 || true; docker image prune -f >/dev/null 2>&1 || true"

echo
echo "✓ Deployed and verified healthy. Public endpoint:"
echo "    curl -s https://api.theemeraldexchange.com/api/health"
