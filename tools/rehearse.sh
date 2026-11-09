#!/usr/bin/env bash
# 리허설 회차 도구 (z75-26, 작업 Z78). 5분 발표 대본(TALK-5MIN-v2)의 장면 순서대로 데모 명령을 기계가 대신 눌러 보고,
# 장면마다 걸린 시간과 "화면이 멈춰 있는 시간(대기)"을 잰다. 같은 회차를 여러 번(기본 2번) 돌려 결과가 같은지 판정한다.
# 맥 bash 3.2 에서도 돈다 (연관 배열·date +%N 안 씀). 필요한 것: curl, python3, perl(없으면 python3 로 대신).
# 클라우드 자원을 만들지 않는다. 로컬(또는 --prod 로 운영 모양) API 에 이전 한 건씩만 만든다.
#
# 장면 (대본 문단 → 하는 일 → 확인)
#   S0 소개           healthz·readyz 200, 데모 회사 환경에 dev-aws·dev-gcp 있음
#   S1 시작·계획      POST /migrations(dev-aws→dev-gcp) → spec_review → POST plan → awaiting_approval, 계획 지문 64자
#   S4 승인→완료      POST approvals → approved → POST start → completed (버튼 4번째까지)
#   S5 숫자           demo.sh numbers, "stub(가짜)였나" 줄을 읽는다
#   S6 보안 시각화     GET security 요약 칩, demo.sh wall(401·빈 목록·404), demo.sh audit(줄마다 해시 12자)
#   S7 AI 샌드박스    demo.sh agent → "# pass N", "# fail 0"
#   S8 마무리         docs/archive/DESIGN-FINALS.md 에 "2-3. 숫자로 본 지금 상태" 절이 있음
#   화면(z75-38)      회차 끝에 playwright 헤드리스 1개(apps/web/e2e/scene-timing.timing.ts)로 발표 화면 장면마다
#                     이동·누름 → 주요 요소 보임까지 ms: 목록 → 이전 상세 → 감사 → 숫자 → 에이전트. 기준 주소 운영 빌드 8080
#
# 판정 (마지막 줄)
#   - 회차마다 장면이 전부 OK, 장면별 기계 시간 합 ≤ REHEARSE_LIMIT_SEC(300)
#   - 대기(상태가 안 바뀌는 구간, 명령 하나가 도는 시간) 중 WAIT_SEC(10)초 이상인 것 0개
#   - 장면마다 기계 시간이 대본 칸(초) 안에 들어감
#   - 이어진 두 회차의 "결과 지문"(최종 상태, 보안 요약, 벽 응답, 감사 action 순서, 시험 통과 수, stub 여부)이 같음
#   - 이어진 두 회차의 장면별 시간 차이 ≤ 10% (단, 차이가 0.5초 미만이면 통과: 1초 안쪽 장면의 잡음)
#   - 화면: 장면당 ≤ WEB_SCENE_LIMIT_MS(1000), 합 ≤ WEB_TOTAL_LIMIT_MS(8000), 두 회차의 "합" 차이 ≤ 10% (차이 WEB_DEV_FLOOR_MS(300)ms 미만은 통과, z75-50: 200→300, VM 27%·25% 흔들림)
#           장면 하나씩은 0.1~0.3초라 화면 폴링 한 번 차이로 30% 넘게 흔들린다(VM 5번 중 1번) → 편차는 합으로만 본다
#   - S4 (z75-36): 승인→완료 기계 시간이 대본 문단 3 읽기 시간 −1초 안, 그리고 2초 이상 (화면이 말보다 늦게 끝나거나 너무 빨리 끝나지 않게)
#                  읽기 시간 = S4_READ_CHARS(195, TALK-5MIN-v2 부록 문단 3 음절 합) ÷ 초당 5~6자. 기준은 빠른 쪽(6자)
#   - 첫 요청 (z75-37): 회차 첫 요청(S0 healthz)의 curl time_total ≤ FIRST_REQ_LIMIT_MS(200)
#   - 자원 (z75-40): 리허설 내내 1초마다 tools/measure/res-sample.sh 가 CPU 쉬는 비율·도커 메모리·스왑을 적는다(LOG_DIR/res.csv)
#                    장면마다 CPU idle 최저 ≥ RES_IDLE_MIN(25)%, 도커 메모리 최대 ≤ RES_DOCKER_MAX_MB(10240), 스왑 증가 0
#                    도커가 없거나 값을 못 읽으면 그 칸은 "-" 로 찍고 판정에서 뺀다
#   - 관측 끔 비교 (z75-40): COMPARE_WITH=<켜 둔 리허설 LOG_DIR> 를 주면 이번(관측 끈) 장면 합과 비교한 줄을 찍는다
#                    차이 <5% → 발표 때 관측(Grafana·Prometheus) 켜 둠, ≥10% → 끔, 그 사이 → 켜 둠·다시 잼. 판정에는 안 넣는다
#   - 대본-실측 표 (z75-41): 회차마다 tools/measure/talk-timing.py 로 문단별 글자·읽기 초(÷5.5)·기계 초·큰 값·누적 표를
#                    TALK_OUT_DIR(기본 LOG_DIR)/talk-timing-run<N>.md 로 쓴다. 기준 누적 ≤300초, 기계 초 > 읽기 초 문단 0개
#                    대본은 TALK_FILE(기본 docs/archive/TALK-5MIN-v2.md, 없으면 공유 폴더 Z60 본). 대본이 없으면 SKIP 하고 판정에서 뺀다
#
# 쓰는 법 (서비스 폴더 맨 위에서, API·워커·DB 를 먼저 띄운다)
#   bash tools/rehearse.sh                    2회, 회차 앞마다 tools/demo-reset.sh
#   bash tools/rehearse.sh --runs 3 --no-reset
#   bash tools/rehearse.sh --prod             운영 모양(API 3300, docker compose -f docker-compose.prod.yml 의 db)
#   bash tools/rehearse.sh --no-web           화면 시간 재기를 뺀다
#   bash tools/rehearse.sh --no-warmup        회차 앞 예열(GET 몇 번)을 뺀다 (예열 효과를 잴 때만)
#   bash tools/rehearse.sh --no-sample        자원 샘플러를 뺀다
#   bash tools/rehearse.sh --net-fail cloudflare   (z75-42) Cloudflare API 가 끊긴 척: 워커를 TRAFFIC_PROVIDER=cloudflare(가짜 번호)
#                                             + 프록시 127.0.0.1:9(NODE_USE_ENV_PROXY)로 다시 띄워 S4 의 shift 가 막히게 한다. hosts·코드 수정 없음
#                                             시작 → paused + 실패 코드(화면 "실패 코드:" 줄과 같은 값)까지 ≤ NET_FAIL_STUCK_SEC(15)초,
#                                             워커 정상으로 다시 띄움 + 재개 → completed 까지 ≤ NET_FAIL_RECOVER_SEC(20)초. 이 모드는 장면 전체를 돌리지 않는다
#                                             --prod: docker compose 덮어쓰기 파일(LOG_DIR/net-fail.override.yml)로 worker 만 다시 띄움
#                                             개발: NET_FAIL_RESTART_CMD(워커를 다시 띄우는 명령, 환경 변수를 물려받음)가 있어야 한다
#   bash tools/rehearse.sh --human-delay 3   (z75-45) 장면 전환마다 3초 고정 대기(사람이 화면을 넘기는 시간 흉내). 기본 0
#                                             요약에 "기계 합 / 사람 포함 합" 두 줄. 사람 포함 합도 ≤ REHEARSE_LIMIT_SEC(300) 이어야 PASS
#                                             S4_CLOUD_EXTRA_SEC(기본 60): 실클라우드 shift 가 길어질 때를 더한 참고 줄(판정에는 안 넣음)
#   bash tools/rehearse.sh --deeplink         (z75-49) 회차 끝 화면 측정에 Z83 메뉴 7개 딥링크 vs 메뉴 경로 ms 를 더한다
#                                             (apps/web/e2e/scene-deeplink.timing.ts, 표 parallel/Z78/SCENES.md). Z83 화면이 있는 빌드에서만
#                                             기준: 7개 모두 HTTP 200, 딥링크 요소 보임 ≤ DEEPLINK_LIMIT_MS(1000)
#   bash tools/rehearse.sh --viewports        (z75-54) 1회차 끝에 장면 9개 × 확대 3조건(1920×1080 의 100%·125%·150%)을 본다
#                                             (apps/web/e2e/scene-viewport.timing.ts, 사진 run-1/viewport-shots/). Z83 화면이 있는 빌드에서만
#                                             기준: 가로 스크롤 0, 보여 줄 요소 보임·창 안, 왼쪽 메뉴 마지막 항목이 창 높이 안. Grafana 는 떠 있을 때만
#   유효 설정 확인 (z75-43): 시작 전에 떠 있는 워커의 "effective config" 로그 줄(Z81 z81-10)을 10초 안에 읽어
#                    GITOPS=off (LLM 칸은 Z90 부터 기대값 없음), 그리고 관찰 시간(EXPECT_OBSERVE_SEC, --prod 기본 4, 개발은 TRAFFIC_OBSERVE_SEC 를 줬을 때만)과
#                    다르면 장면을 돌리지 않고 FAIL. 로그는 --prod 면 docker compose logs worker, 개발이면 WORKER_LOG(파일 경로, 없으면 SKIP)
#                    줄이 없으면(z81-10 전 이미지) 경고만, CONFIG_STRICT=1 이면 FAIL
#   WEB_URL=http://localhost:5173 bash tools/rehearse.sh   개발 화면과 비교할 때만
# 환경 변수
#   API(기본 http://localhost:3000, --prod 면 3300) PSQL_MAIN(demo.sh 와 같음) LOG_DIR(기본 tools/measure/out/rehearse-<시각>)
#   WAIT_SEC(10) REHEARSE_LIMIT_SEC(300) WAIT_LIMIT_SEC(장면 안 상태 하나 기다리는 최대, 60) POLL_MS(200)
#   GITOPS_DISABLE(기본 1): 이 스크립트가 부르는 명령에 넘긴다. 이미 떠 있는 워커에는 안 먹으니 워커도 같은 값으로 띄운다 (AI 는 Z90 부터 늘 실제 LLM, 가짜는 FAKE_LLM=1 시험만)
# 결과: LOG_DIR/progress.log (장면별 시작·끝 시각), LOG_DIR/run-N/<장면>.out (명령 출력), LOG_DIR/summary.txt (표 + 판정)
# 끝 코드: 0 = PASS, 1 = FAIL, 2 = 잘못된 옵션
set -u
CALLER_PWD=$(pwd)
cd "$(dirname "$0")/.." || exit 1

