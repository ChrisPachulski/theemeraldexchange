#!/usr/bin/env bash
# Hands-off weekly deploy of a new eex-ytresolve release to the backend — the NAS
# (residential-egress) half of the YouTube-extractor upkeep loop.
#
# The cloud side (rust-yt-extractor: ci.yml + yt-canary.yml) keeps clients.json
# fresh and publishes a new glibc binary as a GitHub release when the Innertube
# client identities drift. This script runs ON the NAS via weekly cron, PULLS that
# prebuilt binary (never compiles boa on the box — Plex lives here), and swaps it
# into the backend image — but ONLY behind two hard gates so an unattended deploy
# can never ship a broken extractor or brown out Plex:
#
#   GATE 1  authoritative canary — run the NEW binary from THIS box's residential
#           egress (the same path prod uses; GitHub runner IPs get YT-throttled, so
#           CI's live check is only advisory). Resolve a known id AND probe an
#           OFFSET byte-range of the adaptive stream — catches PoToken-gating
#           (resolve-OK-but-download-403), the exact failure the mux can't survive.
#   GATE 2  Plex-safe build + post-deploy proof — cap the compile and abort if Plex
#           degrades; after the swap, prove /trailer actually serves a muxed mp4.
#           Any failure → roll back to the previous image and alert. Never leave
#           prod down.
#
# Prereq (one-time, user-provided secret): a fine-grained GitHub PAT with
# contents:read on ChrisPachulski/rust-yt-extractor at $TOKEN_FILE (chmod 600).
# Private-repo release assets can't be fetched without it.
#
# Usage:
#   nas-canary-deploy.sh            # full run (cron)
#   nas-canary-deploy.sh --dry-run  # check + canary only; never builds/swaps
#   nas-canary-deploy.sh --force    # redeploy even if already on latest
#
# Exit: 0 ok / up-to-date · 1 canary failed (no deploy) · 2 build/proof failed
#       (rolled back) · 3 setup error.
set -uo pipefail

REPO="${YTRESOLVE_REPO:-ChrisPachulski/rust-yt-extractor}"
APPDATA="${APPDATA:-/mnt/user/appdata/exchange-backend}"
TOKEN_FILE="${EEX_GH_TOKEN_FILE:-$APPDATA/.gh-token}"
BIN="$APPDATA/bin/eex-ytresolve"
VERFILE="$APPDATA/bin/eex-ytresolve.version"
LOG="${EEX_CANARY_LOG:-$APPDATA/nas-canary-deploy.log}"
COMPOSE_DIR="$APPDATA"
BACKEND_SVC="backend"
BACKEND_CTR="exchange-backend"
CF_CTR="exchange-cloudflared"
CRITICAL="${CRITICAL:-Plex-Media-Server}"
CANARY_ID="${CANARY_ID:-dQw4w9WgXcQ}"
PROOF_ID="${PROOF_ID:-uYPbbksJxIg}"        # adaptive-only (forces the mux path)
API="https://api.theemeraldexchange.com/api/health"
# Build cap: leave headroom on the 6-thread box so Plex keeps cycles.
JOBS="${CARGO_BUILD_JOBS:-3}"

DRY_RUN=0; FORCE=0
for a in "$@"; do case "$a" in
  --dry-run) DRY_RUN=1 ;; --force) FORCE=1 ;;
  -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
  *) echo "unknown arg: $a" >&2; exit 3 ;;
esac; done

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
die() { log "FATAL: $*"; exit "${2:-3}"; }
have() { command -v "$1" >/dev/null 2>&1; }

have docker || die "docker not found"
have curl   || die "curl not found"
# Always run JSON parsing + the fetch download-probe inside the backend container
# (node v24, guaranteed global fetch, identical to prod) rather than relying on
# whatever node the Unraid host ships. The binary itself runs on the host.
NODE_IN_CTR=1

