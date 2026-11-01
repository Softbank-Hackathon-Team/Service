#!/bin/sh
# 샘플 앱 출발·도착 DB 를 처음 상태로 (출발 = 시드 포함, 도착 = 빈 스키마). 펜스·구독·슬롯도 같이 사라진다
# 사용: SHOP_DIR=<M 의 sample-app> SRC_PORT=55432 TGT_PORT=55433 sh reset-shop-db.sh
set -eu
: "${SHOP_DIR:?SHOP_DIR}"
export PGHOST=${PGHOST:-localhost} PGUSER=postgres PGPASSWORD=${PG_SUPERUSER_PASSWORD:-pw} POSTGRES_USER=postgres POSTGRES_DB=shop APP_DB_PASSWORD=${APP_DB_PASSWORD:-app_pw}
for P in ${TGT_PORT:-55433} ${SRC_PORT:-55432}; do
  psql -p $P -d postgres -qtAc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='shop' AND pid<>pg_backend_pid()" >/dev/null
  psql -p $P -d shop -qtAc "SELECT subname FROM pg_subscription" 2>/dev/null | while read s; do [ -n "$s" ] && psql -p $P -d shop -qc "ALTER SUBSCRIPTION \"$s\" DISABLE; ALTER SUBSCRIPTION \"$s\" SET (slot_name=NONE); DROP SUBSCRIPTION \"$s\""; done
  psql -p $P -d postgres -qtAc "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database='shop'" >/dev/null
  psql -p $P -d postgres -qc "DROP DATABASE IF EXISTS shop" -c "DROP ROLE IF EXISTS app" -c "DROP ROLE IF EXISTS shop_owner" -c "CREATE DATABASE shop"
  PGPORT=$P sh "$SHOP_DIR/db/01-roles.sh" >/dev/null
  PGPORT=$P psql -q -d shop -v ON_ERROR_STOP=1 -f "$SHOP_DIR/db/02-schema.sql"
done
PGPORT=${SRC_PORT:-55432} psql -q -d shop -v ON_ERROR_STOP=1 -v scale=${SEED_SCALE:-1} -f "$SHOP_DIR/seed/seed.sql" >/dev/null
echo "shop db reset"
