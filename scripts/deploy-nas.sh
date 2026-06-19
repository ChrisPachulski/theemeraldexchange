#!/usr/bin/env bash
# Deploy the Hono backend + Cloudflare Tunnel sidecar to the NAS.
#
# Architecture (V2):
#   theemeraldexchange.com         → Netlify (SPA)             [auto-deploys on git push]
#   api.theemeraldexchange.com     → Cloudflare Tunnel
#                                   → cloudflared container sharing backend netns
#                                   → 127.0.0.1:3001
#                                   → exchange-backend container (Hono on Node)
#                                   → Sonarr / Radarr / SAB on the LAN
#
# What this script does:
#   1. Refuses to run with uncommitted tracked changes (--allow-dirty to
#      override — the payload is ALWAYS `git archive HEAD`, so dirty edits
#      would silently not ship).
#   2. Validates a local .env.production exists with all required keys.
#   3. Stages a clean payload from `git archive HEAD` into a temp dir and
#      rsyncs Dockerfile, docker-compose.yml, package*.json, tsconfig.json,
#      server/, recommender/, crates/ FROM THAT STAGE — never the working
#      tree — to /mnt/user/appdata/exchange-backend/ on the NAS.
#   4. Ships .env.production → NAS as .env (consumed by docker compose).
#   5. Tags every currently-deployed image as :rollback, then SSHs into the
#      NAS and runs `docker compose up -d --build` with
#      EEX_RELEASE=<short sha of HEAD> so /api/version reports the deployed
#      commit (drift detection).
#   6. Health-gates backend + recommender + media-core + transcoder; on
#      failure rolls back to the :rollback images and prints the manual
#      rollback commands for every image.
#
# What this script does NOT do:
#   - Build the SPA. That's Netlify's job, triggered by `git push`.
#
# Flags:
#   --allow-dirty   Deploy even when tracked files have uncommitted changes.
#                   LOUD WARNING: those changes are NOT shipped — the payload
#                   is git archive HEAD. Commit first unless you know better.
#
# First-time setup: see DEPLOY.md.

set -euo pipefail

NAS_HOST="${NAS_HOST:-theemeraldexchange.local}"
NAS_USER="${NAS_USER:-root}"
APPDATA="${APPDATA:-/mnt/user/appdata/exchange-backend}"
LOCAL_ENV="${LOCAL_ENV:-.env.production}"

ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help)
      # Print the header comment block (everything up to the first non-comment
      # line) as the help text, so the docs above never drift from --help.
      awk 'NR>1 && !/^#/ {exit} NR>1 {sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg (supported: --allow-dirty, --help)" >&2
      exit 1
      ;;
  esac
done

# ── Source-of-truth guard ────────────────────────────────────────────────────
# The payload is built from `git archive HEAD`, never the working tree, so an
# uncommitted edit would silently NOT ship. Refuse to run on a dirty tree
# (tracked files only — untracked scratch is fine) unless explicitly waived.
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "ERROR: not inside a git repository (the deploy payload is git archive HEAD)." >&2
  exit 1
fi
dirty=$(git status --porcelain --untracked-files=no)
if [[ -n "$dirty" ]]; then
  if [[ "$ALLOW_DIRTY" == "1" ]]; then
    echo "╔════════════════════════════════════════════════════════════════════╗" >&2
    echo "║ WARNING: deploying with UNCOMMITTED tracked changes (--allow-dirty) ║" >&2
    echo "║ The payload is git archive HEAD — these changes will NOT ship:      ║" >&2
    echo "╚════════════════════════════════════════════════════════════════════╝" >&2
    printf '%s\n' "$dirty" >&2
  else
    echo "ERROR: tracked files have uncommitted changes — the deploy payload is" >&2
    echo "       git archive HEAD, so these edits would silently not ship:" >&2
    printf '%s\n' "$dirty" >&2
    echo "       Commit them first, or re-run with --allow-dirty to deploy HEAD anyway." >&2
    exit 1
  fi
fi

DEPLOY_SHA=$(git rev-parse HEAD)
DEPLOY_SHA_SHORT=$(git rev-parse --short HEAD)

# Per-run rollback generation id. Both the image revert tags and the config
# snapshots below carry this timestamp so (a) a re-run can never clobber the
# only good rollback generation and (b) the rollback path restores the image
# set AND the compose/.env config from the SAME pre-deploy moment. UTC,
# zero-padded → lexical sort == chronological sort.
ROLLBACK_TS=$(date -u +%Y%m%d-%H%M%S)

