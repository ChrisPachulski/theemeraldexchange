#!/usr/bin/env bash
# eex-deploy.sh — guarded, auto-rollback deploy of theemeraldexchange to the NAS.
#
# This is the prod-side counterpart to the autoloop's git-side promote.sh: once a
# change is on `main` and CI-green, this lands it on the live box WITHOUT a human
# — but only behind hard guardrails, and it ROLLS BACK to the previous image if
# the post-deploy health gate fails. It NEVER does anything the box can't recover
# from on its own.
#
# What it does NOT do (deliberately, stays human-only — matches CLAUDE.md):
#   * raw compiles on the NAS (a PreToolUse hook blocks them; this uses
#     nas-safe-build.sh, which caps the build + watchdogs Plex),
#   * database migrations / schema changes,
#   * any destructive volume / data op.
#
# Safety model:
#   * DRY-RUN BY DEFAULT. Prints the plan and exits 0. Pass --arm (or set
#     EEX_DEPLOY_ARM=1) to actually build/recreate.
#   * STOP file ($AUTOLOOP_DIR/STOP) or MASTER:OFF → refuse immediately.
#   * Preconditions: Plex healthy AND 1-min load/core under the ceiling AND
#     MemAvailable above a floor — else defer (exit 3), never force onto a busy box.
#   * Rate limit: at most one deploy per RATE_WINDOW_SECS (state file), so a loop
#     can't thrash the box.
#   * Per service: capture the CURRENT image ID before swapping; on a failed
#     health gate, retag that ID back to :latest and recreate (rollback), then
#     re-probe. The box ends on a known-good image either way.
#
# Usage:
#   eex-deploy.sh --from <sha> [--to <sha>] [--arm] [--services "a b c"]
#     --from   last-deployed sha; changed services are detected from <from>..<to>.
#              If omitted, falls back to the recorded state file, else lists only.
#     --to     defaults to origin/main (what we deploy).
#     --services  explicit service list, bypassing change detection.
#     --arm    actually execute (default: dry-run plan).
#
# Exit: 0 ok/dry-run · 2 deploy failed (after rollback) · 3 deferred (guard) · 4 usage · 5 refused (STOP)
set -uo pipefail

NAS_HOST="${NAS_HOST:-theemeraldexchange.local}"
NAS_USER="${NAS_USER:-root}"
NAS="${NAS_USER}@${NAS_HOST}"
APPDATA="${APPDATA:-/mnt/user/appdata/exchange-backend}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
AUTOLOOP_DIR="${AUTOLOOP_DIR:-$REPO/.autoloop}"
STATE_DIR="${EEX_DEPLOY_STATE:-$HOME/.eex-autoloop}"
LAST_SHA_FILE="$STATE_DIR/last-deployed-sha"
LAST_DEPLOY_TS="$STATE_DIR/last-deploy-ts"
HEALTH_URL="${EEX_HEALTH_URL:-https://api.theemeraldexchange.com/api/health}"
LOAD_PER_CORE_CEIL="${LOAD_PER_CORE_CEIL:-1.5}"
MIN_MEM_KB="${MIN_MEM_KB:-1500000}"
RATE_WINDOW_SECS="${RATE_WINDOW_SECS:-1800}"
HEALTH_DEADLINE_SECS="${HEALTH_DEADLINE_SECS:-90}"

FROM=""; TO="origin/main"; ARM="${EEX_DEPLOY_ARM:-0}"; SERVICES_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2;;
    --to) TO="$2"; shift 2;;
    --services) SERVICES_OVERRIDE="$2"; shift 2;;
    --arm) ARM=1; shift;;
    *) echo "usage: $0 --from <sha> [--to <sha>] [--arm] [--services '...']" >&2; exit 4;;
  esac
done

say()  { printf '\n[eex-deploy] %s\n' "$*"; }
note() { printf '[eex-deploy]   %s\n' "$*"; }
fail() { printf '\n[eex-deploy] FAIL: %s\n' "$*" >&2; }
nas()  { timeout 30 ssh -o ConnectTimeout=12 -o BatchMode=yes "$NAS" "$@"; }
mkdir -p "$STATE_DIR"

# ── 0. Refuse on STOP / MASTER:OFF ───────────────────────────────────────────
if [ -f "$AUTOLOOP_DIR/STOP" ]; then fail "STOP file present ($AUTOLOOP_DIR/STOP) — refusing"; exit 5; fi
if [ -f "$AUTOLOOP_DIR/CONTROL.md" ] && grep -qiE '^\s*MASTER:\s*OFF' "$AUTOLOOP_DIR/CONTROL.md"; then
  fail "MASTER: OFF — refusing"; exit 5
