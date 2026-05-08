#!/usr/bin/env bash
# Build and deploy the dashboard to the NAS.
# Strategy: build the static bundle locally, rsync it into the appdata mount,
# then trigger a container restart so any nginx config changes also take effect.
#
# Container: official nginx:alpine on host port 8085, with our dist/ mounted
# at /usr/share/nginx/html and nginx/default.conf mounted at
# /etc/nginx/templates/default.conf.template (envsubst at startup).
# Container name: exchange-dashboard
# Appdata path: /mnt/user/appdata/exchange-dashboard/{www,conf}
# API keys live in the container's environment, NOT in this script.
# First-time setup: see DEPLOY.md.

set -euo pipefail

NAS_HOST="${NAS_HOST:-theemeraldexchange.local}"
NAS_USER="${NAS_USER:-root}"
APPDATA_DIR="${APPDATA_DIR:-/mnt/user/appdata/exchange-dashboard}"
CONTAINER_NAME="${CONTAINER_NAME:-exchange-dashboard}"

echo "→ Building"
npm run build

echo "→ Syncing dist/ to ${NAS_USER}@${NAS_HOST}:${APPDATA_DIR}/www/"
ssh "${NAS_USER}@${NAS_HOST}" "mkdir -p ${APPDATA_DIR}/www ${APPDATA_DIR}/conf"
rsync -av --delete dist/ "${NAS_USER}@${NAS_HOST}:${APPDATA_DIR}/www/"

echo "→ Syncing nginx config"
rsync -av nginx/default.conf "${NAS_USER}@${NAS_HOST}:${APPDATA_DIR}/conf/default.conf.template"

echo "→ Restarting container"
ssh "${NAS_USER}@${NAS_HOST}" "docker restart ${CONTAINER_NAME} || echo 'container ${CONTAINER_NAME} not running; start it manually first time'"

echo "✓ Deployed. Try http://${NAS_HOST}:8085/"