# Ad-hoc branch deploys are legitimate (hotfix soaks), but flag the drift so a
# stale local main or a forgotten feature branch never ships silently.
if git rev-parse --verify origin/main >/dev/null 2>&1; then
  if [[ "$DEPLOY_SHA" != "$(git rev-parse origin/main)" ]]; then
    echo "[deploy] WARN: HEAD ($DEPLOY_SHA_SHORT) != origin/main ($(git rev-parse --short origin/main))." >&2
    echo "         Deploying HEAD anyway — make sure that's intentional." >&2
  fi
else
  echo "[deploy] WARN: origin/main not found locally; skipping branch-drift check." >&2
fi

if [[ ! -f "$LOCAL_ENV" ]]; then
  echo "ERROR: $LOCAL_ENV not found at $(pwd)/$LOCAL_ENV" >&2
  echo "       Copy .env.production.example, fill it in, then re-run." >&2
  echo "       (See DEPLOY.md for what each variable means.)" >&2
  exit 1
fi

required=(
  TUNNEL_TOKEN
  PLEX_CLIENT_ID
  SESSION_SECRET
  STREAM_TOKEN_SECRET
  DEVICE_TOKEN_SECRET
  INTERNAL_PRINCIPAL_SECRET
  RECOMMENDER_EVENT_SECRET
  ALLOWED_ORIGINS
  SONARR_API_KEY
  RADARR_API_KEY
  SAB_API_KEY
)
# NOTE: EEX_TELEMETRY_DSN is required by env.ts in prod but is deliberately
# NOT gated here — glitchtip-setup.md §2 runs this deploy once to bring the
# Glitchtip stack up *before* a DSN exists, then redeploys with it set. The
# backend crash-loops in that bootstrap window by design; Glitchtip itself
# has no such dependency and comes up fine.
env_value() {
  local key="$1"
  local line value
  line=$(grep -E "^[[:space:]]*${key}=" "$LOCAL_ENV" | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    return 1
  fi
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}
for key in "${required[@]}"; do
  if ! value=$(env_value "$key"); then
    echo "ERROR: ${key} missing from $LOCAL_ENV" >&2
    exit 1
  fi
  if [[ -z "$value" ]]; then
    echo "ERROR: ${key} in $LOCAL_ENV must not be empty." >&2
    exit 1
  fi
done

# SESSION_SECRET protects every user's encrypted Plex auth token. The
# backend SHA-256s this value to derive the A256GCM key, so a short or
# placeholder secret is equivalent to publishing the AES key. Mirror
# env.ts's prod gate here so deploy fails fast with a clearer message
# than a container crash loop.
session_secret_value=$(env_value SESSION_SECRET)
if [ "${#session_secret_value}" -lt 32 ]; then
  echo "ERROR: SESSION_SECRET in $LOCAL_ENV must be at least 32 bytes (${#session_secret_value} found)." >&2
  echo "       Generate one with: openssl rand -base64 48" >&2
  exit 1
fi
session_secret_lower=$(printf '%s' "$session_secret_value" | tr '[:upper:]' '[:lower:]')
case "$session_secret_lower" in
  changeme|change-me|change_me|placeholder|secret|password|test|test-secret|replaceme|replace-me|replace_me|your-secret-here|session-secret)
    echo "ERROR: SESSION_SECRET in $LOCAL_ENV is a placeholder value." >&2
    echo "       Generate a real secret with: openssl rand -base64 48" >&2
    exit 1
    ;;
esac

# PLEX_SERVER_ID gates sign-in to members of the household's Plex
# server. A blank value turns the app into "any Plex user can sign
# in," so the backend hard-fails at boot in prod unless the operator
# explicitly opted into bootstrap mode. Mirror that check here so
# deploy fails fast with a clearer message than a container crash
# loop.
plex_server_id_value=$(env_value PLEX_SERVER_ID || true)
allow_unscoped_plex_login_value=$(env_value ALLOW_UNSCOPED_PLEX_LOGIN || true)
if [[ -n "$plex_server_id_value" ]]; then
  : # populated — good
