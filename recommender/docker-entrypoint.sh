#!/bin/sh
set -e

mkdir -p /data /data/hf-cache
chown -R recommender:recommender /data

exec gosu recommender "$@"
