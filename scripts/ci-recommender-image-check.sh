#!/bin/sh
# CI check of a built recommender image (ci.yml on main, sidecar-images.yml on
# PRs). Never builds; the image must already be loaded.
#
#   1. verify-embedding: the baked MiniLM files reproduce the committed baseline
#      (1e-4 / 1e-5 / top-3 gates, sha256 of the baseline, a fresh-DB persist).
#   2. cold-volume boot: an empty /data under the exact compose hardening
#      (cap_drop ALL + SETUID/SETGID/CHOWN, no-new-privileges, read-only rootfs,
#      tmpfs /tmp) in the production posture must serve /health with an empty
#      catalog. This is what catches an entrypoint/gosu crash-loop or a boot-time
#      write outside /data, which the crate's fresh-dir boot test cannot see.
#
#   usage: ci-recommender-image-check.sh <image>
set -eu

IMAGE="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/crates/recommender/tests/fixtures/torch_2_12_embedding_baseline.json"

docker run --rm --user 10001:10001 \
  -v "$BASELINE:/ci/baseline.json:ro" \
  --entrypoint eex-recommender \
  "$IMAGE" verify-embedding /ci/baseline.json

secret() { head -c 48 /dev/urandom | base64 | tr -d '\n'; }
DATA="$(mktemp -d)"
# mktemp gives 0700 owned by the runner user; root without DAC caps could not
# even list it. A fresh docker volume or mkdir'd bind dir is 0755.
chmod 755 "$DATA"
NAME="recommender-check-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$NAME" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN \
  --read-only --tmpfs /tmp \
  -e NODE_ENV=production \
  -e RECOMMENDER_EVENT_SECRET="$(secret)" \
  -e INTERNAL_PRINCIPAL_SECRET="$(secret)" \
  -v "$DATA:/data" \
  -p 127.0.0.1:18000:8000 \
  "$IMAGE" >/dev/null

BODY=""
i=0
while [ "$i" -lt 60 ]; do
  BODY="$(curl -fsS http://127.0.0.1:18000/health 2>/dev/null)" && break
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    docker logs "$NAME"
    echo "FAIL: container exited during boot" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 2
done
[ -n "$BODY" ] || { docker logs "$NAME"; echo "FAIL: /health never answered" >&2; exit 1; }
echo "$BODY"
echo "$BODY" | grep -q '"ok":true'
echo "$BODY" | grep -q '"titles":0'
echo "$BODY" | grep -q '"title_vectors":0'
# The jobs run in process: the image carries no python for a host cron to exec.
! docker exec "$NAME" sh -c 'command -v python3 || command -v python'
echo "PASS: recommender image verified and booted on a cold volume"