elif [[ "$allow_unscoped_plex_login_value" == "1" ]]; then
  echo "[deploy] WARN: PLEX_SERVER_ID is blank and ALLOW_UNSCOPED_PLEX_LOGIN=1 is set." >&2
  echo "         This means ANY Plex account can sign in. Use only for the brief" >&2
  echo "         first-deploy window — discover your machineIdentifier via the SPA's" >&2
  echo "         /api/me discoveredServers payload, set PLEX_SERVER_ID, and remove the" >&2
  echo "         escape hatch immediately." >&2
else
  echo "ERROR: production env needs PLEX_SERVER_ID (your home Plex server's" >&2
  echo "       machineIdentifier) so sign-in is scoped to household members." >&2
  echo "       For the first-deploy bootstrap window, set ALLOW_UNSCOPED_PLEX_LOGIN=1" >&2
  echo "       explicitly to opt into the open mode. See DEPLOY.md." >&2
  exit 1
fi

# ── Stage the payload from the committed tree, never the working tree ──────
# `git archive HEAD` materializes exactly what is committed: no uncommitted
# edits, no untracked scratch, no node_modules/target/.venv — so the rsyncs
# below ship a reproducible payload identified by $DEPLOY_SHA.
STAGE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/eex-deploy-stage.XXXXXX")
cleanup_stage() { rm -rf "$STAGE_DIR"; }
trap cleanup_stage EXIT
echo "→ Staging payload from git archive ${DEPLOY_SHA_SHORT} (${STAGE_DIR})"
git archive HEAD | tar -x -C "$STAGE_DIR"

# ── Stage the prebuilt eex-ytresolve binary into the build context ──────────
# Our native YouTube resolver is built in its OWN repo's CI (never compiled on
# the NAS — it pulls boa_engine, a heavy compile that has brown-outed Plex). The
# backend Dockerfile COPYs bin/eex-ytresolve; it's .gitignored, so the git
# archive above doesn't carry it. Fetch the release asset (default) or use a
# local file via EEX_YTRESOLVE_BIN_SRC (e.g. a CI workflow_dispatch artifact
# before the first release tag exists).
YTRESOLVE_REPO="${YTRESOLVE_REPO:-ChrisPachulski/rust-yt-extractor}"
mkdir -p "${STAGE_DIR}/bin"
if [ -n "${EEX_YTRESOLVE_BIN_SRC:-}" ]; then
  echo "→ Staging eex-ytresolve from local ${EEX_YTRESOLVE_BIN_SRC}"
  cp "${EEX_YTRESOLVE_BIN_SRC}" "${STAGE_DIR}/bin/eex-ytresolve"
else
  echo "→ Fetching eex-ytresolve release asset from ${YTRESOLVE_REPO}"
  gh release download --repo "$YTRESOLVE_REPO" \
    --pattern 'eex-ytresolve-x86_64-linux' \
    --output "${STAGE_DIR}/bin/eex-ytresolve" --clobber
fi
chmod +x "${STAGE_DIR}/bin/eex-ytresolve"
test -s "${STAGE_DIR}/bin/eex-ytresolve" \
  || { echo "ERROR: eex-ytresolve binary missing/empty after staging" >&2; exit 1; }

echo "→ Ensuring ${APPDATA} exists on ${NAS_HOST}"
ssh "${NAS_USER}@${NAS_HOST}" "mkdir -p ${APPDATA} ${APPDATA}/bin"

# ── Rollback config snapshot ────────────────────────────────────────────────
# Image-only rollback is insufficient: the rsync below overwrites
# docker-compose.yml and the env ship overwrites .env, so a deploy broken BY
# the new compose file or env values would "roll back" the images and then
# `compose up` from the still-broken config. Snapshot both BEFORE the
# overwrite, tagged with this run's generation id; keep the last 2 generations
# (mirroring the image-tag retention below) and prune older ones. First-ever
# deploy: neither file exists yet — nothing to snapshot, the rollback path
# warns instead.
echo "→ Snapshotting current compose + env for rollback (generation ${ROLLBACK_TS})"
ssh "${NAS_USER}@${NAS_HOST}" "cd ${APPDATA} && \
  for f in docker-compose.yml .env; do \
    if [ -f \"\$f\" ]; then \
      cp -p \"\$f\" \"\$f.rollback-${ROLLBACK_TS}\"; \
      echo \"[deploy] snapshotted \$f → \$f.rollback-${ROLLBACK_TS}\"; \
    fi; \
    ls -1 \"\$f\".rollback-* 2>/dev/null | sort | head -n -2 | xargs -r rm -f; \
  done"

