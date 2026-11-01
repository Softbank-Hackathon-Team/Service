#!/usr/bin/env bash
# 데모 리허설 도우미. 서비스 폴더(Service) 어디서 불러도 된다: bash docs/demo/demo.sh <명령>
# 맥 bash 3.2에서도 돌게 썼다(연관 배열 같은 bash 4 기능 안 씀).
# DB 접속 방식은 환경 변수로 바꿀 수 있다. 기본값은 맥 도커 기준.
set -u
cd "$(dirname "$0")/../.." || exit 1

API="${API:-http://localhost:3000}"
TENANT="11111111-1111-4111-8111-111111111111"
OTHER="99999999-9999-4999-8999-999999999999"
PSQL_MAIN="${PSQL_MAIN:-docker compose exec -T db psql -U platform_owner -d platform}"
PSQL_SRC="${PSQL_SRC:-docker compose -f packages/replication/docker-compose.test.yml exec -T src psql -U postgres -d app}"
PSQL_DST="${PSQL_DST:-docker compose -f packages/replication/docker-compose.test.yml exec -T dst psql -U postgres -d app}"
MEASURE_FILE="docs/demo/measure-latest.txt"

say() { printf '\n== %s\n' "$1"; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
latest_mid() { curl -s "$API/api/v1/migrations" -H "x-dev-tenant: $TENANT" | json 'd["items"][0]["id"] if d["items"] else ""'; }

cmd="${1:-help}"
case "$cmd" in
  enable-repl)
    if grep -q '^REPL_SOURCE_URL=' .env; then echo "이미 켜져 있음 (.env에 REPL_SOURCE_URL 있음)"; exit 0; fi
    cat >> .env <<'EOF'
REPL_SOURCE_URL=postgres://postgres:postgres@localhost:55432/app
REPL_SOURCE_PEER_URL=postgres://postgres:postgres@src:5432/app
REPL_SOURCE_APP_ROLE=app_user
REPL_TARGET_URL=postgres://postgres:postgres@localhost:55433/app
REPL_TARGET_PEER_URL=postgres://postgres:postgres@dst:5432/app
REPL_TARGET_APP_ROLE=app_user
REPL_TABLES=customers,orders
EOF
    echo "복제 켬: .env에 REPL_ 7줄 추가. 워커를 Ctrl+C 후 다시 띄워야 적용된다"
    ;;
  prep)
    say "복제용 DB 두 대 띄우기 (55432 출발, 55433 도착)"
    (cd packages/replication && npm run db:up) || exit 1
    say "부하 중 컷오버·롤백 5회 측정 → $MEASURE_FILE (약 1분)"
    (cd packages/replication && npm run measure) 2>&1 | grep -E 'initial_copy|sync gate|cutover pause|rollback pause|app writes|leftovers' | tee "$MEASURE_FILE"
    say "출발 DB에 데모 데이터 다시 넣기 (주문 2000, 고객 100)"
    (cd packages/replication && npm run demo:seed) || exit 1
    ;;
  reset)
    say "플랫폼 DB 지우고 다시 만들기"
    docker compose down -v && docker compose up -d --wait db || exit 1
    say "출발·도착 DB를 데모 시작 상태로"
    (cd packages/replication && npm run demo:seed) || exit 1
    echo "다음: api·worker 터미널을 Ctrl+C 후 다시 띄운다"
    ;;
  check)
    say "API"
    printf 'healthz %s\nreadyz  %s\n' "$(curl -s "$API/healthz")" "$(curl -s "$API/readyz")"
    say "복제 설정 (.env의 REPL_ 줄 수, 7이면 켜짐)"
    grep -c '^REPL_' .env
    say "이전 목록 (0건이어야 깨끗)"
    curl -s "$API/api/v1/migrations" -H "x-dev-tenant: $TENANT" | json 'len(d["items"])'
    say "출발 DB 행 수 (orders 2000, customers 100)"
    $PSQL_SRC -At -c "select 'orders', count(*) from orders union all select 'customers', count(*) from customers"
    say "도착 DB 행 수 (표가 없거나 0이어야 함)"
    $PSQL_DST -At -c "select 'orders', count(*) from orders union all select 'customers', count(*) from customers" 2>&1 | head -3
    ;;
  cost)
    curl -s -X POST "$API/api/v1/cost/estimate" -H 'content-type: application/json' -H "x-dev-tenant: $TENANT" -d @docs/demo/cost-request.json | python3 docs/demo/cost-summary.py
    ;;
  wronghash)
    MID="$(latest_mid)"; [ -n "$MID" ] || { echo "이전이 없다"; exit 1; }
    PID="$(curl -s "$API/api/v1/migrations/$MID/plan" -H "x-dev-tenant: $TENANT" | json 'd["planId"]')"
    echo "이전 $MID / 계획 $PID 에 틀린 지문으로 승인 요청"
    curl -s -X POST "$API/api/v1/plans/$PID/approvals" -H 'content-type: application/json' -H "x-dev-tenant: $TENANT" -d '{"decision":"approve","planHash":"wrong"}'
    echo
    printf '지금 상태: '; curl -s "$API/api/v1/migrations/$MID" -H "x-dev-tenant: $TENANT" | json 'd["status"]'
    ;;
  audit)
    MID="$(latest_mid)"
    $PSQL_MAIN -c "select seq, actor, action, left(hash, 12) as hash from audit_events where target = '$MID' order by seq"
    ;;
  numbers)
    # z75-34: detail.stub 은 true 이거나 이유 문장이다 (TRAFFIC_OBSERVE_SEC 를 줄이면 shift 가 문장을 남긴다). 문장도 가짜로 센다
    MID="$(latest_mid)"
    $PSQL_MAIN -At -F ' ' -c "select a.action, m->>'name', m->>'value', m->>'unit' from audit_events a, jsonb_array_elements(a.detail->'measurements') m where a.target = '$MID' and a.action in ('sync.shifting','cutover.rollback_window') and m->>'name' in ('initial_copy_ms','replication_lag_ms','cutover_pause_ms','sequences_synced') order by a.seq"
    printf 'stub(가짜)였나: '; $PSQL_MAIN -At -c "select coalesce(bool_or(CASE jsonb_typeof(detail->'stub') WHEN 'boolean' THEN (detail->'stub')::boolean WHEN 'string' THEN (detail->>'stub') <> '' ELSE false END), false) from audit_events where target = '$MID'"
    printf '가짜였던 단계: '; $PSQL_MAIN -At -c "select coalesce(string_agg(a, ', ' order by s), '없음') from (select action || case when jsonb_typeof(detail->'stub') = 'string' then '(' || (detail->>'stub') || ')' else '' end as a, min(seq) as s from audit_events where target = '$MID' and CASE jsonb_typeof(detail->'stub') WHEN 'boolean' THEN (detail->'stub')::boolean WHEN 'string' THEN (detail->>'stub') <> '' ELSE false END group by 1) x"
    # 발표자가 그대로 읽는 줄: 쓰기 멈춘 시간은 sync.*·cutover.* 감사가 낸다. 그 줄들이 가짜가 아니면 DB 숫자는 진짜다 (관찰 시간 압축은 shift.* 라 상관없음)
    printf 'DB 숫자(쓰기 멈춘 시간): '; $PSQL_MAIN -At -c "select case when count(*) = 0 then '없음' when bool_or(CASE jsonb_typeof(detail->'stub') WHEN 'boolean' THEN (detail->'stub')::boolean WHEN 'string' THEN (detail->>'stub') <> '' ELSE false END) then '가짜' else '진짜' end from audit_events where target = '$MID' and (action like 'sync.%' or action like 'cutover.%')"
    ;;
  rows)
    say "출발 DB"
    $PSQL_SRC -At -c "select 'orders', count(*) from orders union all select 'customers', count(*) from customers"
    say "도착 DB"
    $PSQL_DST -At -c "select 'orders', count(*) from orders union all select 'customers', count(*) from customers"
    ;;
  security)
    MID="${2:-$(latest_mid)}"; [ -n "$MID" ] || { echo "이전이 없다"; exit 1; }
    say "보안 표 (GET /api/v1/migrations/$MID/security)"
    curl -s "$API/api/v1/migrations/$MID/security" -H "x-dev-tenant: $TENANT" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "rows" not in d: print(d); sys.exit(1)
