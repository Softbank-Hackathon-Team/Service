#!/bin/sh
# Z31: 가동 중 앱 + 실제 복제 이전 1회. MODE=dbhold (앱 → DB 붙잡기 프록시 → 출발/도착) | none (앱 → 출발 DB 직접, 지금 통합본과 같음)
# 전제: 플랫폼 DB(5432) 마이그레이션 끝, 출발 55432 / 도착 55433 Postgres(wal_level=logical), Service 폴더에서 실행
# MODE=pgbouncer (Z64): 앱 → 진짜 PgBouncer(트랜잭션 풀링) → 출발/도착. 제어는 pgbouncer-control.ts (같은 /pause /resume 계약)
#   전제: pgbouncer 1.22+ 가 PATH 에 있다 (맥: brew install pgbouncer, 리눅스: apt install pgbouncer)
# MODE=deadlink: 제어 주소가 죽은 프록시 (pause 실패 → 펜스 전에 멈춤)
# 사용: MODE=dbhold RUN=1 sh tools/load/live-app/run-z31.sh
set -eu
MODE=${MODE:-dbhold}; RUN=${RUN:-1}; OUT=${OUT:-/tmp/z31}; mkdir -p "$OUT"
SHOP_DIR=$(pwd)/examples/shop
export SHOP_DIR APP_DB_PASSWORD=${APP_DB_PASSWORD:-app_pw}
LOG="$OUT/$MODE${ROLLBACK_AFTER_CUTOVER:+-rb}-$RUN"
PGHOST=localhost sh tools/load/live-app/reset-shop-db.sh
export REPL_SOURCE_URL=postgres://postgres@localhost:55432/shop REPL_SOURCE_APP_ROLE=app REPL_SOURCE_SCHEMA=shop
export REPL_TARGET_URL=postgres://postgres@localhost:55433/shop REPL_TARGET_APP_ROLE=app REPL_TARGET_SCHEMA=shop
if [ "$MODE" = dbhold ]; then
  export APP_LINK_URLS=http://127.0.0.1:6480
  DBPROXY_UPSTREAMS=source=127.0.0.1:55432,target=127.0.0.1:55433 node packages/dbproxy/src/proxy.ts > "$LOG.dbproxy.log" 2>&1 &
  echo $! > "$OUT/pids"; APP_DB_PORT=6432
elif [ "$MODE" = pgbouncer ]; then
  export APP_LINK_URLS=http://127.0.0.1:6480
  PGB_DIR=${PGB_DIR:-$OUT/pgb}; mkdir -p "$PGB_DIR"
  # pgbouncer 는 root 로 안 돈다. root 면 -u postgres (설정 폴더는 그 계정이 쓸 수 있어야 한다)
  PGB_U=""; [ "$(id -u)" = 0 ] && PGB_U="-u postgres" && chmod 777 "$PGB_DIR"
  sed "s#@DIR@#$PGB_DIR#g" tools/load/live-app/pgbouncer/pgbouncer.local.ini > "$PGB_DIR/pgbouncer.ini"
  # 시험용 비밀번호만 (실환경은 Secret 마운트). 앱 계정 app / 관리 계정 pgb_admin
  printf '"app" "%s"\n"pgb_admin" "%s"\n' "$APP_DB_PASSWORD" "${PGB_ADMIN_PASSWORD:-pgb_admin_pw}" > "$PGB_DIR/userlist.txt"
  printf '[databases]\nshop = host=127.0.0.1 port=55432 dbname=shop\n' > "$PGB_DIR/databases.ini"
  (cd "$PGB_DIR" && pgbouncer $PGB_U "$PGB_DIR/pgbouncer.ini" > "$LOG.pgbouncer.log" 2>&1) & echo $! > "$OUT/pids"
  sleep 0.5
  PGB_ADMIN_URL=postgres://pgb_admin:${PGB_ADMIN_PASSWORD:-pgb_admin_pw}@127.0.0.1:6432/pgbouncer PGB_DB=shop PGB_DB_FILE="$PGB_DIR/databases.ini" \
    DBPROXY_UPSTREAMS=source=127.0.0.1:55432,target=127.0.0.1:55433 node packages/dbproxy/src/pgbouncer-control.ts > "$LOG.pgbctl.log" 2>&1 & echo $! >> "$OUT/pids"
  APP_DB_PORT=6432
