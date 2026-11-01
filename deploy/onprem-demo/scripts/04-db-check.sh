#!/usr/bin/env bash
# DRAFT(ai) DB 이전(@svc/replication)이 이 Postgres 를 도착으로 쓸 수 있는지 확인
# 비밀번호는 Secret 에서 읽어 바로 쓰고 화면에 찍지 않는다
source "$(dirname "$0")/lib.sh"
pod=$(kc -n "$NS" get pod -l "cnpg.io/cluster=${APP}-db,cnpg.io/instanceRole=primary" -o jsonpath='{.items[0].metadata.name}')
q() { kc -n "$NS" exec "$pod" -c postgres -- psql -U postgres -d "$APP" -tAc "$1"; }
echo "primary=$pod"
echo "wal_level=$(q 'show wal_level')"
echo "max_replication_slots=$(q 'show max_replication_slots')"
echo "repl_role=$(q "select rolname||' replication='||rolreplication from pg_roles where rolname='repl'")"
echo "app_owner=$(q "select datname||' owner='||pg_get_userbyid(datdba) from pg_database where datname='${APP}'")"
kc -n "$NS" get secret "${APP}-db-superuser" >/dev/null && echo "superuser_secret=${APP}-db-superuser (있음)"

step "맥에서 바깥 길로 접속 (localhost:${DB_HOST_PORT} → NodePort 30432)"
PW=$(kc -n "$NS" get secret "${APP}-db-superuser" -o jsonpath='{.data.password}' | base64 -d)
docker run --rm -e PGPASSWORD="$PW" postgres:16-alpine \
  psql "host=host.docker.internal port=${DB_HOST_PORT} user=postgres dbname=${APP} sslmode=require" -tAc "select 'external ok '||version()"