RUNS=2
DO_RESET=1
DO_WEB=1
DO_WARM=1
DO_SAMPLE=1
NET_FAIL=""
HUMAN_DELAY=0
DO_DEEPLINK=0
DO_VIEWPORT=0
MODE=dev
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS=${2:?"--runs 뒤에 숫자"}; shift ;;
    --no-reset) DO_RESET=0 ;;
    --prod) MODE=prod ;;
    --no-web) DO_WEB=0 ;;
    --no-warmup) DO_WARM=0 ;;
    --no-sample) DO_SAMPLE=0 ;;
    --deeplink) DO_DEEPLINK=1 ;;
    --viewports) DO_VIEWPORT=1 ;;
    --human-delay) HUMAN_DELAY=${2:?"--human-delay 뒤에 초"}; shift
      echo "$HUMAN_DELAY" | grep -Eq '^[0-9]+(\.[0-9]+)?$' || { echo "--human-delay 는 0 이상 숫자" >&2; exit 2; } ;;
    --net-fail) NET_FAIL=${2:?"--net-fail 뒤에 cloudflare"}; shift
      [ "$NET_FAIL" = cloudflare ] || { echo "--net-fail 은 cloudflare 만" >&2; exit 2; } ;;
    -h|--help) sed -n '2,61p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $1" >&2; exit 2 ;;
  esac
  shift
done
echo "$RUNS" | grep -Eq '^[1-9][0-9]*$' || { echo "--runs 는 1 이상 숫자" >&2; exit 2; }

