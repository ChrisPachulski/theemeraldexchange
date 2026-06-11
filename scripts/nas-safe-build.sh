#!/usr/bin/env bash
# nas-safe-build.sh — build a compose service image ON the NAS without ever
# overwhelming the box that also runs Plex.
#
# WHY THIS EXISTS (a real, twice-repeated incident):
#   `docker compose up -d --build transcoder` on the 6-thread NAS ran a COLD
#   full-workspace Rust compile. Uncapped, it drove load to ~73 and brown-outed
#   Plex for ~13 min; a CPU-capped retry then I/O-stormed the box just as badly.
#   The NAS hosts the whole stack AND Plex, so it has to stay — which means any
#   compile here must be SELF-THROTTLING, MONITORED, and ABORTABLE.
#
# WHAT THIS GUARANTEES:
#   1. Capacity is DISCOVERED at run time (cores, live load, critical-container
#      presence) — never hard-coded — and the build is capped to leave headroom.
#   2. The build runs DETACHED on the NAS (setsid + logfile + done-sentinel), so
#      a dropped/again-starved SSH session can never orphan it (the failure mode
#      that made the first incident unkillable).
#   3. A PROGRESS HEARTBEAT prints every interval (a slow build is fine — a
#      SILENT one is not).
#   4. A WATCHDOG aborts the build the moment the critical container (Plex by
#      default) goes unhealthy or load-per-core blows past the ceiling — early,
#      before the box wedges, while SSH can still land the kill.
#
# This pairs with the transcoder Dockerfile's BuildKit cache mounts: after the
# first (cold) build, rebuilds are INCREMENTAL (only changed crates) and barely
# register — but this script keeps even a cold build inside safe bounds.
#
# Usage:
#   scripts/nas-safe-build.sh <compose-service> [critical-container]
#   NAS_HOST=theemeraldexchange scripts/nas-safe-build.sh transcoder Plex-Media-Server
#
# Env knobs (all optional; sensible defaults):
#   NAS_HOST (theemeraldexchange)  NAS_USER (root)
#   APPDATA  (/mnt/user/appdata/exchange-backend)
#   CORES_RESERVED   override the auto-reserved headroom cores
#   ABORT_LOAD_PER_CORE (2.0)  abort if 1-min load/core exceeds this for N samples
#   ABORT_SAMPLES (3)          consecutive bad samples before abort
#   HEARTBEAT_SECS (20)        poll/heartbeat cadence
#   MAX_BUILD_MINUTES (75)     hard wall-clock ceiling on the whole run
#
# Exit codes: 0 build ok · 2 build failed · 3 aborted (watchdog) · 4 timeout · 5 setup
set -euo pipefail

SERVICE="${1:-}"
CRITICAL="${2:-Plex-Media-Server}"
if [ -z "$SERVICE" ]; then
  echo "usage: $0 <compose-service> [critical-container]" >&2
  exit 5
fi

NAS_HOST="${NAS_HOST:-theemeraldexchange}"
NAS_USER="${NAS_USER:-root}"
APPDATA="${APPDATA:-/mnt/user/appdata/exchange-backend}"
ABORT_LOAD_PER_CORE="${ABORT_LOAD_PER_CORE:-2.0}"
ABORT_SAMPLES="${ABORT_SAMPLES:-3}"
HEARTBEAT_SECS="${HEARTBEAT_SECS:-20}"
MAX_BUILD_MINUTES="${MAX_BUILD_MINUTES:-75}"
NAS="${NAS_USER}@${NAS_HOST}"

# Unique-ish run id without Date.now()/random (zsh-safe): pid + epoch from NAS.
RUN_TAG="eex-safe-build-${SERVICE}"
LOG="/tmp/${RUN_TAG}.log"
DONE="/tmp/${RUN_TAG}.done"
PIDF="/tmp/${RUN_TAG}.pgid"

say() { printf '[nas-safe-build] %s\n' "$*"; }

# A short SSH that fails fast under load instead of hanging the whole script.
nas() { timeout 25 ssh -o ConnectTimeout=12 -o BatchMode=yes "$NAS" "$@"; }