s = d["summary"]
print("지켜짐 %d · 약점 %d · 위반 %d · 미구현 %d · 해당 없음 %d" % (s["ok"], s["warn"], s["fail"], s["notImplemented"], s["na"]))
mark = {"ok": "OK  ", "warn": "약점", "fail": "위반", "not_implemented": "미구현", "n_a": "-   "}
for r in d["rows"]:
    if r["state"] != "n_a": print("%-6s %-16s %s" % (mark[r["state"]], r["id"], r["value"]))
'
    ;;
  wall)
    MID="$(latest_mid)"
    printf '회사 헤더 없음 → '; curl -s -o /dev/null -w '%{http_code}\n' "$API/api/v1/migrations"
    printf '다른 회사 목록 → '; curl -s "$API/api/v1/migrations" -H "x-dev-tenant: $OTHER"; echo
    printf '다른 회사가 이 이전 조회 → '; curl -s "$API/api/v1/migrations/$MID" -H "x-dev-tenant: $OTHER"; echo
    ;;
  agent)
    node --import tsx --test --test-reporter=tap packages/agent/test/ai-loop.test.ts 2>&1 | grep -E '^(not )?ok|^# (pass|fail)'
    ;;
  why)
    say "최근 실패·재시도 작업 (상태가 한 칸에서 안 움직일 때)"
    $PSQL_MAIN -At -c "select name, state, retry_count, left(coalesce(output->>'message', output::text), 160) from pgboss.job where state in ('failed','retry') order by created_on desc limit 3"
    ;;
  measure)
    cat "$MEASURE_FILE" 2>/dev/null || echo "측정 파일 없음. 먼저 prep"
    ;;
  *)
    echo "쓰는 법: bash docs/demo/demo.sh <enable-repl|prep|reset|check|cost|wronghash|audit|numbers|rows|security [이전번호]|wall|agent|why|measure>"
    ;;
esac