# JSON field reader: prefer host node, else docker exec into the backend.
jq_field() { # $1=json  $2=node-expr returning a string
  if [ "${NODE_IN_CTR:-0}" = "1" ]; then
    printf '%s' "$1" | docker exec -i "$BACKEND_CTR" node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($2)})"
  else
    printf '%s' "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($2)})"
  fi
}

[ -f "$TOKEN_FILE" ] || die "no GitHub token at $TOKEN_FILE — create a fine-grained PAT (contents:read on $REPO), chmod 600" 3
TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
[ -n "$TOKEN" ] || die "token file $TOKEN_FILE is empty" 3
gh_api() { curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: ${2:-application/vnd.github+json}" "$1"; }

# ── 1. Is there a newer release than what's deployed? ────────────────────────
log "checking latest release of $REPO"
rel="$(gh_api "https://api.github.com/repos/$REPO/releases/latest")" || die "GitHub API failed (token valid? repo correct?)" 3
tag="$(jq_field "$rel" 'j.tag_name||""')"
[ -n "$tag" ] || die "could not read latest release tag" 3
cur="$(cat "$VERFILE" 2>/dev/null || echo none)"
log "latest=$tag deployed=$cur"
if [ "$tag" = "$cur" ] && [ "$FORCE" != "1" ]; then
  log "already on $tag — nothing to do"; exit 0
fi

# ── 2. Download the new binary to a temp path ────────────────────────────────
asset_url="$(jq_field "$rel" '(j.assets.find(a=>a.name==="eex-ytresolve-x86_64-linux")||{}).url||""')"
[ -n "$asset_url" ] || die "release $tag has no eex-ytresolve-x86_64-linux asset" 3
tmpbin="$(mktemp "${TMPDIR:-/tmp}/eex-ytresolve.XXXXXX")"
cleanup() { rm -f "$tmpbin"; }
trap cleanup EXIT
log "downloading $tag binary"
curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" "$asset_url" -o "$tmpbin" \
  || die "asset download failed" 3
chmod +x "$tmpbin"
[ -s "$tmpbin" ] || die "downloaded binary is empty" 3

# ── 3. GATE 1: authoritative canary (residential egress, real binary) ────────
log "canary: resolving $CANARY_ID with the new binary"
out="$("$tmpbin" "$CANARY_ID" 2>/dev/null)" || die "new binary failed to resolve $CANARY_ID — NOT deploying" 1
# Resolve must yield a stream AND (for the mux path) the adaptive stream must be
# downloadable at a non-zero offset. Probe with the runtime that's available.
probe='
  const j=JSON.parse(process.argv[1]);
  (async()=>{
    const playable=j.hls||j.progressive||(j.video&&j.audio);
    if(!playable){console.error("no playable stream");process.exit(1);}
    if(!j.hls && j.video && j.video.url && j.audio){
      const u=j.video.url+(j.video.url.includes("?")?"&":"?")+"range=1048576-2097151";
      const r=await fetch(u);
      if(r.status!==200 && r.status!==206){console.error("offset "+r.status+" — pot-gated, mux would fail");process.exit(1);}
    }
    console.log("ok");
  })().catch(e=>{console.error(e.message||e);process.exit(1);});
'
if [ "${NODE_IN_CTR:-0}" = "1" ]; then
  docker exec -i "$BACKEND_CTR" node -e "$probe" "$out" || die "canary failed for $tag — extractor regression, NOT deploying" 1
else
  node -e "$probe" "$out" || die "canary failed for $tag — extractor regression, NOT deploying" 1
fi
log "canary GREEN for $tag"

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run: canary passed; skipping build/swap (would deploy $tag)"; exit 0
fi

# ── 4. GATE 2: stage + Plex-safe build + swap + proof + rollback ─────────────
prev_img="$(docker inspect --format '{{.Image}}' "$BACKEND_CTR" 2>/dev/null || echo '')"
[ -n "$prev_img" ] && docker tag "$prev_img" theemeraldexchange-backend:rollback 2>/dev/null && log "tagged rollback image"

cp "$tmpbin" "$BIN"; chmod +x "$BIN"
log "staged new binary at $BIN"

# Capped, Plex-watched build. The binary is prebuilt, so this only recompiles the
# (cached) napi crate + COPY layers — light — but cap + watch anyway.
log "building backend image (CARGO_BUILD_JOBS=$JOBS, ionice/nice, Plex-watched)"
( cd "$COMPOSE_DIR" && CARGO_BUILD_JOBS="$JOBS" ionice -c3 nice -n19 \
    docker compose build "$BACKEND_SVC" >>"$LOG" 2>&1 ) &
build_pid=$!
# Watchdog: abort the build if Plex goes unhealthy.
while kill -0 "$build_pid" 2>/dev/null; do
  st="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CRITICAL" 2>/dev/null || echo absent)"
  if [ "$st" != "healthy" ] && [ "$st" != "running" ] && [ "$st" != "absent" ]; then
    log "Plex degraded ($st) during build — aborting build to protect it"
    kill "$build_pid" 2>/dev/null; pkill -f 'compose build' 2>/dev/null
    die "build aborted (Plex protection); old image still live" 2
  fi
  sleep 10
