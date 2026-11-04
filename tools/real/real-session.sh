#!/usr/bin/env bash
# REALRUN: 실클라우드 한 회차 (상태: AI 초안). 맥 RC 가 돌린다. 이 스크립트 자체는 terraform apply/destroy 를 치지 않는다.
#   올리기·내리기는 Jeong 손 줄(sh tools/jeong-up.sh, sh tools/jeong-down.sh)이고, 이 스크립트는 진행 파일만 기다린다. 분류기 우회 금지.
# 사용: bash tools/real/real-session.sh [Service 폴더] [시작 단계]   (레포 안 판. 예전 mac/real-session.sh 와 같은 흐름)
#   단계 이름: pre up deploy connect import ecs-up ecs-import ecs-down run down zero   (ecs-* = ECS 출발 샘플 한 번. STOP_AFTER=<단계> 면 그 단계 끝에서 멈춤)   (앞 단계가 끝난 회차면 이어서: 시작 단계 지정)
#   Service 폴더 기본 = 이 스크립트가 든 레포 (tools/real/../..). 대조·흐름 스크립트도 같은 레포의 tools/real/ 것을 쓴다 (복사 안 함)
# 환경(선택): AWS_PROFILE(finals) AWS_REGION(ap-northeast-2) EKS_CONTEXT(eks-platform-target) GKE_CONTEXT
#   REAL_PLAN_ACKS(1: run 단계 전에 api 를 PLAN_ACKS=1 로 재시작, 0: 안 함) UP_WAIT_SEC(3000) DOWN_WAIT_SEC(1800) NS(real-app) WEB_IMAGE·API_IMAGE(태그 또는 @sha256) REAL_CONNECT_RUN(기본 1: 연결 스택을 이 스크립트가 레포 템플릿으로 CLI 생성. 0: 링크만 찍고 사람이 콘솔에서 열 때까지 기다림 — 이때는 .env 의 두 값이 진짜여야 함)
# 결과: $RESULTS_DIR(기본 $HOME/.svc-tf/real-results, 레포 밖)/real-<시각>.md — 단계마다 시각·rc. 실패하면 그 단계에서 멈추고 "down 안내"를 찍는다(자원이 이미 있으므로 down 을 잊지 않게).
#   GATE-v2: 그때 감시 창(sh tools/jeong-watch.sh)이 읽는 실패 신호 파일 $STATE/auto-fail 도 남긴다 → 감시 창이 Jeong 대신 jeong-down 을 친다. STOP_AFTER 로 일부러 멈춘 건 안 남긴다.
# 가림: 12자리 숫자·arn 계정 칸·AKIA/ASIA 키·확인 문구는 파일·화면에 쓰기 전에 sed 로 가린다. 비밀값은 임시 파일(600)에만, 끝에 지운다.
set -uo pipefail
set -m
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="${1:-$(cd "${HERE}/../.." && pwd)}"
START="${2:-pre}"
# FM-ORC-17: 실측 워커·API 는 watch 없는 start:* (dev:* = tsx watch 는 회차 중 git checkout·.ts 저장에 다시 떠 자식 terraform 이 같이 죽음).
#   start:* 가 없는 옛 판(base-10 이하)이면 dev:*. 코드를 고치며 돌릴 때만 REAL_RUN_PREFIX=dev
RUNP="${REAL_RUN_PREFIX:-$(grep -qs '"start:worker"' "${SVC}/package.json" && echo start || echo dev)}"
TS="${REAL_TS:-$(date -u +%Y%m%dT%H%M%SZ)}"
RES="${RESULTS_DIR:-$HOME/.svc-tf/real-results}"; OUT="${RES}/real-${TS}.md"; ART="${RES}/real-${TS}"
STATE="${DEMO_DAY_STATE:-$HOME/.svc-tf/demo-day}"
# FM-OPS-01: 회차 중 어떤 명령도 입력을 기다리지 않게 (gcloud 확인 질문·aws 페이저 less). demo-day·jeong 줄과 같은 값
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 AWS_PAGER="" PAGER=cat
# FM-OPS-01·03: REAL_BG=1 이면 자기를 nohup 으로 다시 띄우고 바로 돌아온다. 띄운 창(로컬 claude 세션·터미널)이 멈추거나 닫혀도 회차는 계속,
#   실패 신호는 감시 창(jeong-watch)이 $STATE/auto-fail 로 받는다. 결과 파일 이름이 같도록 시각(REAL_TS)을 물려준다
if [ "${REAL_BG:-0}" = 1 ] && [ -z "${REAL_BG_CHILD:-}" ]; then
  mkdir -p "${RES}" || exit 1
  BGOUT="${RES}/real-${TS}.out"
  REAL_BG_CHILD=1 REAL_TS="${TS}" nohup bash "$0" "$@" < /dev/null > "${BGOUT}" 2>&1 &
  echo "뒤에서 시작: pid $! · 화면 기록 ${BGOUT} · 결과 ${OUT}"
  echo "따라 보기: tail -f \"${BGOUT}\"   (이 창을 닫아도 회차는 계속 돈다. 멈추려면 kill $!)"
  exit 0
fi
# UPREV: gke-gcloud-auth-plugin 이 gcloud SDK bin 에만 있고 PATH 에 없을 때(맥 실측 /usr/local/share/google-cloud-sdk/bin) PATH 앞에 더함. 뒤로 띄우는 것도 물려받음
if ! command -v gke-gcloud-auth-plugin >/dev/null 2>&1 && command -v gcloud >/dev/null 2>&1; then
  _sdk=$(gcloud info --format='value(installation.sdk_root)' 2>/dev/null)
  [ -n "$_sdk" ] && [ -x "$_sdk/bin/gke-gcloud-auth-plugin" ] && export PATH="$_sdk/bin:$PATH"
fi
JPROG="${STATE}/jeong-progress.log"
# UPREV-B: 회차 사이에 남는 파일은 ART(results 폴더)가 아니라 STATE(맥 홈, 폴더 밖)에 둔다. up 이 끝날 때 도장(UP_STAMP)을 찍고,
#   도장보다 오래된 env-id.txt·migration-id.txt 는 지난 회차 것(스택·클러스터가 이미 없음)이라 쓰지 않는다
UP_STAMP="${STATE}/real-up.stamp"; SECRET_CHECK="${STATE}/real-secret-check"; DIGESTS="${STATE}/real-digests"
export AWS_PROFILE="${AWS_PROFILE:-finals}" AWS_REGION="${AWS_REGION:-ap-northeast-2}"
EKS_CONTEXT="${EKS_CONTEXT:-eks-platform-target}"
# CON-01: GCP 도착 연결 값 (demo-day 와 같은 기본값). REAL_GCP_CONNECT=0 이면 예전처럼 시드 도착(3333…, 흉내 발급)
GCP_PROJECT="${GCP_PROJECT:-finals-demo}"; GCP_ZONE="${GCP_ZONE:-asia-northeast3-a}"; GPP="${GCP_PLATFORM_PROJECT:-${GCP_PROJECT}}"
# FM-CLD-hunt-cloud-25: 자식(cloud-zero·demo-day·gcp-connect-real)이 gcloud 기본 프로젝트 대신 이 값을 보게 내보낸다 (안 내보내면 거짓 "OK zero").
#   결정 3 A안: 도착 전용 프로젝트도 같이 (환경 변수 → 레포 .env)
TARGET_PROJECT_ID="${TARGET_PROJECT_ID:-$(sed -n 's/^TARGET_PROJECT_ID=//p' "${SVC}/.env" 2>/dev/null | tail -n 1 | tr -d "\"' ")}"
export GCP_PROJECT GCP_ZONE TARGET_PROJECT_ID
SEED_TARGET=33333333-3333-4333-8333-333333333333
NS="${NS:-real-app}"
# GATE-common c4: down 은 served-by·ELB 대기(≤5분) + tf:real RDS destroy(≈6~10분, 재시도 60초×3) + env 둘 destroy(재시도 3회) + cloud-zero 대기(≤10분)라 30분을 넘길 수 있다 → 60분
UP_WAIT_SEC="${UP_WAIT_SEC:-3000}"; DOWN_WAIT_SEC="${DOWN_WAIT_SEC:-3600}"
WEB_IMAGE="${WEB_IMAGE:-docker.io/library/nginx:1.27-alpine}"
API_IMAGE="${API_IMAGE:-docker.io/hashicorp/http-echo:1.0}"
API_PORT="${API_PORT:-3000}"
mkdir -p "${RES}" "${ART}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/real-session.XXXXXX")"; chmod 700 "${TMPD}"
# MACAWAKE (FM-OPS-04): 이 회차가 도는 동안(연결 20분 대기·down 60분 대기 포함) 맥이 잠들지 않게. -w: 이 스크립트가 끝나면 같이 끝남. 없는 곳(리눅스)·REAL_NO_AWAKE=1 은 건너뜀
if [ "${REAL_NO_AWAKE:-0}" != 1 ] && command -v caffeinate >/dev/null 2>&1; then caffeinate -i -m -s -w $$ < /dev/null > /dev/null 2>&1 & fi