echo "→ Syncing build context (from stage, commit ${DEPLOY_SHA_SHORT})"
rsync -av \
  "${STAGE_DIR}/Dockerfile" "${STAGE_DIR}/docker-compose.yml" "${STAGE_DIR}/.dockerignore" \
  "${STAGE_DIR}/package.json" "${STAGE_DIR}/package-lock.json" "${STAGE_DIR}/tsconfig.json" \
  "${NAS_USER}@${NAS_HOST}:${APPDATA}/"

echo "→ Syncing server/"
rsync -av --delete \
  --exclude '*.test.ts' \
  --exclude 'middleware/*.test.ts' \
  "${STAGE_DIR}/server/" "${NAS_USER}@${NAS_HOST}:${APPDATA}/server/"

echo "→ Syncing recommender/"
rsync -av --delete \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'data' \
  --exclude '.ruff_cache' \
  --exclude '.pytest_cache' \
  --exclude 'eval/holdout.jsonl' \
  "${STAGE_DIR}/recommender/" "${NAS_USER}@${NAS_HOST}:${APPDATA}/recommender/"

# crates/ feeds two multi-stage image builds:
#   - recommender/Dockerfile compiles the PyO3 wheel from
#     crates/emerald-contracts + crates/emerald-contracts-pyo3.
#   - Dockerfile (backend) compiles the @emerald/contracts-napi
#     linux-x64-gnu .node from crates/emerald-contracts +
#     crates/emerald-contracts-napi.
# The Cargo workspace requires all three members present even when only
# two are built per stage, so we ship every member's manifest. *.node
# files are excluded because each image's builder stage produces a
# fresh artifact for its target triple.
echo "→ Syncing crates/"
rsync -av --delete \
  --exclude 'target' \
  --exclude '**/target' \
  --exclude '.venv' \
  --exclude 'node_modules' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '*.node' \
  "${STAGE_DIR}/crates/" "${NAS_USER}@${NAS_HOST}:${APPDATA}/crates/"

# Cargo.toml + Cargo.lock + LICENSE live at the repo root and are
# required for `cargo build` inside the rust-builder stage. The earlier
# rsync block ships Dockerfile/compose/package*.json but not these.
echo "→ Syncing Cargo workspace manifest"
rsync -av "${STAGE_DIR}/Cargo.toml" "${STAGE_DIR}/Cargo.lock" "${STAGE_DIR}/LICENSE" \
  "${NAS_USER}@${NAS_HOST}:${APPDATA}/"

echo "→ Syncing eex-ytresolve binary"
rsync -av "${STAGE_DIR}/bin/eex-ytresolve" "${NAS_USER}@${NAS_HOST}:${APPDATA}/bin/"

echo "→ Shipping env"
rsync -av "$LOCAL_ENV" "${NAS_USER}@${NAS_HOST}:${APPDATA}/.env"
ssh "${NAS_USER}@${NAS_HOST}" "chmod 600 ${APPDATA}/.env"

ssh "${NAS_USER}@${NAS_HOST}" "test -f ${APPDATA}/.dockerignore || echo '[deploy] WARN: .dockerignore not present in build context — context will include .env, data/, recommender-db/'"

# Pre-create + chown the sidecar DB bind-mount dirs to their in-container
# service uids BEFORE `compose up`. Docker creates a missing bind-mount source
# as root:root, which MASKS the image-time chown — on a fresh volume the
# media-core (uid 10002) and recommender (uid 10001) services then cannot write
# their sqlite DBs under cap_drop: ALL + read_only and crash-loop. Pre-chowning
# the host dirs makes the first boot writable without granting the containers
# any extra capability. The backend's /app/data is owned by root inside its own
# image, so it needs no chown here.
echo "→ Pre-creating + chowning sidecar DB volumes (fresh-volume crash-loop guard)"
ssh "${NAS_USER}@${NAS_HOST}" "\
  mkdir -p ${APPDATA}/data ${APPDATA}/recommender-db ${APPDATA}/recommender-db/hf-cache ${APPDATA}/media-core-db && \
  chown -R 10001:10001 ${APPDATA}/recommender-db && \
  chown -R 10002:10002 ${APPDATA}/media-core-db"

