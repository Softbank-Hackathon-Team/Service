#!/usr/bin/env bash
# DRAFT(ai): examples/shop을 로컬 도커에서 5단계+검증 단계 부하로 돌려 r(λ)를 잰다.
# 클라우드 자원을 만들지 않는다. 결과는 로컬 측정이다.
# 사용: SHOP_DIR=<examples/shop 사본> NODE=<node22> bash measure/run-measure.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../data/measure"
mkdir -p "$OUT"
SHOP_DIR=${SHOP_DIR:?examples/shop 사본 경로}
NODE=${NODE:-node}
PROJECT=costpoc
APP_PORT=18080
export COMPOSE_PROJECT_NAME=$PROJECT APP_PORT DB_PORT=55442 TARGET_DB_PORT=55443 DBPROXY_PORT=56442 DBPROXY_CONTROL_PORT=16480
export PG_SUPERUSER_PASSWORD=local-only-change-me APP_DB_PASSWORD=local-only-change-me-too SEED_SCALE=1 DBPROXY_INSECURE_NO_TOKEN=1
RUN=${RUN:-all}
STAGE_SEC=${STAGE_SEC:-60}
WARM_SEC=${WARM_SEC:-10}

cd "$SHOP_DIR"
docker compose up -d --build --wait db dbproxy app >&2
SQLDB() { docker exec "$PROJECT-db-1" psql -U postgres -d shop -Atc "$1"; }

stage() { # <파일> <mix> <rps> <round>
  local file=$1 mix=$2 rps=$3 round=$4
  local dbsize0 dbsize1 s0 s1 res t0 t1 err
  err=$(mktemp)
  dbsize0=$(SQLDB "select pg_database_size('shop')")
  # 부하를 먼저 띄우고 예열이 끝나면 첫 표본을 뜬다
  "$NODE" "$HERE/load-gen.mjs" "http://127.0.0.1:$APP_PORT" "$rps" "$STAGE_SEC" "$WARM_SEC" "$mix" > "$err.out" 2> "$err" &
  local pid=$!
  until grep -q WINDOW_START "$err"; do sleep 0.2; done
  t0=$(python3 -c 'import time;print(time.time())'); s0=$(bash "$HERE/sample.sh" "$PROJECT")
  until grep -q WINDOW_END "$err"; do sleep 0.2; done
  t1=$(python3 -c 'import time;print(time.time())'); s1=$(bash "$HERE/sample.sh" "$PROJECT")
  wait "$pid"
  res=$(cat "$err.out")
  dbsize1=$(SQLDB "select pg_database_size('shop')")
  printf '{"round":%s,"t0":%s,"t1":%s,"s0":%s,"s1":%s,"dbSize0":%s,"dbSize1":%s,"load":%s}\n' "$round" "$t0" "$t1" "$s0" "$s1" "$dbsize0" "$dbsize1" "$res" >> "$file"
  rm -f "$err" "$err.out"
  echo "done mix=$mix rps=$rps round=$round: $res" >&2
}

idle() { # <파일> <round>: 부하 0 기준선
  local file=$1 round=$2 s0 s1 t0 t1 d
  d=$(SQLDB "select pg_database_size('shop')")
  t0=$(python3 -c 'import time;print(time.time())'); s0=$(bash "$HERE/sample.sh" "$PROJECT")
  sleep 30
  t1=$(python3 -c 'import time;print(time.time())'); s1=$(bash "$HERE/sample.sh" "$PROJECT")
  printf '{"round":%s,"t0":%s,"t1":%s,"s0":%s,"s1":%s,"dbSize0":%s,"dbSize1":%s,"load":{"mix":"idle","targetRps":0,"windowSec":30,"requests":0,"achievedRps":0,"p50Ms":null,"p95Ms":null,"p99Ms":null,"ok":0,"err4xx":0,"err5xx":0,"netErr":0,"errorRate":0,"bytesToClient":0,"bytesFromClient":0,"bytesPerRequest":0}}\n' "$round" "$t0" "$t1" "$s0" "$s1" "$d" "$d" >> "$file"
}

F="$OUT/stages.jsonl"
if [ -n "${EXTRA_RPS:-}" ]; then
  # 이미 있는 원자료 뒤에 높은 단계만 덧붙인다
  STAGE_SEC=30
  for rps in $EXTRA_RPS; do stage "$F" target "$rps" 1; done
  echo finished >&2
  exit 0
fi
: > "$F"
{ docker version --format '{{.Server.Version}}'; docker info --format '{{.OperatingSystem}} cpus={{.NCPU}} mem={{.MemTotal}}'; docker exec "$PROJECT-db-1" postgres --version; docker exec "$PROJECT-app-1" node -v; sysctl -n machdep.cpu.brand_string; date -u +%FT%TZ; } > "$OUT/env.txt"
idle "$F" 1
for round in 1 2; do
  for rps in 10 25 50 100 200 150 400; do stage "$F" target "$rps" "$round"; done
done
for rps in 10 50 200; do stage "$F" write "$rps" 1; done
# 무릎(SLO가 깨지는 지점) 찾기: 한 복제본 기준
STAGE_SEC=30
for rps in 800 1200 1600 2400; do stage "$F" target "$rps" 1; done
echo finished >&2
