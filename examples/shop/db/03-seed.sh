#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v scale="${SEED_SCALE:-1}" -f /seed/seed.sql
