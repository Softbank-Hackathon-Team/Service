#!/bin/sh
# 워커 강제 종료 시험 (작업 Z32). Service 루트에서: sh tools/load/worker-kill.sh
# api(지표 끔·요청 한도 끔 RATE_LIMIT=0) 1 + worker 3 를 이 스크립트가 직접 띄운다(pid 를 알아야 해서). 이미 떠 있는 worker 가 있으면 시작하지 않는다
# 순서: 띄우기 → flows.ts(50개) 시작 → KILL_AFTER 초 뒤 worker 1개 kill -9 → kill-watch.ts 로 회복 관찰 → 전부 끄기
# 환경 변수: FLOWS(50) KILL_AFTER(9) WATCH_LIMIT_MS(1200000) LOG_DIR(./tmp-kill) TRAFFIC_OBSERVE_SEC(셸 > .env > 0.5)
# 시작 전 같은 DB 워커가 있으면 exit 2. 판정은 마지막 줄 KILL VERDICT (PASS=0, FAIL=1, kill-verdict.ts 기준). 끝에 paused 가 남으면 그 id 의 감사 10줄·pgboss.job 행을 자동으로 찍는다(kill-watch.ts)
set -eu
FLOWS=${FLOWS:-50}
KILL_AFTER=${KILL_AFTER:-9}
LOG_DIR=${LOG_DIR:-./tmp-kill}
mkdir -p "$LOG_DIR"

# ── 실행 조건 고정 (Z62 #37) ──
# ① 같은 DATABASE_URL 을 보는 워커가 이미 있으면 결과가 섞인다 → 시작 거부(exit 2). 맥 int5-4: 남은 워커 때문에 줄이 엇갈린 적 있음
#    셈: 이 PC의 개발 워커(apps/worker/src/main.ts 로 뜬 node) + docker compose(기본 파일)의 worker 컨테이너.
#    docker-compose.prod.yml 의 worker 는 자기 db 컨테이너(db:5432, 바깥 포트 없음)를 보므로 세지 않고 참고로만 찍는다
DEV_W=$(ps -eo pid=,args= | grep -E 'node .*apps/worker/(src/main\.ts|dist/main\.js)' | grep -v grep | wc -l | tr -d ' ')
DC_W=0; PROD_W=0
if command -v docker >/dev/null 2>&1; then
  DC_W=$(docker compose ps -q worker 2>/dev/null | wc -l | tr -d ' ')
  PROD_W=$(docker compose -f docker-compose.prod.yml ps -q worker 2>/dev/null | wc -l | tr -d ' ')
fi
if [ "$DEV_W" != "0" ] || [ "$DC_W" != "0" ]; then
  echo "PRECONDITION FAIL: 같은 DB 를 보는 워커가 이미 떠 있음 (개발 워커 $DEV_W, compose worker $DC_W). 끄고 다시 실행" >&2
  ps -eo pid=,args= | grep -E 'node .*apps/worker/' | grep -v grep | cut -c1-160 >&2 || true
  exit 2
fi
# ② 관찰 시간: 셸에 있으면 그 값, 없으면 .env 값, 둘 다 없으면 0.5초 (node --env-file 은 셸 값을 덮지 않는다 → 아래에서 워커에 그대로 넘김)
env_val() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1; }
TRAFFIC_OBSERVE_SEC=${TRAFFIC_OBSERVE_SEC:-$(env_val TRAFFIC_OBSERVE_SEC)}
TRAFFIC_OBSERVE_SEC=${TRAFFIC_OBSERVE_SEC:-0.5}
export TRAFFIC_OBSERVE_SEC
show() { v=$(eval "printf '%s' \"\${$1:-}\""); [ -n "$v" ] && { echo "$v (셸)"; return; }; v=$(env_val "$1"); [ -n "$v" ] && echo "$v (.env)" || echo "(없음 = 코드 기본값)"; }
IMG="(없음: 개발 워커 = tsx 소스 실행)"
if [ "$PROD_W" != "0" ]; then IMG="prod worker $(docker compose -f docker-compose.prod.yml images worker 2>/dev/null | awk 'NR==2{print $2":"$3" "$4}') (다른 DB, 이 시험과 무관)"; fi
{
  echo "| 조건 | 값 |"
  echo "|---|---|"
  echo "| 시각(UTC) | $(date -u +%Y-%m-%dT%H:%M:%SZ) |"
  echo "| FLOWS / KILL_AFTER | $FLOWS / ${KILL_AFTER}s |"
  echo "| TRAFFIC_OBSERVE_SEC | $TRAFFIC_OBSERVE_SEC |"
  echo "| STUB_DELAY_MS | $(show STUB_DELAY_MS) |"
  echo "| ROLLBACK_WINDOW_SEC | $(show ROLLBACK_WINDOW_SEC) |"
  echo "| QUEUE_WAIT_MAX_SEC | $(show QUEUE_WAIT_MAX_SEC) |"
  echo "| 같은 DB 워커(시작 전) | 개발 $DEV_W, compose $DC_W (prod compose worker $PROD_W 는 별도 DB) |"
  echo "| 이미지 | $IMG |"
} | tee "$LOG_DIR/conditions.md"

RATE_LIMIT=0 METRICS_PORT=0 node --env-file=.env --import tsx apps/api/src/main.ts > "$LOG_DIR/api.log" 2>&1 &
API=$!
W1=""; W2=""; W3=""; FLOWS_PID=""
for i in 1 2 3; do
  WORKER_METRICS_PORT=0 WORKER_ID="kill-test-$i" node --env-file=.env --import tsx apps/worker/src/main.ts > "$LOG_DIR/worker$i.log" 2>&1 &
  eval "W$i=$!"
done
cleanup() { kill "$FLOWS_PID" "$API" "$W2" "$W3" 2>/dev/null || true; }
trap cleanup EXIT
sleep 6

RUN_START=$(node -e 'console.log(Date.now())')
FLOWS=$FLOWS FLOW_TIMEOUT_MS=${WATCH_LIMIT_MS:-1200000} npx tsx --env-file=.env tools/load/flows.ts > "$LOG_DIR/flows.log" 2>&1 &
FLOWS_PID=$!
sleep "$KILL_AFTER"
kill -9 "$W1"
KILL_AT=$(node -e 'console.log(Date.now())')
echo "killed worker1 pid=$W1 at +${KILL_AFTER}s"
RUN_START=$RUN_START KILL_AT=$KILL_AT npx tsx --env-file=.env tools/load/kill-watch.ts
wait "$FLOWS_PID" || true
tail -n 12 "$LOG_DIR/flows.log"
# Z32 6차: 판정 = kill-verdict.ts 마지막 줄 (flows.ts RESULT 는 kill 당시 진행 중 흐름의 failed 도 FAIL 로 센다)
VERDICT=0
RUN_START=$RUN_START KILLED_HOLDER="worker:kill-test-1" npx tsx --env-file=.env tools/load/kill-verdict.ts || VERDICT=$?
exit "$VERDICT"