if [ "$MODE" = prod ]; then
  API=${API:-http://localhost:3300}
  PSQL_MAIN=${PSQL_MAIN:-docker compose -f docker-compose.prod.yml exec -T db psql -U platform_owner -d platform}
  RESET_ARGS="--prod"
else
  API=${API:-http://localhost:3000}
  RESET_ARGS=""
fi
export API
[ -n "${PSQL_MAIN:-}" ] && export PSQL_MAIN
export GITOPS_DISABLE=${GITOPS_DISABLE:-1}

TENANT="11111111-1111-4111-8111-111111111111"
SRC_ENV="22222222-2222-4222-8222-222222222222"
DST_ENV="33333333-3333-4333-8333-333333333333"
WAIT_SEC=${WAIT_SEC:-10}
LIMIT_SEC=${REHEARSE_LIMIT_SEC:-300}
WAIT_LIMIT_SEC=${WAIT_LIMIT_SEC:-60}
POLL_MS=${POLL_MS:-200}
WEB_URL=${WEB_URL:-http://localhost:8080}
WEB_SCENE_LIMIT_MS=${WEB_SCENE_LIMIT_MS:-1000}
WEB_TOTAL_LIMIT_MS=${WEB_TOTAL_LIMIT_MS:-8000}
S4_READ_CHARS=${S4_READ_CHARS:-195}
FIRST_REQ_LIMIT_MS=${FIRST_REQ_LIMIT_MS:-200}
RES_IDLE_MIN=${RES_IDLE_MIN:-25}
RES_DOCKER_MAX_MB=${RES_DOCKER_MAX_MB:-10240}
COMPARE_WITH=${COMPARE_WITH:-}
if [ -z "${TALK_FILE:-}" ]; then
  for f in docs/archive/TALK-5MIN-v2.md /mnt/project-files/notes/skeleton/parallel/Z60/TALK-5MIN-v2.md; do [ -f "$f" ] && { TALK_FILE=$f; break; }; done
fi
TALK_FILE=${TALK_FILE:-}
case "$TALK_FILE" in ""|/*) ;; *) [ -f "$TALK_FILE" ] || TALK_FILE="$CALLER_PWD/$TALK_FILE" ;; esac
case "$COMPARE_WITH" in ""|/*) ;; *) COMPARE_WITH="$CALLER_PWD/$COMPARE_WITH" ;; esac
for v in WAIT_SEC LIMIT_SEC WAIT_LIMIT_SEC POLL_MS WEB_SCENE_LIMIT_MS WEB_TOTAL_LIMIT_MS S4_READ_CHARS FIRST_REQ_LIMIT_MS RES_IDLE_MIN RES_DOCKER_MAX_MB; do
  eval "x=\$$v"
  echo "$x" | grep -Eq '^[1-9][0-9]*$' || { echo "$v 는 1 이상 정수여야 한다: $x" >&2; exit 2; }
done
POLL_S=$(awk -v m="$POLL_MS" 'BEGIN { printf "%.3f", m / 1000 }')
# 직접 준 LOG_DIR 이 상대 경로면 부른 곳 기준 (스크립트가 레포 맨 위로 cd 하므로). 기본값은 레포 안
case "${LOG_DIR:-}" in "") LOG_DIR=tools/measure/out/rehearse-$(date -u +%Y%m%dT%H%M%SZ) ;; /*) ;; *) LOG_DIR="$CALLER_PWD/$LOG_DIR" ;; esac
mkdir -p "$LOG_DIR" || exit 1
PROGRESS="$LOG_DIR/progress.log"
SUMMARY="$LOG_DIR/summary.txt"
: > "$PROGRESS"

# 장면 번호, 대본 칸 길이(초), 이름. 칸 = TALK-5MIN-v2 그림의 목표 끝 시각 차이
SCENES="S0:25:소개 S1:30:시작·계획 S4:45:승인→완료 S5:25:숫자 S6:55:보안시각화 S7:40:AI샌드박스 S8:25:마무리"

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000' 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))'; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sec() { awk -v m="$1" 'BEGIN { printf "%.2f", m / 1000 }'; }
log() { echo "$(iso) $*" >> "$PROGRESS"; }
jget() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
try: print($1)
except Exception: print('')"; }

# ---------- 장면 안 공통 ----------
# 대기 기록: 화면이 안 바뀌는 구간 하나의 길이. 장면의 최대값만 남긴다
# $(...) 안(하위 셸)에서도 남도록 변수 대신 파일에 적는다
# 11c: shifting 은 설계상 관찰 시간 × 단계 수(S4 3단계 × 4초 = 12초) 동안 멈춰 있다 → 그 몫(SHIFT_WAIT_SEC, 기본 3×관찰+3초)까지는
#   멈춤 대기로 세지 않고 "계획된 이동"으로 따로 적는다. 넘으면 그대로 대기로 센다
gap() {
  local obs allow
  case "$2" in "상태 shifting"*)
    obs=${EXPECT_OBSERVE_SEC:-${TRAFFIC_OBSERVE_SEC:-4}}; allow=${SHIFT_WAIT_SEC:-$(awk -v o="$obs" 'BEGIN { printf "%d", 3 * o + 3 }')}
    if [ "$1" -lt $((allow * 1000)) ]; then echo "계획된 이동 $(sec "$1")초 (허용 ${allow}초): $2" >> "$OUT"; return 0; fi ;;
  esac
  echo "$1" >> "$GAPF"; [ "$1" -ge $((WAIT_SEC * 1000)) ] && echo "대기 $(sec "$1")초: $2" >> "$OUT"; return 0
}
# 명령 하나를 재면서 돌린다. 출력은 장면 .out 에, 표준출력에도 그대로
timed() {
  local t0 t1 rc
  t0=$(now_ms); "$@"; rc=$?; t1=$(now_ms)
  gap $((t1 - t0)) "$*"
  return $rc
}
H_T="x-dev-tenant: $TENANT"
api() {
  local m=$1 p=$2 b=${3:-}
  [ -n "$b" ] || b='{}'
  if [ "$m" = GET ]; then curl -sS -m 10 "$API$p" -H "$H_T"
  else curl -sS -m 10 -X "$m" "$API$p" -H "$H_T" -H 'content-type: application/json' -d "$b"; fi
}
code_of() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$@"; }
# 상태가 $1 이 될 때까지 POLL_MS 간격으로 본다. 상태가 바뀔 때마다 그 사이 시간을 대기로 기록
wait_status() {
  local want=$1 last="" st t0 tl now
  t0=$(now_ms); tl=$t0
  while :; do
    st=$(api GET "/api/v1/migrations/$MID" | jget 'd.get("status","")')
    now=$(now_ms)
    if [ "$st" != "$last" ]; then
      [ -n "$last" ] && gap $((now - tl)) "상태 $last"
      echo "+$(sec $((now - T_SCENE)))s status=$st" >> "$OUT"
      last=$st; tl=$now
    fi
    if [ "$st" = "$want" ]; then gap $((now - tl)) "상태 $st 확인"; return 0; fi
    case "$st" in failed|cancelled|rolled_back|paused) echo "멈춤: $st" >> "$OUT"; return 1 ;; esac
    if [ $((now - t0)) -gt $((WAIT_LIMIT_SEC * 1000)) ]; then gap $((now - tl)) "상태 $st (시간 초과)"; echo "시간 초과: $st" >> "$OUT"; return 1; fi
    sleep "$POLL_S"
  done
}
fp() { echo "$1=$2" >> "$FP"; }

# ---------- 장면 ----------
scene_S0() {
  local h r e f
  # 회차 첫 요청의 지연 (z75-37). 예열을 했으면 따뜻한 값, --no-warmup 이면 차가운 값
  f=$(curl -s -m 10 -o /dev/null -w '%{time_total}' "$API/healthz" | awk '{ printf "%d", $1 * 1000 }')
  echo "${f:-0}" > "$RDIR/first_ms"
  echo "첫 요청 ${f}ms"
  h=$(timed code_of "$API/healthz"); r=$(timed code_of "$API/readyz")
  e=$(timed api GET /api/v1/environments | jget '" ".join(sorted(x["name"] for x in d.get("items",[])))')
  echo "healthz $h readyz $r envs [$e]"
  fp S0 "$h/$r/$e"
  [ "$h" = 200 ] && [ "$r" = 200 ] && echo "$e" | grep -q dev-aws && echo "$e" | grep -q dev-gcp
}
scene_S1() {
  local body hash
  body=$(timed api POST /api/v1/migrations "{\"sourceEnvId\":\"$SRC_ENV\",\"targetEnvId\":\"$DST_ENV\"}")
  MID=$(echo "$body" | jget 'd["id"]')
  [ -n "$MID" ] || { echo "만들기 실패: $body"; return 1; }
  echo "이전 $MID"
  wait_status spec_review || return 1
  timed api POST "/api/v1/migrations/$MID/plan" >/dev/null || return 1
  wait_status awaiting_approval || return 1
  body=$(timed api GET "/api/v1/migrations/$MID/plan")
  PLAN_ID=$(echo "$body" | jget 'd["planId"]'); PLAN_HASH=$(echo "$body" | jget 'd["planHash"]')
  echo "계획 $PLAN_ID 지문 ${PLAN_HASH:0:12}… (${#PLAN_HASH}자)"
  fp S1 "awaiting_approval/hash${#PLAN_HASH}"
  [ ${#PLAN_HASH} -eq 64 ]
}
scene_S4() {
  timed api POST "/api/v1/plans/$PLAN_ID/approvals" "{\"decision\":\"approve\",\"planHash\":\"$PLAN_HASH\"}" >/dev/null || return 1
  wait_status approved || return 1
  timed api POST "/api/v1/migrations/$MID/start" >/dev/null || return 1
  wait_status completed || return 1
  fp S4 completed
}
scene_S5() {
  local o stub
  o=$(timed bash docs/demo/demo.sh numbers 2>&1); echo "$o"
  stub=$(echo "$o" | sed -n 's/^stub(가짜)였나: *//p' | tail -n 1)
  fp S5 "stub=$stub"
  [ "$stub" = t ] || [ "$stub" = f ]
}
scene_S6() {
  local s w1 w2 w3 o acts
  s=$(timed api GET "/api/v1/migrations/$MID/security" | jget '"ok%(ok)s warn%(warn)s fail%(fail)s ni%(notImplemented)s na%(na)s" % d["summary"]')
  echo "보안 요약 $s"
  w1=$(timed code_of "$API/api/v1/migrations")
  w2=$(timed curl -s -m 10 "$API/api/v1/migrations" -H "x-dev-tenant: 99999999-9999-4999-8999-999999999999" | jget 'len(d["items"])')
  w3=$(timed code_of "$API/api/v1/migrations/$MID" -H "x-dev-tenant: 99999999-9999-4999-8999-999999999999")
  echo "벽: 헤더 없음 $w1 / 다른 회사 목록 ${w2}건 / 다른 회사 조회 $w3"
  timed bash docs/demo/demo.sh wall >/dev/null 2>&1
  o=$(timed bash docs/demo/demo.sh audit 2>&1); echo "$o"
  acts=$(echo "$o" | awk -F'|' 'NF >= 4 && $1 ~ /[0-9]/ { gsub(/ /, "", $3); gsub(/ /, "", $4); if (length($4) == 12) print $3 }' | tr '\n' ',')
  fp S6 "$s/$w1/$w2/$w3"
  fp S6audit "$acts"
  [ -n "$s" ] && [ "$w1" = 401 ] && [ "$w2" = 0 ] && [ "$w3" = 404 ] && [ -n "$acts" ]
}
scene_S7() {
  local o p f
  o=$(timed bash docs/demo/demo.sh agent 2>&1); echo "$o"
  p=$(echo "$o" | sed -n 's/^# pass //p'); f=$(echo "$o" | sed -n 's/^# fail //p')
  fp S7 "pass$p/fail$f"
  [ -n "$p" ] && [ "$p" -gt 0 ] && [ "$f" = 0 ]
}
scene_S8() {
  local n
  n=$(timed grep -c '^### 2-3\. 숫자로 본 지금 상태' docs/archive/DESIGN-FINALS.md)
  fp S8 "doc$n"
  [ "$n" = 1 ]
}

# ---------- 예열 (z75-37) ----------
# 회차 앞에 화면이 처음 부를 길을 한 번씩 데운다: healthz·환경 목록·이전 목록 GET 3회씩, 화면 1회. 결과는 안 본다
warmup() {
  local i
  for i in 1 2 3; do
    curl -s -m 5 -o /dev/null "$API/healthz"
    curl -s -m 5 -o /dev/null "$API/api/v1/environments" -H "$H_T"
    curl -s -m 5 -o /dev/null "$API/api/v1/migrations" -H "$H_T"
  done
  [ "$DO_WEB" = 1 ] && curl -s -m 5 -o /dev/null "$WEB_URL/"
  return 0
}

# ---------- 회차 ----------
run_once() {
  local r=$1 item id slot name rc t1 dur
  RDIR="$LOG_DIR/run-$r"; mkdir -p "$RDIR"
  FP="$RDIR/fingerprint.txt"; : > "$FP"
  TIMES="$RDIR/times.txt"; : > "$TIMES"
  : > "$RDIR/windows.txt"
  : > "$RDIR/human.txt"
  MID=""; PLAN_ID=""; PLAN_HASH=""
  if [ "$DO_RESET" = 1 ]; then
    log "run=$r reset start"
    bash tools/demo-reset.sh $RESET_ARGS > "$RDIR/reset.out" 2>&1
    rc=$?
    log "run=$r reset end rc=$rc $(tail -n 1 "$RDIR/reset.out")"
    [ $rc -eq 0 ] || { echo "회차 $r: 초기화 실패 (run-$r/reset.out)"; return 1; }
  fi
  if [ "$DO_WARM" = 1 ]; then
    local w0; w0=$(now_ms); warmup; log "run=$r warmup sec=$(sec $(( $(now_ms) - w0 )))"
  fi
  echo "== 회차 $r"
  local first=1
  for item in $SCENES; do
    id=${item%%:*}; slot=${item#*:}; slot=${slot%%:*}; name=${item##*:}
    # z75-45: 장면 전환마다 사람 대기. 장면 시간에는 안 넣고 따로 센다
    if [ $first = 0 ] && [ "$HUMAN_DELAY" != 0 ]; then sleep "$HUMAN_DELAY"; echo "$HUMAN_DELAY" >> "$RDIR/human.txt"; fi
    first=0
    OUT="$RDIR/$id.out"; : > "$OUT"
    GAPF="$RDIR/$id.gaps"; : > "$GAPF"
    log "run=$r scene=$id start"
    T_SCENE=$(now_ms)
    "scene_$id" >> "$OUT" 2>&1
    rc=$?
    t1=$(now_ms); dur=$((t1 - T_SCENE))
    MAXGAP=$(sort -n "$GAPF" | tail -n 1); MAXGAP=${MAXGAP:-0}
    if [ $rc -eq 0 ]; then res=OK; else res="FAIL($rc)"; fi
    log "run=$r scene=$id end sec=$(sec $dur) maxwait=$(sec $MAXGAP) slot=$slot result=$res"
    echo "$id $dur $MAXGAP $slot $res $name" >> "$TIMES"
    echo "$id $T_SCENE $t1" >> "$RDIR/windows.txt"
    printf '  %-3s %-10s %7s초  최대 대기 %6s초  %s\n' "$id" "$name" "$(sec $dur)" "$(sec $MAXGAP)" "$res"
    # 앞 장면이 깨지면 이전 번호가 없어 뒤 장면이 전부 헛돈다 → 거기서 회차를 끝낸다
    if [ $rc -ne 0 ]; then case "$id" in S1|S4) log "run=$r stop after $id"; return 1 ;; esac; fi
  done
  [ "$DO_WEB" = 1 ] && web_timing "$r"
  return 0
}

# 화면 장면 시간 (z75-38). 결과 run-N/web.json. 화면이 안 뜨면 web.json 없이 끝나고 판정에서 FAIL
web_timing() {
  local r=$1 rc
  rm -f "$RDIR/web.json"
  local w0; w0=$(now_ms)
  log "run=$r web start url=$WEB_URL"
  if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$WEB_URL/")" != 200 ]; then
    log "run=$r web end rc=9 (화면 응답 없음: $WEB_URL)"; echo "  화면     응답 없음 ($WEB_URL)"; return 1
  fi
  (cd apps/web && SCENE_TIMING_JSON="$RDIR/web.json" SCENE_TIMING_OUTDIR="$RDIR/web-results" E2E_BASE_URL="$WEB_URL" \
    npx playwright test -c playwright.scenes.config.ts e2e/scene-timing.timing.ts) > "$RDIR/web.out" 2>&1
  rc=$?
  if [ "$DO_DEEPLINK" = 1 ]; then
    rm -f "$RDIR/deeplink.json"
    (cd apps/web && DEEPLINK_JSON="$RDIR/deeplink.json" SCENE_TIMING_OUTDIR="$RDIR/deeplink-results" E2E_BASE_URL="$WEB_URL" \
      npx playwright test -c playwright.scenes.config.ts e2e/scene-deeplink.timing.ts) > "$RDIR/deeplink.out" 2>&1 || rc=1
    log "run=$r deeplink $(cat "$RDIR/deeplink.json" 2>/dev/null)"
  fi
  if [ "$DO_VIEWPORT" = 1 ] && [ "$r" = 1 ]; then
    rm -f "$RDIR/viewport.json"
    (cd apps/web && VIEWPORT_JSON="$RDIR/viewport.json" VIEWPORT_OUTDIR="$RDIR/viewport-shots" SCENE_TIMING_OUTDIR="$RDIR/viewport-results" \
      E2E_BASE_URL="$WEB_URL" GRAFANA_URL="${GRAFANA_URL:-http://localhost:3001}" \
      npx playwright test -c playwright.scenes.config.ts e2e/scene-viewport.timing.ts) > "$RDIR/viewport.out" 2>&1 || rc=1
    log "run=$r viewport $(head -c 300 "$RDIR/viewport.json" 2>/dev/null)"
  fi
  echo "WEB $w0 $(now_ms)" >> "$RDIR/windows.txt"
  log "run=$r web end rc=$rc $(cat "$RDIR/web.json" 2>/dev/null)"
  printf '  화면     %s\n' "$(cat "$RDIR/web.json" 2>/dev/null || echo "실패 (run-$r/web.out)")"
  return $rc
}

# ---------- 유효 설정 확인 (z75-43) ----------
# $@ = 이름=값 … 기대값. 끝 코드 0 = 같음(또는 줄 없음·로그 없음 경고), 1 = 다름
config_expect() {
  local src rc out
  if [ "$MODE" = prod ]; then src=(--cmd "docker compose -f docker-compose.prod.yml logs --no-log-prefix worker")
  elif [ -n "${WORKER_LOG:-}" ]; then src=(--file "$WORKER_LOG")
  else log "config SKIP (WORKER_LOG 없음)"; echo "유효 설정: SKIP (개발 모드는 WORKER_LOG=<워커 로그 파일>)"; return 0; fi
  out=$(python3 tools/measure/config-expect.py "${src[@]}" --service worker --wait "${CONFIG_WAIT_SEC:-10}" "$@"); rc=$?
  echo "유효 설정: $out"; log "config rc=$rc $out"
  case $rc in
    0) return 0 ;;
    3) [ "${CONFIG_STRICT:-0}" = 1 ] && return 1; return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- Cloudflare 끊김 모드 (z75-42) ----------
