#!/usr/bin/env bash
# scripts/autoloop/stop-loop.sh — halt the pure-Claude autoloop.
# Trips the canonical breaker, disarms, kills the tmux session, clears the lock.
# Leaves the dedicated worktree in place (reused on next start; remove manually
# with `git worktree remove <repo>-loopwt` if you want it gone).
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
AUTOLOOP_DIR="$REPO/.autoloop"
echo "stop $(date -u +%FT%TZ)" > "$AUTOLOOP_DIR/STOP"
sed -i '' -E 's/^([[:space:]]*MASTER:[[:space:]]*)ON/\1OFF/' "$AUTOLOOP_DIR/CONTROL.md" 2>/dev/null || true
rm -f "$AUTOLOOP_DIR/loop.lock"
tmux kill-session -t eex-autoloop 2>/dev/null && echo "killed tmux session eex-autoloop" || echo "no tmux session running"
echo "stopped: MASTER OFF, STOP set, lock cleared. (delete .autoloop/STOP before re-arming)"