# 화면·파일에 쓰는 글자는 전부 mask 를 거친다
# mask.sh(가림 필터, perl)가 옆에 있으면 그것을, 없으면 sed 간이판을 쓴다
mask_sed() { sed -E -e 's/AKIA[0-9A-Z]{16}/AKIA****/g' -e 's/ASIA[0-9A-Z]{16}/ASIA****/g' \
  -e 's/(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)[0-9]{12}/\1************/g' -e 's/(^|[^0-9])[0-9]{12}([^0-9]|$)/\1************\2/g' \
  -e 's/(ExternalId[=: ]+)[A-Za-z0-9+=,.@:\/-]{8,}/\1****/g' -e 's/(ParameterValue=)[^ ]{20,}/\1****/g' -e 's/([Bb]earer |BEARER |[Pp]assword[=:] ?)[^ "]+/\1****/g' -e 's/(PASSWORD[=:] ?)[^ "]+/\1****/g'; }
mask() { if [ -f "${HERE}/mask.sh" ] && command -v perl >/dev/null 2>&1; then sh "${HERE}/mask.sh" | mask_sed; else mask_sed; fi; }
declare -a ROWS=(); FAILED=0; CUR="pre"; UP_DONE=0; DOWN_DONE=0; DONE=0; STOPPED=0
now() { date -u +%H:%M:%SZ; }
row() { ROWS+=("| $(now) | $1 | $2 | $(printf '%s' "$3" | mask | tr '\n|' ' /') |"); [ "$2" = PASS ] || [ "$2" = SKIP ] || [ "$2" = INFO ] || FAILED=1; printf '%s %s %s\n' "$(now)" "$1" "$2" >&2; }
# stage <이름> <명령...>: 출력은 로그 파일(마스크), 끝 코드를 표에
stage() { local n="$1"; shift; local t0=$SECONDS rc
  "$@" > "${TMPD}/${n}.raw" 2>&1; rc=$?
  mask < "${TMPD}/${n}.raw" > "${ART}/${n}.log"
  if [ "$rc" = 0 ]; then row "$n" PASS "rc=0 $((SECONDS - t0))s"; else row "$n" FAIL "rc=$rc $((SECONDS - t0))s 로그 ${ART}/${n}.log"; fi; return "$rc"; }
K() { kubectl --context "${EKS_CONTEXT}" "$@"; }
down_hint() { echo "자원이 남아 있을 수 있다. Jeong 터미널에서: sh tools/jeong-down.sh  → 끝나면 이 스크립트를 'bash real-session.sh <폴더> zero' 로"; }
# GATE-v2: 감시 창(tools/jeong-watch.sh)이 받는 실패 신호 파일. up 뒤 단계에서 실패해 멈출 때만 남긴다(일부러 멈춘 STOP_AFTER 는 아님).
#   내용 "<시각> real-session <단계> rc=<n>" (비밀값 없음). 단계 up-wait(up 끝 줄을 기다리다 멈춤)는 감시 창이 진행 파일의 up 줄로 따로 판단한다
fail_signal() { local rc="$1" wp
  mkdir -p "${STATE}"; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) real-session ${CUR} rc=${rc}" > "${STATE}/auto-fail"
  wp="$(cat "${STATE}/watch.lock" 2>/dev/null)"
  if [ -n "${wp}" ] && kill -0 "${wp}" 2>/dev/null && ps -p "${wp}" -o command= 2>/dev/null | grep -q 'jeong-watch'; then
    echo "감시 창(pid ${wp})이 이 실패를 받아 잠시 뒤 sh tools/jeong-down.sh 를 친다 (안 치려면 그 창에서 Ctrl-C). 끝 줄: ${JPROG} 의 'JEONG down end rc=0'"
  else echo "감시 창이 안 켜져 있다 → 위 안내대로 손으로 down (다음 회차엔 up 전에 다른 창에서 sh tools/jeong-watch.sh)"; fi; }
finish() { local rc=$?
  [ "${DONE}" = 1 ] || row "중단" FAIL "마지막 단계까지 못 감 (단계 ${CUR})"
  { echo "# REALRUN 실측 ${TS}"; echo; echo "상태: AI 초안 (자동 생성)"; echo "- HEAD: $(git -C "${SVC}" rev-parse HEAD 2>/dev/null)"; echo "- 산출물: ${ART} (명세·계획서·로그, 계정 ID·비밀 가림)"; echo
    { echo "| 시각 | 단계 | 결과 | 비고 |"; echo "|---|---|---|---|"; printf '%s\n' ${ROWS[@]+"${ROWS[@]}"}; echo
      echo "자원 0 증거: $([ "${DOWN_DONE}" = 1 ] && echo '있음(cloud-zero OK zero)' || echo '없음 — down·zero 를 아직 안 돌림')"; } | mask
    echo "전체: $([ "${FAILED}" = 0 ] && [ "${DONE}" = 1 ] && echo PASS || echo FAIL)"; } > "${OUT}"
  cat "${OUT}"
  if [ "${UP_DONE}" = 1 ] && [ "${DOWN_DONE}" != 1 ]; then down_hint; [ "${STOPPED}" = 1 ] || fail_signal "${rc}"; fi
  [ -n "${API_FWD:-}" ] && kill "${API_FWD}" 2>/dev/null
  rm -rf "${TMPD}"
  [ "${FAILED}" = 0 ] && [ "${DONE}" = 1 ] && exit 0 || exit 1
}
trap finish EXIT
order=(pre up deploy connect import ecs-up ecs-import ecs-down run down zero); go=0
for s in "${order[@]}"; do [ "$s" = "$START" ] && go=1; done
[ "$go" = 1 ] || { echo "모르는 시작 단계: ${START}" >&2; FAILED=1; DONE=1; exit 2; }
idx() { local i=0; for s in "${order[@]}"; do [ "$s" = "$1" ] && { echo $i; return; }; i=$((i+1)); done; }
# fresh <파일>: 파일이 있고 이번 회차 up 도장보다 새것이면 0. 도장이 없으면(up 을 이 스크립트가 안 본 회차) 있는 파일을 그대로 믿되 알린다
fresh() { [ -s "$1" ] || return 1; [ -f "${UP_STAMP}" ] || return 0; [ "$1" -nt "${UP_STAMP}" ]; }
latest_fresh() { local f; for f in $(ls -t "${RES}"/real-*/"$1" 2>/dev/null); do fresh "$f" && { echo "$f"; return 0; }; done; return 1; }
# THENREAL: STOP_AFTER=<단계> 는 어느 단계든 그 단계 다음으로 넘어갈 때 멈춘다(예전엔 ecs-* 만). 일부러 멈춘 것이라 감시 창 신호(auto-fail)는 안 남김
at() {
  if [ -n "${STOP_AFTER:-}" ] && [ -n "$(idx "${STOP_AFTER}")" ] && [ "$(idx "$1")" -gt "$(idx "${STOP_AFTER}")" ]; then
    row "중간 종료" INFO "STOP_AFTER=${STOP_AFTER} (다음 단계 $1 안 함)"; STOPPED=1; DONE=1; exit 0
  fi
  [ "$(idx "$1")" -ge "$(idx "$START")" ]; }
# at <단계>: 시작 단계 이후이면 0(실행)

