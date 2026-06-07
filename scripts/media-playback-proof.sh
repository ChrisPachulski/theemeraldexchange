#!/bin/bash
# Local-media web-playback proof. Runs ON the NAS. Drives the DEPLOYED backend
# playback chain end-to-end for a TRANSCODE-required library title:
#
#   media-core /stream handoff  ->  transcoder HLS session
#     ->  backend /api/transcode proxy  (stream-token auth + manifest rewrite)
#       ->  HLS manifest with ?t=-bearing segment lines  ->  segment bytes
#
# Also asserts the auth gate (no token -> 401). media-core is reached on its
# host-published port; the backend is netns-only (127.0.0.1:3001 inside its own
# namespace) so the proxy is exercised via `node fetch` from inside the backend
# container, which is also how it mints the media stream token (napi binding).
#
#   $1 = movie id (media-core movies.id)
set -uo pipefail
ID="${1:?usage: media-playback-proof.sh <movie_id>}"
MC="http://127.0.0.1:8002"
SUB="plex:494190801"

say() { printf '\n==== %s ====\n' "$*"; }

# 1. Internal principal — minted inside the recommender (pyo3 binding); the
#    INTERNAL_PRINCIPAL_SECRET never leaves the container.
PRIN=$(docker exec exchange-recommender python3 -c "
import emerald_contracts as ec, time, os
key=bytes(ec.hkdf_internal_principal(os.environ['INTERNAL_PRINCIPAL_SECRET'].encode()))
now=int(time.time())
c={'iss':'eex','sub':'$SUB','role':'user','auth_mode':'plex','server_id':'proof','device_id':None,'req_id':'mpproof','iat':now,'exp':now+900}
print(ec.internal_principal_encrypt(key,'internal-v1',c))
")
[ -n "$PRIN" ] || { echo "MINT principal FAILED"; exit 1; }

# 2. Start a transcode session through media-core's real /stream handoff.
say "MEDIA-CORE HANDOFF (start transcode session)"
HANDOFF=$(curl -s -H "Authorization: Bearer $PRIN" \
  "$MC/api/media/stream/movie/$ID?containers=mp4&video_codecs=h264&max_height=1080&hdr=false")
echo "$HANDOFF"
SID=$(printf '%s' "$HANDOFF" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
[ -n "$SID" ] || { echo "no sessionId (file direct-played? media-core down?)"; exit 1; }
echo "sessionId=$SID"

# 3. Mint a media remux stream token bound to that session — inside the backend
#    (napi binding); STREAM_TOKEN_SECRET stays in the container.
TOK=$(docker exec -e SID="$SID" exchange-backend node -e '
const c=require("@emerald/contracts-napi");
const s=Buffer.from(process.env.STREAM_TOKEN_SECRET,"utf-8");
const n=Math.floor(Date.now()/1000);
console.log(c.streamTokenSign(s,{exp:n+3600,iat:n,jti:"01ARZ3NDEKTSV4RRFFQ69G5FAV",k:"remux",nbf:n,rid:"media:session:"+process.env.SID,sub:"plex:494190801",v:1}));
')
[ -n "$TOK" ] || { echo "MINT media token FAILED"; exit 1; }
echo "minted media remux token (len ${#TOK})"

# 4. Drive the backend /api/transcode proxy from inside the backend container.
say "BACKEND /api/transcode PROXY (token auth + manifest rewrite + segment bytes)"
docker exec -e SID="$SID" -e TOK="$TOK" exchange-backend node -e '
const sid=process.env.SID, tok=process.env.TOK;
const base=`http://127.0.0.1:3001/api/transcode/session/${sid}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  // Poll the proxied manifest until a segment appears (TTFS a few seconds).
  let body="", seg=null;
  for(let i=0;i<30;i++){
    const m=await fetch(`${base}/index.m3u8?t=${tok}`);
    if(i===0) console.log("manifest status:", m.status, "ct:", m.headers.get("content-type"));
    body=await m.text();
    const mt=body.match(/seg_\d+\.ts\?t=[^\s"]*/);
    if(mt){ seg=mt[0]; break; }
    await sleep(500);
  }
  console.log("--- manifest (head) ---");
  console.log(body.split("\n").slice(0,12).join("\n"));
  if(!seg){ console.log("NO rewritten segment line found — FAIL"); process.exit(1); }
  console.log("rewritten segment line:", seg, "(token preserved on segment URL ✓)");

  const r=await fetch(`${base}/${seg}`);
  const bytes=(await r.arrayBuffer()).byteLength;
  console.log("segment status:", r.status, "ct:", r.headers.get("content-type"), "bytes:", bytes);
  if(r.status!==200 || bytes<1000){ console.log("segment fetch FAIL"); process.exit(1); }

  // Negative: the same path without a token must be rejected (auth gate live).
  const n0=await fetch(`${base}/index.m3u8`);
  console.log("no-token manifest status (expect 401):", n0.status);
  if(n0.status!==401){ console.log("AUTH GATE FAIL — unauthenticated request was not rejected"); process.exit(1); }

  console.log("\nPROXY CHAIN OK ✓");
})().catch(e=>{ console.error(e); process.exit(1); });
'
rc=$?

# 5. Clean up the proof session.
docker exec -e SID="$SID" -e TOK="$TOK" exchange-backend node -e '
fetch(`http://127.0.0.1:3001/api/transcode/session/${process.env.SID}/stop?t=${process.env.TOK}`,{method:"POST"}).then(r=>console.log("stop:",r.status)).catch(()=>{});
' 2>/dev/null || true

exit $rc
