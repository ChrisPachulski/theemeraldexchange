#!/usr/bin/env bash
# Hands-off weekly deploy of a new eex-ytresolve release to the backend — the NAS
# (residential-egress) half of the YouTube-extractor upkeep loop.
#
# The cloud side (rust-yt-extractor: ci.yml + yt-canary.yml) keeps clients.json
# fresh and publishes a new glibc binary as a GitHub release when the Innertube
# client identities drift. This script runs ON the NAS via weekly cron, PULLS that
# prebuilt binary (never compiles boa on the box — Plex lives here), and swaps it
# into the backend (compose bind-mounts ./bin/eex-ytresolve over the image's
# copy, so a container recreate picks it up; nothing is built) — but ONLY behind
# two hard gates so an unattended deploy can never ship a broken extractor:
#
#   GATE 1  authoritative canary — run the NEW binary from THIS box's residential
#           egress (the same path prod uses; GitHub runner IPs get YT-throttled, so
#           CI's live check is only advisory). Resolve a known id AND probe an
#           OFFSET byte-range of the adaptive stream — catches PoToken-gating
#           (resolve-OK-but-download-403), the exact failure the mux can't survive.
#   GATE 2  post-deploy proof — after the swap, health must come back and the
#           binary must resolve the adaptive proof id from INSIDE the backend
#           container. Any failure → restore the previous binary and alert.
#           Never leave prod down.
#
# Prereq (one-time, user-provided secret): a fine-grained GitHub PAT with
# contents:read on ChrisPachulski/rust-yt-extractor at $TOKEN_FILE (chmod 600).
# Private-repo release assets can't be fetched without it.
#
# Usage:
#   nas-canary-deploy.sh            # full run (cron)
#   nas-canary-deploy.sh --dry-run  # check + canary only; never swaps
#   nas-canary-deploy.sh --force    # redeploy even if already on latest
#
# Exit: 0 ok / up-to-date · 1 canary failed (no deploy) · 2 swap/proof failed
#       (rolled back) · 3 setup error.
set -uo pipefail

# cron runs with a minimal PATH; pin it so docker/curl resolve under the
# Unraid crond the same as in an interactive shell.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO="${YTRESOLVE_REPO:-ChrisPachulski/rust-yt-extractor}"
APPDATA="${APPDATA:-/mnt/user/appdata/exchange-backend}"
TOKEN_FILE="${EEX_GH_TOKEN_FILE:-$APPDATA/.gh-token}"
BIN="$APPDATA/bin/eex-ytresolve"
VERFILE="$APPDATA/bin/eex-ytresolve.version"
LOG="${EEX_CANARY_LOG:-$APPDATA/nas-canary-deploy.log}"
COMPOSE_DIR="$APPDATA"
BACKEND_SVC="backend"          # compose service name
BACKEND_CTR="exchange-backend" # container_name
CF_SVC="cloudflared"           # compose service name (NOT the container name)
CANARY_ID="${CANARY_ID:-dQw4w9WgXcQ}"
PROOF_ID="${PROOF_ID:-uYPbbksJxIg}"        # adaptive-only (forces the mux path)
API="https://api.theemeraldexchange.com/api/health"

DRY_RUN=0; FORCE=0
for a in "$@"; do case "$a" in
  --dry-run) DRY_RUN=1 ;; --force) FORCE=1 ;;
  -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
  *) echo "unknown arg: $a" >&2; exit 3 ;;
esac; done

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
die() { log "FATAL: $1"; exit "${2:-3}"; }
have() { command -v "$1" >/dev/null 2>&1; }

have docker || die "docker not found"
have curl   || die "curl not found"
# JSON parsing and the download probe run under python3 inside the backend
# container (the image ships it for yt-dlp; identical to prod), not whatever the
# Unraid host has. The binary itself runs on the host.
jq_field() { # $1=json  $2=python expression over j returning a string
  printf '%s' "$1" | docker exec -i "$BACKEND_CTR" python3 -c "import json,sys; j=json.load(sys.stdin); print($2)"
}

