#!/bin/bash
# exposure-monitor.sh — detects home-IP / origin exposure drift and alerts.
#
# INSTALL (macOS): launchd agents cannot read ~/Documents (TCC-protected), so
# this repo file is the SOURCE; the scheduled copy runs from a non-protected
# path. To (re)install:
#   mkdir -p ~/.local/share/eex-security
#   cp scripts/security/exposure-monitor.sh ~/.local/share/eex-security/
#   launchctl load -w ~/Library/LaunchAgents/com.theemeraldexchange.exposure-monitor.plist
# State (.exposure-baseline.json) + logs live next to the installed copy.
# Run manually any time from the repo:  bash scripts/security/exposure-monitor.sh
#
# Runs locally (launchd/cron), no LLM cost. Three checks, each compared to a
# baseline so it only shouts on CHANGE:
#   1. Public DNS — every known hostname must resolve to Cloudflare or Netlify
#      ranges. Anything else (a residential/ISP IP) = origin leak.
#   2. NAS container port bindings — flags NEW services bound to 0.0.0.0
#      (reachable on the LAN IP, bypassing Cloudflare).
#   3. Plex Remote Access — PublishServerOnPlexOnlineKey must stay 0
#      (1 = Plex is publishing the home WAN IP to plex.tv again).
#
# Drift -> macOS notification + a line in exposure-drift.log. First run writes
# the baseline and stays quiet.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
BASELINE="$HERE/.exposure-baseline.json"
LOG="$HERE/exposure-drift.log"
NAS="root@theemeraldexchange.local"
SSH="ssh -o ConnectTimeout=10 -o BatchMode=yes"

# Hostnames this project exposes. Keep in sync with the tunnel ingress.
HOSTS="theemeraldexchange.com www.theemeraldexchange.com api.theemeraldexchange.com sonarr.theemeraldexchange.com radarr.theemeraldexchange.com sab.theemeraldexchange.com"

# Safe destinations: Cloudflare proxy + Netlify edge prefixes. A resolved A
# record outside these is treated as a potential origin leak.
is_safe_ip() {
  case "$1" in
    104.16.*|104.17.*|104.18.*|104.19.*|104.20.*|104.21.*|104.22.*|104.23.*|104.24.*|104.25.*|104.26.*|104.27.*|104.28.*) return 0 ;; # Cloudflare
    172.64.*|172.65.*|172.66.*|172.67.*|172.68.*|172.69.*|172.70.*|172.71.*) return 0 ;;                                            # Cloudflare
    52.52.192.191|13.52.188.95|75.2.60.5|99.83.190.102|13.215.*|18.165.*) return 0 ;;                                              # Netlify edge
    *) return 1 ;;
  esac
}

ALERTS=""
add_alert() { ALERTS="${ALERTS}- $1\n"; }

# --- 1. DNS ----------------------------------------------------------------
DNS_STATE=""
for h in $HOSTS; do
  ips="$(dig +short A "$h" 2>/dev/null | grep -E '^[0-9.]+$' | sort | tr '\n' ',')"
  DNS_STATE="${DNS_STATE}${h}=${ips};"
  for ip in $(echo "$ips" | tr ',' ' '); do
    [ -z "$ip" ] && continue
    if ! is_safe_ip "$ip"; then
      add_alert "DNS LEAK: $h resolves to $ip (not Cloudflare/Netlify — possible origin/home IP)"
    fi
  done
done

# --- 2 & 3. NAS (ports + Plex) --------------------------------------------
NAS_OUT="$($SSH "$NAS" '
  docker ps --format "{{.Names}} {{.Ports}}" 2>/dev/null | grep -oE "[a-z0-9_-]+ .*0\.0\.0\.0:[0-9-]+" | grep -oE "^[a-z0-9_-]+:?[0-9-]*|0\.0\.0\.0:[0-9-]+" | paste -sd, - ;
  echo "@@@";
  PREF="/mnt/user/appdata/Plex-Media-Server/Library/Application Support/Plex Media Server/Preferences.xml";
  grep -oE "PublishServerOnPlexOnlineKey=\"[^\"]*\"" "$PREF" 2>/dev/null | grep -oE "[0-9]+\"" | tr -d "\"" ;
' 2>/dev/null)"

NAS_PORTS="$(echo "$NAS_OUT" | sed -n '1p')"
PLEX_PUBLISH="$(echo "$NAS_OUT" | awk '/@@@/{getline; print; exit}')"

if [ -n "$PLEX_PUBLISH" ] && [ "$PLEX_PUBLISH" != "0" ]; then
  add_alert "PLEX REMOTE ACCESS RE-ENABLED: PublishServerOnPlexOnlineKey=$PLEX_PUBLISH (publishing home WAN IP to plex.tv). Re-disable in Plex → Settings → Remote Access."
fi

CUR="{\"dns\":\"$DNS_STATE\",\"nas_ports\":\"$NAS_PORTS\",\"plex_publish\":\"$PLEX_PUBLISH\"}"

# --- baseline diff for NEW 0.0.0.0 binds -----------------------------------
if [ -f "$BASELINE" ]; then
  OLD_PORTS="$(grep -oE '"nas_ports":"[^"]*"' "$BASELINE" | sed 's/"nas_ports":"//;s/"$//')"
  for p in $(echo "$NAS_PORTS" | tr ',' ' '); do
    case ",$OLD_PORTS," in *",$p,"*) : ;; *) [ -n "$p" ] && add_alert "NEW PUBLIC BIND: $p now on 0.0.0.0 (LAN-reachable, bypasses Cloudflare). Rebind to 127.0.0.1 if it should only be reached via the tunnel." ;; esac
  done
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$ALERTS" ]; then
  printf "[%s] DRIFT:\n%b\n" "$TS" "$ALERTS" >> "$LOG"
  MSG="$(printf '%b' "$ALERTS" | head -4)"
  osascript -e "display notification \"$(echo "$MSG" | tr '\n' ' ' | sed 's/"/\\"/g')\" with title \"⚠️ EEX exposure drift\" sound name \"Basso\"" 2>/dev/null || true
  echo "DRIFT DETECTED — see $LOG"
else
  echo "[$TS] OK — DNS/ports/Plex all within baseline."
fi

# refresh baseline (always, so a single drift doesn't re-alert forever)
echo "$CUR" > "$BASELINE"
