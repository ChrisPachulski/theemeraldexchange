#!/usr/bin/env bash
# Deploy the Hono backend + Cloudflare Tunnel sidecar to the NAS.
#
# Architecture (V2):
#   theemeraldexchange.com         → Netlify (SPA)             [auto-deploys on git push]
#   api.theemeraldexchange.com     → Cloudflare Tunnel
#                                   → cloudflared container on NAS (network_mode: host)
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
  ALLOWED_ORIGINS
  SONARR_API_KEY
  RADARR_API_KEY
  SAB_API_KEY
)
for key in "${required[@]}"; do
  if ! grep -q "^${key}=" "$LOCAL_ENV"; then
    echo "ERROR: ${key} missing from $LOCAL_ENV" >&2
    exit 1
  fi
done

# PLEX_SERVER_ID gates sign-in to members of the household's Plex
# server. A blank value turns the app into "any Plex user can sign
# in," so the backend hard-fails at boot in prod unless the operator
# explicitly opted into bootstrap mode. Mirror that check here so
# deploy fails fast with a clearer message than a container crash
# loop.
if grep -qE "^PLEX_SERVER_ID=.+" "$LOCAL_ENV"; then
  : # populated — good
elif grep -qE "^ALLOW_UNSCOPED_PLEX_LOGIN=1[[:space:]]*$" "$LOCAL_ENV"; then
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

echo "→ Shipping env"
rsync -av "$LOCAL_ENV" "${NAS_USER}@${NAS_HOST}:${APPDATA}/.env"
ssh "${NAS_USER}@${NAS_HOST}" "chmod 600 ${APPDATA}/.env"

ssh "${NAS_USER}@${NAS_HOST}" "test -f ${APPDATA}/.dockerignore || echo '[deploy] WARN: .dockerignore not present in build context — context will include .env, data/, recommender-db/'"

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

echo "→ Tail logs for 5s to confirm healthy boot"
ssh "${NAS_USER}@${NAS_HOST}" "timeout 5 docker logs --tail=20 -f exchange-backend || true"

echo
echo "✓ Deployed. The cloudflared container may take ~30s to register"
echo "  with Cloudflare. Test:"
echo "    curl -s https://api.theemeraldexchange.com/api/health"
