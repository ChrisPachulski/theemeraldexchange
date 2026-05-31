#!/usr/bin/env bash
# scripts/autoloop/stop-loop.sh — halt the pure-Claude autoloop.
# Trips the breaker, disarms, and kills the tmux session.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
echo "stop $(date -u +%FT%TZ)" > "$REPO/.autoloop/STOP"
sed -i '' -E 's/^([[:space:]]*MASTER:[[:space:]]*)ON/\1OFF/' "$REPO/.autoloop/CONTROL.md" 2>/dev/null || true
tmux kill-session -t eex-autoloop 2>/dev/null && echo "killed tmux session eex-autoloop" || echo "no tmux session running"
echo "stopped: MASTER OFF, STOP set. (delete .autoloop/STOP before re-arming)"
