#!/bin/sh
# The Emerald Exchange — self-host installer (plan 006 Phase 5).
#
#   mkdir emerald && cd emerald
#   curl -fsSL https://raw.githubusercontent.com/ChrisPachulski/theemeraldexchange/main/selfhost/install.sh | sh
#   docker compose up -d
#
# Honest two-step (the Supabase nuance): this script BOOTSTRAPS (fetches the
# compose bundle, generates secrets, prompts for your media folder, pulls
# images); `docker compose up -d` STARTS. POSIX sh; needs curl or wget, and
# docker with the compose plugin.

set -eu

RAW="https://raw.githubusercontent.com/ChrisPachulski/theemeraldexchange/main/selfhost"

fetch() {
  # $1 url → $2 dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "ERROR: need curl or wget" >&2; exit 1
  fi
}

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required — https://docs.docker.com/engine/install/" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: the docker compose plugin is required" >&2; exit 1; }

echo "→ Fetching compose bundle"
for f in docker-compose.yml tailscale-serve.json .env.example; do
  [ -f "$f" ] || fetch "$RAW/$f" "$f"
done

[ -f .env ] || cp .env.example .env
chmod 600 .env

# ── generate the four secrets (idempotent; never overwrites yours) ──
gen_secret() { head -c 48 /dev/urandom | base64 | tr -d '\n'; }
ensure_key() {
  key="$1"
  val=$(grep -E "^${key}=" .env | tail -n1 | cut -d= -f2- || true)
  if [ -z "$val" ]; then
    grep -vE "^${key}=$" .env > .env.tmp && mv .env.tmp .env
    printf '%s=%s\n' "$key" "$(gen_secret)" >> .env
    echo "  generated $key"
  fi
}
echo "→ Generating secrets"
ensure_key SESSION_SECRET
ensure_key STREAM_TOKEN_SECRET
ensure_key DEVICE_TOKEN_SECRET
ensure_key INTERNAL_PRINCIPAL_SECRET
ensure_key RECOMMENDER_EVENT_SECRET

# ── media folder ──
media=$(grep -E '^MEDIA_PATH=' .env | tail -n1 | cut -d= -f2- || true)
if [ -z "$media" ]; then
  printf "→ Absolute path to your media folder (e.g. /srv/media): "
  read -r media </dev/tty || media=""
  if [ -z "$media" ]; then
    echo "ERROR: MEDIA_PATH is required — set it in .env and re-run" >&2
    exit 1
  fi
  grep -vE '^MEDIA_PATH=$' .env > .env.tmp && mv .env.tmp .env
  printf 'MEDIA_PATH=%s\n' "$media" >> .env
fi
[ -d "$media" ] || echo "WARN: $media does not exist yet — create it before starting"

echo "→ Pulling images (multi-arch, from GHCR)"
docker compose pull

cat <<'DONE'

✔ Bootstrap complete. Start the server with:

    docker compose up -d

Then open  http://<this-host>:3001  and claim the server:
the one-time setup token is printed in the backend log —

    docker compose logs backend | grep -A3 unclaimed

Optional extras live in .env (remote access, TMDB, requests, live TV).
DONE
