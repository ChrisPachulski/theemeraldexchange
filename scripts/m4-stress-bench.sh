#!/bin/bash
# M4 transcoder stress/bench harness. Runs ON the NAS.
#
# WHAT IT MEASURES (the open M4 criteria, finally on real hardware):
#   crit-2  real-time sustain — under N concurrent sessions, does each ffmpeg
#           keep producing segments at >= playback rate (it must not fall behind)?
#   crit-3  concurrency cost — do N concurrent re-encodes stay under the box CPU
#           ceiling (the spec's "4 concurrent under 80% CPU")? VAAPI offloads the
#           encode to the iGPU, so this is the number that proves the headroom.
#   crit-6  seek latency — re-measure post-seek time-to-first-segment against the
#           "<2s" target (the old ~23-27s figure predates VAAPI + 2s segments).
#   plus    cold concurrent startup TTFS per session.
#
# WHY IT'S SAFE (the NAS also runs Plex on a weak 6-thread CPU):
#   The dangerous thing on this box is COMPILING, not running transcodes — VAAPI
#   sessions live on the iGPU and 3 concurrent were already proven clean. This
#   harness still carries a watchdog: every SAMPLE_SECS it checks Plex health and
#   box load/core, and the instant either degrades for ABORT_SAMPLES samples it
#   STOPS EVERY SESSION and bails. An EXIT trap also stops every session on any
#   error or Ctrl-C, so a `-re` session can never leak and run a full title.
#
# Usage:
#   scripts/m4-stress-bench.sh [concurrency=4] [duration_secs=60] [media_id ...]
#   # auto-picks N HEVC (re-encode) files when no ids are given.
#
# Env knobs (optional):
#   CRITICAL (Plex-Media-Server)   container whose health gates the run
#   ABORT_LOAD_PER_CORE (4.0)      abort if 1-min load/core exceeds this
#   ABORT_SAMPLES (3)              consecutive bad samples before abort
#   SAMPLE_SECS (3)                CPU/health sampling cadence
#   CPU_CEILING_PCT (80)           crit-3 pass threshold for peak box CPU
#   CAPS_HEIGHT (1080)             max_height in the forced re-encode caps
#
# Exit: 0 ran + reported · 2 setup error · 3 watchdog abort
set -uo pipefail

N="${1:-4}"
DURATION="${2:-60}"
# Drop the two positional args (if present) so "$@" leaves only explicit ids.
[ "$#" -ge 1 ] && shift
[ "$#" -ge 1 ] && shift
IDS=("$@")

DB="file:/mnt/user/appdata/exchange-backend/media-core-db/media.db?immutable=1"
T="http://127.0.0.1:8003"
CRITICAL="${CRITICAL:-Plex-Media-Server}"
ABORT_LOAD_PER_CORE="${ABORT_LOAD_PER_CORE:-4.0}"
ABORT_SAMPLES="${ABORT_SAMPLES:-3}"
SAMPLE_SECS="${SAMPLE_SECS:-3}"
CPU_CEILING_PCT="${CPU_CEILING_PCT:-80}"
CAPS_HEIGHT="${CAPS_HEIGHT:-1080}"
NPROC="$(nproc 2>/dev/null || echo 6)"