fi

# ── 1. Resolve what changed → which services need a deploy ───────────────────
[ -z "$FROM" ] && [ -f "$LAST_SHA_FILE" ] && FROM="$(cat "$LAST_SHA_FILE")"
git -C "$REPO" fetch origin --quiet 2>/dev/null || true
TO_SHA="$(git -C "$REPO" rev-parse "$TO" 2>/dev/null || echo "")"
[ -n "$TO_SHA" ] || { fail "cannot resolve --to '$TO'"; exit 4; }

declare -a SERVICES
if [ -n "$SERVICES_OVERRIDE" ]; then
  # shellcheck disable=SC2206
  SERVICES=($SERVICES_OVERRIDE)
elif [ -n "$FROM" ]; then
  CHANGED="$(git -C "$REPO" diff --name-only "$FROM..$TO_SHA" 2>/dev/null)"
  printf '%s\n' "$CHANGED" | grep -q '^crates/transcoder/'  && SERVICES+=(transcoder)
  printf '%s\n' "$CHANGED" | grep -q '^crates/media-core/'  && SERVICES+=(media-core)
  printf '%s\n' "$CHANGED" | grep -q '^recommender/'        && SERVICES+=(recommender)
  printf '%s\n' "$CHANGED" | grep -qE '^(server/|package(-lock)?\.json|Dockerfile|crates/emerald-contracts)' && SERVICES+=(backend)
  # NOTE: the SPA frontend deploys via Netlify on push to main — never from here.
else
  note "no --from and no recorded last-deployed sha → cannot scope a diff; listing nothing."
fi

say "PLAN  to=$TO ($TO_SHA)  from=${FROM:-<none>}  arm=$ARM"
if [ "${#SERVICES[@]}" -eq 0 ]; then say "No compiled services changed — nothing to deploy (frontend is Netlify)."; exit 0; fi
note "services: ${SERVICES[*]}"

# ── 2. Guard: dry-run, rate limit, box health ────────────────────────────────
if [ "$ARM" != "1" ]; then
  say "DRY-RUN (no --arm). Would: ship src → nas-safe-build ${SERVICES[*]} → recreate → re-link cloudflared → health-gate → rollback-on-fail."
  exit 0
fi

if [ -f "$LAST_DEPLOY_TS" ]; then
  now="$(date +%s)"; last="$(cat "$LAST_DEPLOY_TS" 2>/dev/null || echo 0)"
  if [ $((now - last)) -lt "$RATE_WINDOW_SECS" ]; then
    fail "rate limit: last deploy $((now-last))s ago (< ${RATE_WINDOW_SECS}s) — deferring"; exit 3
  fi
fi

read -r NPROC LOAD1 MEMKB PLEX <<<"$(nas "echo \$(nproc) \$(cut -d' ' -f1 /proc/loadavg) \$(awk '/MemAvailable/{print \$2}' /proc/meminfo) \$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' Plex-Media-Server 2>/dev/null || echo absent)")" || { fail "cannot reach NAS for precondition check"; exit 3; }
LPC="$(awk -v l="$LOAD1" -v n="$NPROC" 'BEGIN{if(n<1)n=1; printf "%.2f", l/n}')"
note "box: nproc=$NPROC load1=$LOAD1 (${LPC}/core) mem=${MEMKB}kB plex=$PLEX"
over="$(awk -v v="$LPC" -v c="$LOAD_PER_CORE_CEIL" 'BEGIN{print (v>c)?1:0}')"
if [ "$PLEX" != "healthy" ] && [ "$PLEX" != "running" ]; then fail "Plex not healthy ($PLEX) — deferring"; exit 3; fi
if [ "$over" = "1" ]; then fail "load/core ${LPC} > ${LOAD_PER_CORE_CEIL} — deferring"; exit 3; fi
if [ "${MEMKB:-0}" -lt "$MIN_MEM_KB" ]; then fail "MemAvailable ${MEMKB}kB < ${MIN_MEM_KB}kB — deferring"; exit 3; fi

# ── 3. Capture rollback image IDs, ship source ───────────────────────────────
declare -A PREV_IMG
for svc in "${SERVICES[@]}"; do
  img="theemeraldexchange-${svc}:latest"
  id="$(nas "docker images --no-trunc --format '{{.ID}}' '$img' 2>/dev/null | head -1")"
  PREV_IMG[$svc]="$id"
  note "rollback ref $svc = ${id:-<none>}"
  [ -n "$id" ] && nas "docker tag '$id' 'theemeraldexchange-${svc}:rollback' 2>/dev/null" || true
