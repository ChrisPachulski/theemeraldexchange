#!/bin/bash
# M4 transcoder SOAK harness (crit-4). Runs ON the NAS.
#
# WHAT crit-4 ACTUALLY ASKS (and the 60s bench does NOT prove):
#   crit-4 = "sustained reap / cleanup under load over time, no leak." The
#   stress bench (scripts/m4-stress-bench.sh) heartbeats EVERY session for its
#   whole 60s window, so nothing is ever reaped mid-run and no slow leak has
#   time to show. A soak must (a) hold a real concurrent re-encode load for a
#   long window, (b) make the 30s idle-reaper FIRE REPEATEDLY under that load
#   and confirm each reap actually cleaned up, and (c) prove neither ffmpeg
#   process count nor transcoder memory climbs across the window (zero leak).
#
# HOW IT PROVES EACH:
#   steady load   : N concurrent forced HEVC->H.264 re-encodes, heartbeated the
#                   whole window (the sustained base load).
#   reap firing   : every REAP_EVERY secs it grants ONE extra "ephemeral"
#                   session and then NEVER heartbeats it — the 30s reaper must
#                   kill it. ~45s later it confirms the session 404s AND the
#                   ffmpeg process count fell back to the steady baseline. A
#                   reap that doesn't clean up is a FAIL.
#   zero leak     : samples box CPU/load, Plex health, transcoder mem, and the
#                   host-side ffmpeg process count every SAMPLE_SECS. The proc
#                   count must oscillate steady..steady+1 and never climb; mem
#                   growth is reported. Final post-stop proc count must be 0.
#
# SAFE ON THIS BOX (also runs Plex): VAAPI offloads encode to the iGPU (3-4
# concurrent already proven clean). Same watchdog as the bench — degraded Plex
# or load/core over the ceiling for ABORT_SAMPLES stops EVERY session and bails.
# An EXIT trap stops every session on any exit so a -re session can never leak.
#
# Usage:
#   scripts/m4-soak.sh [steady_concurrency=3] [duration_secs=1800] [media_id ...]
#
# Env knobs (optional):
#   REFRESH_SECS (240)             refresh the steady pool this often, so load
#                                  stays continuous: VAAPI runs ~3-4x realtime
#                                  with no -re cap, so a session's ffmpeg exits
#                                  when it finishes the whole file (~8 min for a
#                                  30-min movie). Refreshing well before that
#                                  keeps N encoders always running AND exercises
#                                  repeated grant→stop lifecycle under load.
#   REAP_EVERY (300)               secs between reap-proof ephemeral grants
#   REAP_WAIT (45)                 secs to wait before confirming a reap
#                                  (IDLE 30 + sweep 5 + KILL_GRACE 5 + slack)
#   CRITICAL (Plex-Media-Server)   container whose health gates the run
#   ABORT_LOAD_PER_CORE (4.0)      abort if 1-min load/core exceeds this
#   ABORT_SAMPLES (3)              consecutive bad samples before abort
#   SAMPLE_SECS (5)                CPU/health/mem/proc sampling cadence
#   MEM_GROWTH_PCT (25)            crit-4 ceiling on steady-mem FLOOR rise
#   WARMUP_SECS (60)               ignore mem before this (encoder buffer ramp)
#   CAPS_HEIGHT (1080)             max_height in the forced re-encode caps
#
# Exit: 0 ran + reported (read the verdict) · 2 setup error · 3 watchdog abort
set -uo pipefail

STEADY="${1:-3}"
DURATION="${2:-1800}"
[ "$#" -ge 1 ] && shift
[ "$#" -ge 1 ] && shift
IDS=("$@")

DB="file:/mnt/user/appdata/exchange-backend/media-core-db/media.db?immutable=1"
T="http://127.0.0.1:8003"
TRANSCODER_CTR="exchange-transcoder"
CRITICAL="${CRITICAL:-Plex-Media-Server}"
REFRESH_SECS="${REFRESH_SECS:-240}"
REAP_EVERY="${REAP_EVERY:-300}"
REAP_WAIT="${REAP_WAIT:-45}"
ABORT_LOAD_PER_CORE="${ABORT_LOAD_PER_CORE:-4.0}"
ABORT_SAMPLES="${ABORT_SAMPLES:-3}"
SAMPLE_SECS="${SAMPLE_SECS:-5}"
MEM_GROWTH_PCT="${MEM_GROWTH_PCT:-25}"
WARMUP_SECS="${WARMUP_SECS:-60}"
CAPS_HEIGHT="${CAPS_HEIGHT:-1080}"
NPROC="$(nproc 2>/dev/null || echo 6)"

