#!/usr/bin/env bash
# 이전 1건의 실측값을 JSON 1개로 뽑는다 (작업 Z40, DRAFT(ai))
#
# 하는 일 (읽기만 한다. API에 쓰는 요청은 POST /cost/estimate 계산 1번뿐이고 저장하지 않는다)
#   1) API에서 이전 1건의 증적 리포트·비용 화면·보안 표를 받는다
#   2) 데모 비용 요청(docs/demo/cost-request.json)으로 비용 비교를 한 번 계산한다 (무대 숫자 $233.3/$146.9/$86.4의 출처)
#   3) psql 이 있고 OWNER_DATABASE_URL 이 있으면 감사 기록에서 "어느 단계가 STUB였나"를 읽는다
#   4) 받은 원본은 out/raw-<이전번호>/ 에, 정리한 JSON은 out/measure-<날짜시각>-<앞8자리>.json 에 둔다
#
# 사용
#   bash tools/measure/collect.sh                      가장 최근에 끝난 이전 1건
#   bash tools/measure/collect.sh <이전번호>             그 이전
#   bash tools/measure/collect.sh <이전번호> --label "AWS EKS → GCP GKE, 서울"
#   bash tools/measure/collect.sh <이전번호> --set refresh_s=0.7 --set writes_total=4338 --set writes_failed=0
# 환경 변수
#   API_BASE        기본 http://localhost:${API_PORT:-3000}/api/v1
#   MEASURE_TENANT  기본 시드 회사 11111111-1111-4111-8111-111111111111 (x-dev-tenant 헤더)
#   MEASURE_OUT     기본 이 스크립트 옆 out/
#   OWNER_DATABASE_URL  있으면 감사 기록을 직접 읽는다 (.env 에 이미 있음). 값은 출력에 안 남긴다
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
if [ -f "$ROOT/.env" ] && [ -z "${OWNER_DATABASE_URL:-}" ]; then
  OWNER_DATABASE_URL=$(grep -E '^OWNER_DATABASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2- || true)
fi
API=${API_BASE:-http://localhost:${API_PORT:-3000}/api/v1}
TENANT=${MEASURE_TENANT:-11111111-1111-4111-8111-111111111111}
OUT=${MEASURE_OUT:-$HERE/out}

ID=""
LABEL=""
SETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL=${2:?"--label 뒤에 환경 설명"}; shift 2 ;;
    --set) SETS+=("${2:?"--set 뒤에 이름=값"}"); shift 2 ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    -*) echo "모르는 옵션: $1" >&2; exit 2 ;;
    *) ID=$1; shift ;;
  esac
done

for t in curl node; do
  command -v "$t" >/dev/null 2>&1 || { echo "필요한 도구 없음: $t" >&2; exit 2; }
done

get() { curl -sS -f -H "x-dev-tenant: $TENANT" "$API$1"; }

# API 살아 있나 (healthz 는 /api/v1 밖)
HEALTH=${API%/api/v1}/healthz
curl -sS -f "$HEALTH" >/dev/null || { echo "API 응답 없음: $HEALTH  (npm run dev:api 먼저)" >&2; exit 1; }