elif [ "$MODE" = deadlink ]; then
  # 프록시 제어가 죽은 경우: pause 가 실패해야 하고, 펜스 전에 멈춰 앱은 출발에 계속 써야 한다
  export APP_LINK_URLS=http://127.0.0.1:1 APP_LINK_TIMEOUT_MS=300; : > "$OUT/pids"; APP_DB_PORT=55432
else
  unset APP_LINK_URLS || true; : > "$OUT/pids"; APP_DB_PORT=55432
fi
sleep 0.5
PORT=8080 DB_HOST=127.0.0.1 DB_PORT=$APP_DB_PORT DB_PASSWORD=$APP_DB_PASSWORD node examples/shop/app/src/server.mjs > "$LOG.app.log" 2>&1 & echo $! >> "$OUT/pids"
(cd apps/api && npx tsx --env-file=../../.env src/main.ts > "$LOG.api.log" 2>&1) & echo $! >> "$OUT/pids"
for w in 1 2 3; do (cd apps/worker && WORKER_ID=w$w npx tsx --env-file=../../.env src/main.ts > "$LOG.worker$w.log" 2>&1) & echo $! >> "$OUT/pids"; done
for i in $(seq 1 60); do curl -sf localhost:3000/healthz >/dev/null && curl -sf localhost:8080/healthz >/dev/null && break; sleep 0.5; done
WRITER_URL=http://localhost:8080 SHOP_DIR=$SHOP_DIR RETRIES=${RETRIES:-0} DBPROXY_CONTROL=$([ "$MODE" = dbhold ] || [ "$MODE" = pgbouncer ] && echo http://127.0.0.1:6480 || echo "") \
  npx tsx --env-file=.env tools/load/live-app/live-migration.ts > "$LOG.result.txt" 2>&1 || echo "live-migration exit $?" >> "$LOG.result.txt"
ACK=$(grep '^ACK_FILE' "$LOG.result.txt" | cut -d' ' -f2)
MID=$(grep '^MIGRATION_ID' "$LOG.result.txt" | cut -d' ' -f2)
VERIFY_PORT=55433; [ "${ROLLBACK_AFTER_CUTOVER:-}" = 1 ] && VERIFY_PORT=55432
[ -n "$ACK" ] && (cd examples/shop/app && DB_HOST=127.0.0.1 DB_PORT=$VERIFY_PORT DB_PASSWORD=$APP_DB_PASSWORD node src/verify.mjs < "$ACK") >> "$LOG.result.txt" 2>&1 || true
[ -n "$MID" ] && psql postgres://platform_owner:owner_pw@localhost:5432/platform -XAtc "SELECT action, detail->'appLink', detail->'replication' FROM audit_events WHERE target='$MID' AND (action LIKE 'cutover.%' OR action LIKE 'rollback.%')" >> "$LOG.result.txt" 2>&1 || true
# 끄기: pid 로 (pkill -f 는 이 셸까지 죽일 수 있다)
for p in $(cat "$OUT/pids"); do kill $p 2>/dev/null || true; done
sleep 1; for p in $(pgrep -f "src/main.ts" || true); do kill $p 2>/dev/null || true; done
pgrep -f "dbproxy/src/proxy.ts" | xargs -r kill 2>/dev/null || true
pgrep -f "dbproxy/src/pgbouncer-control.ts" | xargs -r kill 2>/dev/null || true
pgrep -x pgbouncer | xargs -r kill 2>/dev/null || true
pgrep -f "shop/app/src/server.mjs" | xargs -r kill 2>/dev/null || true
sleep 1
cat "$LOG.result.txt"
