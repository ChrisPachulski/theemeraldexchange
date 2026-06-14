#!/bin/bash
# Recommender fresh-volume boot proof. Runs on any docker host that already
# has the recommender image (the NAS, or a dev box).
#
# Proves the CONTAINER LAYER of a cold-volume first deploy: the image boots
# against an EMPTY /data volume, under the EXACT compose hardening
# (cap_drop ALL + cap_add SETUID/SETGID/CHOWN, no-new-privileges, read-only
# rootfs, tmpfs /tmp), runs migrate() from the lifespan, and serves /health
# with the fresh-DB shape. This catches the regressions the Python test
# (recommender/tests/test_fresh_volume_boot.py) CANNOT see because they only
# exist in the built image + container sandbox:
#   * gosu/cap crash-loop — dropping ALL caps without re-adding SETUID/SETGID/
#     CHOWN makes docker-entrypoint.sh's chown + `gosu` fail ("operation not
#     permitted") and the container never serves.
#   * read-only rootfs — any boot-time write outside /data or /tmp aborts.
#   * the sqlite-vec .so + torch CPU wheel actually being present and loadable
#     in the runtime image (the migrator's title_vec vec0 table needs the
#     extension; a broken wheel install only shows at runtime).
#
# IMPORTANT: this script NEVER builds. The recommender image compiles a Rust
# PyO3 wheel, and a raw compile on the NAS browns out Plex (see CLAUDE.md).
# Build it safely first with scripts/nas-safe-build.sh recommender, then run
# this against the resulting image.
#
#   usage: recommender-fresh-volume-boot-proof.sh [image] [host-port]
#     image     default: theemeraldexchange-recommender:latest
#     host-port default: 18999 (loopback only; avoids the 8001 admin port)
set -uo pipefail

IMAGE="${1:-theemeraldexchange-recommender:latest}"
PORT="${2:-18999}"
NAME="recommender-freshboot-proof-$$"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/recommender-freshvol.XXXXXX")"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
DEADLINE_SECS=120

say()  { printf '\n==== %s ====\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; cleanup; exit 1; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "docker not found on this host"
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fail "image '$IMAGE' not present — build it first with: scripts/nas-safe-build.sh recommender"

# A genuinely cold volume: an empty dir, no exchange.db.
say "COLD VOLUME"
echo "host data dir: $DATA_DIR (empty: $(ls -A "$DATA_DIR" | wc -l | tr -d ' ') entries)"
[ -f "$DATA_DIR/exchange.db" ] && fail "precondition: $DATA_DIR must start without exchange.db"

# Boot under the EXACT docker-compose.yml hardening for this service.
say "BOOT (compose hardening, empty /data)"
docker run -d --name "$NAME" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN \
  --read-only --tmpfs /tmp \
  -e NODE_ENV=development \
  -e RECOMMENDER_DB_PATH=/data/exchange.db \
  -v "$DATA_DIR:/data" \
  -p "127.0.0.1:${PORT}:8000" \
  "$IMAGE" >/dev/null \
  || fail "docker run failed (the cap/hardening combo may be rejecting boot)"

# Poll /health. A crash-loop (gosu/cap) shows as the container not running;
# a slow first boot (model/extension load) just needs a few more polls.
say "WAIT FOR /health (deadline ${DEADLINE_SECS}s)"
BODY=""
for ((i = 0; i < DEADLINE_SECS; i++)); do
  if ! docker ps --filter "name=$NAME" --filter status=running --format '{{.Names}}' | grep -q "$NAME"; then
    echo "--- container is not running; last logs: ---"
    docker logs "$NAME" 2>&1 | tail -30
    fail "container exited during boot (cap/gosu crash-loop or migration abort)"
  fi
  BODY="$(curl -fsS "$HEALTH_URL" 2>/dev/null)" && [ -n "$BODY" ] && break
  sleep 1
done
[ -n "$BODY" ] || { docker logs "$NAME" 2>&1 | tail -30; fail "/health never came up within ${DEADLINE_SECS}s"; }

say "HEALTH BODY"
echo "$BODY"

# Assert the fresh-DB shape: ok=true, an empty catalog, the migration-created
# schema present (titles + the vec0 table the migrator builds).
echo "$BODY" | grep -q '"ok":true' || fail "/health did not report ok=true"
echo "$BODY" | grep -q '"titles":0' || fail "fresh volume should report titles:0"
echo "$BODY" | grep -q '"title_vectors":0' || fail "fresh volume should report title_vectors:0"

say "DB MATERIALISED ON THE COLD VOLUME"
[ -f "$DATA_DIR/exchange.db" ] || fail "boot did not create exchange.db on the mounted volume"
echo "exchange.db present: $(ls -l "$DATA_DIR/exchange.db" | awk '{print $5" bytes"}')"
# Every on-disk migration must be recorded as applied.
APPLIED="$(docker exec "$NAME" python -c "import sqlite3,glob,os; c=sqlite3.connect('/data/exchange.db'); a={r[0] for r in c.execute('SELECT version FROM schema_migrations')}; d={int(os.path.basename(p)[:4]) for p in glob.glob('/srv/migrations/*.sql')}; print('OK' if a==d else f'MISMATCH applied={sorted(a)} on_disk={sorted(d)}')" 2>&1)"
echo "migrations: $APPLIED"
echo "$APPLIED" | grep -q '^OK$' || fail "not every migration applied on fresh boot: $APPLIED"

say "PASS — cold-volume boot served /health under full compose hardening"