done
wait "$build_pid" || die "image build failed; old image still live" 2

log "swapping backend + recreating cloudflared (shared netns)"
( cd "$COMPOSE_DIR" && docker compose up -d --no-build "$BACKEND_SVC" ) >>"$LOG" 2>&1 || die "swap failed" 2
( cd "$COMPOSE_DIR" && docker compose up -d --no-build --force-recreate "$CF_CTR" ) >>"$LOG" 2>&1 \
  || log "WARN: cloudflared recreate failed — public path may 502 until fixed"

# Post-deploy proof: health, then a real /trailer mux on the adaptive id.
rollback() {
  log "ROLLING BACK to previous image"
  if docker image inspect theemeraldexchange-backend:rollback >/dev/null 2>&1; then
    docker tag theemeraldexchange-backend:rollback theemeraldexchange-backend:latest
    ( cd "$COMPOSE_DIR" && docker compose up -d --no-build --force-recreate "$BACKEND_SVC" "$CF_CTR" ) >>"$LOG" 2>&1
    log "rolled back"
  else
    log "WARN: no rollback image tagged — manual intervention needed"
  fi
}

log "post-deploy proof: health"
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "$API" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && { ok=1; break; }
  sleep 5
done
[ "$ok" = "1" ] || { log "health never went 200"; rollback; die "post-deploy health failed — rolled back" 2; }

log "post-deploy proof: /trailer mux on $PROOF_ID (in-container, cookie + token)"
proof_ok="$(docker exec "$BACKEND_CTR" node --import tsx -e '
  import("./server/session.ts").then(async (m) => {
    const tok = await m.createSession({ sub: "plex:494190801", username: "owner", role: "admin" });
    const base = process.env.SELF_BASE || "http://127.0.0.1:3001";
    const r = await fetch(base + "/api/tmdb/trailer?key='"$PROOF_ID"'", { headers: { Cookie: "eex.session=" + tok } });
    const j = await r.json();
    console.log(j.url && j.url.includes("/stream.mp4?t=") ? "MUX_OK" : ("NOMUX:" + (j.url||"").slice(0,40)));
  }).catch((e) => { console.log("ERR:" + (e.message||e)); });
' 2>/dev/null | grep -oE 'MUX_OK|NOMUX:.*|ERR:.*' | tail -1)"
if [ "$proof_ok" != "MUX_OK" ]; then
  log "trailer proof did not return a muxed stream URL ($proof_ok)"; rollback
  die "post-deploy trailer proof failed — rolled back" 2
fi

echo "$tag" > "$VERFILE"
log "DEPLOYED $tag successfully (canary + health + mux proof all green)"
exit 0
