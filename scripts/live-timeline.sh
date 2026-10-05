#!/usr/bin/env bash
# live-timeline.sh — compact live/IPTV playback timeline from the prod backend log.
#
# Prints, oldest first: live grants (with the requesting client's user agent),
# remux manifest fetches, session DELETEs, and the remux engine's lifecycle
# lines (ffmpeg input/exit, storms, idle sweeps). Session-list polling, EPG
# traffic, segment fetches and per-frame ffmpeg warnings are dropped, and each
# line is cut to 220 chars. Filtering runs on the NAS so only the timeline
# crosses SSH.
#
# Reading it: a grant `-->` 200 followed by NO `remux/index.m3u8` line means the
# client died before requesting the stream (look at the client, not the server).
#
# Usage: scripts/live-timeline.sh [since]     since: docker logs --since (default 1h)
# Env:   NAS_HOST (theemeraldexchange)  NAS_USER (root)  CONTAINER (exchange-backend)
set -euo pipefail

since="${1:-1h}"
nas="${NAS_USER:-root}@${NAS_HOST:-theemeraldexchange}"
container="${CONTAINER:-exchange-backend}"

ssh "$nas" "docker logs --since '$since' -t '$container' 2>&1 \
  | grep -E '(<-- POST /api/iptv/stream/live/[0-9]+/grant)|(--> (POST|GET|DELETE) /api/iptv/(stream/live/|sessions/))|(\[iptv-remux\] (Input #0|ffmpeg exited|timestamp-discontinuity storm|remux session stopped|throttl|cooldown))' \
  | grep -v 'remux/seg' \
  | cut -c1-220"
