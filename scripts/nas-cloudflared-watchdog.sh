#!/usr/bin/env bash
# nas-cloudflared-watchdog.sh — self-heal the Cloudflare Tunnel after a
# standalone backend restart (the stale-netns outage).
#
# WHY THIS EXISTS
#   cloudflared runs `network_mode: service:backend` (docker-compose.yml:494):
#   it shares exchange-backend's network namespace so the tunnel origin
#   (127.0.0.1:3001) resolves. That netns reference is frozen to the backend
#   CONTAINER at create time. Whenever exchange-backend is *recreated* — a
#   deploy, an auto-restart (`restart: unless-stopped`), an OOM/health roll,
#   a `docker restart` — its netns is replaced and the still-running
#   cloudflared keeps dialing Cloudflare's edge from the DEAD netns
#   ("failed to dial ... sendmsg: network is unreachable"). Public API then
#   serves Cloudflare 1033 / HTTP 530 indefinitely while the SPA looks fine.
#
#   deploy-nas.sh (line 432) and nas-canary-deploy.sh (line 167) already
#   force-recreate cloudflared after THEIR OWN backend swaps. But a backend
#   recreation that does NOT go through a deploy script (the 2026-06-28
#   outage: a bare restart) leaves nothing to recover the tunnel. This
#   watchdog is that missing recovery: run it on a 1–2 min cron and it
#   detects the drift and re-recreates cloudflared automatically.
#
# HOW IT DECIDES
#   Compare `docker inspect -f '{{.State.StartedAt}}' exchange-backend`
#   against the same for exchange-cloudflared. If the backend started AFTER
#   cloudflared, cloudflared is pinned to a stale netns → force-recreate it
#   with `docker compose up -d --no-deps --no-build --force-recreate cloudflared`
#   (a plain `docker restart` is INSUFFICIENT — it relaunches cloudflared
#   still bound to the old, removed netns; only a recreate re-resolves
#   `service:backend` to the live backend container).
#
#   StartedAt is Go RFC3339Nano (UTC, trailing-zero-trimmed fraction), so a
#   naive string compare is WRONG (".5Z" would sort AFTER ".500000005Z"
#   because 'Z' > '0'). Timestamps are normalized to a fixed-width all-digit
#   form before comparison — see _norm_ts() and `--self-test`.
#
# INSTALL ON THE NAS  (DEPLOY-STAGE — this repo does NOT install it; see the
# report's deploy notes). As root on the NAS, add one crontab line
# (`crontab -e`) — runs every 2 minutes, appends timestamped lines to a log:
#
#   */2 * * * * /mnt/user/appdata/exchange-backend/scripts/nas-cloudflared-watchdog.sh >> /var/log/eex-cf-watchdog.log 2>&1
#
#   (Unraid note: /etc/cron is not persistent across reboot on stock Unraid —
#   install via the User Scripts plugin with a custom "*/2 * * * *" schedule,
#   or drop a line in /boot/config/plugins/dynamix/... that survives reboot.
#   Rotate /var/log/eex-cf-watchdog.log with logrotate; the OK heartbeat is
#   one line per run. The exchange-tailscale sidecar shares the same netns
#   caveat — point CF_SVC/CF_CTR at it, or run a second copy, if it ever
#   needs the same guard.)
#
# MODES / FLAGS
#   (none)         One health check. Recreate cloudflared iff drift detected.
#   --dry-run      Detect drift and LOG the recreate it *would* run, but do
#                  not touch docker. Safe to run anywhere with a live docker.
#   --self-test    Run the timestamp-comparison unit checks (no docker, no
#                  network). Exit 0 iff every check passes. This is what the
#                  vitest shell-out test asserts.
#   --compare A B  Print RECREATE if StartedAt A (backend) is strictly newer
#                  than StartedAt B (cloudflared), else SKIP. Exit 0. Lets
#                  tests drive individual comparison cases.
#   -h | --help    Print this header.
#
# ENV OVERRIDES (all optional)
#   BACKEND_CTR   backend container name       (default exchange-backend)
#   CF_CTR        cloudflared container name    (default exchange-cloudflared)
#   CF_SVC        cloudflared compose service   (default cloudflared)
#   COMPOSE_DIR   dir holding docker-compose.yml(default /mnt/user/appdata/exchange-backend)
#   DOCKER_BIN    docker executable             (default docker)
#   COMPOSE_CMD   compose invocation            (default "docker compose")
#   HEALTH_URL    post-recreate probe target    (default public /api/health)
#   EEX_CF_WATCHDOG_LOG  extra logfile to tee timestamped lines into
#                        (default unset — stdout only; cron redirect owns
#                        persistence).

