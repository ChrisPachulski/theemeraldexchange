#!/usr/bin/env bash
# deploy-image.sh — build compose-service images LOCALLY (cross-compiled for
# the NAS), ship them over SSH, and roll the services WITHOUT compiling on the
# NAS. This is the DEFAULT deploy path for compiled services.
#
# WHY: the NAS is a 6-thread box that also runs Plex. On-box compiles have
# wedged it three times — the 2026-06-11 incident fork-starved the whole box
# for ~4h (sshd couldn't even send a banner) and needed a power-cycle. A local
# amd64 cross-build + `docker save | docker load` moves ALL compile cost off
# the box; the NAS only pays ~seconds of image-load I/O and a container swap.
# Use scripts/nas-safe-build.sh only when a local build is impossible.
#
# Usage:
#   scripts/deploy-image.sh <service> [<service>...]
#   scripts/deploy-image.sh transcoder backend
#
# Env knobs:
#   NAS_HOST (theemeraldexchange.local)  NAS_USER (root)
#   APPDATA  (/mnt/user/appdata/exchange-backend)
#   SKIP_BUILD=1   ship + roll already-built local images as-is
#   EEX_RELEASE    release id baked into the backend image (defaults to the
#                  short HEAD sha so /api/version reflects what's deployed)
#
# Exit codes: 0 ok · 2 build failed · 3 wrong arch · 4 ship/roll failed · 5 setup
set -euo pipefail

[ "$#" -ge 1 ] || { echo "usage: $0 <service> [<service>...]" >&2; exit 5; }

NAS_HOST="${NAS_HOST:-theemeraldexchange.local}"
NAS_USER="${NAS_USER:-root}"
APPDATA="${APPDATA:-/mnt/user/appdata/exchange-backend}"
NAS="${NAS_USER}@${NAS_HOST}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The local sandbox PATH often lacks docker; resolve Docker Desktop's binary.
DOCKER="${DOCKER:-$(command -v docker || true)}"
[ -n "$DOCKER" ] || DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
[ -x "$DOCKER" ] || { echo "ERR: docker binary not found" >&2; exit 5; }

say() { printf '[deploy-image] %s\n' "$*"; }

cd "$REPO_ROOT"
EEX_RELEASE="${EEX_RELEASE:-$(git rev-parse --short HEAD)}"
export EEX_RELEASE

# ── 1. Build locally, cross-compiled for the NAS (amd64) ─────────────────────
images=()
for svc in "$@"; do
  img="theemeraldexchange-${svc}:latest"
  images+=("$img")
  if [ -z "${SKIP_BUILD:-}" ]; then
    say "building $svc locally for linux/amd64 (EEX_RELEASE=$EEX_RELEASE)…"
    DOCKER_DEFAULT_PLATFORM=linux/amd64 "$DOCKER" compose build "$svc" \
      || { say "build of $svc FAILED"; exit 2; }
  fi
  arch="$("$DOCKER" image inspect "$img" --format '{{.Architecture}}' 2>/dev/null || echo missing)"
  if [ "$arch" != "amd64" ]; then
    say "ERR: $img is '$arch', NAS needs amd64 — rebuild without SKIP_BUILD"
    exit 3
  fi
  say "$img ok (amd64)"
done

# ── 2. Ship: one gzipped stream over SSH (no compile, trivial I/O) ───────────
say "shipping ${#images[@]} image(s) to ${NAS}…"
"$DOCKER" save "${images[@]}" | gzip | ssh "$NAS" 'gunzip | docker load' \
  || { say "ship FAILED"; exit 4; }

# ── 3. Roll: recreate from the loaded images, NEVER build on the NAS ─────────
say "recreating: $* (no build)…"
ssh "$NAS" "cd '$APPDATA' && docker compose up -d --no-build $*" \
  || { say "recreate FAILED"; exit 4; }

# cloudflared joins the backend container's network namespace; a backend
# RECREATE (new container id) strands its netns ref, and a plain
# `docker restart` then fails with "No such container: <old-backend-id>" —
# only a force-recreate re-resolves the netns to the new backend container.
case " $* " in *" backend "*)
  say "backend recreated → force-recreating exchange-cloudflared (netns)…"
  ssh "$NAS" "cd '$APPDATA' && docker compose up -d --force-recreate --no-build cloudflared" >/dev/null
  ;;
esac

# ── 4. Verify end-to-end (exit 0 ≠ done) ─────────────────────────────────────
say "verifying public health…"
node -e '
  const url = "https://api.theemeraldexchange.com/api/health";
  const tryOnce = (n) => fetch(url, {signal: AbortSignal.timeout(10000)})
    .then(r => { if (r.status !== 200) throw new Error("status " + r.status); console.log("health 200 OK"); })
    .catch(e => { if (n <= 1) { console.error("health check FAILED:", e.message); process.exit(1); }
                  return new Promise(res => setTimeout(res, 5000)).then(() => tryOnce(n - 1)); });
  tryOnce(6);
' || { say "public health did not come back — investigate before walking away"; exit 4; }

ver="$(node -e '
  fetch("https://api.theemeraldexchange.com/api/version", {signal: AbortSignal.timeout(10000)})
    .then(r => r.text()).then(t => console.log(t.slice(0, 200))).catch(e => console.log("unavailable: " + e.message));
')"
say "deployed /api/version: $ver (local HEAD: $EEX_RELEASE)"
say "DONE"
