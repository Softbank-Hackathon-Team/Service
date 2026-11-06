#!/bin/sh
# 역방향(온프레 → 클라우드) 로컬 실험장. ADR-031. 사용법: sh tools/reverse-lab/lab.sh up|seed|status|reset|down
#   up     : 키 만들기(처음 한 번) → 컨테이너 4개 → 길 확인
#   seed   : 온프레 DB 에 앱 표·데이터를 (다시) 넣고, 클라우드 DB 와 양쪽 복제 객체를 비운다 = "처음 이전하는 고객" 상태
#   status : 길(클라우드 → 중계 → 터널 → 온프레)과 양쪽 복제 객체 수
#   reset  : seed 와 같다 (판과 판 사이 초기화)
#   down   : 컨테이너·볼륨 삭제 (키는 남긴다. 지우려면 .state 폴더째)
#   platform      : 로컬 플랫폼 DB 마이그레이션 → api(:3100)·worker 를 platform.env 덮어쓰기로 뒤에서 띄운다 (로그 .state/api.log, worker.log)
#   platform-stop : 위 api·worker 끄기
#   e2e rollback|complete : 실제 api 로 온프레 → AWS 이전을 끝까지 (e2e.ts). 판마다 reset 먼저
set -eu
cd "$(dirname "$0")"
DC="docker compose -p svc-reverse-lab"
S=.state