done

say "SHIP source @ $TO_SHA → NAS appdata"
git -C "$REPO" archive "$TO_SHA" crates server recommender Cargo.lock Cargo.toml package.json package-lock.json Dockerfile \
  | nas "tar -x -C '$APPDATA'" || { fail "source ship failed"; exit 2; }

# Stamp the release into the NAS-side .env so compose interpolates the
# EEX_RELEASE build arg during nas-safe-build (which runs in its OWN remote
# shell — deploy-nas.sh's `export EEX_RELEASE` never reaches it, which is why
# /api/version reported 'dev' after eex deploys). compose reads .env for
# interpolation, so this survives any later ad-hoc `compose up` too.
TO_SHORT="$(git -C "$REPO" rev-parse --short "$TO_SHA")"
say "STAMP EEX_RELEASE=$TO_SHORT in NAS .env"
nas "cd '$APPDATA' && if grep -q '^EEX_RELEASE=' .env 2>/dev/null; then \
      sed -i 's/^EEX_RELEASE=.*/EEX_RELEASE=$TO_SHORT/' .env; \
    else printf 'EEX_RELEASE=%s\n' '$TO_SHORT' >> .env; fi" \
  || note "release stamp failed (cosmetic — /api/version will report 'dev')"

# ── 4. Build (safe) + recreate each service ──────────────────────────────────
deploy_failed=0
for svc in "${SERVICES[@]}"; do
  say "BUILD (safe) $svc"
  if ! NAS_HOST="$NAS_HOST" "$REPO/scripts/nas-safe-build.sh" "$svc" Plex-Media-Server; then
    fail "nas-safe-build $svc failed (or watchdog-aborted)"; deploy_failed=1; break
  fi
done

if [ "$deploy_failed" = "0" ]; then
  say "RECREATE ${SERVICES[*]} + re-link cloudflared"
  nas "cd '$APPDATA' && docker compose up -d --no-build ${SERVICES[*]} && docker compose up -d --force-recreate cloudflared" \
    || { fail "recreate failed"; deploy_failed=1; }
fi

# ── 5. Health gate ───────────────────────────────────────────────────────────
health_ok=0
if [ "$deploy_failed" = "0" ]; then
  say "HEALTH gate ($HEALTH_URL, deadline ${HEALTH_DEADLINE_SECS}s)"
  waited=0
  while [ "$waited" -lt "$HEALTH_DEADLINE_SECS" ]; do
    code="$(node -e "fetch('$HEALTH_URL').then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log(0);process.exit(0)})" 2>/dev/null)"
    if [ "$code" = "200" ]; then health_ok=1; break; fi
    note "health=$code (waited ${waited}s)"; sleep 5; waited=$((waited+5))
  done
fi

# ── 6. Rollback on failure ───────────────────────────────────────────────────
if [ "$deploy_failed" = "1" ] || [ "$health_ok" = "0" ]; then
  fail "deploy unhealthy — ROLLING BACK"
  for svc in "${SERVICES[@]}"; do
    id="${PREV_IMG[$svc]:-}"
    [ -z "$id" ] && { note "no prior image for $svc — cannot roll back that one"; continue; }
    note "rollback $svc → $id"
    nas "docker tag '$id' 'theemeraldexchange-${svc}:latest'" || true
  done
  nas "cd '$APPDATA' && docker compose up -d --no-build ${SERVICES[*]} && docker compose up -d --force-recreate cloudflared" || true
  rb=0
  for _ in 1 2 3 4 5 6; do
    code="$(node -e "fetch('$HEALTH_URL').then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log(0);process.exit(0)})" 2>/dev/null)"
    [ "$code" = "200" ] && { rb=1; break; }; sleep 5
  done
  if [ "$rb" = "1" ]; then
    fail "rolled back to previous image; box healthy again"
  else
    fail "ROLLBACK health still failing — NEEDS A HUMAN (touch $AUTOLOOP_DIR/STOP to halt the loop)"
  fi
  exit 2
fi

# ── 7. Success: record state ─────────────────────────────────────────────────
echo "$TO_SHA" > "$LAST_SHA_FILE"
date +%s > "$LAST_DEPLOY_TS"
say "DEPLOYED + HEALTHY: ${SERVICES[*]} @ $TO_SHA"
exit 0
