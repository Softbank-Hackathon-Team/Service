#!/bin/sh
# cleanup 큐 독점 시험 (작업 Z32 7a, 맥 6차 e2e 정체). Service 루트에서, 빈(또는 버려도 되는) DB 로: sh tools/load/cleanup-flood.sh
# 만드는 것: 고아 rollback_window 이전 FLOOD(500)개 (창 끝남·잠금 줄 없음 = 시험 찌꺼기) + 각자 cleanup 작업 1개
# 그 위에 새 흐름 FLOWS(10)개를 돌리고, 새 이전마다 "창 끝 → completed" 시간을 잰다. 판정: 최대값 ≤ 2초 + 고아 반복 0
# 환경 변수: FLOOD(500) FLOWS(10) LOG_DIR(./tmp-flood). api·worker 1개씩을 이 스크립트가 띄운다(이미 뜬 워커가 있으면 exit 2)
set -eu
FLOOD=${FLOOD:-500}; FLOWS=${FLOWS:-10}; LOG_DIR=${LOG_DIR:-./tmp-flood}
mkdir -p "$LOG_DIR"
if ps -eo args= | grep -E 'node .*apps/worker/(src/main\.ts|dist/main\.js)' | grep -qv grep; then echo "PRECONDITION FAIL: 워커가 이미 떠 있음" >&2; exit 2; fi
RATE_LIMIT=0 METRICS_PORT=0 node --env-file=.env --import tsx apps/api/src/main.ts > "$LOG_DIR/api.log" 2>&1 &
A=$!
WORKER_METRICS_PORT=0 WORKER_ID=flood-w1 node --env-file=.env --import tsx apps/worker/src/main.ts > "$LOG_DIR/worker.log" 2>&1 &
W=$!
trap 'kill $A $W 2>/dev/null || true' EXIT
sleep 7
RUN_START=$(node -e 'console.log(Date.now())')
FLOOD=$FLOOD npx tsx --env-file=.env tools/load/cleanup-flood.ts seed
T0=$(date +%s)
FLOWS=$FLOWS FLOW_TIMEOUT_MS=180000 npx tsx --env-file=.env tools/load/flows.ts > "$LOG_DIR/flows.log" 2>&1 || true
echo "flows wall $(( $(date +%s) - T0 ))s"
sleep 5
RUN_START=$RUN_START npx tsx --env-file=.env tools/load/cleanup-flood.ts measure
