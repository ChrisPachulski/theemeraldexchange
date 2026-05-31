#!/usr/bin/env bash
# scripts/autoloop/kill-switch.sh — the "no matter what" shutdown.
#
# Idempotent. Invoked by:
#   * the killer launchd agent at the 24h wall-clock deadline (the guarantee), and
#   * the governor's internal deadline gate (fast path), and
#   * a human, any time.
#
# It: sets MASTER: OFF, sets STOP (so any in-flight node aborts on next
# self-check), kills running autoloop processes, unloads BOTH launchd agents,
# and emails a cancellation summary with recent errors. Safe to run repeatedly.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
AUTOLOOP="$REPO/.autoloop"
REASON="${1:-manual}"
LA="$HOME/Library/LaunchAgents"

mkdir -p "$AUTOLOOP"

# 1. Trip the fleet-wide breaker + arm the soft switch.
echo "killed: $REASON @ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$AUTOLOOP/STOP"
if [[ -f "$AUTOLOOP/CONTROL.md" ]]; then
  sed -i '' -E 's/^MASTER:[[:space:]]*ON/MASTER: OFF/' "$AUTOLOOP/CONTROL.md" 2>/dev/null || true
fi

# 2. Kill running autoloop processes (supervisor + orchestrator + their codex).
#    Match our own scripts only — never the user's interactive codex/claude.
pkill -f 'scripts/autoloop/supervisor.mjs'    2>/dev/null || true
pkill -f 'scripts/autoloop/orchestrator.mjs'  2>/dev/null || true
if [[ -f "$AUTOLOOP/loop.pid" ]]; then
  LPID="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pid',''))" "$AUTOLOOP/loop.pid" 2>/dev/null || true)"
  [[ -n "$LPID" ]] && kill "$LPID" 2>/dev/null || true
fi
rm -f "$AUTOLOOP/supervisor.lock"

# 3. Unload BOTH launchd agents (scheduler + this killer) so nothing reschedules.
for label in com.eex.autoloop com.eex.autoloop-killer; do
  launchctl unload "$LA/$label.plist" 2>/dev/null || true
done

# 4. Email a cancellation summary with recent errors/issues.
ERRLOG=""
[[ -f "$AUTOLOOP/errors.log" ]] && ERRLOG="$(tail -50 "$AUTOLOOP/errors.log" 2>/dev/null)"
STATUS=""
[[ -f "$AUTOLOOP/STATUS.json" ]] && STATUS="$(cat "$AUTOLOOP/STATUS.json" 2>/dev/null)"
BRANCHES="$(cd "$REPO" && git branch --list 'auto/*' 2>/dev/null | tr -d ' ' | tr '\n' ' ')"

BODY="autoloop CANCELLED — reason: $REASON
time: $(date -u +%Y-%m-%dT%H:%M:%SZ)

branches produced (review the carnage):
${BRANCHES:-（none）}

latest STATUS.json:
${STATUS:-（none）}

recent errors/issues (tail):
${ERRLOG:-（none logged）}
"
gws gmail +send --to pachun95@gmail.com \
  --subject "[autoloop] CANCELLED ($REASON) $(date +%Y-%m-%d\ %H:%M)" \
  --body "$BODY" 2>/dev/null || true

echo "kill-switch complete: $REASON"