# GATE-common c5: demo-day 가 띄운 워커·api 는 자기 프로세스 그룹이 아니다(그 스크립트엔 set -m 이 없음) → kill -- -pid 가 실패하고
#   kill pid 는 맨 위 npm 만 끈다. 아래 node 가 살아 옛 설정으로 작업을 계속 집거나(워커), 3000 을 쥔 채 readyz 에 대답한다(api, PLAN_ACKS 거짓 PASS).
#   demo-day d_procs 와 같은 방식으로 자식부터 끈다
killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null; return 0; }
stop_pidfile() { local p; p="$(cat "$1" 2>/dev/null)"; [ -n "$p" ] || return 0; kill -- -"$p" 2>/dev/null; killtree "$p"; }
# 워커 환경 파일(demo-day.env)의 KEY 를 바꾸고(VALUE 비면 지움) 워커를 다시 띄운다. 비밀값은 안 다룬다
worker_env() { local f="${STATE}/demo-day.env" kv k; touch "$f"; chmod 600 "$f"
  for kv in "$@"; do k="${kv%%=*}"; grep -v "^${k}=" "$f" > "${TMPD}/env.new" 2>/dev/null; [ "${kv#*=}" = "" ] || echo "$kv" >> "${TMPD}/env.new"; cat "${TMPD}/env.new" > "$f"; done
  [ -f "${STATE}/worker.pid" ] && stop_pidfile "${STATE}/worker.pid"
  # FM-ORC-22: pid 파일 밖에 남은 워커(고아 node)도 트리째 끈다 — 안 끄면 옛 설정 워커가 다음 작업을 집는다
  if [ -f "${SVC}/tools/proc-leftovers.sh" ]; then . "${SVC}/tools/proc-leftovers.sh"; pl_kill $(pl_workers); fi
  ( set -a; . "$f"; set +a; MOCK_IAC= GITOPS_DISABLE=1 ROLLBACK_WINDOW_SEC="${ROLLBACK_WINDOW_SEC:-180}" nohup npm run "${RUNP}:worker" > "${ART}/worker.${RANDOM}.log" 2>&1 & echo $! > "${STATE}/worker.pid" )
  sleep 15; }
# ORC-26 (맥 흐름): base 를 바꾼 뒤 플랫폼 DB 에 안 넣은 마이그레이션이 있으면 워커·API 가 옛 표로 돈다 → pending 0 을 확인.
#   pre 에서 DB 가 아직 안 떠 있으면(up 이 켬) INFO 로 넘기고 up 뒤·가져오기 앞에서 다시 본다
mig_check() { local where="$1" o rc n
  o="$(${REAL_DB_MIGRATE:-sh tools/db-migrate.sh} --status 2>&1)"; rc=$?   # REAL_DB_MIGRATE: 시험용 바꿔 끼우기
  if [ "$rc" != 0 ]; then
    if [ "$where" = pre ]; then row "DB 마이그레이션(${where})" INFO "플랫폼 DB 를 못 봄 rc=$rc (up 이 켬) → up 뒤 다시 봄"; return 0; fi
    row "DB 마이그레이션(${where})" FAIL "db-migrate --status rc=$rc: $(printf '%s' "$o" | tail -1 | cut -c1-120)"; return 1; fi
  n="$(printf '%s\n' "$o" | grep -c '^pending ')"
  if [ "$n" = 0 ]; then row "DB 마이그레이션(${where})" PASS "pending 0 (applied $(printf '%s\n' "$o" | grep -c '^applied '))"; return 0; fi
  row "DB 마이그레이션(${where})" FAIL "pending ${n}개 (첫 $(printf '%s\n' "$o" | sed -n 's/^pending  *//p' | head -1)) → npm run db:migrate 뒤 API·워커 재시작"; return 1; }
stop_after() { [ "${STOP_AFTER:-}" = "$1" ] && { row "중간 종료" INFO "STOP_AFTER=$1"; STOPPED=1; DONE=1; exit 0; }; return 0; }
ECS_CLUSTER="${ECS_CLUSTER:-realecs-src}"; ECS_SVC="${ECS_SVC:-realecs-src-api}"; ECS_ART="${ART}/ecs"

# 진행 파일에서 "JEONG <이름> end rc=" 를 기다린다 (이 시각 이후 줄만)
wait_jeong() { local name="$1" limit="$2" since="$3" t0=$SECONDS line
  mkdir -p "${STATE}"; date +%s > "${STATE}/jeong-request-${name}"
  echo "▶ Jeong 터미널에서 한 줄: sh tools/jeong-${name}.sh   (이 스크립트는 ${limit}초까지 ${JPROG} 만 읽는다)" >&2
  while [ $((SECONDS - t0)) -lt "$limit" ]; do
    line=$(awk -v s="$since" -v n="$name" '$1 >= s && $2 == "JEONG" && $3 == n && $4 == "end"' "${JPROG}" 2>/dev/null | tail -1)
    # GATE-common c5: 줄 = "<시각> JEONG <이름> end rc=<n> sec=… log=…" → 5번째 칸만 본다 (log 경로 안 글자에 속지 않게)
    [ -n "$line" ] && { echo "$line"; [ "$(printf '%s\n' "$line" | awk '{print $5}')" = "rc=0" ] && return 0; return 1; }
    sleep 10
  done
  echo "시간 초과(${limit}초)"; return 1; }

# ---- DRY=1: 클라우드·kubectl 호출 0. ECS 단계의 명령 순서(ecs-source.sh --dry-run)와 대조 시험·문법만 본다 (컨테이너·맥 어디서나) ----
if [ "${DRY:-0}" = 1 ]; then CUR=dry
  cd "${SVC}" || { row "Service 폴더" FAIL "${SVC} 없음"; exit 1; }
  stage dry-ecs-up bash tools/ecs-source.sh up --dry-run
  stage dry-ecs-down bash tools/ecs-source.sh down --dry-run
  stage dry-jeong-lines bash -c 'sh -n tools/jeong-ecs-up.sh && sh -n tools/jeong-ecs-down.sh && bash -n tools/cloud-zero.sh'
  [ -d node_modules ] && stage dry-ecs-check npx tsx --test apps/api/test/real-ecs-check.test.ts
  row "DRY 흐름 순서" INFO "ecs-up(jeong-ecs-up 대기) → ecs-import(IMPORT_AWS_ECS_CLUSTER=${ECS_CLUSTER:-realecs-src}, api-flow, ecs-check, 비밀 0) → ecs-down(jeong-ecs-down 대기, ECS 0)"
  DONE=1; exit 0
fi

# ---- 0 사전 ----
if at pre; then CUR=pre
  [ -d "${SVC}/.git" ] || [ -f "${SVC}/.git" ] || { row "Service 폴더" FAIL "${SVC} 없음"; exit 1; }
  cd "${SVC}" || exit 1
  if git merge-base --is-ancestor 0bad3456 HEAD 2>/dev/null; then row "base 확인" PASS "base-29 0bad3456 이상, HEAD $(git rev-parse --short HEAD)"; else row "base 확인" FAIL "base-29(0bad3456) 이상 아님: MAC-MIRROR.md 대로 base 를 받고 다시"; exit 1; fi
  miss=""; for t in terraform aws gcloud kubectl jq curl ssh node openssl; do command -v "$t" >/dev/null 2>&1 || miss="${miss} $t"; done
  if [ -n "${miss}" ]; then row "도구" FAIL "없음:${miss}"; exit 1; else row "도구" PASS ""; fi
  [ -d node_modules ] || stage npm-ci npm ci || exit 1
  if stage cloud-zero-시작 env CLOUD_ZERO_WAIT_SEC="${CLOUD_ZERO_WAIT_SEC:-300}" bash tools/cloud-zero.sh; then :; else row "시작 조건" FAIL "자원이 0 이 아님(또는 조회 실패): 로그 확인 → 남은 건 jeong-down.sh 먼저"; exit 1; fi
  stage demo-day-dry bash tools/demo-day.sh up --dry-run --fg || { row "demo-day 순서" FAIL "dry-run 실패"; exit 1; }
  mig_check pre || exit 1
fi
cd "${SVC}" || exit 1