NET_FAIL_STUCK_SEC=${NET_FAIL_STUCK_SEC:-15}
NET_FAIL_RECOVER_SEC=${NET_FAIL_RECOVER_SEC:-20}
# 가짜 번호와 닿지 않는 프록시. 비밀값 아님. 127.0.0.1:9 는 아무도 안 듣는 포트라 바로 연결 거부
NF_ENV="TRAFFIC_PROVIDER=cloudflare TRAFFIC_LB_ID=netfail-lb CLOUDFLARE_ZONE_ID=netfail-zone CLOUDFLARE_SOURCE_POOL_ID=netfail-src
CLOUDFLARE_TARGET_POOL_ID=netfail-dst CLOUDFLARE_API_TOKEN=netfail-dummy NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9
HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=localhost,127.0.0.1,db,api,prometheus,grafana"
# 워커 다시 띄우기: $1 = fail | normal. 끝나면 "worker ready" 까지 기다린다
nf_worker() {
  local since i
  if [ "$MODE" = prod ]; then
    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ "$1" = fail ]; then
      { echo "services:"; echo "  worker:"; echo "    environment:"
        for kv in $NF_ENV; do echo "      ${kv%%=*}: \"${kv#*=}\""; done; } > "$LOG_DIR/net-fail.override.yml"
      docker compose -f docker-compose.prod.yml -f "$LOG_DIR/net-fail.override.yml" up -d worker || return 1
    else
      docker compose -f docker-compose.prod.yml up -d worker || return 1
    fi
    for i in $(seq 1 60); do docker compose -f docker-compose.prod.yml logs --since "$since" worker 2>/dev/null | grep -q "worker ready" && return 0; sleep 0.5; done
    echo "워커가 30초 안에 ready 를 안 찍음"; return 1
  fi
  [ -n "${NET_FAIL_RESTART_CMD:-}" ] || { echo "개발 모드는 NET_FAIL_RESTART_CMD 가 필요하다"; return 1; }
  if [ "$1" = fail ]; then env $NF_ENV sh -c "$NET_FAIL_RESTART_CMD"; else sh -c "$NET_FAIL_RESTART_CMD"; fi
}
net_fail_main() {
  local t0 t1 tp tc st fc rc=0 stuck rec
  RDIR="$LOG_DIR/net-fail"; mkdir -p "$RDIR"; FP="$RDIR/fingerprint.txt"; : > "$FP"
  OUT="$RDIR/run.out"; : > "$OUT"; GAPF="$RDIR/gaps"; : > "$GAPF"
  log "net-fail start mode=$MODE"
  if [ "$DO_RESET" = 1 ]; then bash tools/demo-reset.sh $RESET_ARGS > "$RDIR/reset.out" 2>&1 || { echo "초기화 실패"; return 1; }; fi
  nf_worker fail >> "$OUT" 2>&1 || { echo "워커(끊김) 못 띄움: $OUT"; return 1; }
  config_expect TRAFFIC_PROVIDER=cloudflare || { echo "워커가 끊김 설정으로 안 떴다"; nf_worker normal >> "$OUT" 2>&1; return 1; }
  log "net-fail worker=fail ready"
  T_SCENE=$(now_ms)
  scene_S1 >> "$OUT" 2>&1 || { echo "S1 실패: $OUT"; nf_worker normal >> "$OUT" 2>&1; return 1; }
  api POST "/api/v1/plans/$PLAN_ID/approvals" "{\"decision\":\"approve\",\"planHash\":\"$PLAN_HASH\"}" >/dev/null
  wait_status approved >> "$OUT" 2>&1
  t0=$(now_ms); T_SCENE=$t0
  api POST "/api/v1/migrations/$MID/start" >/dev/null
  # paused 와 실패 코드가 둘 다 보일 때까지 (최대 60초)
  while :; do
    st=$(api GET "/api/v1/migrations/$MID"); fc=$(echo "$st" | jget 'd.get("failureCode") or ""'); st=$(echo "$st" | jget 'd.get("status","")')
    [ "$st" = paused ] && [ -n "$fc" ] && break
    case "$st" in completed|failed|rolled_back|cancelled) break ;; esac
    [ $(( $(now_ms) - t0 )) -gt 60000 ] && break
    sleep "$POLL_S"
  done
  tp=$(now_ms); stuck=$((tp - t0))
  echo "끊김: 시작 → $st (실패 코드 ${fc:-없음}) $(sec $stuck)초" | tee -a "$OUT"
  log "net-fail stuck status=$st code=${fc:-} sec=$(sec $stuck)"
  t1=$(now_ms)
  nf_worker normal >> "$OUT" 2>&1 || { echo "워커(정상) 못 띄움: $OUT"; return 1; }
  config_expect TRAFFIC_PROVIDER=mock || { echo "워커가 정상 설정으로 안 돌아왔다"; return 1; }
  api POST "/api/v1/migrations/$MID/resume" >> "$OUT"; echo >> "$OUT"
  T_SCENE=$t1
  WAIT_LIMIT_SEC=60 wait_status completed >> "$OUT" 2>&1; rc=$?
  tc=$(now_ms); rec=$((tc - t1))
  st=$(api GET "/api/v1/migrations/$MID" | jget 'd.get("status","")')
  echo "복구: 워커 정상으로 다시 띄움 + 재개 → $st $(sec $rec)초" | tee -a "$OUT"
  log "net-fail recover status=$st sec=$(sec $rec)"
  {
    echo "Cloudflare 끊김 (--net-fail cloudflare, 이전 $MID)"
    echo "굳는 시간: 시작 → paused + 실패 코드 ${fc:-없음}: $(sec $stuck)초 (기준 ≤${NET_FAIL_STUCK_SEC}초)"
    echo "복구 시간: 워커 정상 기동 + 재개 → $st: $(sec $rec)초 (기준 ≤${NET_FAIL_RECOVER_SEC}초)"
    local bad=""
    [ -n "$fc" ] || bad="$bad 실패 코드 없음;"
    [ "$stuck" -le $((NET_FAIL_STUCK_SEC * 1000)) ] || bad="$bad 굳는 시간 넘침;"
    [ "$st" = completed ] || bad="$bad 복구 뒤 completed 아님;"
    [ "$rec" -le $((NET_FAIL_RECOVER_SEC * 1000)) ] || bad="$bad 복구 시간 넘침;"
    if [ -z "$bad" ]; then echo "판정 PASS: net-fail cloudflare"; else echo "판정 FAIL: net-fail cloudflare /$bad"; fi
  } > "$SUMMARY"
  cat "$SUMMARY"; log "$(tail -n 1 "$SUMMARY")"
  case "$(tail -n 1 "$SUMMARY")" in "판정 PASS"*) return 0 ;; *) return 1 ;; esac
}
if [ -n "$NET_FAIL" ]; then net_fail_main; exit $?; fi