keys() {
  [ -f "$S/tunnel_ed25519" ] && return 0
  mkdir -p "$S"
  # 터널 키(온프레 → 중계 로그인)와 중계 호스트 키. 실제로는 이전마다 마스터 키에서 파생한다 (migration-secrets.ts)
  ssh-keygen -q -t ed25519 -N "" -C reverse-lab-tunnel -f "$S/tunnel_ed25519"
  ssh-keygen -q -t ed25519 -N "" -C reverse-lab-relay -f "$S/host_ed25519"
  # 호스트 키 고정 (StrictHostKeyChecking=yes): 처음 보는 키는 거부 = TOFU 없음
  printf 'relay %s\n' "$(cut -d' ' -f1,2 "$S/host_ed25519.pub")" > "$S/known_hosts"
  chmod 644 "$S"/*.pub "$S/known_hosts"; chmod 644 "$S/tunnel_ed25519" "$S/host_ed25519"   # 컨테이너가 복사해 600 으로 쓴다
}

# 컨테이너 안 psql. $1 = 서비스, $2 = 접속 문자열, 나머지 = psql 인자
psqlin() { svc=$1; url=$2; shift 2; $DC exec -T "$svc" psql "$url" -X -q -v ON_ERROR_STOP=1 "$@"; }
# 초기화용: 결과 표·NOTICE 를 숨긴다 (오류는 그대로 보인다)
psqlq() { psqlin "$@" -o /dev/null -c "SET client_min_messages = warning" -f - ; }
ONPREM_SU="postgres://postgres:lab-onprem-super@localhost:5432/shop"
CLOUD_SU="postgres://postgres:lab-cloud-super@localhost:5432/shop"

seed() {
  # 양쪽 복제 객체 정리 (구독 → 슬롯 → 발행 → 복제 전용 계정 → _repl). superuser 로 하는 것은 실험장 초기화뿐이다 (이전 흐름은 superuser 를 안 쓴다)
  for pair in "cloud-pg $CLOUD_SU" "onprem-pg $ONPREM_SU"; do
    set -- $pair
    psqlq "$1" "$2" <<'SQL'
DO $$ DECLARE s record; BEGIN
  FOR s IN SELECT subname FROM pg_subscription LOOP
    EXECUTE format('ALTER SUBSCRIPTION %I DISABLE', s.subname);
    EXECUTE format('ALTER SUBSCRIPTION %I SET (slot_name = NONE)', s.subname);
    EXECUTE format('DROP SUBSCRIPTION %I', s.subname);
  END LOOP;
END $$;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename LIKE 'repl\\_%\\_u' OR backend_type = 'walsender';
SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_type = 'logical' AND NOT active;
DO $$ DECLARE p record; r record; BEGIN
  FOR p IN SELECT pubname FROM pg_publication LOOP EXECUTE format('DROP PUBLICATION %I', p.pubname); END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'repl\_%\_u' LOOP
    EXECUTE format('DROP OWNED BY %I', r.rolname); EXECUTE format('DROP ROLE %I', r.rolname);
  END LOOP;
END $$;
DROP SCHEMA IF EXISTS _repl CASCADE;
ALTER DATABASE shop RESET default_transaction_read_only;
SQL
  done
  # 클라우드(도착): 앱 표 없음 = DB-T5(도착이 비어 있다) 통과 상태. 표 구조는 이전이 복사한다 (copySchema)
  echo "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION app; DROP ROLE IF EXISTS shop_app;" | psqlq cloud-pg "$CLOUD_SU"
  # 온프레(출발): 앱 표는 앱 계정(shop_app = DB 주인) 소유. 쓰기 권한 복구 (지난 판의 울타리가 남았으면 걷힌다)
  psqlq onprem-pg "postgres://shop_app:lab-shop-app@localhost:5432/shop" <<'SQL'
DROP TABLE IF EXISTS orders, customers;
CREATE TABLE customers (id bigserial PRIMARY KEY, name text NOT NULL, visits int NOT NULL DEFAULT 0);
CREATE TABLE orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers(id),
                     item text NOT NULL, amount int NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO customers(name) SELECT 'c' || g FROM generate_series(1, 50) g;
INSERT INTO orders(customer_id, item, amount) SELECT 1 + g % 50, 'seed-' || g, g FROM generate_series(1, 500) g;
SQL
  echo "seed: 온프레 customers 50, orders 500 / 클라우드 빈 상태 / 양쪽 복제 객체 0"
  hostcheck
}

# 호스트 입구(127.0.0.1:56432·56433)가 정말 이 실험장의 DB 로 가는지 본다. 2026-11-07 실측: Docker Desktop 에 오후 실험장이 남아
#   포트를 쥔 채 OrbStack 에 새 실험장을 띄우니, 시험은 낡은 DB(남은 구독으로 초기 복사가 멈춤)에 붙고 reset 은 새 DB 만 비웠다 (조용히 실패)
#   → 컨테이너 안에서 본 postmaster 시작 시각과 호스트 입구로 본 시각이 다르면 멈춘다
hostcheck() {
  for pair in "onprem-pg 56432 postgres://svc_migrate:lab-svc-migrate@127.0.0.1:56432/shop $ONPREM_SU" "cloud-pg 56433 postgres://app:lab-cloud-admin@127.0.0.1:56433/shop $CLOUD_SU"; do
    set -- $pair
    inside=$(psqlin "$1" "$4" -At -c "SELECT pg_postmaster_start_time()::text")
    outside=$(cd "$ROOT" && node -e 'const pg=require("pg");const c=new pg.Client(process.argv[1]);c.connect().then(()=>c.query("SELECT pg_postmaster_start_time()::text t")).then(r=>{console.log(r.rows[0].t);return c.end()}).catch(e=>{console.log("ERR "+e.message);process.exit(0)})' "$3")
    if [ "$inside" != "$outside" ]; then
      echo "실패: 호스트 입구 127.0.0.1:$2 가 이 실험장의 $1 이 아닌 다른 DB 로 간다 (안: $inside / 입구: $outside)." >&2
      echo "  다른 Docker 엔진에 실험장이 또 떠 있나 본다: docker context ls, docker --context <이름> ps | grep reverse-lab → 그쪽을 stop" >&2
      return 1
    fi
  done
}

status() {
  echo "== 길: 클라우드 DB → 중계:5432 → 터널(-R) → 온프레 DB (svc_migrate)"
  psqlin cloud-pg "postgres://svc_migrate:lab-svc-migrate@relay:5432/shop?connect_timeout=5" -At \
    -c "SELECT 'ok: ' || current_user || ' @ ' || inet_server_addr() || ' orders=' || (SELECT count(*) FROM orders)" 2>&1 \
    || echo "실패: 터널이 아직 안 붙었거나 끊겼다 ($DC logs tunnel relay)"
  echo "== 길: 온프레 DB → 터널(-L) → 중계 → 클라우드 DB (롤백 창 역복제 길)"
  psqlin onprem-pg "postgres://app:lab-cloud-admin@tunnel:5432/shop?connect_timeout=5" -At -c "SELECT 'ok: ' || current_user" 2>&1 \
    || echo "실패: 정방향 입구"
  for pair in "onprem-pg $ONPREM_SU" "cloud-pg $CLOUD_SU"; do
    set -- $pair
    printf '== %s: ' "$1"
    psqlin "$1" "$2" -At -c "SELECT 'slots=' || (SELECT count(*) FROM pg_replication_slots) || ' pubs=' || (SELECT count(*) FROM pg_publication)
      || ' subs=' || (SELECT count(*) FROM pg_subscription) || ' repl_users=' || (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'repl\_%\_u')
      || ' _repl=' || (SELECT count(*) FROM pg_namespace WHERE nspname = '_repl')
      || ' orders=' || coalesce((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'orders')::text, '-')"
  done
  echo "== 호스트 입구: 온프레 관리 127.0.0.1:56432 (svc_migrate), 클라우드 관리 127.0.0.1:56433 (app)"
  hostcheck && echo "ok: 호스트 입구가 이 실험장 DB 로 간다"
}

ROOT=$(cd ../.. && pwd)
platform() {
  mkdir -p "$S"
  platform_stop >/dev/null 2>&1 || true
  # 플랫폼 DB 마이그레이션: 맥에 psql 이 없으면 compose 의 migrate 컨테이너로 (package.json db:up 과 같은 길)
  #   실패해도 멈추지 않는다 (예: 표는 있는데 기록이 빠진 로컬 DB). 상태는 docker compose run --rm migrate --status 로 본다
  if command -v psql >/dev/null; then (cd "$ROOT" && sh tools/db-migrate.sh >/dev/null 2>&1)
  else (cd "$ROOT" && docker compose run --rm migrate >/dev/null 2>&1); fi \
    || echo "경고: 로컬 플랫폼 DB 마이그레이션 실패. 계속한다 (docker compose run --rm migrate 로 원인 확인)"
  # 로그·pid 는 절대 경로로 (예전엔 하위 셸 안 $OLDPWD 로 잡아, 셸에 따라 레포 맨 위를 가리켜 api.pid 쓰기가 실패하고 worker 가 안 떴다. 2026-11-07 실측)
  st="$(pwd)/$S"
  for app in api worker; do
    (cd "$ROOT/apps/$app" && nohup npx tsx --env-file=../../.env --env-file=../../tools/reverse-lab/platform.env src/main.ts \
      < /dev/null > "$st/$app.log" 2>&1 & echo $! > "$st/$app.pid")
  done
  for i in $(seq 1 60); do curl -fs -o /dev/null "http://localhost:3100/api/v1/migrations" -H 'x-dev-tenant: 11111111-1111-4111-8111-111111111111' && break; sleep 1; done
  echo "api :3100, worker 뒤에서 돎 (로그 tools/reverse-lab/$S/api.log, worker.log). 같은 로컬 DB 를 보는 다른 worker 는 꺼 둔다 (작업을 가로챈다)"
}
platform_stop() {
  for app in api worker; do
    [ -f "$S/$app.pid" ] || continue
    pid=$(cat "$S/$app.pid"); pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; rm -f "$S/$app.pid"
  done
  echo "api·worker 끔"
}

case "${1:-}" in
  up) keys; $DC up -d --build --wait; seed; status ;;
  seed|reset) seed ;;
  status) status ;;
  down) $DC down -v ;;
  platform) platform ;;
  platform-stop) platform_stop ;;
  e2e) (cd "$ROOT" && node --import tsx tools/reverse-lab/e2e.ts "${2:-rollback}") ;;
  *) echo "사용법: $0 up|seed|status|reset|down|platform|platform-stop|e2e rollback|complete" >&2; exit 2 ;;
esac