# Snapshot every currently-deployed image as :rollback-${ROLLBACK_TS} BEFORE
# the build overwrites :latest, so an unhealthy deploy can be reverted (see
# post-deploy healthcheck below). Timestamped per run — a single :rollback tag
# was clobbered by any re-run, so a failed deploy followed by a second failed
# deploy would have re-tagged the BROKEN images as the revert target. Keep the
# newest 2 generations, prune older (including the legacy un-timestamped
# :rollback tag, which sorts first). Best-effort: the first-ever deploy has no
# prior images.
echo "→ Tagging current images as :rollback-${ROLLBACK_TS} (revert targets; keeping last 2 generations)"
ssh "${NAS_USER}@${NAS_HOST}" "
  for img in theemeraldexchange-backend theemeraldexchange-recommender theemeraldexchange-media-core theemeraldexchange-transcoder; do
    if docker image inspect \"\$img:latest\" >/dev/null 2>&1; then
      docker tag \"\$img:latest\" \"\$img:rollback-${ROLLBACK_TS}\"
      echo \"[deploy] tagged \$img:rollback-${ROLLBACK_TS}\"
    else
      echo \"[deploy] no prior \$img image to tag (first deploy)\"
    fi
    docker image ls --format '{{.Tag}}' \"\$img\" | grep '^rollback' | sort | head -n -2 | \
      while read -r t; do
        docker rmi \"\$img:\$t\" >/dev/null 2>&1 && echo \"[deploy] pruned stale rollback tag \$img:\$t\"
      done
  done
  exit 0"

echo "→ Building and starting containers"
# Unraid occasionally loses both docker compose forms (plugin + standalone)
# after system updates. To keep deploys working without manual NAS
# intervention, we try them in order and fall back to a direct docker
# build + run that mirrors the docker-compose.yml. Only the backend
# service is recreated this way — cloudflared keeps running across the
# rebuild since its config is in the container, not on the host.
#
# The fallback CANNOT recreate the compose network where
# `http://recommender:8000` resolves, so it would silently downgrade
# USE_LOCAL_RECOMMENDER=1 to trending. When that env is set, refuse
# to fall back: hard-fail so the operator installs docker compose
# instead of shipping a broken-but-running deploy.
# EEX_RELEASE is interpolated by docker-compose.yml into the backend image's
# build args (Dockerfile ARG → ENV → env.ts → /api/version `release`), so the
# deployed API self-reports the exact commit this script shipped — that's the
# drift detection /api/version exists for. Exported in the remote shell so
# compose interpolation sees it (the shipped .env deliberately doesn't pin it).
ssh "${NAS_USER}@${NAS_HOST}" "cd ${APPDATA} && \
  export EEX_RELEASE=${DEPLOY_SHA_SHORT} && \
  if docker compose version >/dev/null 2>&1; then \
    docker compose up -d --build; \
  elif command -v docker-compose >/dev/null 2>&1; then \
    docker-compose up -d --build; \
  elif grep -qE '^USE_LOCAL_RECOMMENDER=1' .env 2>/dev/null; then \
    echo >&2; \
    echo '[deploy] FATAL: docker compose is unavailable AND USE_LOCAL_RECOMMENDER=1.' >&2; \
    echo '         The direct-docker fallback cannot wire the backend↔recommender' >&2; \
    echo '         network — suggestions would silently degrade to trending.' >&2; \
    echo '         Install docker compose on the NAS, then re-run.' >&2; \
    exit 1; \
  else \
    echo '[deploy] compose unavailable — rebuilding backend directly'; \
    echo '         (recommender disabled by env, so single-container is OK)'; \
    docker build --build-arg EEX_RELEASE=${DEPLOY_SHA_SHORT} -t theemeraldexchange-backend:latest . && \
    docker stop exchange-backend 2>/dev/null || true; \
    docker rm exchange-backend 2>/dev/null || true; \
    docker run -d \
      --name exchange-backend \
      --restart unless-stopped \
      -p 127.0.0.1:3001:3001 \
      -v ${APPDATA}/data:/app/data \
      --env-file ${APPDATA}/.env \
      -e NODE_ENV=production \
      -e PORT=3001 \
      -e GRAB_LOG_PATH=/app/data/grabs.jsonl \
      theemeraldexchange-backend:latest; \
  fi"

# cloudflared joins the backend's network namespace (network_mode:
# service:backend), so the tunnel origin (localhost:3001) only resolves while
# the EXACT backend container it first joined is alive. `compose up --build`
# recreates the backend on any image change, staling that netns reference —
# `depends_on` orders the first start but does NOT re-gate a recreate — so the
# public site 502s until cloudflared is restarted. Always restart it after a
# deploy (cheap, idempotent). This has caused a real prod outage before.
echo "→ Restarting cloudflared (re-joins the recreated backend netns; else public 502)"
ssh "${NAS_USER}@${NAS_HOST}" "docker restart exchange-cloudflared >/dev/null 2>&1 || echo '[deploy] WARN: could not restart exchange-cloudflared (not running?)'"