set -euo pipefail
# Byte-wise collation so the fixed-width digit-string comparison in
# backend_is_newer() is locale-independent.
export LC_ALL=C

BACKEND_CTR="${BACKEND_CTR:-exchange-backend}"
CF_CTR="${CF_CTR:-exchange-cloudflared}"
CF_SVC="${CF_SVC:-cloudflared}"
COMPOSE_DIR="${COMPOSE_DIR:-/mnt/user/appdata/exchange-backend}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
COMPOSE_CMD="${COMPOSE_CMD:-docker compose}"
# Ordered compose invocations to try when recreating cloudflared, mirroring
# deploy-nas.sh's fallback chain. Unraid has dropped one or BOTH compose forms
# after system updates (documented in deploy-nas.sh); with only the hard-coded
# plugin form this watchdog — the sole recovery for a non-deploy backend
# restart — would fail on every tick and leave the public tunnel down until a
# human noticed. Try the configured/plugin form first, then standalone
# docker-compose. An explicit COMPOSE_CMD override is honored first; the
# standalone form is still appended unless it already IS the override.
COMPOSE_CMDS=("$COMPOSE_CMD")
[[ "$COMPOSE_CMD" == "docker-compose" ]] || COMPOSE_CMDS+=("docker-compose")
HEALTH_URL="${HEALTH_URL:-https://api.theemeraldexchange.com/api/health}"

# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------
log() {
  local ts msg
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '?')"
  msg="[$ts] nas-cloudflared-watchdog: $*"
  printf '%s\n' "$msg"
  if [[ -n "${EEX_CF_WATCHDOG_LOG:-}" ]]; then
    printf '%s\n' "$msg" >> "$EEX_CF_WATCHDOG_LOG" 2>/dev/null || true
  fi
}
# self-test / compare lines: plain, no timestamp noise.
say() { printf '%s\n' "$*"; }

print_help() {
  # Print the header comment block (up to the first non-comment line), same
  # trick deploy-nas.sh uses so --help never drifts from the docs above.
  awk 'NR>1 && !/^#/ {exit} NR>1 {sub(/^# ?/,""); print}' "$0"
}

# ---------------------------------------------------------------------------
# timestamp comparison (pure bash 3.2+, no `date -d` so it is portable and
# unit-testable off the NAS)
# ---------------------------------------------------------------------------
_norm_ts() {
  # Normalize a docker RFC3339Nano UTC StartedAt to a fixed-width 23-digit
  # string (14 date digits + 9 fractional-second digits) so a plain string
  # compare orders two of them chronologically. Go trims trailing zeros from
  # the fraction, so the raw strings are NOT safe to compare directly.
  #   2026-07-06T15:49:00.5Z        -> 20260706154900500000000
  #   2026-07-06T15:49:00.500000005Z-> 20260706154900500000005
  #   2026-07-06T15:49:00Z          -> 20260706154900000000000
  #   0001-01-01T00:00:00Z (never)  -> 00010101000000000000000
  local ts="$1" base frac
  ts="${ts%$'\r'}"            # defensive: strip a trailing CR
  if [[ "$ts" == *.* ]]; then
    base="${ts%%.*}"          # 2026-07-06T15:49:00
    frac="${ts#*.}"           # 500000005Z  (or 5Z)
    frac="${frac%Z}"          # 500000005
  else
    base="${ts%Z}"            # 2026-07-06T15:49:00
    frac=""
  fi
  frac="${frac//[!0-9]/}"     # digits only (defensive)
  frac="${frac}000000000"     # right-pad
  frac="${frac:0:9}"          # to exactly 9
  base="${base//[-T:]/}"      # 20260706154900
  base="${base//[!0-9]/}"     # digits only (defensive)
  printf '%s%s' "$base" "$frac"
}

