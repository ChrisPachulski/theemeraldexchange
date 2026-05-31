#!/usr/bin/env bash
# scripts/autoloop/arm.sh — arm the FIRST RUN with a hard 24h auto-kill.
#
# Sets a now+24h deadline, loads the 10-min scheduler AND the absolute-time
# killer launchd agents, records the Claude over-bill baseline, flips MASTER: ON,
# and emails an ARMED notice. The killer fires at the wall-clock deadline no
# matter what (survives sleep/reboot); the governor also self-kills at the
# deadline as a fast path.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
AUTOLOOP="$REPO/.autoloop"
# Notify recipient resolved from env or git identity — never hardcoded in source.
NOTIFY_TO="${AUTOLOOP_NOTIFY_TO:-$(git -C "$REPO" config user.email 2>/dev/null || true)}"
LA="$HOME/Library/LaunchAgents"
NODE_BIN="$(node -e 'process.stdout.write(process.execPath)')"
PATHV="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$AUTOLOOP" "$LA"

# Deadline = now + 24h (local time). Compute fields in node so launchd integers
# are unpadded (a plist <integer>07</integer> is invalid).
read -r DEADLINE_ISO DMONTH DDAY DHOUR DMIN < <(node -e "const d=new Date(Date.now()+24*3600*1000);const z=n=>String(n).padStart(2,'0');console.log([d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate())+'T'+z(d.getHours())+':'+z(d.getMinutes())+':'+z(d.getSeconds()),(d.getMonth()+1),d.getDate(),d.getHours(),d.getMinutes()].join(' '))")
echo "$DEADLINE_ISO" > "$AUTOLOOP/DEADLINE"
rm -f "$AUTOLOOP/STOP"

# Record the Claude extra_usage baseline so the over-bill tripwire is live.
node -e "const fs=require('fs'),os=require('os'),p=require('path');const c=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude','.usage-cache.json')));fs.writeFileSync('$AUTOLOOP/claude-baseline.json',JSON.stringify({extra_usage_used_credits:c.extra_usage_used_credits,recorded_at:new Date().toISOString()},null,2))"

# Scheduler agent (every 10 min).
sed -e "s#__NODE__#${NODE_BIN}#g" -e "s#__REPO__#${REPO}#g" -e "s#__PATH__#${PATHV}#g" \
  "$REPO/scripts/autoloop/com.eex.autoloop.plist.template" > "$LA/com.eex.autoloop.plist"
launchctl unload "$LA/com.eex.autoloop.plist" 2>/dev/null || true
launchctl load "$LA/com.eex.autoloop.plist"

# Killer agent (fires at the absolute deadline).
sed -e "s#__REPO__#${REPO}#g" -e "s#__PATH__#${PATHV}#g" \
    -e "s#__MONTH__#${DMONTH}#g" -e "s#__DAY__#${DDAY}#g" -e "s#__HOUR__#${DHOUR}#g" -e "s#__MINUTE__#${DMIN}#g" \
  "$REPO/scripts/autoloop/com.eex.autoloop-killer.plist.template" > "$LA/com.eex.autoloop-killer.plist"
launchctl unload "$LA/com.eex.autoloop-killer.plist" 2>/dev/null || true
launchctl load "$LA/com.eex.autoloop-killer.plist"

# ARM.
sed -i '' -E 's/^MASTER:[[:space:]]*OFF/MASTER: ON/' "$AUTOLOOP/CONTROL.md"

[ -n "$NOTIFY_TO" ] && gws gmail +send --to "$NOTIFY_TO" \
  --subject "[autoloop] ARMED — first run, auto-kill $DEADLINE_ISO" \
  --body "Autoloop P2 first run is ARMED.
- engine: codex (flat-rate; cannot over-bill Claude)
- scope: discover -> worktree fix -> commit -> push branch; NEVER main, NEVER deploy
- cap: 6 branches (FIRST_RUN_MAX_BRANCHES)
- HARD KILL at: $DEADLINE_ISO (killer launchd agent + governor self-kill)
- kill now: touch $AUTOLOOP/STOP  (or set MASTER: OFF, or run kill-switch.sh)
Errors, issues, and the final cancellation will be emailed here." 2>/dev/null || true

echo "ARMED. hard auto-kill at: $DEADLINE_ISO"
launchctl list | grep -i eex.autoloop || true
