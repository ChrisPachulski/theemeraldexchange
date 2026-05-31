#!/usr/bin/env bash
# scripts/autoloop/install.sh — render + (un)install the autoloop launchd agent.
#
#   install.sh            # render template with this machine's paths, load agent
#   install.sh uninstall  # unload + remove the agent
#
# Installing only SCHEDULES the supervisor (every 10 min). It does nothing until
# you set MASTER: ON in .autoloop/CONTROL.md. RunAtLoad is false, so install
# never triggers an immediate run.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST_NAME="com.eex.autoloop.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"
TEMPLATE="$REPO/scripts/autoloop/com.eex.autoloop.plist.template"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl unload "$DEST" 2>/dev/null || true
  rm -f "$DEST"
  echo "uninstalled: $DEST"
  exit 0
fi

NODE_BIN="$(node -e 'process.stdout.write(process.execPath)')"
NODE_DIR="$(dirname "$NODE_BIN")"

# Render template → installed plist with concrete paths (kept out of git).
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__NODE__#${NODE_BIN}#g" \
    -e "s#__REPO__#${REPO}#g" \
    -e "s#__PATH__#${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin#g" \
    "$TEMPLATE" > "$DEST"

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "installed + loaded: $DEST"
echo "scheduled every 600s. ARM by setting MASTER: ON in $REPO/.autoloop/CONTROL.md"
echo "kill fast:  touch $REPO/.autoloop/STOP   (or set MASTER: OFF)"