# Post-deploy healthcheck. The 5s log tail this replaces was shorter than the
# container's 20s health start_period, so a crash-looping or boot-failing
# backend (bad migration, env-gate crash, napi ABI mismatch) shipped with an
# "✓ Deployed" and the API was simply down. Poll the backend's health until it
# is actually serving; if it never does, roll back to the :rollback image.
# Bootstrap window: on the very first deploy EEX_TELEMETRY_DSN doesn't exist yet
# (you create it from the Glitchtip instance THIS deploy brings up — see
# glitchtip-setup.md §2). The backend crash-loops by design that one time, so we
# must NOT health-gate/roll-back the whole stack — that would tear down the
# Glitchtip you need to mint the DSN from. Detect the unset DSN and, in that
# window only, skip the rollback with guidance instead.
telemetry_dsn="$(env_value EEX_TELEMETRY_DSN 2>/dev/null || true)"
# Gate on the WHOLE service stack, not just the backend: recommender,
# media-core and transcoder all carry docker healthchecks (compose +
# image HEALTHCHECK), so a sidecar that crash-loops (bad migration,
# missing INTERNAL_PRINCIPAL_SECRET, torch OOM) fails the deploy instead
# of silently degrading suggestions/playback. The recommender's first
# boot loads a sentence-transformer model (start_period 60s), hence the
# generous ~150s ceiling. A MISSING sidecar is a warning, not a failure —
# the direct-docker fallback path runs the backend alone by design.
echo "→ Waiting for backend + sidecars to report healthy (up to ~150s)"
# The poll body lives in a variable because it runs TWICE: once after the
# deploy and — if that fails — once more after the rollback, so the script
# never reports "rolled back" without re-verifying the restored stack with
# the exact same gate.
health_poll_remote='
  containers="exchange-backend exchange-recommender exchange-media-core exchange-transcoder"
  summary=""
  # Telemetry stack status (§15: telemetry is MANDATORY, but it is not in the
  # request path). Reported as WARN-not-fail, deliberately: hard-failing here
  # would roll back the app images over a telemetry blip and — in the DSN
  # bootstrap window — tear down the very Glitchtip instance the operator
  # needs to mint the DSN from. glitchtip web carries a compose healthcheck
  # (/_health/); the worker has none by design (see docker-compose.yml), so
  # for it the running-state is the signal (a crashed/restarting worker is
  # what real failure looks like).
  report_telemetry() {
    warn_summary=""
    for tc in exchange-glitchtip exchange-glitchtip-worker; do
      ts=$(docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" "$tc" 2>/dev/null || echo missing)
      warn_summary="$warn_summary $tc=$ts"
    done
    case "$warn_summary" in
      *=unhealthy*|*=restarting*|*=exited*|*=dead*|*=missing*|*=created*|*=paused*)
        echo "[deploy] WARN: telemetry stack not fully healthy (crash reports may be dropping):$warn_summary" ;;
      *) echo "[deploy] telemetry stack:$warn_summary" ;;
    esac
  }
  for i in $(seq 1 50); do
    all_ok=1
    summary=""
    for c in $containers; do
      s=$(docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" "$c" 2>/dev/null || echo missing)
      if [ "$s" = "none" ] && [ "$c" = "exchange-backend" ]; then
        # Direct-docker fallback container has no docker healthcheck — probe the port.
        if curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1; then s="healthy(port-probe)"; fi
      fi
      summary="$summary $c=$s"
      case "$s" in
        healthy|"healthy(port-probe)") : ;;
        missing)
          if [ "$c" = "exchange-backend" ]; then echo "[deploy] exchange-backend container is missing"; exit 2; fi
          ;; # missing sidecar: direct-docker fallback / partial stack — warn at the end
        *) all_ok=0 ;;
      esac
    done
    if [ "$all_ok" = "1" ]; then
      echo "[deploy] stack healthy:$summary"
      case "$summary" in *=missing*) echo "[deploy] WARN: some sidecars are missing (direct-docker fallback?):$summary" ;; esac
      report_telemetry
      exit 0
    fi
    sleep 3
  done
  echo "[deploy] stack never became healthy:$summary"
  report_telemetry
  exit 3
