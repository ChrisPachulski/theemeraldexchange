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
#   4. TWO watchdogs abort the build the moment the critical container (Plex by
#      default) goes unhealthy, load-per-core blows past the ceiling, or free
#      memory collapses:
#        a. an ON-NAS watchdog launched next to the build, whose hot path is
#           fork-free (builtin reads of /proc + builtin kill), so it still
#           fires when the box is so starved that fork()/sshd are failing —
#           the 2026-06-11 incident proved the SSH abort path dies FIRST and
#           a "detached and finite" build can thrash-lock the box for hours;
#        b. this Mac-side watchdog over SSH as the outer, second layer.
#   5. A LAUNCH-TIME memory floor: rustc link steps eat GBs; starting a build
#      into low MemAvailable is how the OOM-thrash wedge begins.
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
#   MIN_MEM_AVAILABLE_KB (400000)   on-NAS watchdog aborts if MemAvailable
#                                   stays below this (OOM-thrash precursor)
#   MIN_LAUNCH_MEM_KB (1500000)     refuse to even start below this much
#                                   MemAvailable (FORCE_LOW_MEM=1 overrides)
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
MIN_MEM_AVAILABLE_KB="${MIN_MEM_AVAILABLE_KB:-400000}"
MIN_LAUNCH_MEM_KB="${MIN_LAUNCH_MEM_KB:-1500000}"
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
# Values go over as inline env assignments, NOT positional args: SSH joins argv
# into one remote string, and an EMPTY positional (RES_OVERRIDE when unset)
# collapses and shifts the rest, leaving later params unbound under `set -u`.
launch_out=$(nas "APPDATA='$APPDATA' SERVICE='$SERVICE' CRITICAL='$CRITICAL' RES_OVERRIDE='${CORES_RESERVED:-}' LOG='$LOG' DONE='$DONE' PIDF='$PIDF' ABORT_LPC='$ABORT_LOAD_PER_CORE' WD_SAMPLES='$ABORT_SAMPLES' MAX_MIN='$MAX_BUILD_MINUTES' MIN_MEM_KB='$MIN_MEM_AVAILABLE_KB' MIN_LAUNCH_MEM_KB='$MIN_LAUNCH_MEM_KB' FORCE_LOW_MEM='${FORCE_LOW_MEM:-}' bash -s" <<'REMOTE'
set -eu
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

# Launch-time memory floor: a Rust build/link into low MemAvailable is how the
# 2026-06-11 OOM-thrash wedge started (4h fork-starved, power-cycle territory).
MEM_AVAIL_KB="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
if [ "$MEM_AVAIL_KB" -lt "$MIN_LAUNCH_MEM_KB" ] && [ -z "$FORCE_LOW_MEM" ]; then
  echo "ERR: MemAvailable ${MEM_AVAIL_KB}kB < floor ${MIN_LAUNCH_MEM_KB}kB — free memory first or set FORCE_LOW_MEM=1"
  exit 5
fi

echo "DISCOVERED nproc=$NPROC load1=$LOAD1 mem_avail_kb=$MEM_AVAIL_KB reserve=$RESERVE jobs=$JOBS critical=$CRITICAL:$crit_state"

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

# ── ON-NAS WATCHDOG ──────────────────────────────────────────────────────────
# The abort must NOT depend on SSH: overload starves sshd first (2026-06-11),
# so a Mac-side abort can never land exactly when it's needed. This watchdog
# lives in the blast radius with a fork-free hot path — /proc via builtin
# `read`, waits via `read -t` on a never-written fifo fd, abort via builtin
# `kill` — so it still fires when fork() is failing box-wide. Killing the
# compose client closes its BuildKit session, which cancels the actual solve.
WDLOG="${LOG}.watchdog"
WDFIFO="${LOG}.wdfifo"
rm -f "$WDLOG" "$WDFIFO"
mkfifo "$WDFIFO"
LOAD_X100_MAX="$(awk -v n="$NPROC" -v c="$ABORT_LPC" 'BEGIN{printf "%d", n*c*100}')"
MAX_SECS=$(( MAX_MIN * 60 ))
BUILD_PGID="$(cat "$PIDF")"
setsid env BUILD_PGID="$BUILD_PGID" DONE="$DONE" WDLOG="$WDLOG" WDFIFO="$WDFIFO" \
    LOAD_X100_MAX="$LOAD_X100_MAX" MIN_MEM_KB="$MIN_MEM_KB" MAX_SECS="$MAX_SECS" \
    SAMPLES="$WD_SAMPLES" bash -c '
  exec 9<>"$WDFIFO"
  bad=0 elapsed=0
  abort() {
    echo "WATCHDOG ABORT: $1 (elapsed=${elapsed}s)" >> "$WDLOG"
    echo 3 > "$DONE"
    kill -TERM -"$BUILD_PGID" 2>/dev/null
    read -t 3 -u 9 _ 2>/dev/null
    kill -KILL -"$BUILD_PGID" 2>/dev/null
    # Best-effort remnant sweep (needs fork; the pgid kill above is the
    # load-bearing one — client death cancels the BuildKit solve).
    pkill -9 rustc 2>/dev/null; pkill -9 cargo 2>/dev/null
    rm -f "$WDFIFO" 2>/dev/null
    exit 0
  }
  while [ ! -s "$DONE" ]; do
    read -r load1 _ < /proc/loadavg
    f="${load1#*.}"
    load_x100=$(( 10#${load1%.*} * 100 + 10#${f:0:2} ))
    mem_kb=0
    while read -r k v _; do
      if [ "$k" = "MemAvailable:" ]; then mem_kb=$v; break; fi
    done < /proc/meminfo
    if [ "$load_x100" -gt "$LOAD_X100_MAX" ] || [ "$mem_kb" -lt "$MIN_MEM_KB" ]; then
      bad=$((bad+1))
      echo "strike $bad/$SAMPLES load_x100=$load_x100 mem_kb=$mem_kb t=${elapsed}s" >> "$WDLOG"
      if [ "$bad" -ge "$SAMPLES" ]; then
        abort "load_x100=$load_x100 (max $LOAD_X100_MAX) mem_kb=$mem_kb (min $MIN_MEM_KB)"
      fi
    else
      bad=0
    fi
    if [ "$elapsed" -ge "$MAX_SECS" ]; then
      abort "wall-clock ${elapsed}s >= ${MAX_SECS}s"
    fi
    read -t 10 -u 9 _ 2>/dev/null || true
    elapsed=$((elapsed+10))
  done
  rm -f "$WDFIFO" 2>/dev/null
' >/dev/null 2>&1 &
echo "LAUNCHED pgid=$(cat "$PIDF") watchdog_pid=$!"
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
    done=\$(cat $DONE 2>/dev/null);
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
    if [ "$done_code" = "3" ]; then
      say "BUILD ABORTED by the on-NAS watchdog:"
      nas "tail -n 6 ${LOG}.watchdog" 2>/dev/null || true
      exit 3
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