# ---- 1 올리기 (Jeong 손 줄) ----
if at up; then CUR=up-wait   # GATE-v2: up 끝 줄을 기다리는 동안의 실패는 감시 창이 진행 파일 줄로 판단한다
  T_UP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  UP_DONE=1   # 부탁을 보낸 순간부터 자원이 생길 수 있다 → 중간에 멈추면 down 안내를 찍는다
  if wait_jeong up "${UP_WAIT_SEC}" "${T_UP}" > "${TMPD}/up.raw"; then row "올리기(jeong-up)" PASS "$(tail -1 "${TMPD}/up.raw")"; mkdir -p "${STATE}"; touch "${UP_STAMP}"; else row "올리기(jeong-up)" FAIL "$(tail -1 "${TMPD}/up.raw")"; exit 1; fi
  CUR=up-check   # GATE-v2: 여기서부터는 자원이 떠 있는 실패 → 감시 창이 down
  tail -3 "$(ls -dt "${HOME}"/Softbank_final/measurements/demo-day-up-* tools/measure/out/demo-day-up-* 2>/dev/null | head -1)/progress.log" 2>/dev/null | mask >> "${ART}/up-progress.log"
  stage kubeconfig-eks kubectl --context "${EKS_CONTEXT}" get nodes || exit 1
  if [ -n "${GKE_CONTEXT:-}" ] || kubectl config get-contexts -o name | grep -q '^gke_'; then row "kubeconfig-gke" PASS ""; else row "kubeconfig-gke" FAIL "gke context 없음"; exit 1; fi
  mig_check up || exit 1
fi

# ---- 2 EKS 에 샘플 3티어 (우리가 만든 클러스터에만) ----
if at deploy; then CUR=deploy
  UP_DONE=1
  case "${EKS_CONTEXT}" in eks-platform-target) ;; *) row "대상 확인" FAIL "EKS_CONTEXT=${EKS_CONTEXT} 는 demo-day 가 만든 이름이 아님. kubectl apply 중단"; exit 1;; esac
  RDS_HOST="$(aws rds describe-db-instances --query 'DBInstances[?DBInstanceStatus==`available`]|[0].Endpoint.Address' --output text 2>/dev/null)"
  [ -n "${RDS_HOST}" ] && [ "${RDS_HOST}" != None ] || { row "RDS 주소" FAIL "available 인 RDS 없음 (demo-day up 이 RDS 까지 끝났는지)"; exit 1; }
  row "RDS 주소" PASS "${RDS_HOST%%.*}.…"
  dig_of() { case "$1" in *@sha256:*) echo "${1##*@}";; *) docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest;; esac; }
  WEB_D="$(dig_of "${WEB_IMAGE}")"; API_D="$(dig_of "${API_IMAGE}")"
  [ -n "${WEB_D}" ] && [ -n "${API_D}" ] || { row "이미지 digest" FAIL "태그 → digest 실패 (WEB_IMAGE·API_IMAGE 에 @sha256 로 주면 됨)"; exit 1; }
  row "이미지 digest" PASS "web ${WEB_D:0:19}… api ${API_D:0:19}…"
  WEB_REF="${WEB_IMAGE%@*}"; WEB_REF="${WEB_REF%:*}@${WEB_D}"; API_REF="${API_IMAGE%@*}"; API_REF="${API_REF%:*}@${API_D}"
  sed -e "s#__NS__#${NS}#g" -e "s#__WEB_IMAGE__#${WEB_REF}#g" -e "s#__API_IMAGE__#${API_REF}#g" -e "s#__DB_HOST__#${RDS_HOST}#g" "${HERE}/flow/sample-3tier-eks.yaml.tpl" > "${TMPD}/sample.yaml"
  stage ns bash -c "kubectl --context ${EKS_CONTEXT} create namespace ${NS} --dry-run=client -o yaml | kubectl --context ${EKS_CONTEXT} apply -f -" || exit 1
  openssl rand -hex 24 | tr -d '\n' > "${TMPD}/s1"; openssl rand -hex 24 | tr -d '\n' > "${TMPD}/s2"
  # UPREV-B: 다시 돌려도 AlreadyExists 로 멈추지 않게 create --dry-run | apply (deploy 단계 재시작·이어하기)
  stage secrets bash -c "kubectl --context ${EKS_CONTEXT} -n ${NS} create secret generic api-secrets --from-file=API_TOKEN=${TMPD}/s1 --dry-run=client -o yaml | kubectl --context ${EKS_CONTEXT} -n ${NS} apply -f - && kubectl --context ${EKS_CONTEXT} -n ${NS} create secret generic shop-db-app --from-file=password=${TMPD}/s2 --dry-run=client -o yaml | kubectl --context ${EKS_CONTEXT} -n ${NS} apply -f -" || exit 1
  stage sample-apply K apply -f "${TMPD}/sample.yaml" || exit 1
  if K -n "${NS}" wait --for=condition=Available deployment --all --timeout=300s > "${ART}/wait-app.log" 2>&1; then row "Deployment Available" PASS ""; else row "Deployment Available" INFO "300초 안에 아님 (가져오기는 정의만 읽음)"; fi
  mkdir -p "${STATE}"; ( umask 077; echo "${WEB_D} ${API_D}" > "${DIGESTS}"; cp "${TMPD}/s1" "${SECRET_CHECK}" )   # 비밀값 누출 검사용. results 폴더가 아니라 STATE(600), zero 성공 때 지움
fi