'
set +e
ssh "${NAS_USER}@${NAS_HOST}" "$health_poll_remote"
health_rc=$?
set -e

if [ "$health_rc" -ne 0 ] && [ -z "$telemetry_dsn" ]; then
  echo "→ Backend not healthy, but EEX_TELEMETRY_DSN is unset — this is the" >&2
  echo "  expected Glitchtip bootstrap window, NOT a deploy failure. The stack is" >&2
  echo "  up; create the EEX project + DSN (docs/operations/glitchtip-setup.md §4)," >&2
  echo "  set EEX_TELEMETRY_DSN in .env.production, then re-run this deploy — the" >&2
  echo "  next run health-gates the backend normally. Skipping rollback." >&2
elif [ "$health_rc" -ne 0 ]; then
  echo "✗ Stack unhealthy after deploy (rc=$health_rc) — rolling back images AND config" >&2
  # Restore the compose file + .env snapshotted at the top of THIS run (the
  # last-healthy generation) before `compose up`, so a deploy broken by the
  # new config — not just a new image — actually reverts. Then bring the
  # stack up from the RESTORED config.
  ssh "${NAS_USER}@${NAS_HOST}" "cd ${APPDATA} && \
    restored_cfg=0; \
    for f in docker-compose.yml .env; do \
      if [ -f \"\$f.rollback-${ROLLBACK_TS}\" ]; then \
        cp -p \"\$f.rollback-${ROLLBACK_TS}\" \"\$f\"; \
        echo \"[deploy] restored \$f from \$f.rollback-${ROLLBACK_TS}\"; \
        restored_cfg=1; \
      else \
        echo \"[deploy] WARN: no \$f.rollback-${ROLLBACK_TS} snapshot to restore (first deploy?)\" >&2; \
      fi; \
    done; \
    rolled=0; \
    for img in theemeraldexchange-backend theemeraldexchange-recommender theemeraldexchange-media-core theemeraldexchange-transcoder; do \
      if docker image inspect \"\$img:rollback-${ROLLBACK_TS}\" >/dev/null 2>&1; then \
        docker tag \"\$img:rollback-${ROLLBACK_TS}\" \"\$img:latest\"; \
        echo \"[deploy] restored \$img:latest from :rollback-${ROLLBACK_TS}\"; \
        rolled=1; \
      else \
        echo \"[deploy] WARN: no \$img:rollback-${ROLLBACK_TS} image to restore\" >&2; \
      fi; \
    done; \
    if [ \"\$rolled\" = \"1\" ] || [ \"\$restored_cfg\" = \"1\" ]; then \
      ( docker compose up -d --no-build 2>/dev/null || docker-compose up -d --no-build 2>/dev/null || true ) && \
      docker restart exchange-cloudflared >/dev/null 2>&1 || true; \
      echo '[deploy] rollback applied (images + config) — re-verifying health'; \
    else \
      echo '[deploy] FATAL: nothing to roll back to (no snapshot images or config) — stack is down, manual intervention required' >&2; \
    fi"
  # Re-verify with the SAME gate the deploy uses. A rollback that does not
  # come back healthy must be reported as an outage, not as a recovery.
  echo "→ Re-verifying stack health after rollback (same gate, up to ~150s)"
  set +e
  ssh "${NAS_USER}@${NAS_HOST}" "$health_poll_remote"
  rollback_health_rc=$?
  set -e
  if [ "$rollback_health_rc" -eq 0 ]; then
    echo "✗ Deploy of ${DEPLOY_SHA} FAILED; rolled back to generation ${ROLLBACK_TS} and the restored stack re-verified HEALTHY." >&2
  else
    echo "✗ Deploy of ${DEPLOY_SHA} FAILED and the ROLLBACK IS ALSO UNHEALTHY (rc=${rollback_health_rc})." >&2
    echo "  THE STACK IS DOWN — manual intervention required NOW." >&2
  fi
  echo "  Investigate before retrying:" >&2
  echo "    ssh ${NAS_USER}@${NAS_HOST} 'docker ps -a --format \"table {{.Names}}\\t{{.Status}}\"'" >&2
  echo "    ssh ${NAS_USER}@${NAS_HOST} 'docker logs --tail=80 exchange-backend'" >&2
  echo "    ssh ${NAS_USER}@${NAS_HOST} 'docker logs --tail=80 exchange-recommender'" >&2
  echo "    ssh ${NAS_USER}@${NAS_HOST} 'docker logs --tail=80 exchange-media-core'" >&2
  echo "    ssh ${NAS_USER}@${NAS_HOST} 'docker logs --tail=80 exchange-transcoder'" >&2
  echo "  Manual rollback (already attempted automatically), per image:" >&2
  for img in theemeraldexchange-backend theemeraldexchange-recommender theemeraldexchange-media-core theemeraldexchange-transcoder; do
    echo "    ssh ${NAS_USER}@${NAS_HOST} 'docker tag ${img}:rollback-${ROLLBACK_TS} ${img}:latest'" >&2
  done
  echo "  Manual config restore:" >&2
  echo "    ssh ${NAS_USER}@${NAS_HOST} 'cd ${APPDATA} && cp -p docker-compose.yml.rollback-${ROLLBACK_TS} docker-compose.yml && cp -p .env.rollback-${ROLLBACK_TS} .env'" >&2
  echo "    ssh ${NAS_USER}@${NAS_HOST} 'cd ${APPDATA} && docker compose up -d --no-build && docker restart exchange-cloudflared'" >&2
  exit 1
