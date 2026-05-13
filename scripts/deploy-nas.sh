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

echo "→ Ensuring ${APPDATA} exists on ${NAS_HOST}"
ssh "${NAS_USER}@${NAS_HOST}" "mkdir -p ${APPDATA}"

echo "→ Syncing build context"
rsync -av \
  Dockerfile docker-compose.yml package.json package-lock.json tsconfig.json \
  "${NAS_USER}@${NAS_HOST}:${APPDATA}/"

echo "→ Syncing server/"
rsync -av --delete \
  --exclude '*.test.ts' \
  --exclude 'middleware/*.test.ts' \
  server/ "${NAS_USER}@${NAS_HOST}:${APPDATA}/server/"

echo "→ Shipping env"
rsync -av "$LOCAL_ENV" "${NAS_USER}@${NAS_HOST}:${APPDATA}/.env"
ssh "${NAS_USER}@${NAS_HOST}" "chmod 600 ${APPDATA}/.env"

echo "→ Building and starting containers"
# Unraid sometimes loses the docker compose plugin during system
# updates while keeping the standalone docker-compose binary. Try the
# plugin form first; fall back to the hyphenated standalone if that
# fails. Both accept the same up -d --build / logs flags.
ssh "${NAS_USER}@${NAS_HOST}" "cd ${APPDATA} && (docker compose up -d --build || docker-compose up -d --build)"

echo "→ Tail logs for 5s to confirm healthy boot"
ssh "${NAS_USER}@${NAS_HOST}" "cd ${APPDATA} && (timeout 5 docker compose logs --tail=20 -f || timeout 5 docker-compose logs --tail=20 -f || true)"

echo
echo "✓ Deployed. The cloudflared container may take ~30s to register"
echo "  with Cloudflare. Test:"
echo "    curl -s https://api.theemeraldexchange.com/api/health"