# 장면 전에 떠 있는 워커 설정을 본다 (6차 맥: 운영 워커가 관찰 30초로 떠 있었다)
EXPECT_OBSERVE_SEC=${EXPECT_OBSERVE_SEC:-$([ "$MODE" = prod ] && echo "${TRAFFIC_OBSERVE_SEC:-4}" || echo "${TRAFFIC_OBSERVE_SEC:-}")}
if ! config_expect GITOPS=off TRAFFIC_OBSERVE_SEC.floorApplied=false ${EXPECT_OBSERVE_SEC:+TRAFFIC_OBSERVE_SEC=$EXPECT_OBSERVE_SEC}; then
  echo "판정 FAIL: 워커 유효 설정이 리허설 기대와 다름 (위 줄). 워커를 기대값으로 다시 띄운 뒤 돌린다" | tee "$SUMMARY"
  log "$(tail -n 1 "$SUMMARY")"; exit 1
fi

log "start runs=$RUNS reset=$DO_RESET warmup=$DO_WARM web=$DO_WEB mode=$MODE api=$API GITOPS_DISABLE=$GITOPS_DISABLE"
echo "리허설 ${RUNS}회 시작 $(iso) → $LOG_DIR"
SAMPLER=""
if [ "$DO_SAMPLE" = 1 ]; then
  RES_SAMPLE_PARENT=$$ bash tools/measure/res-sample.sh "$LOG_DIR/res.csv" 2>/dev/null &
  SAMPLER=$!
  trap '[ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null' EXIT