fi

# ── Release drift check (executed, not printed) ────────────────────────────
# /api/version exists precisely so a deploy can prove the serving container
# was built from the commit it shipped (EEX_RELEASE build arg → env.ts →
# `release` field). Query it via the NAS loopback publish (curl exists on the
# NAS; deliberately NOT the public URL, so this verifies the container we just
# deployed independent of Cloudflare edge state — the tunnel path is covered
# by the cloudflared restart above). Only meaningful when the health gate
# passed; the bootstrap window (health_rc != 0, no DSN) has a crash-looping
# backend by design, so the check is skipped there.
if [ "$health_rc" -eq 0 ]; then
  echo "→ Verifying deployed release via /api/version (drift check)"
  deployed_release=$(ssh "${NAS_USER}@${NAS_HOST}" \
    "curl -fsS --max-time 10 http://127.0.0.1:3001/api/version" 2>/dev/null \
    | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')
  if [ -z "$deployed_release" ]; then
    # The health gate just proved /api/health serves, so an unreadable
    # /api/version is transport noise (ssh blip), not drift evidence — warn,
    # don't fail a verified-healthy deploy on it.
    echo "[deploy] WARN: could not read /api/version for the drift check — verify manually:" >&2
    echo "         ssh ${NAS_USER}@${NAS_HOST} 'curl -s http://127.0.0.1:3001/api/version'" >&2
  elif [ "$deployed_release" != "$DEPLOY_SHA_SHORT" ]; then
    echo "✗ RELEASE DRIFT: /api/version reports release '${deployed_release}' but this run shipped ${DEPLOY_SHA_SHORT}." >&2
    echo "  The stack is healthy but serving the WRONG build — the new image did not" >&2
    echo "  actually take (stale compose cache? container not recreated?). NOT rolling" >&2
    echo "  back (the running code IS the previous build); investigate on the NAS:" >&2
    echo "    ssh ${NAS_USER}@${NAS_HOST} 'cd ${APPDATA} && docker compose up -d --build --force-recreate backend'" >&2
    exit 1
  else
    echo "[deploy] /api/version release matches ${DEPLOY_SHA_SHORT} — no drift."
  fi
fi

echo "→ Reclaiming BuildKit cache + dangling images (the docker vdisk creeps ~1GB/deploy otherwise)"
ssh "${NAS_USER}@${NAS_HOST}" "docker builder prune -f >/dev/null 2>&1 || true; docker image prune -f >/dev/null 2>&1 || true"

echo
if [ "$health_rc" -eq 0 ]; then
  echo "✓ Deployed commit ${DEPLOY_SHA} (release tag: ${DEPLOY_SHA_SHORT}) — health-gated and release-verified."
else
  # Only reachable in the Glitchtip bootstrap window (rollback skipped above).
  echo "⚠ Deployed commit ${DEPLOY_SHA} (release tag: ${DEPLOY_SHA_SHORT}) — backend NOT healthy yet"
  echo "  (expected: EEX_TELEMETRY_DSN bootstrap window — mint the DSN and re-deploy)."
fi
echo "  Public health endpoint:"
echo "    curl -s https://api.theemeraldexchange.com/api/health"