say() { printf '\n==== %s ====\n' "$*"; }
info() { printf '     %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || { echo "docker not found — run this ON the NAS"; exit 2; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not found — run this ON the NAS"; exit 2; }

# ── 1. Mint one internal-principal token (secret never leaves the container) ──
TOKEN=$(docker exec exchange-recommender python3 -c '
import emerald_contracts as ec, time, os
key=bytes(ec.hkdf_internal_principal(os.environ["INTERNAL_PRINCIPAL_SECRET"].encode()))
now=int(time.time())
c={"iss":"eex","sub":"local:m4stress","role":"service","auth_mode":"service","server_id":os.environ.get("SERVER_ID","") or "stress","device_id":None,"req_id":"m4stress","iat":now,"exp":now+3600}
print(ec.internal_principal_encrypt(key,"internal-v1",c))
') || true
[ -n "$TOKEN" ] || { echo "MINT FAILED (is exchange-recommender up?)"; exit 2; }
AUTH="Authorization: Bearer $TOKEN"
info "minted internal-principal token (len ${#TOKEN})"

# ── 2. Pick N real RE-ENCODE files (HEVC) if ids were not given ───────────────
if [ "${#IDS[@]}" -eq 0 ]; then
  while IFS= read -r row; do [ -n "$row" ] && IDS+=("$row"); done < <(
    sqlite3 "$DB" "select id from media_files
      where lower(coalesce(video_codec,'')) like '%hevc%'
        and coalesce(duration_secs,0) > 600
      order by random() limit $N")
fi
[ "${#IDS[@]}" -gt 0 ] || { echo "no re-encode (HEVC) files found and none supplied"; exit 2; }
info "files under test (media_files.id): ${IDS[*]}"

# Forced-re-encode caps: h264/mp4/SDR @ CAPS_HEIGHT guarantees HEVC -> H.264 work
# (a copy-remux would not stress the encoder, defeating the bench).
grant_body() {
  sqlite3 "$DB" "select json_object(
    'file', json_object(
      'path', path, 'container', container, 'duration_secs', duration_secs,
      'video_codec', video_codec, 'video_height', video_height,
      'video_profile', video_profile, 'hdr_format', hdr_format,
      'audio_tracks_json', audio_tracks_json,
      'subtitle_tracks_json', subtitle_tracks_json),
    'caps', json_object('containers', json_array('mp4'), 'video_codecs', json_array('h264'),
      'max_height', $CAPS_HEIGHT, 'hdr', json('false'), 'max_bitrate', null),
    'media_kind','movie','media_id', id, 'sub','local:m4stress','start_secs', 0)
    from media_files where id=$1"
}

# ── Always stop every session we started, on any exit path ───────────────────
SESSIONS=()
cleanup() {
  [ "${#SESSIONS[@]}" -eq 0 ] && return 0
  printf '\n     stopping %d session(s)…\n' "${#SESSIONS[@]}"
  for sid in "${SESSIONS[@]}"; do
    [ -n "$sid" ] && curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$sid/stop" >/dev/null 2>&1
  done
}
trap cleanup EXIT INT TERM

# ── 3. Grant all N sessions back-to-back (the concurrent load) ────────────────
say "GRANT $N CONCURRENT RE-ENCODE SESSIONS"
declare -a GRANT_T0=()
for i in "${!IDS[@]}"; do
  [ "$i" -ge "$N" ] && break
  BODY=$(grant_body "${IDS[$i]}")
  GRANT_T0[$i]=$(date +%s.%N)
  RESP=$(curl -s -X POST "$T/api/transcode/grant" -H "$AUTH" -H 'content-type: application/json' -d "$BODY")
  SID=$(printf '%s' "$RESP" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
  if [ -z "$SID" ]; then
    info "id=${IDS[$i]}: NO SESSION (copy-remux? busy? auth?) resp=$RESP"
    SESSIONS[$i]=""
  else
    SESSIONS[$i]="$SID"
    info "id=${IDS[$i]} -> session $SID"
  fi
done
started=0; for s in "${SESSIONS[@]}"; do [ -n "$s" ] && started=$((started+1)); done
[ "$started" -gt 0 ] || { echo "no sessions started"; exit 2; }
info "$started/$N sessions started concurrently"

# ── 4. Cold concurrent startup: time-to-first-segment per session ─────────────
say "COLD STARTUP — time to first segment (concurrent)"
declare -a TTFS=() MAXSEG0=()
seg_secs=2
for idx in "${!SESSIONS[@]}"; do
  sid="${SESSIONS[$idx]}"; [ -z "$sid" ] && { TTFS[$idx]=""; continue; }
  ready=0
  for _ in $(seq 1 240); do
    M=$(curl -s -H "$AUTH" "$T/api/transcode/session/$sid/index.m3u8")
    if printf '%s' "$M" | grep -qoE 'seg_[0-9]+\.ts'; then
      t1=$(date +%s.%N)
      TTFS[$idx]=$(awk "BEGIN{printf \"%.2f\", $t1-${GRANT_T0[$idx]}}")
      td=$(printf '%s' "$M" | sed -n 's/#EXT-X-TARGETDURATION:\([0-9]*\).*/\1/p' | head -1)
      [ -n "$td" ] && [ "$td" -gt 0 ] && seg_secs="$td"
      MAXSEG0[$idx]=$(printf '%s' "$M" | grep -oE 'seg_[0-9]+' | sed 's/seg_//' | sort -n | tail -1)
      ready=1; break
    fi
    sleep 0.5
  done
  if [ "$ready" = 1 ]; then
    info "session $sid: first segment after ${TTFS[$idx]}s"
  else
    TTFS[$idx]="TIMEOUT"; info "session $sid: NO segment (timeout)"
  fi
done

# ── 5. Sustained window: sample box CPU + Plex health (watchdog armed) ─────────
say "SUSTAINED LOAD ${DURATION}s @ ${started} concurrent — box CPU / load / Plex"
read_cpu() { # echoes "total idle" jiffies from /proc/stat
  awk '/^cpu /{t=0; for(i=2;i<=NF;i++)t+=$i; print t" "($5+$6)}' /proc/stat
}
peak_cpu=0; cpu_sum=0; cpu_n=0; bad=0; elapsed=0; aborted=0
ts_start=$(date +%s)
while [ "$elapsed" -lt "$DURATION" ]; do
  read -r c0t c0i < <(read_cpu)
  sleep "$SAMPLE_SECS"
  read -r c1t c1i < <(read_cpu)
  cpu=$(awk -v dt=$((c1t-c0t)) -v di=$((c1i-c0i)) 'BEGIN{ if(dt<=0){print 0; exit} printf "%.0f", 100*(1-di/dt) }')
  load1=$(cut -d' ' -f1 /proc/loadavg)
  lpc=$(awk -v l="$load1" -v n="$NPROC" 'BEGIN{ if(n<1)n=1; printf "%.2f", l/n }')
  crit=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CRITICAL" 2>/dev/null || echo absent)
  [ "$cpu" -gt "$peak_cpu" ] && peak_cpu="$cpu"
  cpu_sum=$((cpu_sum+cpu)); cpu_n=$((cpu_n+1))
  elapsed=$(( $(date +%s) - ts_start ))
  printf '     t=%3ss  cpu=%3s%%  load=%-5s (%s/core)  plex=%s\n' "$elapsed" "$cpu" "$load1" "$lpc" "$crit"

  over=$(awk -v v="$lpc" -v c="$ABORT_LOAD_PER_CORE" 'BEGIN{print (v>c)?1:0}')
  if { [ "$crit" != "healthy" ] && [ "$crit" != "running" ] && [ "$crit" != "absent" ]; } || [ "$over" = "1" ]; then
    bad=$((bad+1)); info "  ! degraded sample [$bad/$ABORT_SAMPLES] (plex=$crit load/core=$lpc)"
    if [ "$bad" -ge "$ABORT_SAMPLES" ]; then aborted=1; break; fi
  else
    bad=0
  fi
done

# Per-container CPU snapshot at the end of the window (informational).
tstat=$(docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}}' exchange-transcoder 2>/dev/null || echo 'n/a')

if [ "$aborted" = 1 ]; then
  say "WATCHDOG ABORT — box/Plex degraded; sessions are being stopped"
  exit 3
fi

# ── 6. Real-time sustain per session (max segment index advanced over window) ─
say "REAL-TIME SUSTAIN (crit-2)"
expected=$(awk -v d="$DURATION" -v s="$seg_secs" 'BEGIN{ if(s<1)s=1; printf "%.1f", d/s }')
min_ratio=""
for idx in "${!SESSIONS[@]}"; do
  sid="${SESSIONS[$idx]}"; [ -z "$sid" ] && continue
  M=$(curl -s -H "$AUTH" "$T/api/transcode/session/$sid/index.m3u8")
  maxnow=$(printf '%s' "$M" | grep -oE 'seg_[0-9]+' | sed 's/seg_//' | sort -n | tail -1)
  s0="${MAXSEG0[$idx]:-0}"; [ -z "$maxnow" ] && maxnow="$s0"
  produced=$(( 10#${maxnow:-0} - 10#${s0:-0} ))
  ratio=$(awk -v p="$produced" -v e="$expected" 'BEGIN{ if(e<=0){print "0.00";exit} printf "%.2f", p/e }')
  info "session $sid: +${produced} segs in ${DURATION}s (expected ~${expected}); realtime ratio=${ratio}x"
  if [ -z "$min_ratio" ] || awk -v a="$ratio" -v b="$min_ratio" 'BEGIN{exit !(a<b)}'; then min_ratio="$ratio"; fi
done

# ── 7. Seek latency (crit-6) on the first live session ────────────────────────
say "SEEK LATENCY (crit-6) — seek to +1800s, re-measure first segment"
seek_ttfs="n/a"
for idx in "${!SESSIONS[@]}"; do
  sid="${SESSIONS[$idx]}"; [ -z "$sid" ] && continue
  curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$sid/seek?to=1800" >/dev/null
  s0=$(date +%s.%N)
  for _ in $(seq 1 120); do
    M=$(curl -s -H "$AUTH" "$T/api/transcode/session/$sid/index.m3u8")
    SS=$(printf '%s' "$M" | grep -oE 'seg_[0-9]+\.ts' | head -1)
    if [ -n "$SS" ] && curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$T/api/transcode/session/$sid/$SS" | grep -q 200; then
      seek_ttfs=$(awk "BEGIN{printf \"%.2f\", $(date +%s.%N)-$s0}"); break
    fi
    sleep 0.5
  done
  info "session $sid: post-seek first segment after ${seek_ttfs}s"
  break
done

# ── 8. Report card vs the M4 thresholds ───────────────────────────────────────
avg_cpu=$([ "$cpu_n" -gt 0 ] && echo $((cpu_sum/cpu_n)) || echo 0)
max_ttfs=$(printf '%s\n' "${TTFS[@]}" | grep -vi timeout | sort -t. -k1,1n -k2,2n | tail -1)
verdict() { awk -v a="$1" -v op="$2" -v b="$3" 'BEGIN{ ok = (op=="<")?(a<b):(a>b); print ok?"PASS":"FAIL" }'; }

say "REPORT CARD ($started concurrent · ${DURATION}s · ${NPROC} cores · seg=${seg_secs}s)"
printf '  crit-3  concurrency cost : peak box CPU %s%% / avg %s%% (ceiling %s%%)  -> %s\n' \
  "$peak_cpu" "$avg_cpu" "$CPU_CEILING_PCT" "$(verdict "$peak_cpu" '<' "$CPU_CEILING_PCT")"
printf '          transcoder ctr   : %s\n' "$tstat"
printf '  crit-2  realtime sustain : min ratio %sx across sessions (target >=0.90x) -> %s\n' \
  "${min_ratio:-n/a}" "$([ -n "${min_ratio:-}" ] && verdict "$min_ratio" '>' 0.89 || echo n/a)"
printf '  crit-6  seek latency     : %ss post-seek TTFS (target <2.0s)            -> %s\n' \
  "$seek_ttfs" "$([ "$seek_ttfs" != n/a ] && verdict "$seek_ttfs" '<' 2.0 || echo n/a)"
printf '  startup TTFS (concurrent): max %ss across sessions\n' "${max_ttfs:-n/a}"
say "DONE"
