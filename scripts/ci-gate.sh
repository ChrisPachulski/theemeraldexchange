#!/usr/bin/env bash
# ci-gate.sh — refuse to deploy a commit GitHub Actions has not passed.
#
# The deploy scripts ship `git archive HEAD`, and nothing on that path ever
# asked whether CI was green: a red main deployed exactly like a green one.
# This gate polls the public check-runs API (no token — the repo is public and
# a 25-minute wait at one poll a minute stays under the 60 req/h anonymous
# limit) until every check on the sha has completed, then passes or refuses.
#
# Usage: scripts/ci-gate.sh <sha>
# Exit:  0 every check passed (or SKIP_CI_GATE=1)
#        1 a check failed or was cancelled
#        2 checks still pending, or none reported, after CI_GATE_WAIT_SECS
#
# Env:   EEX_GITHUB_REPO    owner/repo               (ChrisPachulski/theemeraldexchange)
#        GITHUB_API_URL     API base                 (https://api.github.com)
#        CI_GATE_WAIT_SECS  max seconds to wait      (1500)
#        CI_GATE_POLL_SECS  seconds between polls    (60)
#        CI_GATE_ALLOW_RED  comma list of check names that may be red, e.g.
#                           "audit" while a new advisory waits on a fix; every
#                           other check must still pass
#        SKIP_CI_GATE=1     bypass the verdict, loudly
#
# Prefer CI_GATE_ALLOW_RED to SKIP_CI_GATE. From 2026-11-05 to 11-23 a red
# audit job (advisories against unchanged dependencies) left SKIP_CI_GATE as
# the only way to deploy, and that also waived the two runs whose tests
# failed (33e998c, 79ae179).
set -euo pipefail

sha="${1:?usage: ci-gate.sh <sha>}"
repo="${EEX_GITHUB_REPO:-ChrisPachulski/theemeraldexchange}"
api="${GITHUB_API_URL:-https://api.github.com}"
wait_secs="${CI_GATE_WAIT_SECS:-1500}"
poll_secs="${CI_GATE_POLL_SECS:-60}"
short="${sha:0:7}"
export CI_GATE_ALLOW_RED="${CI_GATE_ALLOW_RED:-}"

if [[ "${SKIP_CI_GATE:-0}" == "1" ]]; then
  echo "[ci-gate] WARN: SKIP_CI_GATE=1 — shipping $short without a CI verdict." >&2
  exit 0
fi

# One line: "pass <n>[ allowed red: ...]" | "fail <name (conclusion), ...>" |
# "pending <done>/<total>". A check named in CI_GATE_ALLOW_RED never fails the
# verdict and is reported; it must still have completed.
verdict() {
  curl -fsS -H 'Accept: application/vnd.github+json' \
    "$api/repos/$repo/commits/$sha/check-runs?per_page=100" \
  | python3 -c '
import json, os, sys
runs = json.load(sys.stdin)["check_runs"]
allowed = {n.strip() for n in os.environ.get("CI_GATE_ALLOW_RED", "").split(",") if n.strip()}
bad = [r for r in runs
       if r["status"] == "completed" and r["conclusion"] not in ("success", "skipped", "neutral")]
red = sorted({"%s (%s)" % (r["name"], r["conclusion"]) for r in bad if r["name"] not in allowed})
waived = sorted({r["name"] for r in bad if r["name"] in allowed})
open_ = [r for r in runs if r["status"] != "completed"]
if red:
    print("fail", ", ".join(red))
elif not runs or open_:
    print("pending %d/%d" % (len(runs) - len(open_), len(runs)))
else:
    print("pass %d" % len(runs) + (" allowed red: " + ", ".join(waived) if waived else ""))
'
}

deadline=$(( $(date +%s) + wait_secs ))
while :; do
  line=$(verdict 2>/dev/null) || line="pending (API unreachable)"
  case "$line" in
    pass*allowed*)
      echo "[ci-gate] WARN: $short: shipping with ${line#*allowed } (CI_GATE_ALLOW_RED)." >&2
      exit 0 ;;
    pass*)
      echo "[ci-gate] $short: ${line#pass } checks passed."
      exit 0 ;;
    fail*)
      echo "[ci-gate] ERROR: $short has red checks: ${line#fail }" >&2
      echo "         Fix and push. If only a check unrelated to this change is red (a new" >&2
      echo "         advisory on unchanged deps), CI_GATE_ALLOW_RED=<check> ships past" >&2
      echo "         that one check; SKIP_CI_GATE=1 waives every check." >&2
      exit 1 ;;
    *)
      if (( $(date +%s) >= deadline )); then
        echo "[ci-gate] ERROR: $short still pending after ${wait_secs}s (${line#pending })." >&2
        echo "         No checks at all usually means the sha was never pushed." >&2
        exit 2
      fi
      echo "[ci-gate] $short: ${line#pending } checks done; polling again in ${poll_secs}s."
      sleep "$poll_secs" ;;
  esac
done