# ---- 3 M-L4 연결 + verify ----
if at connect; then CUR=connect
  UP_DONE=1
  cd "${SVC}"
  # CONNSTACK: 연결 링크 발급(api)은 CONNECT_TEMPLATE_URL·PLATFORM_PRINCIPAL_ARN 이 없으면 503. .env 를 안 고치고 이 단계에서만 api 를 두 값으로 다시 띄운다.
  #   PLATFORM_PRINCIPAL_ARN = 지금 이 맥 자격의 역할(SSO 역할) ARN — 워커의 REAL_STS assume-role 이 이 자격으로 돌기 때문. 값은 안 찍는다.
  #   스택은 콘솔 링크 대신 레포 템플릿(--template-body)으로 CLI 가 만든다 → S3 업로드 불필요. 그래서 템플릿 주소는 링크 모양용 자리 값.
  # CON-01: 링크 발급(api)·회사 SA 빌리기(워커) 둘 다 GCP_PLATFORM_PROJECT 가 있어야 한다 → api·워커 재시작 전에 env 파일에 넣는다
  _gcp_new=0
  if [ "${REAL_GCP_CONNECT:-1}" = 1 ] && ! grep -qsx "GCP_PLATFORM_PROJECT=${GPP}" "${STATE}/demo-day.env"; then
    touch "${STATE}/demo-day.env"; chmod 600 "${STATE}/demo-day.env"
    { grep -v '^GCP_PLATFORM_PROJECT=' "${STATE}/demo-day.env"; echo "GCP_PLATFORM_PROJECT=${GPP}"; } > "${TMPD}/env.gpp"; cat "${TMPD}/env.gpp" > "${STATE}/demo-day.env"; _gcp_new=1
  fi
  if [ "${REAL_CONNECT_RUN:-1}" = 1 ]; then
    _carn="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)"
    case "${_carn}" in
      arn:aws:sts::*:assumed-role/*) _rn="$(printf '%s' "${_carn}" | cut -d/ -f2)"; _parn="$(aws iam get-role --role-name "${_rn}" --query Role.Arn --output text 2>/dev/null)" ;;
      arn:aws:iam::*:role/*) _parn="${_carn}" ;;
      # CONNSTACK-USER DRAFT(ai): 맥 finals 프로필은 IAM 사용자 키라 역할이 아니다. 워커의 assume-role 이 이 사용자로 돌기 때문에 신뢰 주체 = 이 사용자 ARN.
      #   레포 템플릿은 역할만 받는다(AllowedPattern) → 이번 실세션에서만 TMPD 사본의 패턴을 role|user 로 넓혀 쓴다. 레포 템플릿·고객용 링크는 그대로 역할만
      arn:aws:iam::*:user/*) _parn="${_carn}"
        python3 -I - "${SVC}/infra/onboarding/aws-connect.json" "${TMPD}/aws-connect.json" <<'PY' || { row "연결: 템플릿 사본" FAIL "사용자용 사본을 못 만듦"; exit 1; }
import json, sys
t = json.load(open(sys.argv[1]))
t["Parameters"]["PlatformPrincipalArn"]["AllowedPattern"] = "^arn:aws:iam::\\d{12}:(role|user)/.+$"
json.dump(t, open(sys.argv[2], "w"), ensure_ascii=False, indent=2)
PY
        CONNECT_TPL="${TMPD}/aws-connect.json" ;;
      *) _parn="" ;;
    esac
    case "${_parn}" in arn:aws:iam::*:role/*|arn:aws:iam::*:user/*) ;; *) row "연결: 플랫폼 주체 ARN" FAIL "이 자격이 IAM 역할·사용자가 아님(:root 등) 또는 iam:GetRole 실패"; exit 1 ;; esac
    [ -f "${STATE}/api.pid" ] && stop_pidfile "${STATE}/api.pid"
    _gone=0; for _ in $(seq 1 15); do curl -sf -m 2 "http://localhost:${API_PORT}/readyz" >/dev/null 2>&1 || { _gone=1; break; }; sleep 1; done
    [ "${_gone}" = 1 ] || { row "연결: api 다시 띄움" FAIL "옛 api 가 ${API_PORT} 에서 15초 넘게 대답함"; exit 1; }
    ( set -a; [ -f "${STATE}/demo-day.env" ] && . "${STATE}/demo-day.env"; set +a; API_HOST=127.0.0.1 CONNECT_TEMPLATE_URL="${CONNECT_TEMPLATE_URL:-https://connect-template.invalid/cli-template-body/aws-connect.json}" PLATFORM_PRINCIPAL_ARN="${_parn}" nohup npm run "${RUNP}:api" > "${ART}/api.connect.log" 2>&1 & echo $! > "${STATE}/api.pid" )
    _up=0; for _ in $(seq 1 40); do curl -sf -m 2 "http://localhost:${API_PORT}/readyz" >/dev/null 2>&1 && { _up=1; break; }; sleep 1; done
    [ "${_up}" = 1 ] && row "연결: api 다시 띄움" PASS "연결 설정 두 값 넣음(.env 안 고침)" || { row "연결: api 다시 띄움" FAIL "40초 안에 안 뜸: ${ART}/api.connect.log"; exit 1; }
  fi
  # REALSTS: 연결 확인(verify)·가져오기가 고객 관찰 역할(svc-observe)을 진짜로 빌리게 워커를 REAL_STS=1 로 다시 띄운다
  #   (없으면 맥 자격 그대로 읽고 CloudTrail SourceIdentity 증거도 안 남음. 근거 apps/worker/src/jobs/import.ts L5, packages/security/src/issuers.ts L4).
  #   external_id 없는 시드 환경(smoke 의 온프레·RDS)은 그대로 mock 이라 영향 없음
  if ! grep -qs "^REAL_STS=1" "${STATE}/demo-day.env" || [ "${_gcp_new}" = 1 ]; then worker_env REAL_STS=1; row "워커 설정" INFO "REAL_STS=1 (관찰 역할 진짜로 빌림)$([ "${_gcp_new}" = 1 ] && echo " · GCP_PLATFORM_PROJECT") → 워커 재시작"; fi
  # CONNREUSE (SvN5 pf01 86cf764 짝): env:connect create 가 같은 이름 환경을 이어 쓰고, 연결 스택을 미리 본다 (끄기 CONNECT_STACK_CHECK=0)
  #   "연결 스택 충돌  <스택> <상태>" (종료 3) = 지난 회차 스택이 고정 역할 svc-observe 를 쥠 → 그 스택을 지우고 DELETE_COMPLETE 뒤 create 를 한 번 더
  #     (finals 계정 안 우리 연결 스택만: 이름이 svc-connect- 로 시작할 때만 지운다. 아니면 멈추고 사람에게)
  #   "연결 스택 이미 있음  <스택> <상태> 이 환경 것" = 이 환경 스택이 이미 있음 → create-stack·wait 건너뛰고 verify
  #   "이미 connected|verifying" = 링크를 안 줌 → 스택 단계 건너뛰고 verify
  # CLD-07: 콘솔 링크로 연결할 때(REAL_CONNECT_RUN=0)만 S3 템플릿이 쓰인다 → 레포와 다르면 다시 올림 (CLI 생성은 레포 파일이라 상관없음)
  if [ "${REAL_CONNECT_RUN:-1}" = 0 ] && [ -f tools/connect-template-sync.sh ]; then stage connect-template-sync bash tools/connect-template-sync.sh || exit 1; fi
  _try=0
  while :; do
    _try=$((_try + 1))
    npm run -s env:connect -- create --provider aws --name real-src --cluster "${CLUSTER_NAME:-platform-target}" > "${TMPD}/c.raw" 2>&1; rc=$?
    mask < "${TMPD}/c.raw" > "${ART}/connect-create.log"
    _old="$(sed -n 's/^연결 스택 충돌  *\([^ ]*\).*/\1/p' "${TMPD}/c.raw" | head -1)"
    [ -n "${_old}" ] || break
    [ "${_try}" -ge 2 ] && { row "연결: 지난 스택 정리" FAIL "지우고 다시 했는데 또 충돌 (${_old})"; exit 1; }
    case "${_old}" in svc-connect-*) ;; *) row "연결: 지난 스택 정리" FAIL "svc-observe 를 쥔 스택 이름이 우리 연결 스택 모양(svc-connect-*)이 아님 → 사람이 확인"; exit 1 ;; esac
    _reg="$(grep -oE 'https://[^ ]*cloudformation/home[^ ]*' "${TMPD}/c.raw" | head -1 | sed -n 's/.*[?&]region=\([a-z0-9-]*\).*/\1/p')"
    _reg="${_reg:-${AWS_REGION:-ap-northeast-2}}"
    row "연결: 지난 스택 정리" INFO "${_old} 가 svc-observe 를 쥠 → delete-stack 후 다시 create"
    stage connect-old-stack-delete aws cloudformation delete-stack --stack-name "${_old}" --region "${_reg}" || exit 1
    stage connect-old-stack-wait aws cloudformation wait stack-delete-complete --stack-name "${_old}" --region "${_reg}" || exit 1
  done
  ENV_ID="$(grep -oE '환경 만듦  [0-9a-f-]{36}' "${TMPD}/c.raw" | awk '{print $3}')"
  if [ "$rc" != 0 ] || [ -z "${ENV_ID}" ]; then row "연결: 환경 만들기" FAIL "rc=$rc 로그 ${ART}/connect-create.log"; exit 1; fi
  echo "${ENV_ID}" > "${ART}/env-id.txt"; row "연결: 환경 만들기" PASS "env ${ENV_ID}"
  # 연결 스택: 명령이 있으면(REAL_CONNECT_RUN=1) 직접, 아니면 링크(URL)를 사람이 열 때까지
  # CONNSTACK: 링크(빠른 생성 URL)의 값(스택 이름·ExternalId·역할 ARN·클러스터)을 풀어 레포 템플릿으로 CLI 가 스택을 만든다. 파라미터 파일은 TMPD(700)
  grep -oE 'https://[^ ]*cloudformation/home[^ ]*' "${TMPD}/c.raw" | head -1 > "${TMPD}/link.url"
  STACK="$(python3 -I - "${TMPD}/link.url" "${TMPD}/params.json" <<'PY'
import json, sys, urllib.parse
u = open(sys.argv[1]).read().strip()
q = urllib.parse.parse_qs(u.split("?", 2)[-1]) if u else {}
ps = [{"ParameterKey": k[6:], "ParameterValue": v[0]} for k, v in q.items() if k.startswith("param_")]
if ps and q.get("stackName"):
    json.dump(ps, open(sys.argv[2], "w")); print(q["stackName"][0])
