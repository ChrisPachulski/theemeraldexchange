#!/bin/bash
# M4 real-library transcode proof. Runs ON the NAS.
# Drives the DEPLOYED transcoder against a REAL non-direct-play library file
# through the authenticated (enforce-mode) HTTP surface, captures evidence.
#   $1 = media_files.id to transcode
set -uo pipefail
ID="${1:?usage: m4-transcode-proof.sh <media_id>}"
DB="file:/mnt/user/appdata/exchange-backend/media-core-db/media.db?immutable=1"
T="http://127.0.0.1:8003"
AUTH=""

say() { printf '\n==== %s ====\n' "$*"; }

# 1) Real probe row -> EXACT grant body media-core would send (sqlite builds the JSON).
say "FILE UNDER TEST (real library row)"
sqlite3 "$DB" "select id||'  '||path||'  ['||video_codec||' '||video_height||'p '||coalesce(hdr_format,'SDR')||']' from media_files where id=$ID"
BODY=$(sqlite3 "$DB" "select json_object(
  'file', json_object(
    'path', path, 'container', container, 'duration_secs', duration_secs,
    'video_codec', video_codec, 'video_height', video_height,
    'video_profile', video_profile, 'hdr_format', hdr_format,
    'audio_tracks_json', audio_tracks_json,
    'subtitle_tracks_json', subtitle_tracks_json),
  'caps', json_object('containers', json_array('mp4'), 'video_codecs', json_array('h264'),
    'max_height', 1080, 'hdr', json('false'), 'max_bitrate', null),
  'media_kind','movie','media_id', id, 'sub','local:m4proof','start_secs', 0)
  from media_files where id=$ID")
[ -n "$BODY" ] || { echo "no such media_files row"; exit 1; }

# 2) Mint an internal-principal token INSIDE the recommender (secret never leaves the container).
TOKEN=$(docker exec exchange-recommender python3 -c '
import emerald_contracts as ec, time, os
key=bytes(ec.hkdf_internal_principal(os.environ["INTERNAL_PRINCIPAL_SECRET"].encode()))
now=int(time.time())
c={"iss":"eex","sub":"local:m4proof","role":"service","auth_mode":"service","server_id":os.environ.get("SERVER_ID","") or "proof","device_id":None,"req_id":"m4proof","iat":now,"exp":now+900}
print(ec.internal_principal_encrypt(key,"internal-v1",c))
')
[ -n "$TOKEN" ] || { echo "MINT FAILED"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"
echo "minted internal-principal token (len ${#TOKEN})"

# 3) Grant -> plan + start a real ffmpeg session.
say "GRANT (plan + session start)"
RESP=$(curl -s -X POST "$T/api/transcode/grant" -H "$AUTH" -H 'content-type: application/json' -d "$BODY")
echo "$RESP"
SID=$(printf '%s' "$RESP" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
[ -n "$SID" ] || { echo "no session started (not a transcode? busy? auth?)"; exit 1; }
echo "sessionId=$SID"

# 4) Time-to-first-segment: poll the manifest until it lists a .ts.
say "TIME TO FIRST SEGMENT"
t0=$(date +%s.%N)
SEG=""; ready=0
for i in $(seq 1 120); do
  M=$(curl -s -H "$AUTH" "$T/api/transcode/session/$SID/index.m3u8")
  SEG=$(printf '%s' "$M" | grep -oE 'seg_[0-9]+\.ts' | head -1)
  if [ -n "$SEG" ]; then ready=1; break; fi
  sleep 0.5
done
t1=$(date +%s.%N)
if [ "$ready" = 1 ]; then
  echo "first segment '$SEG' after $(awk "BEGIN{printf \"%.2f\", $t1-$t0}")s"
else
  echo "NO SEGMENT after timeout"; curl -s -H "$AUTH" "$T/api/transcode/session/$SID/index.m3u8"; docker logs --tail 40 exchange-transcoder; curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$SID/stop" >/dev/null; exit 1
fi

# 5) Resource cost while transcoding.
say "RESOURCE COST (docker stats, mid-transcode)"
docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}}' exchange-transcoder

# 6) Validate the OUTPUT is real, decodable, H.264, and SDR (proves HDR->SDR tonemap).
say "OUTPUT VALIDATION (ffprobe the served segment bytes)"
curl -s -H "$AUTH" "$T/api/transcode/session/$SID/$SEG" -o /tmp/m4seg.ts
echo "served segment size: $(stat -c%s /tmp/m4seg.ts 2>/dev/null || wc -c </tmp/m4seg.ts) bytes"
docker cp /tmp/m4seg.ts exchange-transcoder:/scratch/_probe.ts 2>/dev/null
docker exec exchange-transcoder ffprobe -v error -print_format json -show_streams -show_format /scratch/_probe.ts 2>&1 \
  | docker exec -i exchange-recommender python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d.get('streams',[]):
    t=s.get('codec_type')
    if t=='video':
        print(f\"  VIDEO codec={s.get('codec_name')} profile={s.get('profile')} {s.get('width')}x{s.get('height')} pix_fmt={s.get('pix_fmt')} primaries={s.get('color_primaries')} transfer={s.get('color_transfer')}\")
    elif t=='audio':
        print(f\"  AUDIO codec={s.get('codec_name')} ch={s.get('channels')} rate={s.get('sample_rate')}\")
print(f\"  CONTAINER format={d.get('format',{}).get('format_name')} dur={d.get('format',{}).get('duration')}\")
"
docker exec exchange-transcoder rm -f /scratch/_probe.ts 2>/dev/null

# 7) Seek latency: kill+respawn at +1800s, time to first segment again.
say "SEEK LATENCY (seek to 1800s, re-measure first segment)"
curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$SID/seek?to=1800" >/dev/null
s0=$(date +%s.%N); sok=0
for i in $(seq 1 120); do
  M=$(curl -s -H "$AUTH" "$T/api/transcode/session/$SID/index.m3u8")
  SS=$(printf '%s' "$M" | grep -oE 'seg_[0-9]+\.ts' | head -1)
  if [ -n "$SS" ]; then
    if curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$T/api/transcode/session/$SID/$SS" | grep -q 200; then sok=1; break; fi
  fi
  sleep 0.5
done
s1=$(date +%s.%N)
[ "$sok" = 1 ] && echo "post-seek first segment after $(awk "BEGIN{printf \"%.2f\", $s1-$s0}")s" || echo "post-seek: no segment after timeout"

# 8) Clean up.
say "STOP"
curl -s -X POST -H "$AUTH" "$T/api/transcode/session/$SID/stop"; echo
rm -f /tmp/m4seg.ts
say "DONE"