if [ -z "$ID" ]; then
  ID=$(get /migrations | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const done = ["completed", "rolled_back"];
    const m = r.items.find((x) => done.includes(x.status));
    if (!m) { console.error("끝난 이전(completed/rolled_back)이 없음"); process.exit(1); }
    console.log(m.id);')
  echo "가장 최근에 끝난 이전: $ID" >&2
fi

RAW="$OUT/raw-$ID"
mkdir -p "$RAW"
get "/migrations/$ID/report" > "$RAW/report.json"
get "/migrations/$ID/cost" > "$RAW/migration-cost.json" 2>/dev/null || echo '{"missing":true}' > "$RAW/migration-cost.json"
# 보안 표 (Z18) 는 통합 전이면 404 → 없음으로 적는다
get "/migrations/$ID/security" > "$RAW/security.json" 2>/dev/null || echo '{"missing":true}' > "$RAW/security.json"
curl -sS -f -H "x-dev-tenant: $TENANT" -H "content-type: application/json" \
  --data-binary @"$ROOT/docs/demo/cost-request.json" "$API/cost/estimate" > "$RAW/cost-estimate.json" \
  || echo '{"missing":true}' > "$RAW/cost-estimate.json"

# 감사 기록에서 STUB 단계 (psql 이 없거나 연결이 안 되면 리포트 gaps 로만 판단)
# z75-34: detail.stub 은 true 이거나 이유 문장(예: shift 의 "관찰 시간 압축 (TRAFFIC_OBSERVE_SEC)")이다. 예전 ::boolean 은 문장에서 깨져
#   감사를 통째로 못 읽고 "psql 없음" 으로 보였다. 이제 문장도 STUB 으로 센다.
# 왜 못 읽었는지를 why 에 남긴다 (예전엔 접속 실패도 "psql 없음"으로 보였다).
#   psql 이 없으면 맥 도커 DB(docker compose 의 db 서비스) 안 psql 로 한 번 더 해 본다 (docs/demo/demo.sh 와 같은 길)
#   PSQL_MAIN 을 주면 그 명령을 쓴다 (예: PSQL_MAIN="docker compose exec -T db psql -U platform_owner -d platform")
AUDIT_SQL="SELECT coalesce(json_agg(json_build_object('seq', seq, 'action', action, 'stub', CASE jsonb_typeof(detail->'stub') WHEN 'boolean' THEN (detail->'stub')::boolean WHEN 'string' THEN (detail->>'stub') <> '' ELSE false END)
           ORDER BY seq), '[]'::json)
      FROM audit_events WHERE target = '$ID'"
audit_missing() { printf '{"missing":true,"why":"%s"}\n' "$1" > "$RAW/audit-stub.json"; }
# 오류 첫 줄만, 따옴표·역슬래시·접속 주소(비밀번호 포함)는 지운다
errline() { head -1 "$RAW/audit-stub.err" | sed -e 's/["\\]//g' -e 's#postgres[a-z]*://[^ ]*#<주소>#g' | cut -c1-120; }
if [ -n "${PSQL_MAIN:-}" ]; then
  # shellcheck disable=SC2086
  $PSQL_MAIN -X -q -At -v ON_ERROR_STOP=1 -c "$AUDIT_SQL" > "$RAW/audit-stub.json" 2>"$RAW/audit-stub.err" \
    || audit_missing "PSQL_MAIN 실패: $(errline)"
elif command -v psql >/dev/null 2>&1 && [ -n "${OWNER_DATABASE_URL:-}" ]; then
  psql "$OWNER_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 -c "$AUDIT_SQL" > "$RAW/audit-stub.json" 2>"$RAW/audit-stub.err" \
    || audit_missing "접속 실패: $(errline)"
elif [ -n "$(cd "$ROOT" && docker compose ps -q --status running db 2>/dev/null)" ]; then
  (cd "$ROOT" && docker compose exec -T db psql -U platform_owner -d platform -X -q -At -v ON_ERROR_STOP=1 -c "$AUDIT_SQL") \
    > "$RAW/audit-stub.json" 2>"$RAW/audit-stub.err" || audit_missing "도커 db 안 psql 실패: $(errline)"
elif ! command -v psql >/dev/null 2>&1; then
  audit_missing "psql 없음 (도커 db 도 안 떠 있음)"
else
  audit_missing "OWNER_DATABASE_URL 없음"
fi
# Z38 R8-23: 읽기는 됐는데 이 이전의 감사가 0줄이면 다른 DB 를 읽은 것이다 → "STUB 없음"(거짓 진짜)으로 보지 않게 missing 으로
if [ "$(tr -d '[:space:]' < "$RAW/audit-stub.json")" = "[]" ]; then audit_missing "이 이전 감사 0줄 (다른 DB?)"; fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUT/measure-$STAMP-${ID:0:8}.json"
node "$HERE/build-json.mjs" --raw "$RAW" --api "$API" --label "$LABEL" \
  ${SETS[@]+"${SETS[@]/#/--set=}"} > "$FILE"
echo "$FILE"
node "$HERE/build-json.mjs" --summary "$FILE" >&2