backend_is_newer() {
  # $1 backend StartedAt, $2 cloudflared StartedAt.
  # return 0 (true) iff backend started STRICTLY after cloudflared.
  local b c
  b="$(_norm_ts "$1")"
  c="$(_norm_ts "$2")"
  # Equal-width digit strings under LC_ALL=C: byte compare == chronological.
  [[ "$b" > "$c" ]]
}

# ---------------------------------------------------------------------------
# docker actions
# ---------------------------------------------------------------------------
inspect_started() {
  # echo the container's State.StartedAt, or fail (non-zero) if not found.
  "$DOCKER_BIN" inspect -f '{{.State.StartedAt}}' "$1"
}

health_probe() {
  command -v curl >/dev/null 2>&1 || { log "health: curl unavailable — skipping probe"; return 0; }
  local code
  for _ in 1 2 3 4 5; do
    code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)"
    if [[ "$code" == "200" ]]; then
      log "health: $HEALTH_URL -> 200 (tunnel recovered)"
      return 0
    fi
    sleep 3
  done
  log "health: $HEALTH_URL -> ${code:-000} after retries (still unhealthy — investigate)"
  return 0
}

recreate_cloudflared() {
  local reason="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] would run: (cd $COMPOSE_DIR && <${COMPOSE_CMDS[*]}> up -d --no-deps --no-build --force-recreate $CF_SVC)  [reason: $reason]"
    return 0
  fi
  log "ACTION: force-recreating $CF_SVC (reason: $reason)"
  local out rc cc
  # Try each compose form in turn: a box that has lost the plugin can still be
  # healed by standalone docker-compose (and vice-versa).
  for cc in "${COMPOSE_CMDS[@]}"; do
    # shellcheck disable=SC2086  # $cc must word-split ("docker compose" -> 2 args)
    out="$(cd "$COMPOSE_DIR" && $cc up -d --no-deps --no-build --force-recreate "$CF_SVC" 2>&1)" && rc=0 || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      log "ACTION: force-recreate of $CF_SVC succeeded (via: $cc)"
      health_probe
      return 0
    fi
    log "WARN: '$cc up ... $CF_SVC' failed (rc=$rc): ${out:-<no output>} — trying next compose form"
  done
  log "ERROR: force-recreate of $CF_SVC failed via all compose forms (${COMPOSE_CMDS[*]})"
  return 1
}

do_check() {
  local backend_ts cf_ts
  if ! backend_ts="$(inspect_started "$BACKEND_CTR" 2>/dev/null)"; then
    log "ERROR: cannot inspect $BACKEND_CTR (not running?) — aborting, no action taken"
    return 2
  fi
  if ! cf_ts="$(inspect_started "$CF_CTR" 2>/dev/null)"; then
    log "WARN: cannot inspect $CF_CTR (absent/not running) — (re)creating it"
    recreate_cloudflared "cloudflared container absent"
    return $?
  fi
  if backend_is_newer "$backend_ts" "$cf_ts"; then
    log "DRIFT: $BACKEND_CTR StartedAt=$backend_ts is NEWER than $CF_CTR StartedAt=$cf_ts — cloudflared is on a stale netns; recovering"
    recreate_cloudflared "backend recreated after cloudflared (stale netns)"
    return $?
  fi
  log "OK: $CF_CTR StartedAt=$cf_ts >= $BACKEND_CTR StartedAt=$backend_ts — tunnel netns current, no action"
  return 0
}

