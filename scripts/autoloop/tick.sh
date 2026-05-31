#!/bin/bash
# scripts/autoloop/tick.sh — launchd entrypoint.
#
# launchd exec'ing node DIRECTLY hangs node in bootstrap on this machine (its
# XPC-service exec context). Routing through bash and launching node DETACHED
# (nohup + background, stdin from /dev/null) reparents node out of that context
# — matching the invocation that works from a normal shell. bash returns
# immediately; the supervisor's own lock prevents overlap with a prior tick.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
nohup node scripts/autoloop/supervisor.mjs </dev/null >>.autoloop/launchd.out.log 2>&1 &
exit 0