PY
)"
  if grep -qE '^연결 스택 이미 있음  ' "${TMPD}/c.raw"; then
    row "연결 스택" PASS "이 환경 스택이 이미 있음 → 만들기 건너뜀, verify 로"
  elif grep -qE '^이미 (connected|verifying) ' "${TMPD}/c.raw"; then
    row "연결 스택" PASS "환경이 이미 $(sed -n 's/^이미 \([a-z]*\) .*/\1/p' "${TMPD}/c.raw" | head -1) → 스택 단계 건너뜀, verify 로"
  elif [ "${REAL_CONNECT_RUN:-1}" = 1 ] && [ -n "${STACK}" ] && [ -s "${TMPD}/params.json" ]; then
    stage connect-stack aws cloudformation create-stack --stack-name "${STACK}" --template-body "file://${CONNECT_TPL:-${SVC}/infra/onboarding/aws-connect.json}" --capabilities CAPABILITY_NAMED_IAM --parameters "file://${TMPD}/params.json" || exit 1
    stage connect-stack-wait aws cloudformation wait stack-create-complete --stack-name "${STACK}" || exit 1
  else
    echo "▶ 연결 링크를 고객(=팀) AWS 콘솔에서 열고 스택을 만든다. 링크(가린 것)는 ${ART}/connect-create.log, 원본은 터미널에서 npm run env:connect -- link --env ${ENV_ID} → ~/.svc-tf/connect-link-${ENV_ID}.url (0600, 화면에 찍으려면 CONNECT_PRINT_URL=1)" >&2
    for _ in $(seq 1 120); do aws cloudformation describe-stacks --query 'Stacks[?StackStatus==`CREATE_COMPLETE`].StackName' --output text 2>/dev/null | grep -q . && break; sleep 10; done
    aws cloudformation describe-stacks --query 'Stacks[?StackStatus==`CREATE_COMPLETE`].StackName' --output text 2>/dev/null | grep -q . && row "연결 스택" PASS "CREATE_COMPLETE" || { row "연결 스택" FAIL "20분 안에 스택이 안 생김"; exit 1; }
  fi
  ACCT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"
  [ -n "${ACCT}" ] || { row "verify" FAIL "계정 조회 실패"; exit 1; }
  # FM-CON-mac-03: --cluster 를 주면 verify 가 401(K8S_ACCESS_MISSING) 때 EKS 접근 항목이 옛 역할에 묶였는지 보고 다시 만든 뒤 한 번 더 확인 (모르는 옛 판은 무시)
  npm run -s env:connect -- verify --env "${ENV_ID}" --account "${ACCT}" --cluster "${CLUSTER_NAME:-platform-target}" > "${TMPD}/v.raw" 2>&1; rc=$?
  mask < "${TMPD}/v.raw" | sed "s/${ACCT}/************/g" > "${ART}/verify.log"
  # 판정은 끝 코드(0 = connected 만)와 고정 줄로. 예전 grep "connected" 는 "disconnected" 에도 걸려 거짓 PASS
  if [ "$rc" = 0 ] && grep -qx "연결 확인 결과  connected" "${TMPD}/v.raw"; then row "verify → connected" PASS "env ${ENV_ID}"
  else row "verify → connected" FAIL "rc=$rc $(sed -n 's/^연결 확인 결과  //p' "${TMPD}/v.raw" | tail -1) 로그 ${ART}/verify.log"; exit 1; fi
  # CloudTrail SourceIdentity (이벤트 반영까지 몇 분 걸릴 수 있어 15분까지 5번)
  for i in 1 2 3 4 5; do
    aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole --max-results 20 --query 'Events[].CloudTrailEvent' --output text 2>/dev/null \
      | grep -o '"sourceIdentity":"svc-[^"]*"' | head -3 > "${TMPD}/ct.raw"
    [ -s "${TMPD}/ct.raw" ] && break; sleep 180
  done
  if [ -s "${TMPD}/ct.raw" ]; then mask < "${TMPD}/ct.raw" > "${ART}/cloudtrail-sourceidentity.log"; row "CloudTrail SourceIdentity" PASS "$(head -1 "${ART}/cloudtrail-sourceidentity.log")"; else row "CloudTrail SourceIdentity" INFO "15분 안에 못 봄 (CloudTrail 지연일 수 있음, 가져오기는 계속)"; fi
  # CON-01: GCP 도착 환경 진짜 연결 (회사 SA → 환경·명령 → 고객 연결 → verify). 끝 줄 "도착 환경 <id>" 를 import 의 MI_TARGET_ENV 로
  if [ "${REAL_GCP_CONNECT:-1}" = 1 ]; then
    stage connect-gcp env GCP_PROJECT="${GCP_PROJECT}" GCP_TARGET_PROJECT="${GCP_TARGET_PROJECT:-${TARGET_PROJECT_ID:-}}" TARGET_PROJECT_ID="${TARGET_PROJECT_ID:-}" GCP_PLATFORM_PROJECT="${GPP}" GCP_ZONE="${GCP_ZONE}" CLUSTER_NAME="${CLUSTER_NAME:-platform-target}" bash tools/gcp-connect-real.sh \
      || { grep -a 'gcp-connect 실패' "${ART}/connect-gcp.log" | tail -1 >&2; exit 1; }
    _tgt="$(sed -n 's/^도착 환경  *\([0-9a-f-]\{36\}\).*/\1/p' "${TMPD}/connect-gcp.raw" | tail -1)"
    [ -n "${_tgt}" ] || { row "GCP 도착 환경" FAIL "'도착 환경' 줄이 없음 (${ART}/connect-gcp.log)"; exit 1; }
    echo "${_tgt}" > "${ART}/target-env-id.txt"; row "GCP 도착 환경" PASS "env ${_tgt} → 가져오기의 MI_TARGET_ENV"
  else row "GCP 도착 환경" INFO "REAL_GCP_CONNECT=0 → 시드 도착 ${SEED_TARGET} (흉내 발급)"; fi
  echo "${ENV_ID}" > "${TMPD}/envid"
fi
[ -f "${ART}/env-id.txt" ] && ENV_ID="$(cat "${ART}/env-id.txt")"
# UPREV-B: 이어서 돌릴 때(시작 단계 import 등)는 이번 up 이후의 가장 새 env-id 를 쓴다 (지난 회차 것은 스택이 이미 없어 verify 가 헛돈다)
[ -n "${ENV_ID:-}" ] || { _f="$(latest_fresh env-id.txt)" && ENV_ID="$(cat "${_f}")"; }
# CON-01: 도착 = 사람이 준 MI_TARGET_ENV → 이번 up 이후 connect-gcp 가 남긴 target-env-id.txt → (REAL_GCP_CONNECT=0 일 때만) 시드
if [ -z "${MI_TARGET_ENV:-}" ]; then
  if [ -f "${ART}/target-env-id.txt" ]; then MI_TARGET_ENV="$(cat "${ART}/target-env-id.txt")"
  elif _f="$(latest_fresh target-env-id.txt)"; then MI_TARGET_ENV="$(cat "${_f}")"
  elif [ "${REAL_GCP_CONNECT:-1}" = 0 ]; then MI_TARGET_ENV="${SEED_TARGET}"; fi
fi