# ---------------------------------------------------------------------------
# self-test — exercises backend_is_newer() across the tricky cases, especially
# the variable-length-fraction trap that a naive string compare gets wrong.
# ---------------------------------------------------------------------------
run_self_test() {
  local fails=0 n=0
  _st() { # $1 desc  $2 backend_ts  $3 cf_ts  $4 expected(RECREATE|SKIP)
    n=$((n + 1))
    local got
    if backend_is_newer "$2" "$3"; then got=RECREATE; else got=SKIP; fi
    if [[ "$got" == "$4" ]]; then
      say "  PASS [$n] $1"
    else
      say "  FAIL [$n] $1 — expected $4 got $got (backend=$2 cf=$3)"
      fails=$((fails + 1))
    fi
  }

  say "self-test: cloudflared stale-netns watchdog comparison logic"
  _st "backend restarted long after cloudflared -> recreate" \
      "2026-07-06T15:49:10.000000000Z" "2026-07-06T10:00:00.000000000Z" RECREATE
  _st "cloudflared newer than backend -> skip" \
      "2026-07-06T10:00:00Z" "2026-07-06T15:49:10Z" SKIP
  _st "identical timestamps -> skip (not STRICTLY newer)" \
      "2026-07-06T15:49:10.5Z" "2026-07-06T15:49:10.5Z" SKIP
  _st "trimmed fraction: .5 is OLDER than .500000005 -> skip (naive compare gets this WRONG)" \
      "2026-07-06T15:49:10.5Z" "2026-07-06T15:49:10.500000005Z" SKIP
  _st "trimmed fraction: .6 is NEWER than .500000005 -> recreate" \
      "2026-07-06T15:49:10.6Z" "2026-07-06T15:49:10.500000005Z" RECREATE
  _st "second rollover vs .999999999 fraction -> recreate" \
      "2026-07-06T15:49:11Z" "2026-07-06T15:49:10.999999999Z" RECREATE
  _st "whole-second equality, no fraction -> skip" \
      "2026-07-06T15:49:10Z" "2026-07-06T15:49:10Z" SKIP
  _st "docker zero-time cloudflared (never started) -> recreate" \
      "2026-07-06T15:49:10Z" "0001-01-01T00:00:00Z" RECREATE
  _st "minute boundary newer -> recreate" \
      "2026-07-06T15:50:00Z" "2026-07-06T15:49:59.999999999Z" RECREATE

  if [[ "$fails" -eq 0 ]]; then
    say "self-test: ALL $n CHECKS PASSED"
    return 0
  fi
  say "self-test: $fails/$n CHECKS FAILED"
  return 1
}

# ---------------------------------------------------------------------------
# arg parse + dispatch
# ---------------------------------------------------------------------------
DRY_RUN=0
MODE=check
COMPARE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --self-test) MODE=selftest ;;
    --compare)   MODE=compare ;;
    -h|--help)   print_help; exit 0 ;;
    *)
      if [[ "$MODE" == "compare" ]]; then
        COMPARE_ARGS+=("$arg")
      else
        echo "ERROR: unknown argument: $arg (see --help)" >&2
        exit 64
      fi
      ;;
  esac
done

case "$MODE" in
  selftest)
    run_self_test
    exit $?
    ;;
  compare)
    if [[ "${#COMPARE_ARGS[@]}" -ne 2 ]]; then
      echo "usage: nas-cloudflared-watchdog.sh --compare <backendStartedAt> <cloudflaredStartedAt>" >&2
      exit 64
    fi
    if backend_is_newer "${COMPARE_ARGS[0]}" "${COMPARE_ARGS[1]}"; then
      echo RECREATE
    else
      echo SKIP
    fi
    exit 0
    ;;
  check)
    do_check
    exit $?
    ;;
esac
