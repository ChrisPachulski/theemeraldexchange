#!/bin/sh
# self-host-env.sh — generate the boot-required secrets into .env (plan 006
# Phase 3). Idempotent: only fills keys that are missing or empty; never
# touches a key the operator already set. Run before `docker compose up`
# (the Phase 5 installer calls this for you).
#
# Generated HOST-side (not per-container) on purpose: INTERNAL_PRINCIPAL_SECRET
# and RECOMMENDER_EVENT_SECRET are SHARED secrets — the backend mints and the
# sidecars verify — so independent per-container generation would desync them.
#
# Deliberately NOT generated (verdict A10):
#   - RECOMMENDER_EVENT_SECRET: only when USE_LOCAL_RECOMMENDER=1 (flag-gated
#     below).
#   - IPTV_RECOMMENDER_EXPORT_SECRET: minting it silently ENABLES the export
#     endpoint the operator meant to leave off. Stays opt-in, always.
#
# POSIX sh only — runs on any box with /dev/urandom + base64 (openssl not
# required). $status is never assigned (zsh-reserved).

set -eu

ENV_FILE="${1:-.env}"

gen_secret() {
  # 48 random bytes, base64 — matches the documented `openssl rand -base64 48`
  # recipe (≥32 chars, passes the prod strength gate).
  head -c 48 /dev/urandom | base64 | tr -d '\n'
}

# True (0) when the key is absent OR present-but-empty in $ENV_FILE.
needs_key() {
  key="$1"
  if [ ! -f "$ENV_FILE" ]; then return 0; fi
  val=$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
  [ -z "$val" ]
}

ensure_key() {
  key="$1"
  if needs_key "$key"; then
    # Drop any empty placeholder line so the file stays single-sourced.
    if [ -f "$ENV_FILE" ] && grep -qE "^${key}=$" "$ENV_FILE"; then
      grep -vE "^${key}=$" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    fi
    printf '%s=%s\n' "$key" "$(gen_secret)" >> "$ENV_FILE"
    echo "[self-host-env] generated $key"
  else
    echo "[self-host-env] $key already set — kept"
  fi
}

touch "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

# The four boot-required secrets (two always, two prod-only — generate all
# four; extras are harmless and prod is the compose default).
ensure_key SESSION_SECRET
ensure_key STREAM_TOKEN_SECRET
ensure_key DEVICE_TOKEN_SECRET
ensure_key INTERNAL_PRINCIPAL_SECRET

# Conditional: only when the local recommender sidecar is enabled.
if grep -qE '^USE_LOCAL_RECOMMENDER=1' "$ENV_FILE" 2>/dev/null; then
  ensure_key RECOMMENDER_EVENT_SECRET
fi

echo "[self-host-env] done — secrets live in $ENV_FILE (0600). Never commit this file."