# ── 1. DISCOVER capacity + launch the build, detached, on the NAS ────────────
# Everything below the marker runs ON the NAS in one shot: it reads the box's
# real core count and live load, computes a job cap that LEAVES HEADROOM, then
# launches the throttled build under its own session (setsid) so it outlives
# this SSH connection. The chosen numbers are echoed back for the operator.
say "discovering capacity on ${NAS_HOST} and launching detached build of '${SERVICE}'…"
launch_out=$(nas bash -s -- "$APPDATA" "$SERVICE" "$CRITICAL" "${CORES_RESERVED:-}" "$LOG" "$DONE" "$PIDF" <<'REMOTE'
set -eu
APPDATA="$1"; SERVICE="$2"; CRITICAL="$3"; RES_OVERRIDE="$4"; LOG="$5"; DONE="$6"; PIDF="$7"
cd "$APPDATA" || { echo "ERR: appdata $APPDATA missing"; exit 5; }

NPROC="$(nproc)"
LOAD1="$(cut -d' ' -f1 /proc/loadavg)"
# Reserve headroom so the box keeps cycles for Plex + system: half the threads,
# at least 2. The build gets what's left, at least 1. Discovered, not fixed.
if [ -n "$RES_OVERRIDE" ]; then
  RESERVE="$RES_OVERRIDE"
else
  RESERVE=$(( (NPROC + 1) / 2 ))
  [ "$RESERVE" -lt 2 ] && RESERVE=2
fi
JOBS=$(( NPROC - RESERVE ))
[ "$JOBS" -lt 1 ] && JOBS=1

crit_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CRITICAL" 2>/dev/null || echo absent)"

echo "DISCOVERED nproc=$NPROC load1=$LOAD1 reserve=$RESERVE jobs=$JOBS critical=$CRITICAL:$crit_state"

rm -f "$LOG" "$DONE" "$PIDF"
# Detached, own session/process-group so the whole tree is killable by -PGID
# and survives this SSH closing. ionice/nice are belt-and-suspenders (the real
# CPU lever is CARGO_BUILD_JOBS via compose build.args; the real I/O lever is
# the Dockerfile cache mounts that keep rebuilds incremental).
setsid bash -c '
  echo "build start $(date -u +%H:%M:%S)" >> "'"$LOG"'"
  CARGO_BUILD_JOBS='"$JOBS"' ionice -c3 nice -n19 \
    docker compose build '"$SERVICE"' >> "'"$LOG"'" 2>&1
  echo $? > "'"$DONE"'"
' >/dev/null 2>&1 &
# Record the negative-able process-group id for a clean tree-kill on abort.
echo "$!" > "$PIDF"
echo "LAUNCHED pgid=$(cat "$PIDF")"
REMOTE
) || { say "FAILED to launch build (ssh/setup error):"; printf '%s\n' "$launch_out" >&2; exit 5; }

printf '%s\n' "$launch_out" | sed 's/^/[nas] /'
echo "$launch_out" | grep -q '^LAUNCHED' || { say "launch did not confirm; aborting"; exit 5; }

# ── 2. WATCH: heartbeat + Plex watchdog until the build finishes ─────────────
abort_build() {
  say "ABORTING build (watchdog): $1"
  # Kill the whole process group; retry a few times in case ssh is briefly slow.
  for _ in 1 2 3 4 5; do
    if nas "pgid=\$(cat $PIDF 2>/dev/null); [ -n \"\$pgid\" ] && kill -TERM -\"\$pgid\" 2>/dev/null; pkill -TERM -f 'compose build $SERVICE' 2>/dev/null; sleep 1; pkill -KILL -f 'compose build $SERVICE' 2>/dev/null; echo ABORTED" 2>/dev/null | grep -q ABORTED; then
      say "abort signal delivered"; return 0
    fi
    sleep 4
  done
  say "WARNING: could not confirm abort over ssh (box may be wedged); build is detached and finite, it will end on its own"
}