[ -f "$TOKEN_FILE" ] || die "no GitHub token at $TOKEN_FILE — create a fine-grained PAT (contents:read on $REPO), chmod 600" 3
TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
[ -n "$TOKEN" ] || die "token file $TOKEN_FILE is empty" 3
gh_api() { curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: ${2:-application/vnd.github+json}" "$1"; }

# ── 1. Is there a newer release than what's deployed? ────────────────────────
log "checking latest release of $REPO"
rel="$(gh_api "https://api.github.com/repos/$REPO/releases/latest")" || die "GitHub API failed (token valid? repo correct?)" 3
tag="$(jq_field "$rel" 'j.get("tag_name") or ""')"
[ -n "$tag" ] || die "could not read latest release tag" 3
cur="$(cat "$VERFILE" 2>/dev/null || echo none)"
log "latest=$tag deployed=$cur"
if [ "$tag" = "$cur" ] && [ "$FORCE" != "1" ]; then
  log "already on $tag — nothing to do"; exit 0
fi

# ── 2. Download the new binary to a temp path ────────────────────────────────
asset_url="$(jq_field "$rel" 'next((a["url"] for a in j.get("assets", []) if a.get("name") == "eex-ytresolve-x86_64-linux"), "")')"
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
import json, sys, urllib.error, urllib.request
j = json.load(sys.stdin)
if not (j.get("hls") or j.get("progressive") or (j.get("video") and j.get("audio"))):
    sys.exit("no playable stream")
video = j.get("video") or {}
if not j.get("hls") and video.get("url") and j.get("audio"):
    u = video["url"] + ("&" if "?" in video["url"] else "?") + "range=1048576-2097151"
    try:
        status = urllib.request.urlopen(u, timeout=30).status
    except urllib.error.HTTPError as e:
        status = e.code
    if status not in (200, 206):
        sys.exit(f"offset {status} — pot-gated, mux would fail")
print("ok")
'
printf '%s' "$out" | docker exec -i "$BACKEND_CTR" python3 -c "$probe" \
  || die "canary failed for $tag — extractor regression, NOT deploying" 1
log "canary GREEN for $tag"

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run: canary passed; skipping swap (would deploy $tag)"; exit 0
fi

# ── 4. GATE 2: swap + proof + rollback ───────────────────────────────────────
# compose bind-mounts $BIN over the image's copy, so swapping the file and
# recreating the container is the whole deploy: no image build on the NAS.
prevbin="$BIN.rollback"
[ -f "$BIN" ] && cp -p "$BIN" "$prevbin" && log "kept previous binary at $prevbin"

cp "$tmpbin" "$BIN"; chmod +x "$BIN"
log "staged new binary at $BIN"

log "swapping backend + recreating cloudflared (shared netns)"
( cd "$COMPOSE_DIR" && docker compose up -d --no-build --force-recreate "$BACKEND_SVC" ) >>"$LOG" 2>&1 || die "swap failed" 2
( cd "$COMPOSE_DIR" && docker compose up -d --no-build --force-recreate "$CF_SVC" ) >>"$LOG" 2>&1 \
  || log "WARN: cloudflared recreate failed — public path may 502 until fixed"

# Post-deploy proof: health, then the swapped binary resolves the adaptive id
# from inside the backend container (the path the trailer mux runs).
rollback() {
  log "ROLLING BACK to the previous binary"
  if [ -f "$prevbin" ]; then
    cp -p "$prevbin" "$BIN"
    ( cd "$COMPOSE_DIR" && docker compose up -d --no-build --force-recreate "$BACKEND_SVC" "$CF_SVC" ) >>"$LOG" 2>&1
    log "rolled back"
  else
    log "WARN: no previous binary kept — manual intervention needed"
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

log "post-deploy proof: in-container resolve of $PROOF_ID"
if ! docker exec "$BACKEND_CTR" eex-ytresolve "$PROOF_ID" >/dev/null 2>&1; then
  log "the swapped binary did not resolve $PROOF_ID inside the backend"; rollback
  die "post-deploy resolve proof failed — rolled back" 2
fi

echo "$tag" > "$VERFILE"
log "DEPLOYED $tag successfully (canary + health + resolve proof all green)"
exit 0
