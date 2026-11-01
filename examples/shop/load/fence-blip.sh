#!/bin/bash
set -u
cd "$(dirname "$0")/.."
RETRIES="${RETRIES:-3}"
BLIP_SEC="${BLIP_SEC:-0.15}"
(
  for i in $(seq 1 9); do
    sleep 2
    docker compose exec -T db psql -U postgres -d shop -qtA \
      -c "REVOKE INSERT, UPDATE ON ALL TABLES IN SCHEMA shop FROM app" \
      -c "SELECT pg_sleep($BLIP_SEC)" \
      -c "GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA shop TO app" >/dev/null
  done
) &
DURATION_SEC=20 docker compose --profile load run --rm -e RETRIES="$RETRIES" load
wait