# ---- 4 가져오기 (IMPORT_IR=v2) — 최우선 성공 기준 ----
if at import; then CUR=import
  UP_DONE=1; cd "${SVC}"
  mig_check import || exit 1
  [ -n "${ENV_ID:-}" ] || { row "가져오기" FAIL "환경 번호 없음 (connect 단계를 먼저)"; exit 1; }
  # api·worker 는 demo-day 가 이미 띄움. 가져오기는 IMPORT_IR=v2 로 다시 띄워야 하므로 워커만 재시작 안내 대신 확인한다
  if ! grep -qs "IMPORT_IR=v2" "${STATE}/demo-day.env" || ! grep -qs "^REAL_STS=1" "${STATE}/demo-day.env"; then
    worker_env IMPORT_IR=v2 PLAN_IR=v2 REAL_STS=1
    row "워커 설정" INFO "demo-day.env 에 IMPORT_IR=v2·PLAN_IR=v2·REAL_STS=1 → 워커 재시작"
  fi
  # IR-04: 출발 네임스페이스는 이전 만들 때 sourceScope.namespaces 로 넘긴다 (워커 IMPORT_NAMESPACE 손 설정 없앰)
  stage import-flow env API_PORT="${API_PORT}" MI_NAMESPACES="${NS}" MI_SOURCE_ENV="${ENV_ID}" MI_TARGET_ENV="${MI_TARGET_ENV}" MI_TIMEOUT_MS=600000 npx tsx tools/real/m-import/api-flow.ts "${ART}" || { grep -a "FAIL\|STATUS" "${ART}/import-flow.log" | tail -3; exit 1; }
  row "가져오기 요약" INFO "$(grep -a '^SPEC\|^PLAN' "${ART}/import-flow.log" | tr '\n' ' ')"
  # 명세 v2·field_meta 가 DB 에 저장됐는지: API 의 spec 보기에 specV2 가 있으면 저장된 것(api-flow 가 이미 FAIL 로 막음)
  row "spec_v2·field_meta" PASS "api-flow: specV2 있음"
  read -r WEB_D API_D < "${DIGESTS}" 2>/dev/null || { WEB_D=""; API_D=""; }
  [ -s "${SECRET_CHECK}" ] || row "비밀 검사 원본" INFO "deploy 단계를 이번 회차에 안 거침 → 랜덤 비밀 대조는 못 함"
  CHECK_MD="$(npx tsx tools/real/m-import/check-import.ts "${ART}/spec-view.json" "${NS}" "${SECRET_CHECK}" "${WEB_D}" "${API_D}" 2>"${ART}/check.err")"; rc=$?
  printf '%s\n' "${CHECK_MD}" | mask > "${ART}/ir-check.md"
  if [ "$rc" = 0 ]; then row "IR 대조(MACIMPORT)" PASS "$(grep -c '| PASS |' "${ART}/ir-check.md")개 PASS"; else row "IR 대조(MACIMPORT)" FAIL "표 ${ART}/ir-check.md (대조는 k3d 샘플 기준이라 EKS 에서 어긋나는 항목은 설명 필요)"; fi
  # UPREV-B: 원본이 없으면 grep 이 오류(2)로 끝나 예전엔 "PASS" 로 찍혔다 → 없으면 PASS 라 하지 않는다
  if [ ! -s "${SECRET_CHECK}" ]; then row "비밀 값 0" INFO "검사 원본 없음(검사 안 함)"
  elif grep -rqF -f "${SECRET_CHECK}" "${ART}" 2>/dev/null; then row "비밀 값 0" FAIL "랜덤 비밀 글자가 산출물에 있음"; else row "비밀 값 0" PASS ""; fi
fi

# ---- 4b ECS 출발 샘플 올리기 (Jeong 손 줄) ----
if at ecs-up; then CUR=ecs-up
  UP_DONE=1; mkdir -p "${ECS_ART}"
  [ "$(aws ecs list-clusters --query 'length(clusterArns)' --output text 2>/dev/null)" = 0 ] || row "ECS 시작 조건" INFO "이미 ECS 클러스터가 있음 (cloud-zero 는 ECS 0 이어야 끝남)"
  T_EU="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if wait_jeong ecs-up 1500 "${T_EU}" > "${TMPD}/eu.raw"; then row "ECS 올리기(jeong-ecs-up)" PASS "$(tail -1 "${TMPD}/eu.raw")"; else row "ECS 올리기(jeong-ecs-up)" FAIL "$(tail -1 "${TMPD}/eu.raw")"; exit 1; fi
  CNT="$(aws ecs describe-services --cluster "${ECS_CLUSTER}" --services "${ECS_SVC}" --query 'services[0].runningCount' --output text 2>/dev/null)"
  if [ "${CNT}" -ge 1 ] 2>/dev/null; then row "ECS 서비스 실행 중" PASS "running ${CNT}"; else row "ECS 서비스 실행 중" INFO "running=${CNT:-?} (가져오기는 정의만 읽음)"; fi
  stop_after ecs-up
fi