start_epoch=$(nas 'date +%s' 2>/dev/null || echo 0)
bad=0
miss=0
while :; do
  sample=$(nas "
    done='\$(cat $DONE 2>/dev/null)';
    load1=\$(cut -d' ' -f1 /proc/loadavg);
    crit=\$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $CRITICAL 2>/dev/null || echo absent);
    tail=\$(tail -n1 $LOG 2>/dev/null | tr -d '\r');
    echo \"DONE=\${done}|LOAD=\${load1}|CRIT=\${crit}|TAIL=\${tail}\"
  " 2>/dev/null) || sample=""

  ts=$(date -u +%H:%M:%S)
  if [ -z "$sample" ]; then
    miss=$((miss+1))
    say "[$ts] sample missed (ssh slow/starved) [$miss]"
    # Repeated misses == the box is getting overwhelmed: try to abort early.
    if [ "$miss" -ge "$ABORT_SAMPLES" ]; then
      abort_build "ssh unresponsive for $miss samples — box overwhelmed"
      exit 3
    fi
    sleep "$HEARTBEAT_SECS"; continue
  fi
  miss=0

  done_code=$(printf '%s' "$sample" | sed -n 's/.*DONE=\([^|]*\).*/\1/p')
  load1=$(printf '%s' "$sample" | sed -n 's/.*LOAD=\([^|]*\).*/\1/p')
  crit=$(printf '%s' "$sample" | sed -n 's/.*CRIT=\([^|]*\).*/\1/p')
  tail=$(printf '%s' "$sample" | sed -n 's/.*TAIL=\(.*\)$/\1/p')

  # Per-core load via awk (float-safe). nproc cached from launch line.
  nproc_n=$(printf '%s' "$launch_out" | sed -n 's/.*nproc=\([0-9]*\).*/\1/p'); [ -z "$nproc_n" ] && nproc_n=1
  lpc=$(awk -v l="$load1" -v n="$nproc_n" 'BEGIN{ if(n<1)n=1; printf "%.2f", l/n }')
  say "[$ts] load=${load1} (${lpc}/core) plex=${crit} | ${tail}"

  # Build finished?
  if [ -n "$done_code" ]; then
    if [ "$done_code" = "0" ]; then
      say "BUILD OK (exit 0). Recreate with: ssh $NAS 'cd $APPDATA && docker compose up -d --no-build $SERVICE'"
      exit 0
    fi
    say "BUILD FAILED (exit $done_code). Last log:"
    nas "tail -n 25 $LOG" 2>/dev/null || true
    exit 2
  fi

  # Watchdog: critical container unhealthy, or load/core over ceiling.
  over=$(awk -v v="$lpc" -v c="$ABORT_LOAD_PER_CORE" 'BEGIN{ print (v>c)?1:0 }')
  if [ "$crit" != "healthy" ] && [ "$crit" != "running" ] && [ "$crit" != "absent" ]; then
    bad=$((bad+1)); say "  ! plex=$crit (degraded) [$bad/$ABORT_SAMPLES]"
  elif [ "$over" = "1" ]; then
    bad=$((bad+1)); say "  ! load/core ${lpc} > ${ABORT_LOAD_PER_CORE} [$bad/$ABORT_SAMPLES]"
  else
    bad=0
  fi
  if [ "$bad" -ge "$ABORT_SAMPLES" ]; then
    abort_build "critical degraded / overload sustained for $bad samples"
    exit 3
  fi

  # Wall-clock ceiling.
  now_epoch=$(nas 'date +%s' 2>/dev/null || echo 0)
  if [ "$start_epoch" -gt 0 ] && [ "$now_epoch" -gt 0 ]; then
    elapsed_min=$(( (now_epoch - start_epoch) / 60 ))
    if [ "$elapsed_min" -ge "$MAX_BUILD_MINUTES" ]; then
      abort_build "exceeded MAX_BUILD_MINUTES=${MAX_BUILD_MINUTES}"
      exit 4
    fi
  fi
  sleep "$HEARTBEAT_SECS"
done