fi
r=1
while [ $r -le "$RUNS" ]; do run_once $r; r=$((r + 1)); done
if [ -n "$SAMPLER" ]; then sleep 1; kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null; SAMPLER=""; fi

# ---------- 대본-실측 표 (z75-41) ----------
TALK_OUT_DIR=${TALK_OUT_DIR:-$LOG_DIR}
case "$TALK_OUT_DIR" in /*) ;; *) TALK_OUT_DIR="$CALLER_PWD/$TALK_OUT_DIR" ;; esac
: > "$LOG_DIR/talk.txt"
r=1
while [ $r -le "$RUNS" ]; do
  out="$TALK_OUT_DIR/talk-timing-run$r.md"
  [ "$TALK_OUT_DIR" = "$LOG_DIR" ] || out="$TALK_OUT_DIR/talk-timing-$(basename "$LOG_DIR")-run$r.md"
  python3 tools/measure/talk-timing.py "${TALK_FILE:-/없음}" "$LOG_DIR/run-$r" "$out" > "$LOG_DIR/run-$r/talk.out" 2>&1
  echo "$r $? $out $(tail -n 1 "$LOG_DIR/run-$r/talk.out")" >> "$LOG_DIR/talk.txt"
  r=$((r + 1))
done

# ---------- 판정 ----------
{
  echo "장면 / 대본 칸(초) / 회차별 기계 시간(초) / 회차별 최대 대기(초)"
  for item in $SCENES; do
    id=${item%%:*}
    line="$id"
    r=1
    while [ $r -le "$RUNS" ]; do
      v=$(awk -v i="$id" '$1 == i { printf "%.2f/%.2f/%s", $2 / 1000, $3 / 1000, $5 }' "$LOG_DIR/run-$r/times.txt" 2>/dev/null)
      line="$line  ${v:--}"
      r=$((r + 1))
    done
    echo "$line  (칸 ${item#*:})"
  done
} > "$SUMMARY"

python3 - "$LOG_DIR" "$RUNS" "$WAIT_SEC" "$LIMIT_SEC" "$SCENES" "$DO_WEB" "$WEB_SCENE_LIMIT_MS" "$WEB_TOTAL_LIMIT_MS" "$WEB_URL" \
  "$S4_READ_CHARS" "$FIRST_REQ_LIMIT_MS" "$DO_WARM" "${TRAFFIC_OBSERVE_SEC:-?}" \
  "$DO_SAMPLE" "$RES_IDLE_MIN" "$RES_DOCKER_MAX_MB" "$COMPARE_WITH" "$HUMAN_DELAY" "${S4_CLOUD_EXTRA_SEC:-60}" \
  "$DO_DEEPLINK" "${DEEPLINK_LIMIT_MS:-1000}" "$DO_VIEWPORT" >> "$SUMMARY" <<'PY'
import sys, os, json
d, runs, wait_s, limit_s, scenes = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5].split()
do_web, web_one, web_total, web_url = sys.argv[6] == "1", int(sys.argv[7]), int(sys.argv[8]), sys.argv[9]
s4_chars, first_limit, do_warm, observe = int(sys.argv[10]), int(sys.argv[11]), sys.argv[12] == "1", sys.argv[13]
do_sample, idle_min, dock_max, compare = sys.argv[14] == "1", float(sys.argv[15]), float(sys.argv[16]), sys.argv[17]
human_delay, s4_extra = float(sys.argv[18]), float(sys.argv[19])
do_deep, deep_limit = sys.argv[20] == "1", int(sys.argv[21])
do_vp = sys.argv[22] == "1"
order = [s.split(":")[0] for s in scenes]
def load(r):
    t, fp = {}, []
    try:
        for ln in open(os.path.join(d, f"run-{r}", "times.txt")):
            p = ln.split()
            t[p[0]] = (int(p[1]), int(p[2]), int(p[3]), p[4])
        fp = open(os.path.join(d, f"run-{r}", "fingerprint.txt")).read().splitlines()
    except FileNotFoundError:
        pass
    return t, fp
R = [load(r) for r in range(1, runs + 1)]
bad = []
waits = 0; over_slot = 0; worst_dev = 0.0
for i, (t, fp) in enumerate(R, 1):
    missing = [s for s in order if s not in t]
    fails = [s for s, v in t.items() if v[3] != "OK"]
    total = sum(v[0] for v in t.values()) / 1000
    if missing or fails: bad.append(f"회차{i} 실패 {','.join(fails + missing)}")
    if total > limit_s: bad.append(f"회차{i} 총 {total:.1f}초 > {limit_s:.0f}")
    waits += sum(1 for v in t.values() if v[1] >= wait_s * 1000)
    over_slot += sum(1 for v in t.values() if v[0] > v[2] * 1000)
    print(f"회차{i}: 총 {total:.2f}초, {wait_s:.0f}초 이상 대기가 있는 장면 {sum(1 for v in t.values() if v[1] >= wait_s * 1000)}개")
same = True
for i in range(1, runs):
    (a, fa), (b, fb) = R[i - 1], R[i]
    if fa != fb:
        same = False
        diff = [f"{x} ≠ {y}" for x, y in zip(fa, fb) if x != y] or ["줄 수 다름"]
        print(f"회차{i}·{i+1} 지문 다름: " + "; ".join(diff[:3]))
    for s in order:
        if s in a and s in b:
            x, y = a[s][0], b[s][0]
            dev = abs(x - y) / max(x, y, 1)
            if abs(x - y) >= 500:
                worst_dev = max(worst_dev, dev)
web_dev = 0.0
if do_web:
    W = []
    for r in range(1, runs + 1):
        try: W.append(json.load(open(os.path.join(d, f"run-{r}", "web.json"))))
        except Exception: W.append(None)
    for i, w in enumerate(W, 1):
        if w is None:
            bad.append(f"회차{i} 화면 시간 없음"); print(f"화면 장면당 ms 회차{i}: 없음 ({web_url})"); continue
        tot = sum(w.values())
        print(f"화면 장면당 ms 회차{i}: " + " ".join(f"{k}={v}" for k, v in w.items()) + f" 합 {tot} ({web_url})")
        slow = [k for k, v in w.items() if v > web_one]
        if slow: bad.append(f"회차{i} 화면 {','.join(slow)} > {web_one}ms")
        if tot > web_total: bad.append(f"회차{i} 화면 합 {tot} > {web_total}ms")
    for i in range(1, runs):
        a, b = W[i - 1], W[i]
        if a and b:
            x, y = sum(a.values()), sum(b.values())
            if abs(x - y) >= int(os.environ.get("WEB_DEV_FLOOR_MS", "300")):
                web_dev = max(web_dev, abs(x - y) / max(x, y, 1))
    if web_dev > 0.10: bad.append(f"화면 합 편차 {web_dev*100:.0f}% > 10%")
# z75-36: S4 기계 시간 vs 대본 문단 3 읽기 시간
read_fast, read_slow = s4_chars / 6, s4_chars / 5
s4_hi, s4_lo = read_fast - 1, 2.0
s4s = [t["S4"][0] / 1000 for t, _ in R if "S4" in t]
s4w = [t["S4"][1] / 1000 for t, _ in R if "S4" in t]
s4_ok = all(s4_lo <= x <= s4_hi for x in s4s)
print(f"S4 비교 (TRAFFIC_OBSERVE_SEC={observe}): 대본 문단 3 읽기 {read_fast:.1f}~{read_slow:.1f}초 ({s4_chars}자 ÷ 6~5), "
      f"기준 {s4_lo:.1f}~{s4_hi:.1f}초 / S4 " + "·".join(f"{x:.2f}" for x in s4s) + "초, 최대 대기 " + "·".join(f"{x:.2f}" for x in s4w)
      + f"초 → {'OK' if s4_ok else '넘침' if any(x > s4_hi for x in s4s) else '너무 빠름'}")
if s4s and not s4_ok: bad.append("S4 가 대본 읽기 시간 기준 밖")
# z75-37: 회차 첫 요청 지연
firsts = []
for r in range(1, runs + 1):
    try: firsts.append(int(open(os.path.join(d, f"run-{r}", "first_ms")).read().strip() or 0))
    except Exception: pass
if firsts:
    print(f"첫 요청 ms ({'예열 함' if do_warm else '예열 없음'}): " + "·".join(map(str, firsts)) + f" (기준 ≤{first_limit})")
    if max(firsts) > first_limit: bad.append(f"첫 요청 {max(firsts)}ms > {first_limit}")
# z75-40: 장면별 자원 (리허설 내내 1초 샘플, 회차를 합쳐 장면마다 최저 idle·최대 도커 메모리·스왑 증가)
def num(x):
    try: return float(x)
    except ValueError: return None
samples = []
if do_sample:
    try:
        for ln in open(os.path.join(d, "res.csv")).read().splitlines()[1:]:
            p = (ln.split(",") + [""] * 5)[:5]
            samples.append((int(p[0]), num(p[1]), num(p[2]), num(p[3]), num(p[4])))
    except (FileNotFoundError, ValueError):
        pass
if do_sample and not samples:
    print("자원: 샘플 없음 (res.csv 비었음)")
elif samples:
    wins = {}
    for r in range(1, runs + 1):
        try:
            for ln in open(os.path.join(d, f"run-{r}", "windows.txt")):
                k, a, b = ln.split(); wins.setdefault(k, []).append((int(a), int(b)))
        except FileNotFoundError:
            pass
    fmt = lambda v, f: "-" if v is None else f.format(v)
    worst = []
    page_kb = float(os.environ.get("RES_PAGE_KB", "4")); swap_max_mb = float(os.environ.get("RES_SWAP_MAX_MB", "1"))
    for k in order + ["WEB"]:
        if k not in wins: continue
        idle = dock = None; sw_mb = sw_pg = 0.0
        for a, b in wins[k]:
            # 장면이 1초보다 짧아도 샘플 하나는 잡히게 앞뒤 1초를 붙인다
            w = [s for s in samples if a - 1000 <= s[0] <= b + 1000]
            if not w: continue
            iv = [s[1] for s in w if s[1] is not None]; dv = [s[2] for s in w if s[2] is not None]
            if iv: idle = min(iv) if idle is None else min(idle, min(iv))
            if dv: dock = max(dv) if dock is None else max(dock, max(dv))
            um = [s[3] for s in w if s[3] is not None]; up = [s[4] for s in w if s[4] is not None]
            if um: sw_mb = max(sw_mb, max(um) - um[0])
            if up: sw_pg = max(sw_pg, max(up) - up[0])
        # 11c: 스왑아웃 누계는 페이지 수 → MB 로 바꿔 참고만. 판정은 스왑 사용량(MB) 증가로 한다 (맥 11차: 12만 페이지를 그대로 비교해 FAIL)
        pg_mb = sw_pg * page_kb / 1024
        print(f"자원 {k}: CPU idle 최저 {fmt(idle, '{:.0f}%')}, 도커 메모리 최대 {fmt(None if dock is None else dock / 1024, '{:.2f}GB')}, "
              f"스왑 사용 증가 {sw_mb:.0f}MB (스왑아웃 누계 +{pg_mb:.0f}MB, 참고)")
        if idle is not None and idle < idle_min: worst.append(f"{k} idle {idle:.0f}%<{idle_min:.0f}%")
        if dock is not None and dock > dock_max: worst.append(f"{k} 도커 {dock/1024:.1f}GB>{dock_max/1024:.0f}GB")
        if sw_mb >= swap_max_mb: worst.append(f"{k} 스왑 사용 +{sw_mb:.0f}MB")
    print(f"자원 기준: CPU idle ≥{idle_min:.0f}%, 도커 메모리 ≤{dock_max/1024:.0f}GB, 스왑 사용 증가 <{swap_max_mb:.0f}MB / 샘플 {len(samples)}개 → " + ("OK" if not worst else "넘침: " + ", ".join(worst)))
    if worst: bad.append("자원 기준 넘침 (" + ", ".join(worst) + ")")
# z75-40: 관측 끔 비교 (COMPARE_WITH = 관측 켠 리허설 폴더). 판정에는 안 넣는다
def scene_sums(dd):
    out = []
    for r in range(1, 20):
        f = os.path.join(dd, f"run-{r}", "times.txt")
        if not os.path.exists(f): break
        out.append(sum(int(ln.split()[1]) for ln in open(f) if ln.strip()))
    return out
if compare:
    on, off = scene_sums(compare), scene_sums(d)
    if on and off:
        a, b = sum(on) / len(on), sum(off) / len(off)
        diff = abs(a - b) / max(a, b, 1)
        pick = "관측 켜 둠" if diff < 0.05 else "관측 끔" if diff >= 0.10 else "관측 켜 둠 (5~10% 사이, 한 번 더 잼)"
        print(f"관측 끔 비교: 켬 {a/1000:.2f}초 ({len(on)}회 평균) vs 이번 {b/1000:.2f}초 ({len(off)}회), 차이 {diff*100:.1f}% → {pick}")
    else:
        print(f"관측 끔 비교: 장면 시간 없음 (COMPARE_WITH={compare})")
# z75-41: 대본-실측 표 (talk-timing.py 결과, 끝 코드 2 = 대본 없음 → 판정에서 뺌)
try:
    for ln in open(os.path.join(d, "talk.txt")):
        p = ln.rstrip("\n").split(" ", 3)
        if len(p) < 4: continue
        if p[1] == "2": print(f"대본-실측 회차{p[0]}: SKIP (대본 없음, TALK_FILE)"); continue
        print(f"대본-실측 회차{p[0]}: {p[3]} → {p[2]}")
        if p[1] != "0": bad.append(f"대본-실측 회차{p[0]} FAIL")
except FileNotFoundError:
    pass
# z75-45: 기계 합 / 사람 포함 합 (장면 전환마다 --human-delay 초)
mach, human = [], []
for r, (t, _) in enumerate(R, 1):
    m = sum(v[0] for v in t.values()) / 1000
    try: h = sum(float(x) for x in open(os.path.join(d, f"run-{r}", "human.txt")).read().split())
    except FileNotFoundError: h = 0.0
    mach.append(m); human.append(m + h)
if mach:
    print("기계 합: " + "·".join(f"{x:.2f}" for x in mach) + f"초 (기준 ≤{limit_s:.0f})")
    print(f"사람 포함 합 (전환마다 {human_delay:g}초): " + "·".join(f"{x:.2f}" for x in human) + f"초 (기준 ≤{limit_s:.0f})")
    if max(human) > limit_s: bad.append(f"사람 포함 합 {max(human):.1f}초 > {limit_s:.0f}")
    # 실클라우드 shift 가 S4_CLOUD_EXTRA_SEC 길어질 때 (z75-38 단계 도달 판정, Z75 추정 약 60초). 참고만
    if s4s and s4_extra:
        s4c = [x + s4_extra for x in s4s]; hc = [x + s4_extra for x in human]
        talk = f"대본 문단 3 읽기 {read_fast:.1f}~{read_slow:.1f}초"
        over = max(s4c) - read_slow
        print(f"실클라우드 가정 S4 +{s4_extra:g}초: S4 " + "·".join(f"{x:.1f}" for x in s4c) + f"초 vs {talk}"
              + (f" → 말이 화면을 {over:.0f}초 기다림 (S4 칸·대본 조정 필요)" if over > 0 else " → 말 안에 끝남")
              + ", 사람 포함 합 " + "·".join(f"{x:.1f}" for x in hc) + f"초 → {'300초 안' if max(hc) <= limit_s else '300초 넘침'}")
# z75-49: 딥링크 vs 메뉴 경로
if do_deep:
    for r in range(1, runs + 1):
        try: dl = json.load(open(os.path.join(d, f"run-{r}", "deeplink.json")))
        except Exception:
            print(f"딥링크 회차{r}: 결과 없음 (run-{r}/deeplink.out)"); bad.append(f"딥링크 회차{r} 결과 없음"); continue
        rows = dl.get("routes", [])
        print(f"딥링크 ms 회차{r} (딥링크/메뉴): " + " ".join(f"{x['id']}={x['deepMs']}/{x['menuMs']}" for x in rows))
        nok = [x["id"] for x in rows if x.get("status") != 200]
        slow = [x["id"] for x in rows if x["deepMs"] > deep_limit]
        if nok: bad.append(f"딥링크 200 아님: {','.join(nok)}")
        if slow: bad.append(f"딥링크 {deep_limit}ms 넘음: {','.join(slow)}")
# z75-54: 장면 × 확대 조건 표 (1회차)
if do_vp:
    try: vp = json.load(open(os.path.join(d, "run-1", "viewport.json")))
    except Exception: vp = None
    if vp is None:
        print("확대 조건: 결과 없음 (run-1/viewport.out)"); bad.append("확대 조건 결과 없음")
    else:
        conds = [c["id"] for c in vp.get("conds", [])]
        cell = {}
        vbad = []
        for x in vp.get("rows", []):
            if x.get("skipped"): cell[(x["scene"], x["cond"])] = "건너뜀"; continue
            probs = []
            if x.get("status") not in (None, 200): probs.append(f"HTTP {x.get('status')}")
            if x.get("hscroll", 0) > 0: probs.append(f"가로 스크롤 {x['hscroll']}px")
            if not x.get("visible"): probs.append("요소 안 보임")
            elif not x.get("inside"): probs.append("요소 창 밖")
            if x.get("menu") is False: probs.append("메뉴 없음")
            if x.get("menuFits") is False: probs.append("메뉴 아래 잘림")
            cell[(x["scene"], x["cond"])] = "OK" if not probs else "·".join(probs)
            if probs: vbad.append(f"{x['scene']}@{x['cond']}%:" + "·".join(probs) + (" 넘친 요소 " + ",".join(o["el"] for o in x.get("over", [])) if x.get("over") else ""))
        scn = list(dict.fromkeys(x["scene"] for x in vp.get("rows", [])))
        print("확대 조건 (1920×1080, 브라우저 확대 " + "·".join(f"{c}%" for c in conds) + "):")
        print("| 장면 | " + " | ".join(f"{c}%" for c in conds) + " |")
        print("|---|" + "---|" * len(conds))
        for sc in scn: print(f"| {sc} | " + " | ".join(cell.get((sc, c), "-") for c in conds) + " |")
        if vbad: bad.append("확대 조건 잘림 " + "; ".join(vbad[:5]))
if waits: bad.append(f"{wait_s:.0f}초 이상 대기가 있는 장면 {waits}개")
if over_slot: bad.append(f"대본 칸 넘친 장면 {over_slot}개")
if runs > 1 and not same: bad.append("결과 지문 다름")
if worst_dev > 0.10: bad.append(f"장면 시간 편차 {worst_dev*100:.0f}% > 10%")
verdict = "PASS" if not bad else "FAIL"
same_txt = ("예" if same else "아니오") if runs > 1 else "(1회만)"
print(f"판정 {verdict}: {runs}회 결과 같음={same_txt}, 장면 시간 편차 최대 {worst_dev*100:.0f}% (0.5초 미만 차이 제외, 기준 10%), "
      f"{wait_s:.0f}초 이상 대기 장면 {waits}개, 칸 넘침 {over_slot}개" + (f", 화면 합 편차 {web_dev*100:.0f}%" if do_web else ", 화면 안 잼") + ("" if not bad else " / " + "; ".join(bad)))
PY
echo
cat "$SUMMARY"
verdict=$(tail -n 1 "$SUMMARY")
log "$verdict"
case "$verdict" in "판정 PASS"*) exit 0 ;; *) exit 1 ;; esac
