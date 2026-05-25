#!/bin/sh
set -e

mkdir -p /data /data/hf-cache

if [ ! -f /data/.ownership-v1 ]; then
  chown -R recommender:recommender /data
  touch /data/.ownership-v1
  chown recommender:recommender /data/.ownership-v1
else
  if [ "$(stat -c '%u:%g' /data)" != "10001:10001" ]; then
    chown recommender:recommender /data
  fi
  if [ "$(stat -c '%u:%g' /data/hf-cache)" != "10001:10001" ]; then
    chown recommender:recommender /data/hf-cache
  fi
fi

exec gosu recommender "$@"
