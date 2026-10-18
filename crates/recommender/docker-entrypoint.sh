#!/bin/sh
set -e

mkdir -p /data

if [ ! -f /data/.ownership-v1 ]; then
  chown -R recommender:recommender /data
  # Write the marker AS recommender, never as root. The hardened container runs
  # cap_drop ALL (only SETUID/SETGID/CHOWN added), so root has NO DAC_OVERRIDE:
  # once the chown above hands /data to recommender, root can no longer create a
  # file inside it (touch → "Permission denied"), which crash-looped a genuinely
  # cold /data volume on first deploy. gosu needs only SETUID/SETGID (granted).
  gosu recommender touch /data/.ownership-v1
elif [ "$(stat -c '%u:%g' /data)" != "10001:10001" ]; then
  chown recommender:recommender /data
fi

exec gosu recommender "$@"