# ---- 4c ECS 출발 가져오기 (IMPORT_IR=v2) → 대조 → 비밀 0 ----
if at ecs-import; then CUR=ecs-import
  UP_DONE=1; cd "${SVC}"; mkdir -p "${ECS_ART}"
  [ -n "${ENV_ID:-}" ] || { _f="$(latest_fresh env-id.txt)" && ENV_ID="$(cat "${_f}")"; }
  [ -n "${ENV_ID:-}" ] || { row "ECS 가져오기" FAIL "환경 번호 없음 (connect 단계를 먼저)"; exit 1; }
  # ECS 만 읽으려고 EKS 는 일부러 안 고른다(ECS_ONLY=0 이면 둘 다). IMPORT_AWS_ECS_CLUSTER 로 샘플 클러스터를 고른다
  if [ "${ECS_ONLY:-1}" = 1 ]; then worker_env IMPORT_IR=v2 PLAN_IR=v2 IMPORT_AWS_ECS_CLUSTER="${ECS_CLUSTER}" IMPORT_AWS_EKS_CLUSTER=none-realecs
  else worker_env IMPORT_IR=v2 PLAN_IR=v2 IMPORT_AWS_ECS_CLUSTER="${ECS_CLUSTER}"; fi
  row "워커 설정(ECS)" INFO "IMPORT_AWS_ECS_CLUSTER=${ECS_CLUSTER} ECS_ONLY=${ECS_ONLY:-1}"
  stage ecs-import-flow env API_PORT="${API_PORT}" MI_ECS_CLUSTER="${ECS_CLUSTER}" MI_SOURCE_ENV="${ENV_ID}" MI_TARGET_ENV="${MI_TARGET_ENV}" MI_TIMEOUT_MS=600000 npx tsx tools/real/m-import/api-flow.ts "${ECS_ART}" \
    || { grep -a "FAIL\|STATUS" "${ART}/ecs-import-flow.log" | tail -3; exit 1; }
  row "ECS 가져오기 요약" INFO "$(grep -a '^SPEC\|^PLAN' "${ART}/ecs-import-flow.log" | tr '\n' ' ')"
  npx tsx tools/real/flow/ecs-check.ts "${ECS_ART}/spec-view.json" - "${ECS_SVC}" > "${TMPD}/ecs-check.md" 2>"${ART}/ecs-check.err"; rc=$?
  mask < "${TMPD}/ecs-check.md" > "${ART}/ecs-ir-check.md"
  if [ "$rc" = 0 ]; then row "IR 대조(runtime managedContainer·product ecs)" PASS "$(grep -c '| PASS |' "${ART}/ecs-ir-check.md")개 PASS, 표 ${ART}/ecs-ir-check.md"; else row "IR 대조(runtime managedContainer·product ecs)" FAIL "표 ${ART}/ecs-ir-check.md"; fi
  # 비밀 0: 샘플은 비밀을 안 쓴다 → 산출물에 비밀처럼 보이는 글자(키 ID·토큰·password 값)가 없어야 한다
  if grep -rEq 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.|password"?[:=] *"?[^<*" ]{4,}' "${ECS_ART}" 2>/dev/null; then row "ECS 비밀 값 0" FAIL "산출물에 키·토큰·password 꼴 글자"; else row "ECS 비밀 값 0" PASS ""; fi
  stop_after ecs-import
fi

# ---- 4d ECS 출발 샘플 지우기 (Jeong 손 줄) ----
if at ecs-down; then CUR=ecs-down
  UP_DONE=1
  worker_env IMPORT_AWS_ECS_CLUSTER= IMPORT_AWS_EKS_CLUSTER=   # EKS 쪽 회차로 되돌림
  T_ED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if wait_jeong ecs-down 1200 "${T_ED}" > "${TMPD}/ed.raw"; then row "ECS 지우기(jeong-ecs-down)" PASS "$(tail -1 "${TMPD}/ed.raw")"; else row "ECS 지우기(jeong-ecs-down)" FAIL "$(tail -1 "${TMPD}/ed.raw")"; exit 1; fi
  # UPREV-B: 클러스터가 목록에서 빠지기까지 몇十 초 걸린다 → 최대 2분 다시 본다
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do n="$(aws ecs list-clusters --query 'length(clusterArns)' --output text 2>/dev/null)"; [ "${n}" = 0 ] && break; sleep 10; done
  if [ "${n}" = 0 ]; then row "ECS 클러스터·서비스·태스크 0" PASS "클러스터 0"; else row "ECS 클러스터·서비스·태스크 0" FAIL "클러스터 ${n:-?}개 남음"; exit 1; fi
  stop_after ecs-down
fi

# ---- 5 계획 → 승인 → 배포·이전 → 트래픽 → 컷오버 → 롤백 1회 ----
if at run; then CUR=run
  UP_DONE=1; cd "${SVC}"
  # UPREV-B: 이번 up 이후에 만든 migration-id.txt 만 쓴다. 지난 회차 것이면 그 이전은 이미 없는 클러스터를 가리킨다
  SRC_ART="${ART}"
  if ! fresh "${ART}/migration-id.txt"; then _f="$(latest_fresh migration-id.txt)" || _f=""; [ -n "${_f}" ] && SRC_ART="$(dirname "${_f}")"; fi
  fresh "${SRC_ART}/migration-id.txt" || { row "이전 실행" FAIL "이번 회차의 migration-id.txt 없음 (import 단계 먼저. 지난 회차 것은 쓰지 않음)"; exit 1; }
  # DEMOFLAGS (회의 D5): 실회차의 승인·시작은 real-flow.ts 스크립트만 한다(화면 승인 안 씀) → api 를 PLAN_ACKS=1 로 다시 띄워 비용 고지 확인 항목(acks)과 시작 지문(planHash)을 서버가 검사하게 한다.
  #   real-flow 는 계획서의 확인 항목 id 를 전부 acks 로, start 에 planHash 를 이미 보낸다. 끄려면 REAL_PLAN_ACKS=0 (화면으로 승인할 때: 화면이 acks 를 보내기 전까진 409 ACKS_MISSING)
  if [ "${REAL_PLAN_ACKS:-1}" = 1 ]; then
    [ -f "${STATE}/api.pid" ] && stop_pidfile "${STATE}/api.pid"
    _gone=0; for _ in $(seq 1 15); do curl -sf -m 2 "http://localhost:${API_PORT}/readyz" >/dev/null 2>&1 || { _gone=1; break; }; sleep 1; done
    # GATE-common c5: 옛 api 가 아직 대답하면 새 api 는 포트를 못 잡고, 아래 readyz 는 옛 api(PLAN_ACKS 꺼짐)로 통과해 버린다 → 여기서 멈춤
    [ "${_gone}" = 1 ] || { row "api PLAN_ACKS=1" FAIL "옛 api 가 ${API_PORT} 에서 15초 넘게 대답함 (lsof -ti tcp:${API_PORT} -sTCP:LISTEN 로 확인)"; exit 1; }
    ( set -a; [ -f "${STATE}/demo-day.env" ] && . "${STATE}/demo-day.env"; set +a; API_HOST=127.0.0.1 PLAN_ACKS=1 MOCK_IAC= GITOPS_DISABLE=1 nohup npm run "${RUNP}:api" > "${ART}/api.acks.log" 2>&1 & echo $! > "${STATE}/api.pid" )
    _up=0; for _ in $(seq 1 40); do curl -sf -m 2 "http://localhost:${API_PORT}/readyz" >/dev/null 2>&1 && { _up=1; break; }; sleep 1; done
    if [ "${_up}" = 1 ]; then row "api PLAN_ACKS=1" PASS "승인 확인 항목·시작 지문 검사 켬"; else row "api PLAN_ACKS=1" FAIL "api 가 40초 안에 안 뜸: ${ART}/api.acks.log"; exit 1; fi
  else row "api PLAN_ACKS" INFO "REAL_PLAN_ACKS=0 → 서버 깃발 기본(꺼짐)"; fi
  # TRF-21: 워커가 이 이전의 Cloudflare LB·풀을 DB 에서 읽게, 이전을 만든 뒤·shift 전에 cf:check 로 등록 (예전: .env 4줄 + 워커 재시작 손으로).
  #   --apply --keep: LB·풀을 만들고 남김(down 의 cf-check --cleanup 이 지움) / --probe·--probe-target: 단계마다 분배 증거. 끄기 REAL_CF_REGISTER=0
  if [ "${REAL_CF_REGISTER:-1}" = 1 ]; then
    _mid="$(head -1 "${SRC_ART}/migration-id.txt" | tr -d ' \r')"
    _tid="$(npm run -s env:connect -- whoami 2>/dev/null | sed -n 's/^회사  *\([0-9a-f-]\{36\}\).*/\1/p' | head -1)"
    [ -n "${_mid}" ] && [ -n "${_tid}" ] || { row "LB 등록(cf:check)" FAIL "이전 번호·회사 번호를 못 받음 (migration-id.txt·env:connect whoami)"; exit 1; }
    stage cf-register env DEMO_ENV="${STATE}/demo-day.env" MID="${_mid}" TID="${_tid}" PN="${REAL_CF_PROBES:-20}" PT="${REAL_CF_PROBE_TARGET:-gcp-app-demo}" \
      sh -c 'set -a; [ -f "$DEMO_ENV" ] && . "$DEMO_ENV"; set +a; exec npm run -s cf:check -- --register="$MID" --tenant="$TID" --apply --keep --probe="$PN" --probe-target="$PT"' \
      || { row "LB 등록(cf:check)" FAIL "로그 ${ART}/cf-register.log (Cloudflare 토큰·오리진 CF_CHECK_*_ORIGIN 확인)"; exit 1; }
    row "LB 등록(cf:check)" PASS "이전 ${_mid} 에 cf-check LB·풀 등록, 분배 probe ${REAL_CF_PROBES:-20}번 (도착 ${REAL_CF_PROBE_TARGET:-gcp-app-demo})"
  else row "LB 등록(cf:check)" INFO "REAL_CF_REGISTER=0 → 등록 안 함 (워커가 .env 의 LB 값을 씀)"; fi
  stage real-flow env API_PORT="${API_PORT}" RF_TIMEOUT_MS=2400000 npx tsx tools/real/flow/real-flow.ts "${SRC_ART}" || { grep -a "FAIL\|STATUS" "${ART}/real-flow.log" | tail -4; exit 1; }
  row "상태 흐름" INFO "$(grep -a '^STATUS' "${ART}/real-flow.log" | awk '{print $3}' | tr '\n' '>')"
fi

# ---- 6 내리기 (Jeong 손 줄) + 자원 0 ----
if at down; then CUR=down
  UP_DONE=1
  # UPREV-B: 워커는 그룹째 끈다 (npm 아래 node 가 남아 작업을 계속 집는다)
  [ -f "${STATE}/worker.pid" ] && stop_pidfile "${STATE}/worker.pid"
  T_DN="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # UPREV-B: Jeong 이 이 스크립트보다 먼저 down 을 쳐서 끝냈으면(진행 파일에 마지막 up 보다 새 down end rc=0) 30분 헛기다리지 않는다
  _dn="$(awk '$2=="JEONG" && $3=="down" && $4=="end"{d=$1; r=$5} $2=="JEONG" && $3=="up" && $4=="end"{u=$1} END{if(d!="" && d>u && r=="rc=0") print d}' "${JPROG}" 2>/dev/null)"
  if [ -n "${_dn}" ]; then row "내리기(jeong-down)" PASS "이미 끝남(${_dn}, 마지막 up 보다 새것) — 자원 0 은 다음 zero 단계가 다시 확인"
  elif wait_jeong down "${DOWN_WAIT_SEC}" "${T_DN}" > "${TMPD}/dn.raw"; then row "내리기(jeong-down)" PASS "$(tail -1 "${TMPD}/dn.raw")"; else row "내리기(jeong-down)" FAIL "$(tail -1 "${TMPD}/dn.raw")"; exit 1; fi
fi
if at zero; then CUR=zero
  UP_DONE=1   # UPREV-B: zero 부터 시작해도 실패하면 down 안내가 나오게
  cd "${SVC}"
  # 지운 직후엔 NAT·EKS·RDS·ENI 가 지우는 중으로 남는다 → 15분까지 30초마다 다시 본다 (cloud-zero 안에서)
  if stage cloud-zero-끝 env CLOUD_ZERO_WAIT_SEC="${CLOUD_ZERO_WAIT_SEC:-900}" bash tools/cloud-zero.sh; then DOWN_DONE=1; rm -f "${UP_STAMP}" "${SECRET_CHECK}" "${DIGESTS}"; row "자원 0 증거" PASS "$(grep -a 'OK zero' "${ART}/cloud-zero-끝.log" | tail -1)"; else row "자원 0 증거" FAIL "OK zero 아님: ${ART}/cloud-zero-끝.log (남은 것 확인 후 jeong-down.sh 다시)"; exit 1; fi
fi
DONE=1
