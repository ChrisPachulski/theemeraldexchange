#!/usr/bin/env bash
# scripts/autoloop/start-loop.sh — launch the pure-Claude autoloop in tmux.
#
# Starts a fresh interactive Claude Code session in a detached tmux session and
# kicks off /loop with the driver prompt. 100% Claude, never `claude -p`. The
# loop self-gates on the window via claude-guard.mjs every iteration.
#
# REFUSES unless you've armed it (MASTER: ON) — arming is deliberate.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="eex-autoloop"
cd "$REPO"

if ! grep -qE '^[[:space:]]*MASTER:[[:space:]]*ON' .autoloop/CONTROL.md 2>/dev/null; then
  echo "REFUSING: MASTER is not ON in .autoloop/CONTROL.md."
  echo "Arm deliberately: set 'MASTER: ON' there, then re-run this script."
  exit 1
fi

# Record the extra-usage baseline so the guard's overage-freeze is live from t0.
rm -f .autoloop/STOP
node -e 'const fs=require("fs"),os=require("os"),p=require("path");const c=JSON.parse(fs.readFileSync(p.join(os.homedir(),".claude",".usage-cache.json")));fs.mkdirSync(".autoloop",{recursive:true});fs.writeFileSync(".autoloop/claude-baseline.json",JSON.stringify({extra_usage_used_credits:c.extra_usage_used_credits,recorded_at:new Date().toISOString()},null,2));console.log("baseline extra_usage="+c.extra_usage_used_credits)'

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "already running (tmux session: $SESSION). attach: tmux attach -t $SESSION"
  exit 0
fi

PROMPT="/loop Run exactly one iteration by following the instructions in scripts/autoloop/loop-prompt.md, then schedule the next per that file."

tmux new-session -d -s "$SESSION" -c "$REPO"
tmux send-keys -t "$SESSION" "claude" Enter

# Wait for the TUI to actually be ready (boot time varies per machine) — the
# footer shows "bypass permissions" once the prompt accepts input. Poll up to 60s.
ready=0
for _ in $(seq 1 60); do
  if tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -q "bypass permissions"; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "WARN: TUI not confirmed ready after 60s; sending anyway"; }

# Type the prompt, then submit — and VERIFY it submitted (Enter can land before
# the TUI is listening). Retry the Enter until the command leaves the input line.
tmux send-keys -t "$SESSION" "$PROMPT"
sleep 1
submitted=0
for _ in $(seq 1 8); do
  tmux send-keys -t "$SESSION" Enter
  sleep 2
  # If the prompt text is no longer sitting in the input buffer, it submitted.
  if ! tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -q "❯ /loop"; then submitted=1; break; fi
done
if [ "$submitted" = 1 ]; then echo "kicked off /loop (submit verified)."; else echo "WARN: could not confirm /loop submitted — attach and press Enter."; fi

echo "started in tmux session '$SESSION'."
echo "  watch:  tmux attach -t $SESSION   (detach: Ctrl-b then d)"
echo "  stop:   bash scripts/autoloop/stop-loop.sh   (or set MASTER: OFF, or touch .autoloop/STOP)"