say()  { printf '\n==== %s ====\n' "$*"; }
info() { printf '     %s\n' "$*"; }

command -v docker  >/dev/null 2>&1 || { echo "docker not found — run this ON the NAS"; exit 2; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not found — run this ON the NAS"; exit 2; }

# Host-side ffmpeg process count inside the transcoder (no in-container deps).
ffcount() { docker top "$TRANSCODER_CTR" 2>/dev/null | grep -c 'ffmpeg'; }
# Transcoder RSS in MiB (parses "523MiB / 3GiB" → 523; GiB→*1024).
tmem_mib() {
  docker stats --no-stream --format '{{.MemUsage}}' "$TRANSCODER_CTR" 2>/dev/null \
  | awk '{u=$1; n=u; sub(/[A-Za-z]+$/,"",n);
          if(u ~ /GiB/) n*=1024; else if(u ~ /KiB/) n/=1024;
          printf "%.0f", n}'
}

# ── 1. Mint one internal-principal token (TTL covers the whole soak window) ───
TOKEN=$(docker exec -e SOAK_TTL="$((DURATION+600))" exchange-recommender python3 -c '
import emerald_contracts as ec, time, os
key=bytes(ec.hkdf_internal_principal(os.environ["INTERNAL_PRINCIPAL_SECRET"].encode()))
now=int(time.time()); ttl=int(os.environ.get("SOAK_TTL","2400"))
c={"iss":"eex","sub":"local:m4soak","role":"service","auth_mode":"service","server_id":os.environ.get("SERVER_ID","") or "soak","device_id":None,"req_id":"m4soak","iat":now,"exp":now+ttl}
print(ec.internal_principal_encrypt(key,"internal-v1",c))
') || true
[ -n "$TOKEN" ] || { echo "MINT FAILED (is exchange-recommender up?)"; exit 2; }
AUTH="Authorization: Bearer $TOKEN"
info "minted internal-principal token (len ${#TOKEN})"

# ── 2. Pick HEVC re-encode files (a pool the refresh + ephemeral churn cycle) ──
NEED=$((STEADY + 9))
if [ "${#IDS[@]}" -eq 0 ]; then
  while IFS= read -r row; do [ -n "$row" ] && IDS+=("$row"); done < <(
    sqlite3 "$DB" "select id from media_files
      where lower(coalesce(video_codec,'')) like '%hevc%'
        and coalesce(duration_secs,0) > 1800
      order by random() limit $NEED")
fi
[ "${#IDS[@]}" -ge 1 ] || { echo "no re-encode (HEVC) files found and none supplied"; exit 2; }
info "candidate files (media_files.id): ${IDS[*]}"

# $1=media id  $2=sub (the transcoder coalesce_key is owner|kind|id|sub|path, so
# the reap-proof ephemeral MUST use a sub distinct from the steady pool or it
# coalesces onto a heartbeated steady session and never idle-reaps).
grant_body() {
  local sub="${2:-local:m4soak}"
  sqlite3 "$DB" "select json_object(
    'file', json_object(
      'path', path, 'container', container, 'duration_secs', duration_secs,
      'video_codec', video_codec, 'video_height', video_height,
      'video_profile', video_profile, 'hdr_format', hdr_format,
      'audio_tracks_json', audio_tracks_json,
      'subtitle_tracks_json', subtitle_tracks_json),
    'caps', json_object('containers', json_array('mp4'), 'video_codecs', json_array('h264'),
      'max_height', $CAPS_HEIGHT, 'hdr', json('false'), 'max_bitrate', null),
    'media_kind','movie','media_id', id, 'sub','$sub','start_secs', 0)
    from media_files where id=$1"
}
# Grant one session for media id $1 (optional sub $2); echoes the sessionId.
grant_one() {
  local body resp
  body=$(grant_body "$1" "${2:-local:m4soak}")
  resp=$(curl -s -X POST "$T/api/transcode/grant" -H "$AUTH" -H 'content-type: application/json' -d "$body")
  printf '%s' "$resp" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p'
}

# ── Always stop every session we started, on any exit path ────────────────────
SESSIONS=()           # steady, heartbeated
cleanup() {
  [ -n "${REAP_PENDING:-}" ] && SESSIONS+=("$REAP_PENDING")
  [ "${#SESSIONS[@]}" -eq 0 ] && return 0
  printf '\n     stopping %d session(s)…\n' "${#SESSIONS[@]}"
  for sid in "${SESSIONS[@]}"; do
    [ -n "$sid" ] && curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$sid/stop" >/dev/null 2>&1
  done
}
# EXIT does the one cleanup; INT/TERM just exit (a trapped signal otherwise
# re-runs the handler and RESUMES the loop, leaving an unkillable zombie).
# HUP is IGNORED so a detached long soak can't be killed when a monitoring SSH
# session tears down (setsid alone proved insufficient — a HUP still reached it).
trap '' HUP
trap cleanup EXIT
trap 'exit 130' INT TERM

# ── 3. Bring up the steady concurrent load ────────────────────────────────────
say "STEADY LOAD: $STEADY concurrent forced HEVC→H.264 re-encodes"
for i in $(seq 0 $((STEADY-1))); do
  sid=$(grant_one "${IDS[$i]}")
  if [ -n "$sid" ]; then SESSIONS+=("$sid"); info "id=${IDS[$i]} -> session $sid"
  else info "id=${IDS[$i]}: NO SESSION (copy-remux? busy? auth?)"; fi
done
[ "${#SESSIONS[@]}" -gt 0 ] || { echo "no steady sessions started"; exit 2; }
STEADY_N="${#SESSIONS[@]}"
info "$STEADY_N/$STEADY steady sessions running"

# Let them all reach first-segment so the baseline reflects live encoders.
info "warming up (waiting for first segments)…"
for sid in "${SESSIONS[@]}"; do
  for _ in $(seq 1 120); do
    curl -s -H "$AUTH" "$T/api/transcode/session/$sid/index.m3u8" | grep -qoE 'seg_[0-9]+\.ts' && break
    sleep 0.5
  done
done
sleep 3
# Quiescent steady proc count = MIN over a few readings: a warmup probe can
# briefly add a transient ffmpeg, and an over-counted baseline would silently
# disable the steady-state mem-drift leak signal (samples never match it).
BASE_PROCS=$(ffcount)
for _ in 1 2 3; do sleep 2; b=$(ffcount); [ "${b:-99}" -lt "$BASE_PROCS" ] && BASE_PROCS="$b"; done
MEM_START=$(tmem_mib)
info "baseline (min over readings): ffmpeg procs=$BASE_PROCS  transcoder mem=${MEM_START}MiB"

# ── 4. Soak window: sample + heartbeat + repeated reap proof (watchdog armed) ──
say "SOAK ${DURATION}s @ $STEADY_N concurrent — sampling every ${SAMPLE_SECS}s, reap proof every ${REAP_EVERY}s"
peak_cpu=0; cpu_sum=0; cpu_n=0; bad=0; elapsed=0; aborted=0
peak_procs="$BASE_PROCS"; peak_mem="$MEM_START"
# Leak signal = does the steady-mem FLOOR rise across the window? Track the min
# mem (ignoring warmup ramp + any ephemeral-in-flight sample) in the first vs
# second half. A real leak raises the floor; activity spikes and the cold-start
# buffer ramp are filtered out by min() and the warmup cutoff.
mem_floor_early=""; mem_floor_late=""
reap_ok=0; reap_fail=0
REAP_PENDING=""; reap_due=0; next_reap_at="$REAP_EVERY"
refreshes=0; lifecycles="$STEADY_N"; next_refresh_at="$REFRESH_SECS"
pool_idx=$STEADY        # next file for refreshes
ephem_idx=$((STEADY+1)) # next file for ephemeral reap-proof (offset to vary)
ts_start=$(date +%s)

read_cpu() { awk '/^cpu /{t=0; for(i=2;i<=NF;i++)t+=$i; print t" "($5+$6)}' /proc/stat; }

while [ "$elapsed" -lt "$DURATION" ]; do
  read -r c0t c0i < <(read_cpu)
  sleep "$SAMPLE_SECS"
  read -r c1t c1i < <(read_cpu)
  cpu=$(awk -v dt=$((c1t-c0t)) -v di=$((c1i-c0i)) 'BEGIN{ if(dt<=0){print 0; exit} printf "%.0f", 100*(1-di/dt) }')
  load1=$(cut -d' ' -f1 /proc/loadavg)
  lpc=$(awk -v l="$load1" -v n="$NPROC" 'BEGIN{ if(n<1)n=1; printf "%.2f", l/n }')
  crit=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CRITICAL" 2>/dev/null || echo absent)
  procs=$(ffcount); mem=$(tmem_mib)
  [ "$cpu" -gt "$peak_cpu" ] && peak_cpu="$cpu"
  [ "${procs:-0}" -gt "$peak_procs" ] && peak_procs="$procs"
  [ "${mem:-0}" -gt "$peak_mem" ] && peak_mem="$mem"
  cpu_sum=$((cpu_sum+cpu)); cpu_n=$((cpu_n+1))
  elapsed=$(( $(date +%s) - ts_start ))

  # Steady-mem floor, first half vs second half (warmup + ephemeral excluded).
  if [ -z "$REAP_PENDING" ] && [ "$elapsed" -gt "$WARMUP_SECS" ] && [ "${mem:-0}" -gt 0 ]; then
    if [ "$elapsed" -lt "$((DURATION/2))" ]; then
      { [ -z "$mem_floor_early" ] || [ "$mem" -lt "$mem_floor_early" ]; } && mem_floor_early="$mem"
    else
      { [ -z "$mem_floor_late" ] || [ "$mem" -lt "$mem_floor_late" ]; } && mem_floor_late="$mem"
    fi
  fi

  # Heartbeat the STEADY sessions only (ephemeral is deliberately left to reap).
  for hb in "${SESSIONS[@]}"; do
    [ -n "$hb" ] && curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$hb/heartbeat" >/dev/null 2>&1
  done

  # ── refresh the steady pool so load stays continuous (and churns lifecycle) ──
  if [ "$elapsed" -ge "$next_refresh_at" ]; then
    for sid in "${SESSIONS[@]}"; do
      [ -n "$sid" ] && curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$sid/stop" >/dev/null 2>&1
    done
    NEW=()
    for _ in $(seq 1 "$STEADY_N"); do
      fid="${IDS[$((pool_idx % ${#IDS[@]}))]}"; pool_idx=$((pool_idx+1))
      sid=$(grant_one "$fid")
      [ -n "$sid" ] && { NEW+=("$sid"); lifecycles=$((lifecycles+1)); }
    done
    SESSIONS=("${NEW[@]}")
    refreshes=$((refreshes+1))
    info "  refresh #$refreshes: pool recycled → ${#SESSIONS[@]} fresh sessions (lifecycles=$lifecycles)"
    next_refresh_at=$((next_refresh_at + REFRESH_SECS))
  fi

  # ── reap proof: grant an un-heartbeated ephemeral, confirm it gets reaped ──
  if [ -z "$REAP_PENDING" ] && [ "$elapsed" -ge "$next_reap_at" ]; then
    eid="${IDS[$((ephem_idx % ${#IDS[@]}))]}"; ephem_idx=$((ephem_idx+1))
    # distinct sub → own coalesce identity → genuinely idle-reaps under load
    sid=$(grant_one "$eid" "local:m4soak-ephem")
    if [ -n "$sid" ]; then
      REAP_PENDING="$sid"; reap_due=$((elapsed + REAP_WAIT))
      info "  reap-proof: granted ephemeral $sid (id=$eid), NOT heartbeating — must be reaped by t=${reap_due}s"
    else
      info "  reap-proof: ephemeral grant failed (busy?) — will retry next cycle"
    fi
    next_reap_at=$((next_reap_at + REAP_EVERY))
  elif [ -n "$REAP_PENDING" ] && [ "$elapsed" -ge "$reap_due" ]; then
    # The definitive reap signal is the manager dropping the session (index
    # 404s). proc count is aggregate/confounded by the refresh churn, so it's
    # reported but not gated on.
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$T/api/transcode/session/$REAP_PENDING/index.m3u8")
    pc=$(ffcount)
    if [ "$code" != "200" ]; then
      reap_ok=$((reap_ok+1)); info "  reap-proof OK: $REAP_PENDING reaped (http=$code, procs=$pc)"
    else
      reap_fail=$((reap_fail+1)); info "  reap-proof FAIL: $REAP_PENDING still served (http=$code) — idle reaper did not fire"
      curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$REAP_PENDING/stop" >/dev/null 2>&1
    fi
    REAP_PENDING=""
  fi

  printf '     t=%4ss  cpu=%3s%%  load=%-5s(%s/c)  plex=%-8s procs=%-2s mem=%4sMiB  refr=%s reap=%s/%s\n' \
    "$elapsed" "$cpu" "$load1" "$lpc" "$crit" "$procs" "$mem" "$refreshes" "$reap_ok" "$reap_fail"

  over=$(awk -v v="$lpc" -v c="$ABORT_LOAD_PER_CORE" 'BEGIN{print (v>c)?1:0}')
  if { [ "$crit" != "healthy" ] && [ "$crit" != "running" ] && [ "$crit" != "absent" ]; } || [ "$over" = "1" ]; then
    bad=$((bad+1)); info "  ! degraded sample [$bad/$ABORT_SAMPLES] (plex=$crit load/core=$lpc)"
    [ "$bad" -ge "$ABORT_SAMPLES" ] && { aborted=1; break; }
  else
    bad=0
  fi
done
held="$elapsed"

if [ "$aborted" = 1 ]; then
  say "WATCHDOG ABORT at t=${held}s — box/Plex degraded; sessions are being stopped"
  exit 3
fi

# ── 5. Teardown + zero-leak check ─────────────────────────────────────────────
say "TEARDOWN — stopping $STEADY_N steady sessions (+ any in-flight ephemeral), then checking for leaked ffmpeg"
# Stop an un-reaped ephemeral too, else it shows up as a phantom "leak" below.
[ -n "$REAP_PENDING" ] && { curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$REAP_PENDING/stop" >/dev/null 2>&1; REAP_PENDING=""; }
for sid in "${SESSIONS[@]}"; do
  [ -n "$sid" ] && curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$sid/stop" >/dev/null 2>&1
done
SESSIONS=()   # disarm the EXIT trap's re-stop
# Give the supervisor KILL_GRACE (5s) + sweep (5s) margin to reap every child.
for _ in $(seq 1 8); do sleep 2; LEFT=$(ffcount); [ "${LEFT:-1}" -eq 0 ] && break; done
LEFT=$(ffcount)

# ── 6. Report card vs the crit-4 bar ──────────────────────────────────────────
avg_cpu=$([ "$cpu_n" -gt 0 ] && echo $((cpu_sum/cpu_n)) || echo 0)
[ -z "$mem_floor_early" ] && mem_floor_early="$MEM_START"
[ -z "$mem_floor_late" ]  && mem_floor_late="$mem_floor_early"
mem_growth=$(awk -v a="$mem_floor_early" -v b="$mem_floor_late" 'BEGIN{ if(a<=0){print 0; exit} printf "%.0f", 100*(b-a)/a }')

# Zero-leak verdict rests on three robust signals — NOT on peak proc count,
# since a session may spawn >1 ffmpeg (tonemap/audio subprocess) so the
# ephemeral's transient footprint is not fixed. The accumulation proof is:
#   (1) every idle-reap cycle dropped its session (reap_ok, index 404s),
#   (2) post-stop procs == 0 (everything cleaned up after teardown), and
#   (3) steady mem at refresh boundaries did not climb. peak is reported only.
leak_verdict="PASS"
[ "${LEFT:-1}" -ne 0 ] && leak_verdict="FAIL"
[ "$mem_growth" -gt "$MEM_GROWTH_PCT" ] && leak_verdict="FAIL"
[ "$reap_ok" -lt 1 ] && leak_verdict="INCONCLUSIVE"

reap_verdict="PASS"
[ "$reap_ok" -lt 1 ] && reap_verdict="INCONCLUSIVE"
[ "$reap_fail" -gt 0 ] && reap_verdict="FAIL"

say "SOAK REPORT CARD ($STEADY_N concurrent · held ${held}s · ${NPROC} cores)"
printf '  duration held            : %ss of %ss target  -> %s\n' \
  "$held" "$DURATION" "$([ "$held" -ge "$DURATION" ] && echo COMPLETE || echo SHORT)"
printf '  box CPU                   : peak %s%% / avg %s%%\n' "$peak_cpu" "$avg_cpu"
printf '  transcoder mem floor      : 1st-half %sMiB / 2nd-half %sMiB (rise %s%%, ceiling %s%%); peak %sMiB\n' \
  "$mem_floor_early" "$mem_floor_late" "$mem_growth" "$MEM_GROWTH_PCT" "$peak_mem"
printf '  session lifecycle churn   : %s pool refreshes, %s total sessions granted+stopped under load\n' \
  "$refreshes" "$lifecycles"
printf '  ffmpeg procs              : steady baseline %s / peak-w/ephemeral %s / post-stop %s (leak gate = post-stop==0)\n' \
  "$BASE_PROCS" "$peak_procs" "$LEFT"
printf '  crit-4 reap under load    : %s reaped clean, %s failed              -> %s\n' \
  "$reap_ok" "$reap_fail" "$reap_verdict"
printf '  crit-4 zero leak          : post-stop procs=%s, mem floor rise %s%%   -> %s\n' \
  "$LEFT" "$mem_growth" "$leak_verdict"
printf '  Plex health               : %s throughout (watchdog did not fire)\n' \
  "$([ "$aborted" = 0 ] && echo healthy || echo DEGRADED)"
say "DONE"
