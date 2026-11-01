#!/bin/bash
set -u
cd "$(dirname "$0")/.."
RETRIES="${RETRIES:-3}"
(
  for i in $(seq 1 9); do
    sleep 2
    docker compose exec -T db psql -U postgres -d shop -qtAc "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = 'app'"
  done
) &
DURATION_SEC=20 docker compose --profile load run --rm -e RETRIES="$RETRIES" load
wait
