#!/usr/bin/env bash
# scripts/autoloop/start-loop.sh — launch the pure-Claude autoloop in tmux,
# ISOLATED in its own git worktree on the integration branch (see ARCHITECTURE.md).
#
# Why a worktree: the loop must not share a working tree / HEAD / index with your
# interactive Claude sessions (that caused ref-races and "HEAD moved under me").
# It runs on auto/integration in <repo>-loopwt; main stays human-gated.
#
# Control/state stay CANONICAL: the loop reads CONTROL.md / STOP / baseline from
# the MAIN repo's .autoloop (AUTOLOOP_DIR), so `touch .autoloop/STOP` and
# MASTER: OFF in your normal checkout halt the loop instantly.
#
# REFUSES unless armed (MASTER: ON) and refuses if another loop is already live.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="eex-autoloop"
INTEGRATION="auto/integration"
WT="${REPO}-loopwt"
AUTOLOOP_DIR="$REPO/.autoloop"
LOCK="$AUTOLOOP_DIR/loop.lock"
cd "$REPO"

if ! grep -qE '^[[:space:]]*MASTER:[[:space:]]*ON' "$AUTOLOOP_DIR/CONTROL.md" 2>/dev/null; then
  echo "REFUSING: MASTER is not ON in .autoloop/CONTROL.md. Set 'MASTER: ON' then re-run."
  exit 1
fi

# Single-loop invariant: never run two mutating loops (they share the account window + risk contention).
if [ -f "$LOCK" ] && tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "REFUSING: a loop is already live (lock $LOCK + tmux $SESSION). Stop it first."
  exit 1
fi

# Record the extra-usage baseline so the guard's overage-freeze is live from t0.
rm -f "$AUTOLOOP_DIR/STOP"
node -e 'const fs=require("fs"),os=require("os"),p=require("path");const dir=process.argv[1];const c=JSON.parse(fs.readFileSync(p.join(os.homedir(),".claude",".usage-cache.json")));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,"claude-baseline.json"),JSON.stringify({extra_usage_used_credits:c.extra_usage_used_credits,recorded_at:new Date().toISOString()},null,2));console.log("baseline extra_usage="+c.extra_usage_used_credits)' "$AUTOLOOP_DIR"

# Ensure the integration branch exists (= main today; accumulates confirmed work).
if ! git show-ref --verify --quiet "refs/heads/$INTEGRATION"; then
  git branch "$INTEGRATION" main
  echo "created $INTEGRATION from main"
fi

# Ensure the dedicated worktree exists on the integration branch.
if ! git worktree list --porcelain | grep -qx "worktree $WT"; then
  git worktree add "$WT" "$INTEGRATION"
  echo "created worktree $WT on $INTEGRATION"
else
  echo "reusing worktree $WT"
fi

echo "loop @ $(date -u +%FT%TZ) wt=$WT branch=$INTEGRATION" > "$LOCK"

PROMPT="/loop Run exactly one iteration by following \$AUTOLOOP_HOME/scripts/autoloop/loop-prompt.md (control+state live in \$AUTOLOOP_DIR, the main checkout's .autoloop). Then schedule the next per that file."

tmux new-session -d -s "$SESSION" -c "$WT"
# Export the canonical paths INTO the session before launching claude.
tmux send-keys -t "$SESSION" "export AUTOLOOP_DIR='$AUTOLOOP_DIR' AUTOLOOP_HOME='$REPO' AUTOLOOP_WT='$WT'" Enter
tmux send-keys -t "$SESSION" "claude" Enter

# Wait for the TUI to be ready (boot varies per machine), then submit + verify.
ready=0
for _ in $(seq 1 60); do
  if tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -q "bypass permissions"; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || echo "WARN: TUI not confirmed ready after 60s; sending anyway"

tmux send-keys -t "$SESSION" "$PROMPT"
sleep 1
submitted=0
for _ in $(seq 1 8); do
  tmux send-keys -t "$SESSION" Enter
  sleep 2
  if ! tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -q "❯ /loop"; then submitted=1; break; fi
done
[ "$submitted" = 1 ] && echo "kicked off /loop (submit verified)." || echo "WARN: could not confirm /loop submitted — attach and press Enter."

echo "started in tmux session '$SESSION' (worktree $WT on $INTEGRATION)."
echo "  watch:  tmux attach -t $SESSION   (detach: Ctrl-b then d)"
echo "  stop:   bash scripts/autoloop/stop-loop.sh   (or MASTER: OFF / touch .autoloop/STOP in THIS checkout)"
