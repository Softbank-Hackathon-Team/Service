#!/usr/bin/env bash
# 결선 당일 클라우드 올리기·내리기 (z75-33, 작업 Z78). 이미 있는 스크립트·terraform 모듈을 정해진 순서로 부르기만 한다.
# 비용이 드는 도구다. 맥에서만 진짜로 돌린다. 클라우드 VM 에서는 --dry-run 으로 명령 순서만 본다.
#
#   bash tools/demo-day.sh up   [--dry-run] [--fg] [--serial]
#     기본 순서 (주제 38: RDS 생성 9분여를 EKS·served-by 와 겹친다)
#     1. 시작 점검: 도구(terraform·aws·gcloud·kubectl·jq·curl·ssh), 클라우드 자원 0 (tools/cloud-zero.sh)
#     2. GKE(gcp/env) apply 를 뒤에서 시작
#     3. aws/env 를 EKS 없이(create_eks=false) 먼저 apply → VPC·서브넷만 (Z77 B1)
#     4. B1 사실값 → B2 역방향 SSH 중계기 apply → 사람이 터널을 열 때까지 기다림 → B3 데모 공개 설정
#        B3 값은 .env 를 고치지 않고 ~/.svc-tf/demo-day/demo-day.env (권한 600) 에 쓴다. 워커는 이 파일을 환경 변수로 받아 뜬다
#     5. B4 시작: tf:real check → 진짜 terraform 길로 워커·API 를 뒤에서 띄움 → smoke(onprem → aws) 를 뒤에서 시작 (RDS 생성)
#        이 이전은 클러스터 이름이 빈 값이라 배포 단계는 STUB 로 지나간다 (Z77 B 회차와 같음)
#     6. 그동안 aws/env 에 EKS 를 더한다(create_eks=true) → GKE 끝 기다림 → kubeconfig → served-by 두 개 + 공개 주소
#     7. B4 끝 기다림: smoke 완료 + RDS available
#        복제(sync)는 RDS 뒤에 시작하고 터널은 4 에서 이미 열려 있다. 터널이 늦어도 sync 는 5·15·45초 간격으로 3번 다시 해 본다(sync.ts)
#   --serial: 예전 순서 (GKE·EKS 동시 → served-by → B1~B3 → B4 를 앞에서 끝까지). 두 순서 시간 비교용
#     8. npm run demo:preflight (스크립트가 있을 때만) + 발표 화면은 8080(운영 빌드)만: 8080 응답 200, 5173 이 떠 있으면 경고
#     9. 예열(z75-37): 8080 화면 1번, 8080 을 거쳐 healthz·환경 목록·이전 목록 GET 3번씩
#   bash tools/demo-day.sh down [--dry-run] [--fg]
#     1. served-by 지우기(두 클러스터) → 그 VPC 의 ELB 0 될 때까지 (최대 180초)
#     2. up 이 띄운 워커·API·터널 끄기
#     3. tf:real 작업 폴더의 이전별 자원(RDS 등) destroy → 중계기 destroy → aws/env 와 gcp/env 를 동시에 destroy
#     4. tools/cloud-zero.sh 끝 코드로 자원 0 판정
#
# 기본은 nohup 으로 뒤에서 돈다 (맥 RC 세션이 끊겨도 계속). 화면에는 로그 경로만 찍는다. --fg 면 앞에서.
# 진행: DEMO_DAY_LOG_DIR(기본 ../measurements/demo-day-<up|down>-<시각>)/progress.log 에 단계별 start/end/rc/초.
# 마지막 줄: "판정 PASS|FAIL up|down 총 N초 (기준 ≤25분|≤15분)". 끝 코드 0 = PASS.
# 비밀값(비밀번호·토큰·접속 문자열)은 화면·로그에 찍지 않는다. IP 도 로그에는 앞 두 자리만.
#
# 환경 변수
#   AWS_PROFILE(finals) AWS_REGION(ap-northeast-2) GCP_PROJECT(finals-demo) GCP_ZONE(asia-northeast3-a) CLUSTER_NAME(platform-target)
#   EKS_CONTEXT(eks-platform-target) GKE_CONTEXT(gke_<프로젝트>_<존>_<이름>)
#   SMOKE_SOURCE_ENV_ID(55555555… onprem) SMOKE_TARGET_ENV_ID(22222222… aws)
#   DEMO_DAY_AUTO_DOWN(1: up 이 중간에 멈추면 뒤에서 돌던 apply 를 기다린 뒤 down 으로 자원 0. 0 이면 남겨 둠)
#   DEMO_DAY_STRICT(1: 발표 화면 8080·예열·smoke 뒷단계(복제·트래픽 시연) 실패도 up 실패(→ 자동 down)로 센다. 기본 0 = 클라우드가 다 떴으면 경고만, 판정 줄에 "경고:")
#   TF_WAIT_SEC(900: down 이 이전별 destroy 전에 아직 도는 terraform(끊긴 smoke 의 apply)을 기다리는 최대 초)
#   DEMO_DAY_RESUME(1: 시작 점검의 cloud-zero 를 건너뛰고 남은 자원 위에서 apply 를 이어 감. 기본 0)
#   DEMO_DAY_UP_LIMIT_SEC(1500) DEMO_DAY_DOWN_LIMIT_SEC(900) TUNNEL_WAIT_SEC(중계기 뒤 사람이 터널을 열 때까지, 900)
#
# Jeong 직접 실행 묶음 (z75-46): terraform apply/destroy 와 터널은 맥 분류기가 막는 명령이라, 진짜 실행은
#   Jeong 이 sh tools/jeong-up.sh / sh tools/jeong-down.sh 한 번씩 친다(이 스크립트를 DEMO_DAY_JEONG=1 로 부름). 맥 RC 는 --dry-run 과 진행 파일 읽기만.
# 역방향 터널(ssh -R)은 맥 RC 가 열지 않는다 (Z38 R8-39). 맥 분류기가 막는 명령이라 사람 터미널에서
# bash tools/demo-tunnel.sh 를 친다(끊기면 스스로 다시 붙음). up 은 "기다림: 터널" 줄에서 그걸 기다린다.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
# UPREV: 자기 자신을 다시 부를 때 쓰는 절대 경로 (tools/ 안에서 bash demo-day.sh 로 쳐도 cd 뒤 "$0" 이 안 깨지게)
SELF="$ROOT/tools/demo-day.sh"

CMD=${1:-}
shift || true
DRY=0
FG=0
SERIAL=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --fg) FG=1 ;;
    --serial) SERIAL=1 ;;
    *) echo "모르는 옵션: $a" >&2; exit 2 ;;
  esac
done
case "$CMD" in up|down) ;; -h|--help|"") sed -n '2,32p' "$0"; [ -n "$CMD" ]; exit $? ;; *) echo "up 또는 down" >&2; exit 2 ;; esac

# UPREV: gke-gcloud-auth-plugin 은 gcloud SDK 의 bin 에 깔리는데 그 폴더가 PATH 에 없을 수 있다(Homebrew cask·설치 스크립트). kubectl 이 못 찾으면 GKE 접속 실패
#   → PATH 에 없으면 gcloud 가 알려 주는 SDK 폴더의 bin 을 PATH 앞에 더한다 (설치는 안 함)
if ! command -v gke-gcloud-auth-plugin >/dev/null 2>&1 && command -v gcloud >/dev/null 2>&1; then
  _sdk=$(gcloud info --format='value(installation.sdk_root)' 2>/dev/null)
  [ -n "$_sdk" ] && [ -x "$_sdk/bin/gke-gcloud-auth-plugin" ] && export PATH="$_sdk/bin:$PATH"
fi
# NOTTY: 뒤로 띄운 줄(j_bg·nohup)이 터미널 입력을 물려받으면 gcloud·aws 가 묻는 창(프롬프트·페이저)에서 터미널을 읽다 멈춘다
#   (11/3 5차: Jeong 터미널에서 띄운 up 만 cloud-precheck gcp-billing 이 30초 넘게 멈춤, 맥 RC 에선 2~4초) → 묻지 않게·페이저 끄기
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 AWS_PAGER="" PAGER=cat
export AWS_PROFILE=${AWS_PROFILE:-finals}
export AWS_REGION=${AWS_REGION:-ap-northeast-2}
# UPREV-A: AWS CLI 는 AWS_REGION 이 아니라 AWS_DEFAULT_REGION 을 읽는다(프로필 리전이 서울이 아니면 rds·elb 조회가 엉뚱한 리전을 본다 → ELB 0 오판)
export AWS_DEFAULT_REGION=$AWS_REGION
GCP_PROJECT=${GCP_PROJECT:-finals-demo}
# DECISION 결정 3 A안(GCP 이전 전용 프로젝트): 도착 GKE·VPC·Cloud SQL(사설 IP, 같은 VPC)은 TARGET_PROJECT_ID 에 만든다.
#   GCP_PROJECT(원래 프로젝트)는 플랫폼 쪽(회사 전용 SA 등)으로 남는다. 순서: 환경 변수 → 레포 .env. 없으면 예전처럼 GCP_PROJECT 하나(동결 실측 판과 같음)
TARGET_PROJECT_ID=${TARGET_PROJECT_ID:-$(sed -n 's/^TARGET_PROJECT_ID=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' ")}
GCP_TARGET=${GCP_TARGET_PROJECT:-${TARGET_PROJECT_ID:-$GCP_PROJECT}}   # FM-INT-16: 8nr2 이름(GCP_TARGET_PROJECT)도 받음
GCP_ZONE=${GCP_ZONE:-asia-northeast3-a}
CLUSTER_NAME=${CLUSTER_NAME:-platform-target}
EKS_CONTEXT=${EKS_CONTEXT:-eks-platform-target}
GKE_CONTEXT=${GKE_CONTEXT:-gke_${GCP_TARGET}_${GCP_ZONE}_${CLUSTER_NAME}}
# GATE: 자식 스크립트(cloud-zero·up-preflight·cloud-precheck)가 같은 프로젝트·존을 보게 내보낸다. 안 내보내면 cloud-zero 가 gcloud 기본 프로젝트를 봐서
#   (다른 프로젝트가 기본이면) 엉뚱한 곳을 "자원 0" 이라고 판정한다
export GCP_PROJECT GCP_ZONE CLUSTER_NAME TARGET_PROJECT_ID
# ENVPASS: 워커(가져오기·사전 점검)는 온프레 출발 클러스터를 kubectl --context ONPREM_KUBE_CONTEXT 로 읽는다. 코드 기본은 k3d-onprem 인데
#   맥은 k3s-onprem(deploy/onprem-demo 가 이름을 바꿈) → 기본으로 두면 "context was not found" (11/3 실측 4차 IMPORT_SOURCE_UNAVAILABLE).
#   순서: 환경변수 → .env → kubeconfig 에서 찾기(k3s-onprem → k3d-onprem → 이름에 onprem 이 든 것 하나). 못 찾으면 빈 값
onprem_ctx() {
  local c names
  c=${ONPREM_KUBE_CONTEXT:-$(sed -n 's/^ONPREM_KUBE_CONTEXT=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' ")}
  [ -n "$c" ] && { echo "$c"; return 0; }
  names=$(kubectl config get-contexts -o name 2>/dev/null)
  for c in k3s-onprem k3d-onprem; do printf '%s\n' "$names" | grep -qx "$c" && { echo "$c"; return 0; }; done
  c=$(printf '%s\n' "$names" | grep onprem)
  [ -n "$c" ] && [ "$(printf '%s\n' "$c" | wc -l | tr -d ' ')" = 1 ] && echo "$c"
  return 0
}
# 워커·API·smoke 가 모두 물려받게 내보낸다. demo-day.env 에도 적어 실세션이 api·워커를 다시 띄울 때도 같은 값
ONPREM_KUBE_CONTEXT=$(onprem_ctx); export ONPREM_KUBE_CONTEXT
STATE=${DEMO_DAY_STATE:-$HOME/.svc-tf/demo-day}

TFA=infra/modules/aws/env
TFG=infra/modules/gcp/env
TFR=infra/modules/aws/demo-relay
if [ "$CMD" = up ]; then LIMIT=${DEMO_DAY_UP_LIMIT_SEC:-1500}; else LIMIT=${DEMO_DAY_DOWN_LIMIT_SEC:-900}; fi
TUNNEL_WAIT_SEC=${TUNNEL_WAIT_SEC:-900}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
if [ -z "${DEMO_DAY_LOG_DIR:-}" ]; then
  if [ -d ../measurements ]; then DEMO_DAY_LOG_DIR=../measurements/demo-day-$CMD-$STAMP; else DEMO_DAY_LOG_DIR=tools/measure/out/demo-day-$CMD-$STAMP; fi
  [ "$DRY" = 1 ] && DEMO_DAY_LOG_DIR=$DEMO_DAY_LOG_DIR-dry
fi
export DEMO_DAY_LOG_DIR
mkdir -p "$DEMO_DAY_LOG_DIR" || exit 1
# RV-18: 단계 로그는 terraform·aws 원문(ARN·IP·계정 번호)이라 주인만 읽게 두고, 남에게 줄 때는 가린 사본을 만든다
chmod 700 "$DEMO_DAY_LOG_DIR" 2>/dev/null
[ -f "$DEMO_DAY_LOG_DIR/README.txt" ] || printf '%s\n' "이 폴더의 *.log 는 가리지 않은 원문이다 (ARN·IP·계정 번호)." "공유 폴더·메시지로 옮길 때는 가린 사본을 쓴다: sh tools/real/share-logs.sh <이 폴더> <새 폴더>" > "$DEMO_DAY_LOG_DIR/README.txt"
PROGRESS="$DEMO_DAY_LOG_DIR/progress.log"
[ "$DRY" = 1 ] && STATE="$DEMO_DAY_LOG_DIR/state"
ENVF="$STATE/demo-day.env"
# UPREV-A: 중계기 ssh 는 회차마다 새 호스트 키라, 맥 ~/.ssh/known_hosts 에 같은 IP 의 옛 키가 있으면 "키 바뀜" 으로 거절된다 → 이 상태 폴더의 known_hosts 만 쓰고 up 시작 때 지운다
RELAY_SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$STATE/known_hosts"

# 11/3 18:3xZ 사고: 진짜 up 안의 점검(selftest)이 다시 진짜 up 을 띄워 3분마다 up 이 하나씩 늘었다(재귀).
#   진짜 up 안에서 진짜 up 을 또 부르면 시작하지 않는다. 표식 DEMO_DAY_ACTIVE=<명령>:<pid> 는 앞에서 도는(뒤로 안 보내는) 쪽만 단다.
#   안에서 부르는 down(자동 down)과 --dry-run 은 막지 않는다
if [ "$CMD" = up ] && [ "$DRY" = 0 ] && [ -n "${DEMO_DAY_ACTIVE:-}" ]; then
  _ap=${DEMO_DAY_ACTIVE##*:}
  if [ "$_ap" != "$$" ] && kill -0 "$_ap" 2>/dev/null; then echo "이미 도는 demo-day(${DEMO_DAY_ACTIVE}) 안에서 up 이 또 불림 → 시작 안 함" >&2; exit 5; fi
fi
# 뒤로 보내기: 같은 인자로 자기 자신을 nohup 으로 다시 부른다
if [ "$FG" = 0 ] && [ -z "${DEMO_DAY_CHILD:-}" ]; then
  DEMO_DAY_CHILD=1 nohup bash "$SELF" "$CMD" --fg $([ "$DRY" = 1 ] && echo --dry-run) $([ "$SERIAL" = 1 ] && echo --serial) < /dev/null > "$DEMO_DAY_LOG_DIR/stdout.log" 2>&1 &
  echo "뒤에서 시작 (pid $!). 진행: tail -f $PROGRESS"
  exit 0
fi
[ "$DRY" = 0 ] && export DEMO_DAY_ACTIVE="$CMD:$$"

# MACAWAKE (FM-ORC-14·OPS-08): 이 up·down 이 도는 동안 맥이 잠들지 않게 (jeong 줄 없이 바로 쳐도). -w: 이 셸이 끝나면 같이 끝남.
#   dry-run·caffeinate 없는 곳(리눅스)·DEMO_DAY_NO_AWAKE=1 은 건너뜀. 시험은 DEMO_DAY_CAFFEINATE 로 가짜를 준다
if [ "$DRY" = 0 ] && [ "${DEMO_DAY_NO_AWAKE:-0}" != 1 ] && command -v "${DEMO_DAY_CAFFEINATE:-caffeinate}" >/dev/null 2>&1; then
  "${DEMO_DAY_CAFFEINATE:-caffeinate}" -i -m -s -w $$ < /dev/null > /dev/null 2>&1 &
fi
now_s() { date +%s; }
BGPIDS=""
APPLIED=0   # apply 를 하나라도 시작했나 (멈출 때 자동 down 여부)
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(iso) $*" | tee -a "$PROGRESS"; }
mask_ip() { echo "$1" | awk -F. 'NF == 4 { print $1 "." $2 ".x.x"; next } { print substr($0, 1, 12) "…" }'; }
T_ALL=$(now_s)
FAILED=""
WARNED=""      # GATE: 실패했지만 up 판정에 안 넣은 단계 (판정 줄 "경고:")
# GATE-common c5: finish·abort 를 안 거치고 끝나는 길에도 자동 down 을 건다.
#   set -u 에서 안 정한 변수 하나면 bash 는 그 자리에서 끝난다(step 안 함수도 같은 셸이라). 예전엔 그때 뒤에서 돌던 GKE apply 와 만든 자원이 그대로 남았다.
#   신호(TERM·HUP·INT: kill, 맥 RC·터미널이 끊으며 보내는 것)도 같다. 자동 down 은 abort 가 하는 것과 같은 길
FINISHED=0
IN_ABORT=0
on_exit() {
  local rc=$?
  [ "$FINISHED" = 1 ] && return 0
  if [ "$IN_ABORT" = 1 ]; then log "멈춤 정리 중에 예상 못 하게 끝남 (rc=$rc) → 자원이 남았을 수 있다: sh tools/jeong-down.sh"; return 0; fi
  FAILED="$FAILED unexpected-exit"
  abort "예상 못 한 끝 (rc=$rc: 안 정한 변수 등 스크립트 내부 오류)"
}
trap on_exit EXIT
trap 'FAILED="$FAILED signal"; abort "신호를 받아 멈춤 (TERM·HUP·INT)"' TERM HUP INT

# run: 명령 하나. dry-run 이면 찍기만. 출력은 단계 로그 파일에
run() {
  if [ "$DRY" = 1 ]; then echo "DRY: $*" >> "$PROGRESS"; return 0; fi
  "$@"
}
# aws/env·bootstrap 의 필수 변수 expected_account_id: 값은 sts 에서 받아 환경 변수(TF_VAR_)로만 넘긴다 — 명령줄·로그에 안 찍힘.
#   이미 TF_VAR_expected_account_id 가 있으면 그대로 쓴다(사람이 export 한 우회와 같이 써도 됨). dry-run 은 자리값
aws_account_var() {
  [ -n "${TF_VAR_expected_account_id:-}" ] && return 0
  if [ "$DRY" = 1 ]; then export TF_VAR_expected_account_id=000000000000; return 0; fi
  local a
  a=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || { log "aws sts 실패: expected_account_id 를 못 받음"; return 1; }
  case "$a" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) export TF_VAR_expected_account_id="$a" ;; *) log "aws sts 응답 모양이 계정 번호 아님"; return 1 ;; esac
}
# step <이름> <명령…>: 시작·끝·rc·초를 progress.log 에. 출력은 <이름>.log
step() {
  local name=$1 t0 rc
  shift
  log "step=$name start"
  t0=$(now_s)
  "$@" >> "$DEMO_DAY_LOG_DIR/$name.log" 2>&1
  rc=$?
  log "step=$name end rc=$rc sec=$(( $(now_s) - t0 ))"
  [ $rc -eq 0 ] || FAILED="$FAILED $name"
  return $rc
}
# 두 단계를 동시에. 둘 다 끝날 때까지 기다리고, 하나라도 실패면 실패
par() {
  local n1=$1 f1=$2 n2=$3 f2=$4 p1 p2 r1 r2
  step "$n1" "$f1" & p1=$!
  step "$n2" "$f2" & p2=$!
  wait $p1; r1=$?; wait $p2; r2=$?
  [ $r1 -eq 0 ] || FAILED="$FAILED $n1"
  [ $r2 -eq 0 ] || FAILED="$FAILED $n2"
  [ $r1 -eq 0 ] && [ $r2 -eq 0 ]
}
# GATE: 실패해도 up 판정을 깨지 않는 단계(발표 화면·예열). 경고로 판정 줄에 남긴다. DEMO_DAY_STRICT=1 이면 예전처럼 실패
step_soft() {
  local name=$1; shift
  step "$name" "$@" && return 0
  [ "${DEMO_DAY_STRICT:-0}" = 1 ] && return 1
  FAILED=${FAILED% "$name"}
  WARNED="$WARNED $name"
  log "경고: $name 실패 → 판정엔 안 넣음 (DEMO_DAY_STRICT=1 이면 실패)"
  return 0
}
tfout() { if [ "$DRY" = 1 ]; then echo "<dry:$2>"; else terraform -chdir="$1" output -raw "$2"; fi; }
tfjson() { if [ "$DRY" = 1 ]; then echo '["<dry:'"$2"'>"]'; else terraform -chdir="$1" output -json "$2"; fi; }
# UPREV-A: 모듈 폴더에 terraform 상태가 있는가. 한 번도 init/apply 안 된 폴더(앞 단계에서 멈춘 up)나 이미 비워진 상태는 destroy 를 건너뛴다
#   (안 그러면 init 없는 destroy 가 실패해 down 이 "자원이 없는데도" FAIL). 상태 조회 자체가 실패하면 "있다" 로 보고 destroy 를 시도한다
tf_has_state() {
  local d=$1 out
  [ "$DRY" = 1 ] && return 0
  if [ ! -d "$d/.terraform" ] && [ ! -f "$d/terraform.tfstate" ]; then echo "$d: init·상태 흔적 없음 → destroy 생략"; return 1; fi
  if out=$(terraform -chdir="$d" state list 2>/dev/null) && [ -z "$out" ]; then echo "$d: 상태에 자원 0 → destroy 생략"; return 1; fi
  return 0
}
finish() {
  local total=$(( $(now_s) - T_ALL )) v=PASS
  [ -z "$FAILED" ] || v=FAIL
  # UPREV DRAFT(ai): 시간 기준을 넘긴 것은 자원이 다 떴으면 실패로 치지 않는다 (끝 코드 0, 판정 줄에 "느림" 으로 남김).
  #   예전엔 25분을 1초만 넘겨도 rc=1 이라, 다 뜬 up 을 실패로 보고 다시 치게 될 수 있었다
  [ "$total" -le "$LIMIT" ] || v="$v(느림: ${LIMIT}초 넘김)"
  [ "$DRY" = 1 ] && v="$v(dry-run)"
  log "판정 $v $CMD 총 ${total}초 (기준 ≤$((LIMIT / 60))분)${FAILED:+ 실패:$FAILED}${WARNED:+ 경고:$WARNED}"
  # z75-50: timeline(TL_MODE=allow) 이 기다리는 끝 줄. jeong-up/down 과 같은 진행 파일
  if [ "$DRY" = 0 ]; then mkdir -p "$STATE" && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DEMODAY $CMD end rc=$([ -z "${v%%PASS*}" ] && echo 0 || echo 1) sec=$total log=$PROGRESS" >> "$STATE/jeong-progress.log"; fi
  FINISHED=1
  case "$v" in PASS*) exit 0 ;; *) exit 1 ;; esac
}
# UPREV: 멈출 때 뒤에서 돌던 apply(GKE 등)를 그냥 두고 끝내면 고아 terraform 이 자원을 계속 만들고 state 잠금을 쥔다
#   (20:2xZ 1차: aws rc=1 로 끝났는데 GKE 7개가 남아 2차 cloud-zero 가 막힘). 그래서 끝날 때까지 기다린 뒤 down 으로 자원 0 을 만든다
abort() {
  local p n tries
  # 정리 중에 또 멈춤이 오면(신호·내부 오류) 판정만 하고 끝낸다 (자동 down 을 두 번 겹쳐 돌리지 않는다)
  [ "$IN_ABORT" = 1 ] && finish
  IN_ABORT=1
  # 정리(뒤 단계 기다림·자동 down) 중엔 신호로 끊지 않는다. 끊으면 자원이 남는다. 정말 끊으려면 kill -9
  trap 'log "자동 정리 중이라 신호를 무시함 (끝까지 감)"' TERM HUP INT
  log "멈춤: $1"
  for p in $BGPIDS; do kill -0 "$p" 2>/dev/null && { log "뒤에서 도는 단계(pid $p)가 끝날 때까지 기다림 (terraform 을 중간에 끊지 않음)"; wait "$p"; }; done
  # GATE: 어느 단계에서 멈춰도 자동 down (팀 기준: 실패하면 자동 정리). down 은 RDS·비밀·고아 LB·PSA 까지 0 으로 가게 고쳤다 (d_migration_tf·secrets_purge·aws_orphans·gcp_orphans)
  if [ "$CMD" = up ] && [ "$DRY" = 0 ] && [ "$APPLIED" = 1 ] && [ "${DEMO_DAY_AUTO_DOWN:-1}" = 1 ]; then
    log "자원 0 으로 되돌림: down 시작 (남기려면 DEMO_DAY_AUTO_DOWN=0)"
    # GATE-common c5: down 이 한 번 실패해도(지우는 중 의존 관계·일시 API 오류) 한 번 더. destroy 는 다시 돌려도 안전하다
    #   DRAFT(ai): 최대 2번 (DEMO_DAY_AUTO_DOWN_TRIES). 2번째 로그는 auto-down-2
    tries=${DEMO_DAY_AUTO_DOWN_TRIES:-2}
    for n in $(seq 1 "$tries"); do
      ( DEMO_DAY_CHILD=1 DEMO_DAY_LOG_DIR="$DEMO_DAY_LOG_DIR/auto-down$([ "$n" -gt 1 ] && echo "-$n")" bash "$SELF" down --fg ); p=$?
      log "자동 down 끝 rc=$p (${n}번째)"
      [ "$p" = 0 ] && break
      [ "$n" -lt "$tries" ] && { log "자동 down 실패 → 60초 뒤 한 번 더"; sleep "${DEMO_DAY_AUTO_DOWN_GAP_SEC:-60}"; }
    done
    [ "$p" = 0 ] || log "자동 down 이 ${tries}번 다 실패 → 자원이 남았다. sh tools/jeong-down.sh 를 다시 치고 판정 PASS(cloud-zero OK zero)를 본다"
  else
    if [ "$APPLIED" = 0 ]; then log "apply 를 시작하기 전에 멈춤 → 만든 자원 없음. 위 FAIL 줄을 고치고 up 을 다시 친다"
    else log "만든 자원은 'bash tools/demo-day.sh down' 으로 지우거나, DEMO_DAY_RESUME=1 로 up 을 다시 쳐서 이어 간다"; fi
  fi
  finish
}
# UPREV: 지난 회차의 워커·API·터널이 살아 있으면 새 API 가 3000 을 못 잡고, readyz 는 예전 API 가 대답해 거짓 통과한다 → 먼저 끈다
u_stale() {
  local i
  # 워커·API·터널·smoke 는 UPREV-A d_procs (pid 재사용 대비: 우리 프로세스일 때만 끔)
  d_procs
  [ "$DRY" = 1 ] || rm -f "$STATE/relay_ip" "$STATE/known_hosts" "$ENVF"
  echo "지난 회차 프로세스 정리, relay_ip·known_hosts·demo-day.env 지움"
  if [ "$DRY" = 0 ] && command -v lsof >/dev/null 2>&1; then
    # GATE: 방금 끈 API 가 3000 을 놓는 데 몇 초 걸린다 → 바로 FAIL 하지 않고 15초까지 기다린다
    for i in $(seq 1 15); do lsof -ti tcp:3000 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
    if lsof -ti tcp:3000 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "3000 포트를 다른 프로세스가 쓰고 있다 (예전 dev:api?). 끄고 다시: lsof -ti tcp:3000 -sTCP:LISTEN"; return 1
    fi
  fi
  # GATE-aws: 여기는 apply 전. 삭제 예약 비밀이 하나라도 안 지워지면(권한·조회 실패) 멈춘다 → smoke apply 의 'scheduled for deletion' 실패를 apply 전에 막음
  secrets_purge strict || return 1
  return 0
}
# GATE: terraform destroy 가 지운 Secrets Manager 비밀은 복구 창(recovery_window_in_days=7) 동안 이름이 묶여, 같은 이름(platform/<회사>/<앱>/<키>)의
#   다음 apply 가 "scheduled for deletion" 으로 실패한다 (11/2 맥 cloud-zero: 삭제 예약 비밀 2개 남음). 삭제 예약 상태인 platform/ 비밀만 바로 지운다(복구 없음).
#   살아 있는 비밀은 건드리지 않는다(그건 이전별 destroy 가 지움). 목록은 list-secrets --include-planned-deletion, 그 옵션이 없는 옛 aws CLI 면 태그 조회로
secrets_purge() {
  # GATE-aws: 인자 strict = up 의 stale 단계(apply 전). 조회 실패·지우기 실패·120초 안에 NotFound 가 안 되면 1 → up 이 apply 전에 멈춤.
  #   strict 아님 = down. 알리기만 하고 0 (남은 것은 마지막 cloud-zero 가 판정)
  #   대상: 삭제 예약(DeletedDate 있음) 비밀 중 이름이 platform/ 로 시작하거나 태그 managed-by=platform 인 것 (v2 루트·kinds/identity 도 platform/<회사>/<앱>/ 이름)
  local mode=${1:-} arns a b d n=0 f=0 left i err q='SecretList[?DeletedDate != `null`].ARN'
  if [ "$DRY" = 1 ]; then echo "DRY: 삭제 예약(platform/*) 비밀 (태그 managed-by=platform 포함) → aws secretsmanager delete-secret --force-delete-without-recovery → describe-secret 이 NotFound 될 때까지 (≤120초)" >> "$PROGRESS"; return 0; fi
  if a=$(aws secretsmanager list-secrets --include-planned-deletion --filters Key=name,Values=platform/ --query "$q" --output text 2>/dev/null) &&
     b=$(aws secretsmanager list-secrets --include-planned-deletion --filters Key=tag-key,Values=managed-by Key=tag-value,Values=platform --query "$q" --output text 2>/dev/null); then
    arns=$(printf '%s\n%s\n' "$a" "$b" | tr '\t' '\n' | grep -v '^None$' | grep -v '^[[:space:]]*$' | sort -u)
  else
    # 옛 aws CLI(--include-planned-deletion 없음): 태그 조회 + describe-secret
    if ! a=$(aws resourcegroupstaggingapi get-resources --resource-type-filters secretsmanager:secret --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null); then
      if [ "$mode" = strict ]; then log "비밀 목록 조회 실패 (list-secrets·태그 조회 둘 다) → apply 전에 멈춤 (aws 로그인 확인)"; return 1; fi; echo "비밀 목록 조회 실패"; return 0
    fi
    arns=""
    for a in $(printf '%s\n' "$a" | tr '\t' '\n'); do
      case "$a" in *:secret:platform/*) d=$(aws secretsmanager describe-secret --secret-id "$a" --query DeletedDate --output text 2>/dev/null); [ -n "$d" ] && [ "$d" != None ] && arns="$arns $a" ;; esac
    done
  fi
  for a in $arns; do
    if aws secretsmanager delete-secret --secret-id "$a" --force-delete-without-recovery >/dev/null 2>&1; then n=$((n + 1)); else f=$((f + 1)); fi
  done
  # 강제 삭제도 비동기다: 바로 같은 이름으로 만들면 실패할 수 있다(AWS 문서: DescribeSecret 이 ResourceNotFound 가 될 때까지 확인). 5초 간격 최대 120초
  left=""
  if [ -n "$arns" ]; then
    err=$(mktemp "${TMPDIR:-/tmp}/sm-purge.XXXXXX")   # (상태 폴더가 아직 없을 수 있는 down 에서도 되게 임시 파일)
    for i in $(seq 1 24); do
      left=""
      for a in $arns; do
        if aws secretsmanager describe-secret --secret-id "$a" --query Name --output text >/dev/null 2>"$err"; then left="$left $a"
        elif ! grep -q ResourceNotFoundException "$err"; then left="$left $a"; fi
      done
      [ -z "$left" ] && break
      sleep 5
    done
    rm -f "$err"
  fi
  echo "삭제 예약 비밀(platform/*) 바로 지움 ${n}개$([ "$f" -gt 0 ] && echo ", 지우기 실패 ${f}개")$([ -n "$left" ] && echo ", 120초 뒤에도 남음 $(echo $left | wc -w | tr -d ' ')개" || { [ -n "$arns" ] && echo ", 전부 NotFound 확인"; })"
  if [ "$mode" = strict ] && { [ "$f" -gt 0 ] || [ -n "$left" ]; }; then log "삭제 예약 비밀이 남아 smoke apply 가 이름 충돌로 실패한다 → apply 전에 멈춤 (aws secretsmanager list-secrets --include-planned-deletion 로 확인)"; return 1; fi
  return 0
}

# ---------------- up ----------------
u_tools() {
  local t miss=""
  for t in terraform aws gcloud kubectl jq curl ssh npm python3 pgrep; do command -v "$t" >/dev/null 2>&1 || miss="$miss $t"; done
  if [ "$DRY" = 1 ]; then echo "dry-run: 없는 도구${miss:- 0개}${miss:+:$miss} (dry-run 은 막지 않음). 사전 점검 tools/cloud-precheck.sh 는 맥에서만"; return 0; fi
  [ -z "$miss" ] || { echo "없는 도구:$miss"; return 1; }
  [ -f "$HOME/.ssh/id_ed25519.pub" ] || { echo "~/.ssh/id_ed25519.pub 없음 (Z77 B2 첫 줄로 만든다)"; return 1; }
  # GATE: 워커·API 가 붙는 플랫폼 DB(.env DATABASE_URL, 기본 localhost:5432)가 안 떠 있으면 B4(apply 뒤 ≈15분)에서야 "API 가 안 뜸" 으로 멈춘다
  #   → 여기서 보고, 닫혀 있으면 docker compose 의 db 를 켠다 (로컬 컨테이너, 클라우드 자원 아님)
  local hp dbh dbp
  hp=$(sed -n 's/^DATABASE_URL=//p' .env 2>/dev/null | tail -n 1 | sed -E 's#^[a-z]+://([^@/]*@)?([^/:?]+)(:([0-9]+))?.*#\2 \4#')
  set -- ${hp:-localhost 5432}; dbh=${1:-localhost}; dbp=${2:-5432}
  if ! (exec 3<>"/dev/tcp/$dbh/$dbp") 2>/dev/null; then
    echo "플랫폼 DB $dbh:$dbp 닫힘 → docker compose up -d --wait db"
    run docker compose up -d --wait db || { echo "플랫폼 DB 를 못 켬 (.env DATABASE_URL 과 docker 확인)"; return 1; }
    (exec 3<>"/dev/tcp/$dbh/$dbp") 2>/dev/null || { echo "db 를 켰는데도 $dbh:$dbp 닫힘"; return 1; }
  fi
  # UPREV: apply 전에 실패할 수 있는 것을 전부 본다(인증·ADC·필수 변수·남은 state·자원 0·한도·출발 DB·8080·validate·plan).
  #   PASS 가 아니면 여기서 멈춰 apply 를 하나도 시작하지 않는다 (DEMO_DAY_RESUME=1 이면 남은 state·자원은 WARN)
  # GATE-common c2 / GATE-aws: stale 단계(secrets_purge strict) 뒤라는 표시 → 삭제 예약 비밀이 남아 있으면 up-preflight 가 WARN 이 아니라 FAIL (혼자 칠 땐 WARN)
  # CLD-07: 콘솔 연결 링크의 S3 템플릿이 레포와 다르면 같은 주소에 다시 올린다 (손 재업로드 없앰). up-preflight 의 connect-template 점검 앞
  if [ "$DRY" = 1 ]; then CTS_DRY=1 bash tools/connect-template-sync.sh 2>&1 | sed 's/^/  /' || true
  else bash tools/connect-template-sync.sh || { echo "S3 연결 템플릿을 못 맞춤 (CONNECT_TEMPLATE_SYNC=0 이면 건너뜀)"; return 1; }; fi
  run env UP_PREFLIGHT_AFTER_PURGE=1 bash "${UP_PREFLIGHT:-tools/up-preflight.sh}"
}
u_gke() { run terraform -chdir="$TFG" init -input=false && run terraform -chdir="$TFG" apply -input=false -auto-approve -var "project_id=$GCP_TARGET" -var "zone=$GCP_ZONE" -var "name=$CLUSTER_NAME"; }
u_eks() { aws_account_var && run terraform -chdir="$TFA" init -input=false && run terraform -chdir="$TFA" apply -input=false -auto-approve -var create_eks=true; }
u_kubeconfig() {
  run gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$GCP_ZONE" --project "$GCP_TARGET" &&
  run aws eks update-kubeconfig --name "$(tfout "$TFA" cluster_name)" --alias "$EKS_CONTEXT" --region "$AWS_REGION"
}
wait_addr() {
  local ctx=$1 i a
  [ "$DRY" = 1 ] && { echo "<dry:addr-$ctx>"; return 0; }
  # GATE: ELB·GKE 공인 IP 는 보통 1~3분, 늦으면 4분 → 300초 (예전 180초)
  for i in $(seq 1 60); do
    a=$(bash deploy/cloud-demo/apply-served-by.sh addr "$ctx" 2>/dev/null)
    [ -n "$a" ] && { echo "$a"; return 0; }
    sleep 5
  done
  return 1
}
# GATE: served-by 올리기는 멱등(kubectl apply)이라 한 번 더 해 본다 (노드 Ready 직후 이미지 받기·rollout 180초 초과 같은 일시 실패)
sb_up() { local i; for i in 1 2; do run bash deploy/cloud-demo/apply-served-by.sh up "$1" "$2" && return 0; echo "served-by $2 ${i}번째 실패 → 20초 뒤 다시"; sleep 20; done; return 1; }
u_served_by() {
  sb_up "$EKS_CONTEXT" aws-app-demo && sb_up "$GKE_CONTEXT" gcp-app-demo || return 1
  SRC_ORIGIN=$(wait_addr "$EKS_CONTEXT") && TGT_ORIGIN=$(wait_addr "$GKE_CONTEXT") || { echo "공개 주소가 300초 안에 안 나옴"; return 1; }
  echo "출발 오리진 $(mask_ip "$SRC_ORIGIN"), 도착 오리진 $(mask_ip "$TGT_ORIGIN")"
}
u_facts() {
  export TF_FACT_VPC_ID TF_FACT_DB_SUBNET_IDS_JSON TF_FACT_CLUSTER_NAME TF_FACT_ACCOUNT_ID TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON
  TF_FACT_VPC_ID=$(tfout "$TFA" vpc_id) &&
  TF_FACT_DB_SUBNET_IDS_JSON=$(tfjson "$TFA" db_subnet_ids) &&
  TF_FACT_CLUSTER_NAME=$(tfout "$TFA" cluster_name) &&
  TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON=$(tfjson "$TFA" public_subnet_ids) || return 1
  if [ "$DRY" = 1 ]; then TF_FACT_ACCOUNT_ID="<dry:account>"; else TF_FACT_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text) || return 1; fi
  echo "사실값 5개 채움 (값은 찍지 않음)"
}
u_relay() {
  local sub myip i ok myip2 cidrs
  MYIP2=""
  if [ "$DRY" = 1 ]; then myip="<dry:myip>"; sub="<dry:subnet>"; cidrs='["<dry:myip>/32"]'; else
    # UPREV-A: 파이프 뒤 rc 는 tr 의 것이라 curl 실패가 가려졌다 → 값 모양을 직접 본다 (빈 값이면 ["/32"] 로 terraform 이 늦게 거절)
    myip=$(curl -fsS -m 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
    case "$myip" in *[!0-9.]*|"") echo "맥 공인 IP 를 못 받음 (checkip.amazonaws.com)"; return 1 ;; esac
    # GATE: 출구 IP 가 둘일 수 있다(VPN·이중 회선). DNS 로 본 공인 IP 가 다르면 둘 다 SSH 허용 목록에 넣는다 (아니면 터널이 900초 기다리다 멈춤)
    cidrs="[\"$myip/32\"]"
    if command -v dig >/dev/null 2>&1; then
      myip2=$(dig +short +time=3 +tries=1 myip.opendns.com @resolver1.opendns.com 2>/dev/null | tail -n 1)
      case "$myip2" in *[!0-9.]*|"") ;; *) [ "$myip2" = "$myip" ] || { echo "공인 IP 가 둘 (https 와 dns 가 다름) → 둘 다 허용"; cidrs="[\"$myip/32\",\"$myip2/32\"]"; MYIP2=$myip2; } ;; esac
    fi
    sub=$(echo "$TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON" | jq -r '.[0] // empty')
    [ -n "$sub" ] || { echo "공개 서브넷 ID 가 없음 (aws/env 출력 public_subnet_ids 비었음)"; return 1; }
    [ -n "${TF_FACT_VPC_ID:-}" ] || { echo "vpc_id 가 없음 (b1-facts 먼저)"; return 1; }
  fi
  MYIP=$myip
  run terraform -chdir="$TFR" init -input=false &&
  run terraform -chdir="$TFR" apply -input=false -auto-approve -var "vpc_id=$TF_FACT_VPC_ID" -var "public_subnet_id=$sub" \
    -var "ssh_public_key=$(cat "$HOME/.ssh/id_ed25519.pub" 2>/dev/null)" -var "ssh_cidrs_json=$cidrs" || return 1
  RELAY_IP=$(tfout "$TFR" public_ip) && RELAY_PRIV=$(tfout "$TFR" private_ip) || { echo "중계기 출력(public_ip·private_ip)을 못 읽음"; return 1; }
  [ -n "$RELAY_IP" ] && [ -n "$RELAY_PRIV" ] || { echo "중계기 IP 가 비었다"; return 1; }
  [ "$DRY" = 1 ] && { echo "DRY: 터널은 사람 터미널에서 bash tools/demo-tunnel.sh → tunnel-ok 기다림 (최대 ${TUNNEL_WAIT_SEC}초)" >> "$PROGRESS"; return 0; }
  mkdir -p "$STATE" && chmod 700 "$STATE" && echo "$RELAY_IP" > "$STATE/relay_ip"
  # 중계기가 SSH 를 받을 때까지 최대 150초. 안 되면 바로 멈춘다 (예전엔 조용히 지나가 터널을 900초 기다렸다)
  ok=""
  for i in $(seq 1 30); do ssh $RELAY_SSH_OPTS -o ConnectTimeout=5 "ec2-user@$RELAY_IP" true 2>/dev/null && { ok=1; break; }; sleep 5; done
  [ -n "$ok" ] || { echo "중계기 SSH 가 150초 안에 안 열림 (맥 공인 IP 가 허용 목록과 다른가? 허용: $(mask_ip "$myip")/32${MYIP2:+ 외 1})"; return 1; }
  # GATE: user_data(GatewayPorts clientspecified + sshd 재시작)가 끝나기 전에 터널이 붙으면 5432 가 루프백에만 열려 RDS 가 못 붙는다(조용히).
  #   → cloud-init 이 끝날 때까지(최대 120초) 기다린 뒤 터널을 연다. 못 확인해도 demo-tunnel 이 바인딩을 스스로 확인하니 계속 간다
  ok=""
  for i in $(seq 1 24); do
    ssh $RELAY_SSH_OPTS -o ConnectTimeout=5 "ec2-user@$RELAY_IP" 'cloud-init status 2>/dev/null' 2>/dev/null | grep -Eq 'status: (done|error|degraded)' && { ok=1; break; }
    sleep 5
  done
  if [ -n "$ok" ]; then echo "중계기 부팅 설정 끝 (cloud-init done)"; else echo "경고: cloud-init 끝을 120초 안에 못 봄 → 터널이 바인딩(0.0.0.0:5432)을 확인하며 다시 붙는다"; fi
  # 역방향 터널은 맥 RC 가 열지 않는다 (Z38 R8-39: 맥 분류기가 막는 명령이라 사람이 직접 친다). 열릴 때까지 기다린다
  # z75-46: Jeong 이 tools/jeong-up.sh 로 이 스크립트를 부른 경우(DEMO_DAY_JEONG=1)엔 이미 사람 터미널에서 도는 것이라 여기서 바로 연다
  if [ "${DEMO_DAY_JEONG:-0}" = 1 ]; then
    nohup bash tools/demo-tunnel.sh < /dev/null > "$DEMO_DAY_LOG_DIR/tunnel.log" 2>&1 &
    echo "터널: Jeong 실행 묶음 안에서 뒤로 엶 (로그 tunnel.log)" | tee -a "$PROGRESS"
  else
    echo "기다림: 터널. 사람 터미널에서 bash tools/demo-tunnel.sh" | tee -a "$PROGRESS"
  fi
  tunnel_wait "$TUNNEL_WAIT_SEC"
}
# 중계기에서 5432 가 모든 주소(0.0.0.0)로 열려 있으면 0. 최대 $1 초 5초 간격으로 본다
#   GATE: 예전엔 루프백(127.0.0.1)만 봐서 GatewayPorts 전에 붙은 터널(루프백 전용)도 tunnel-ok 로 통과했다 → RDS 가 못 붙어 smoke 가 10분 뒤 실패
tunnel_wait() {
  local i st
  for i in $(seq 1 $(( ($1 + 4) / 5 ))); do
    st=$(ssh $RELAY_SSH_OPTS -o ConnectTimeout=5 "ec2-user@$RELAY_IP" 'ss -ltn 2>/dev/null | grep -E "(0\.0\.0\.0|\*):5432[[:space:]]" >/dev/null && echo all || { ss -ltn 2>/dev/null | grep -q "127\.0\.0\.1:5432" && echo loopback || echo none; }' 2>/dev/null)
    case "$st" in
      all) echo tunnel-ok; return 0 ;;
      loopback) [ $((i % 6)) -eq 1 ] && echo "터널이 루프백에만 열림 (sshd 가 GatewayPorts 전) → demo-tunnel 이 끊고 다시 붙는 중" ;;
    esac
    sleep 5
  done
  echo "터널이 ${1}초 안에 안 열림"; return 1
}
u_envfile() {
  local src peer
  mkdir -p "$STATE" && chmod 700 "$STATE" || return 1
  run curl -sS -o "$STATE/rds-ap-northeast-2-bundle.pem" https://truststore.pki.rds.amazonaws.com/ap-northeast-2/ap-northeast-2-bundle.pem || return 1
  [ "$DRY" = 1 ] || [ "$(grep -c 'BEGIN CERTIFICATE' "$STATE/rds-ap-northeast-2-bundle.pem")" -ge 1 ] || { echo "CA 묶음이 비었다"; return 1; }
  # 출발 계정·비밀번호·DB 이름은 REPL_SOURCE_URL 에서 가져오고 호스트만 중계기 사설 IP 로 바꾼다 (값은 파일에만)
  src=${REPL_SOURCE_URL:-$(sed -n 's/^REPL_SOURCE_URL=//p' .env 2>/dev/null | tail -n 1)}
  [ -n "$src" ] || [ "$DRY" = 1 ] || { echo "REPL_SOURCE_URL 이 없다 (demo.sh enable-repl 또는 k3d CNPG 주소)"; return 1; }
  peer=$(python3 -c 'import sys, urllib.parse as u
p = u.urlsplit(sys.argv[1]); auth = p.netloc.rsplit("@", 1)[0] + "@" if "@" in p.netloc else ""
print(u.urlunsplit((p.scheme, auth + sys.argv[2] + ":5432", p.path, "sslmode=require", "")))' "${src:-postgres://dry@x/app}" "$RELAY_PRIV") || return 1
  umask 077
  # 값은 작은따옴표로 감싼다 (JSON 목록의 큰따옴표가 셸에서 벗겨지지 않게)
  kv() { printf "%s='%s'\n" "$1" "$2"; }
  {
    kv TF_FACT_VPC_ID "$TF_FACT_VPC_ID"
    kv TF_FACT_DB_SUBNET_IDS_JSON "$TF_FACT_DB_SUBNET_IDS_JSON"
    kv TF_FACT_CLUSTER_NAME "$TF_FACT_CLUSTER_NAME"
    kv TF_FACT_ACCOUNT_ID "$TF_FACT_ACCOUNT_ID"
    kv TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON "$TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON"
    kv DB_PEER_CIDRS "$MYIP/32,$RELAY_PRIV/32${MYIP2:+,$MYIP2/32}"
    kv DB_PUBLIC "1"
    kv DB_DISPOSABLE "1"
    kv REPL_TARGET_CA_FILE "$STATE/rds-ap-northeast-2-bundle.pem"
    kv REPL_TARGET_SSLMODE "verify-full"
    kv REPL_TARGET_URL "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/{tf:db_name}"
    kv REPL_TARGET_PEER_URL "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/{tf:db_name}?sslmode=require"
    kv REPL_TARGET_PROVIDER "rds"
    # PF-E (FM-APP-13): 앱 계정 이름. 없으면 기본 app_user 라 출발(CNPG owner app)에 없어 precheck DB-05 로 멈췄다. 펜스(쓰기 막기)도 이 계정에 건다
    kv REPL_SOURCE_APP_ROLE "${REPL_SOURCE_APP_ROLE:-app}"
    kv REPL_TARGET_APP_ROLE "{tf:db_username}"
    # SCHEMACOPY (11/3 9회차 F16): 도착 RDS 는 terraform 이 빈 DB 로 만들고 앱 마이그레이션은 이 경로에서 안 돈다 → 워커 sync 가 복제 전에
    #   출발 표 모양(데이터 없음)·앱 계정을 도착에 만들게 켠다 (packages/replication/src/schema.ts)
    kv REPL_COPY_SCHEMA "1"
    kv REPL_SOURCE_PEER_URL "$peer"
    kv REPL_SOURCE_SSLMODE "disable"
    # PF-E11 (FM-APP-20) DRAFT(ai): 도착 구독 접속 문자열에 출발 관리자 비밀번호 대신 이 이전 전용 복제 계정(teardown 때 지움). 끄려면 REPL_EPHEMERAL_USER=0
    kv REPL_EPHEMERAL_USER "${REPL_EPHEMERAL_USER:-1}"
    # PF-E13 (FM-APP-24): 워커는 --env-file=.env 도 읽는데 Node 는 "없는 값만" 채운다 → 여기서 안 적은 REPL_*·SYNC_* 는 .env 옛 값이 새어 든다
    #   (옛 REPL_TABLES=customers,orders 면 DB-T1 로 SYNC_FAILED). 복제가 읽는 값은 전부 여기서 정한다. 빈 값 = 기본값
    kv REPL_COPY_SCHEMA "${REPL_COPY_SCHEMA:-1}"
    kv REPL_SOURCE_PROVIDER "postgres"
    kv REPL_TABLES ""
    kv REPL_SOURCE_SCHEMA ""
    kv REPL_TARGET_SCHEMA ""
    kv REPL_SOURCE_CA_FILE ""
    kv REPL_CA_FILE ""
    kv REPL_SSLMODE ""
    kv REPL_FACTS_FILES ""
    kv REPL_MAX_LAG_MS ""
    kv REPL_GATE_SAMPLES ""
    kv REPL_MAX_CATCHUP_MS ""
    kv REPL_PEER_CONNECT_TIMEOUT_SEC ""
    kv REPL_RUN_AS_OWNER ""
    kv SYNC_RETRY_DELAYS_SEC ""
    kv SYNC_EXHAUSTED_ACTION ""
    kv SYNC_STUB_FAIL ""
    kv SYNC_COPY_RECHECK_SEC ""
    kv SYNC_COPY_MAX_WAIT_SEC ""
    kv SYNC_EVIDENCE_WAIT_MS ""
    kv REPL_MAX_MARKER_RTT_MS ""
    kv CF_CHECK_SOURCE_ORIGIN "${SRC_ORIGIN:-}"
    kv CF_CHECK_TARGET_ORIGIN "${TGT_ORIGIN:-}"
    # z75-36: 관찰 시간 4초로 고정 (VM 2·4·6초 비교에서 S4 10.4초·최대 대기 4.6초, 대본 문단 3 읽기 32~39초 안). 맥 .env 엔 값이 없어 기본 30초가 된다
    kv TRAFFIC_OBSERVE_SEC "${TRAFFIC_OBSERVE_SEC:-4}"
    kv ONPREM_KUBE_CONTEXT "$ONPREM_KUBE_CONTEXT"
  } > "$ENVF"
  chmod 600 "$ENVF"
  echo "공개 설정 $(grep -c '=' "$ENVF")줄 → $ENVF (.env 는 안 고침)"
}
with_env() { ( set -a; . "$ENVF"; set +a; "$@" ); }
u_vpc() { aws_account_var && run terraform -chdir="$TFA" init -input=false && run terraform -chdir="$TFA" apply -input=false -auto-approve -var create_eks=false; }
u_eks_add() { aws_account_var && run terraform -chdir="$TFA" apply -input=false -auto-approve -var create_eks=true; }
# 워커·API 를 뒤에서 띄우고 smoke(RDS 생성)를 뒤에서 시작한다. 끝은 u_rds_wait 가 기다린다
RDS_PID=""
u_rds_start() {
  local i
  run with_env npm run -s tf:real -- check aws || return 1
  u_workers || return 1
  if [ "$DRY" = 1 ]; then echo "DRY: (뒤에서) npm run -s smoke  onprem → aws, SMOKE_TIMEOUT_MS=1200000" >> "$PROGRESS"; return 0; fi
  tunnel_wait 60 || return 1
  env SMOKE_SOURCE_ENV_ID="${SMOKE_SOURCE_ENV_ID:-55555555-5555-4555-8555-555555555555}" \
    SMOKE_TARGET_ENV_ID="${SMOKE_TARGET_ENV_ID:-22222222-2222-4222-8222-222222222222}" \
    SMOKE_TIMEOUT_MS=1200000 ROLLBACK_WINDOW_SEC=3 npm run -s smoke < /dev/null > "$DEMO_DAY_LOG_DIR/rds-smoke.log" 2>&1 &
  RDS_PID=$!
  echo "$RDS_PID" > "$STATE/smoke.pid"   # UPREV-A: down·다음 up 이 남은 smoke 를 끌 수 있게
  echo "smoke 뒤에서 시작 (pid $RDS_PID, 로그 rds-smoke.log)"
}
u_rds_wait() {
  local rc st
  [ "$DRY" = 1 ] && { echo "DRY: smoke 끝 기다림 → aws rds describe-db-instances 로 available 확인 (smoke 뒷단계 실패는 RDS 가 available 이면 경고)" >> "$PROGRESS"; return 0; }
  [ -n "$RDS_PID" ] || { echo "smoke 가 시작되지 않았다"; return 1; }
  # 9분 넘게 지났으니 터널이 아직 살아 있는지 본다. 끊겼으면 demo-tunnel.sh 가 2초 뒤 다시 붙으므로 60초까지 기다린다
  tunnel_wait 60 || echo "경고: 터널이 안 보인다. demo-tunnel.sh 창을 확인"
  wait "$RDS_PID"; rc=$?
  tail -n 3 "$DEMO_DAY_LOG_DIR/rds-smoke.log"
  st=$(aws rds describe-db-instances --query 'DBInstances[].DBInstanceStatus' --output text 2>/dev/null)
  echo "RDS 상태: ${st:-(없음)} (smoke rc=$rc)"
  echo "$st" | grep -q available || { echo "RDS 가 available 이 아님"; return 1; }
  [ $rc -eq 0 ] && return 0
  # GATE DRAFT(ai): up 의 B4 목적은 RDS 다. smoke 의 뒷단계(복제·트래픽·컷오버 시연)가 실패해도 RDS 가 available 이면 up 은 계속하고 경고로 남긴다
  #   (예전엔 up 전체 FAIL → 자동 down 으로 25분이 날아갔다). DEMO_DAY_STRICT=1 이면 예전처럼 실패
  [ "${DEMO_DAY_STRICT:-0}" = 1 ] && return $rc
  WARNED="$WARNED b4-rds-wait(smoke_rc=$rc)"
  echo "경고: smoke rc=$rc 지만 RDS available → 계속 (로그 rds-smoke.log, DEMO_DAY_STRICT=1 이면 실패)"
  return 0
}
# PF FM-ORC-17: dev:* 는 tsx watch 라 실검증 도중 git checkout·.ts 저장이 워커를 다시 띄우고, 자식 terraform apply·destroy 가 같이 죽어
#   state 밖 고아 자원이 남는다 → 기본은 watch 없는 start:*. 코드를 고치며 돌릴 때만 DEMO_DAY_WATCH=1
d_run_script() { if [ "${DEMO_DAY_WATCH:-}" = 1 ]; then echo "dev:$1"; else echo "start:$1"; fi; }
u_workers() {
  local i
  # FM-ORC-26·FM-APP-hunt-deploy-db-07: 판을 바꾸고 db:migrate 를 잊으면 워커·API 가 시작을 거부한다 → 띄우기 전에 넣는다
  #   (플랫폼 DB 만, 앞으로만 가는 변경. 이미 다 들어갔으면 아무것도 안 함). 끄기 DEMO_DAY_AUTO_MIGRATE=0 → 그땐 남았으면 멈춤
  if [ "$DRY" = 1 ]; then echo "DRY: db:migrate (DEMO_DAY_AUTO_MIGRATE=${DEMO_DAY_AUTO_MIGRATE:-1})" >> "$PROGRESS"
  elif [ "${DEMO_DAY_AUTO_MIGRATE:-1}" = 1 ]; then
    env DB_ADMIN_URL="${OWNER_DATABASE_URL:-$(sed -n 's/^OWNER_DATABASE_URL=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"'")}" sh tools/db-migrate.sh < /dev/null || { echo "db:migrate 실패 → 워커·API 안 띄움 (npm run db:migrate 출력 확인)"; return 1; }
  fi
  if [ "$DRY" = 1 ]; then echo "DRY: MOCK_IAC= GITOPS_DISABLE=1 nohup npm run $(d_run_script worker) / $(d_run_script api) & (PLAN_ACKS=$([ "${DEMO_DAY_PLAN_ACKS:-}" = 1 ] && echo 1 || echo 0))" >> "$PROGRESS"; return 0; fi
  # UPREV-A: 3000 에 이미 API 가 있으면 새 API 는 못 뜨는데 아래 readyz 검사는 옛 API 로 통과해 버린다 → 먼저 막는다
  if curl -sf -m 2 http://localhost:3000/readyz >/dev/null 2>&1; then echo "localhost:3000 에 이미 API 가 떠 있다(옛 회차?). 끄고 다시: bash tools/demo-day.sh down 또는 lsof -ti :3000"; return 1; fi
  ( set -a; . "$ENVF"; set +a; MOCK_IAC= GITOPS_DISABLE=1 \
    nohup npm run "$(d_run_script worker)" < /dev/null > "$DEMO_DAY_LOG_DIR/worker.log" 2>&1 & echo $! > "$STATE/worker.pid" )
  # WEBUP: 발표 화면(8080 컨테이너)이 host.docker.internal 로 붙으므로 IPv4 루프백에 확실히 연다 ("localhost" 는 맥에서 ::1 만 될 수 있음)
  # DEMOFLAGS DRAFT(ai): 계획 승인 확인 항목 게이트(회의 D5)는 기본 꺼둔다. 발표 화면(8080)이 아직 acks 를 안 보내서 켜면 화면 승인이 409 ACKS_MISSING 이다
  #   (notes/impl-1103/WEB-GAPS.md §2). 스크립트(smoke·real-flow)만 쓰는 회차나 화면이 acks 를 보내게 된 뒤엔 DEMO_DAY_PLAN_ACKS=1 로 켠다
  # PF FM-ORC-05: 코드 기본값이 PLAN_ACKS 켬(0 일 때만 끔)으로 바뀌어, 위 "기본 꺼둔다"를 지키려면 0 을 명시해야 한다
  ( env API_HOST=127.0.0.1 ONPREM_KUBE_CONTEXT="$ONPREM_KUBE_CONTEXT" PLAN_ACKS=$([ "${DEMO_DAY_PLAN_ACKS:-}" = 1 ] && echo 1 || echo 0) nohup npm run "$(d_run_script api)" < /dev/null > "$DEMO_DAY_LOG_DIR/api.log" 2>&1 & echo $! > "$STATE/api.pid" )
  # z75-43: 워커 유효 설정 줄(Z81 z81-10)을 10초 안에 본다. .env 에 PROM_URL 이 있으면 코드가 관찰을 최소 30초로 올린다(guards.ts)
  local obs out rc
  obs=$(with_env sh -c 'echo "${TRAFFIC_OBSERVE_SEC:-4}"')
  grep -q "^PROM_URL=." .env 2>/dev/null && obs=$(awk -v o="$obs" 'BEGIN { print (o < 30 ? 30 : o) }')
  out=$(python3 tools/measure/config-expect.py --file "$DEMO_DAY_LOG_DIR/worker.log" --service worker --wait 10 \
    TRAFFIC_OBSERVE_SEC="$obs" GITOPS=off); rc=$?
  echo "$out"
  [ $rc -eq 1 ] && return 1
  for i in $(seq 1 30); do curl -sf -m 2 http://localhost:3000/readyz >/dev/null && return 0; sleep 1; done
  echo "API 가 30초 안에 안 뜸"; return 1
}
# served-by 공개 주소를 B3 파일 끝에 더한다 (기본 순서에선 B3 가 served-by 보다 먼저라서)
# APP-22: 도착 GKE 고정 출구 IP (gcp/env nat_egress_ips = /32 없는 IP 목록). GKE apply 가 끝난 뒤라야 값이 있다 → kubeconfig 다음 단계.
#   워커 환경 파일에 계획 사실 TF_FACT_NAT_EGRESS_IPS_JSON(→ natEgressIpsJson)으로 더한다. 출발 SG 허용은 워커가 /32 를 붙인다.
#   빈 목록이면 실패(컷오버 전 도착 앱이 출발 DB 에 못 붙음). 워커는 다음에 뜰 때 읽는다(real-session worker_env 가 다시 띄움)
u_nat_env() {
  local j
  j=$(tfjson "$TFG" nat_egress_ips) || { echo "gcp/env nat_egress_ips 를 못 읽음"; return 1; }
  j=$(printf '%s' "$j" | tr -d ' \n')
  case "$j" in '[]'|'') echo "도착 GKE 고정 출구 IP 가 비었다 (create_gke=false 이거나 NAT 주소 없음)"; return 1 ;; esac
  # 환경 파일엔 비밀값도 있다 → 임시 파일도 600 (umask 077), 원래 파일은 cat > 로 덮어 권한 그대로
  ( umask 077; grep -v '^TF_FACT_NAT_EGRESS_IPS_JSON=' "$ENVF" > "$ENVF.new" 2>/dev/null; printf "%s='%s'\n" TF_FACT_NAT_EGRESS_IPS_JSON "$j" >> "$ENVF.new" ) || return 1
  cat "$ENVF.new" > "$ENVF" && rm -f "$ENVF.new"
  echo "도착 고정 출구 IP $(printf '%s' "$j" | grep -o '"' | wc -l | awk '{print $1/2}')개 더함"
}
u_cf_env() {
  printf "%s='%s'\n" CF_CHECK_SOURCE_ORIGIN "${SRC_ORIGIN:-}" CF_CHECK_TARGET_ORIGIN "${TGT_ORIGIN:-}" >> "$ENVF"
  echo "CF 오리진 2줄 더함"
}
# z75-37: 발표 직전 예열. 8080(nginx)을 거쳐 API 까지 데운다
u_warm() {
  local i h="x-dev-tenant: 11111111-1111-4111-8111-111111111111" f
  [ "$DRY" = 1 ] && { echo "DRY: 8080 / 1번, 8080/api/healthz·environments·migrations 3번씩" >> "$PROGRESS"; return 0; }
  curl -s -m 5 -o /dev/null http://localhost:8080/
  for i in 1 2 3; do
    curl -s -m 5 -o /dev/null http://localhost:8080/api/healthz
    curl -s -m 5 -o /dev/null http://localhost:8080/api/environments -H "$h"
    curl -s -m 5 -o /dev/null http://localhost:8080/api/migrations -H "$h"
  done
  f=$(curl -s -m 5 -o /dev/null -w '%{time_total}' http://localhost:8080/api/healthz | awk '{ printf "%d", $1 * 1000 }')
  echo "예열 뒤 첫 요청 ${f}ms (기준 ≤200)"
  [ "${f:-999}" -le 200 ]
}
# --serial 용: B4 를 앞에서 끝까지
u_rds() {
  run with_env npm run -s tf:real -- check aws || return 1
  u_workers || return 1
  run env SMOKE_SOURCE_ENV_ID="${SMOKE_SOURCE_ENV_ID:-55555555-5555-4555-8555-555555555555}" \
    SMOKE_TARGET_ENV_ID="${SMOKE_TARGET_ENV_ID:-22222222-2222-4222-8222-222222222222}" \
    SMOKE_TIMEOUT_MS=1200000 ROLLBACK_WINDOW_SEC=3 npm run -s smoke || return 1
  [ "$DRY" = 1 ] && return 0
  local st
  st=$(aws rds describe-db-instances --query 'DBInstances[].DBInstanceStatus' --output text 2>/dev/null)
  echo "RDS 상태: ${st:-(없음)}"
  echo "$st" | grep -q available
}
# WEBUP: 발표 화면 8080(svc-prod web)을 이 회차 api(호스트 3000 = 호스트 DB 5432)에 붙인다.
#   예전엔 svc-prod 묶음의 api(3300)·자기 DB 에 붙어 실회차 이전이 화면에 안 보였다. svc-prod api·워커는 멈춘다(같은 화면에 두 DB 가 섞이지 않게)
WEB_UPSTREAM=http://host.docker.internal:3000
u_web() {
  local id up code
  [ "$DRY" = 1 ] && { echo "DRY: svc-prod api·worker·agent-worker 멈춤, WEB_API_UPSTREAM=$WEB_UPSTREAM 로 web 만 다시 띄움, 8080/api/readyz 200 확인" >> "$PROGRESS"; return 0; }
  docker compose -f docker-compose.prod.yml stop api worker agent-worker >/dev/null 2>&1 || true
  WEB_API_UPSTREAM=$WEB_UPSTREAM run docker compose -f docker-compose.prod.yml up -d --no-deps --pull never --wait web || { echo "web 컨테이너 못 띄움 (이미지가 없으면: IMAGE_PREFIX= IMAGE_TAG=dev docker compose -f docker-compose.prod.yml build web)"; return 1; }
  id=$(docker compose -f docker-compose.prod.yml ps -q web 2>/dev/null)
  up=$(docker inspect "$id" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^API_UPSTREAM=//p')
  [ "$up" = "$WEB_UPSTREAM" ] || { echo "web 의 API_UPSTREAM 이 '$up' (기대 $WEB_UPSTREAM)"; return 1; }
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:8080/api/readyz)
  [ "$code" = 200 ] || { echo "8080/api/readyz → $code (화면이 호스트 api 3000 에 못 닿음)"; return 1; }
  echo "발표 화면 8080 → 호스트 api 3000 (같은 DB) OK"
}
u_preflight() {
  local rc=0
  u_web || rc=1
  if grep -q '"demo:preflight"' package.json; then run with_env npm run -s demo:preflight || rc=1; else echo "SKIP (demo:preflight 없음, 6차 z75-22 부터)"; fi
  # z75-38: 발표 화면은 운영 빌드 8080 하나만. 8080 이 안 뜨면 실패, 개발 화면 5173 이 같이 떠 있으면 잘못 띄울 수 있으니 경고
  if [ "$DRY" = 1 ]; then echo "DRY: 8080 응답 200 확인, 5173 떠 있으면 경고" >> "$PROGRESS"; return $rc; fi
  if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:8080/)" = 200 ]; then echo "발표 화면 OK http://localhost:8080 (운영 빌드)"
  else echo "발표 화면 FAIL: 8080 응답 없음 (docker compose -f docker-compose.prod.yml up -d --wait)"; rc=1; fi
  if curl -s -m 2 -o /dev/null http://localhost:5173/; then echo "경고: 개발 화면 5173 도 떠 있다. 발표는 8080 만 연다"; fi
  return $rc
}

# AUTHSMOKE: 실회차 smoke(RDS 이전)는 데모 계정으로 로그인한다. API 는 DEV_AUTH 없이 뜬다(x-dev-tenant 는 시험 전용, auth/settings.ts 팀 결정)
#   → apply 전에 데모 계정 비밀번호를 플랫폼 DB 에 넣어 둔다. .env 에 DEMO_USER_PASSWORD 가 있으면 그 값으로 맞추고(화면 로그인과 같은 값),
#   없으면 auth:seed 가 무작위 값을 .secrets/demo-login.txt(600)에만 쓴다. smoke·env:connect 는 같은 순서로 비밀번호를 찾는다
u_login() {
  local envpw=0 force=1
  grep -qE '^DEMO_USER_PASSWORD=.+' .env 2>/dev/null && envpw=1
  [ "$envpw" = 0 ] && [ -s .secrets/demo-login.txt ] && force=0
  if [ "$DRY" = 1 ]; then echo "DRY: AUTH_SEED_FORCE=$force npm run -s auth:seed (데모 계정 비밀번호, .env 값=$envpw)" >> "$PROGRESS"; return 0; fi
  AUTH_SEED_FORCE=$([ "$force" = 1 ] && echo 1) npm run -s auth:seed || { echo "auth:seed 실패 (플랫폼 DB·OWNER_DATABASE_URL 확인)"; return 1; }
  [ "$envpw" = 1 ] || [ -s .secrets/demo-login.txt ] || { echo "데모 계정 비밀번호를 찾을 곳이 없다 (.env DEMO_USER_PASSWORD 또는 .secrets/demo-login.txt)"; return 1; }
  echo "데모 계정 로그인 준비 OK (smoke 는 로그인으로 인증)"
}
# ENVPASS: apply 전에 온프레 출발 컨텍스트가 있고 닿는지 본다 (없으면 smoke 의 가져오기가 클러스터·RDS 를 다 만든 뒤 실패)
u_onprem_ctx() {
  if [ "$DRY" = 1 ]; then echo "DRY: 온프레 컨텍스트 ${ONPREM_KUBE_CONTEXT:-(못 찾음)} 확인" >> "$PROGRESS"; return 0; fi
  [ -n "$ONPREM_KUBE_CONTEXT" ] || { echo "온프레 출발 kube 컨텍스트를 못 찾음 (kubectl config get-contexts 에 k3s-onprem 이 있어야 함. 다르면 .env ONPREM_KUBE_CONTEXT=<이름>)"; return 1; }
  kubectl config get-contexts -o name 2>/dev/null | grep -qx "$ONPREM_KUBE_CONTEXT" || { echo "kubeconfig 에 컨텍스트 $ONPREM_KUBE_CONTEXT 없음"; return 1; }
  kubectl --context "$ONPREM_KUBE_CONTEXT" --request-timeout=10s get nodes >/dev/null 2>&1 || { echo "컨텍스트 $ONPREM_KUBE_CONTEXT 에 못 닿음 (k3d 클러스터가 꺼졌나: k3d cluster list)"; return 1; }
  echo "온프레 출발 컨텍스트 OK: $ONPREM_KUBE_CONTEXT (워커·API·실세션에 넘김)"
}

do_up() {
  local gpid grc
  log "up 시작 (겹치기 순서) dry=$DRY profile=$AWS_PROFILE gcp=$GCP_PROJECT 도착=$GCP_TARGET eks=$EKS_CONTEXT gke=$GKE_CONTEXT"
  mkdir -p "$STATE" && chmod 700 "$STATE"
  # 지난 회차 중계기 IP·호스트 키·프로세스를 치움 → demo-tunnel 은 이번 up 이 relay_ip 를 새로 적을 때까지 기다린다
  step stale u_stale || abort "지난 회차 정리 실패"
  # GATE: 점검 FAIL 줄을 진행 파일에도 옮긴다 (Jeong 은 progress.log 만 본다 → 원인을 바로 보게)
  step tools u_tools || { grep -E '^(FAIL|없는 도구|플랫폼 DB|~/.ssh)' "$DEMO_DAY_LOG_DIR/tools.log" 2>/dev/null | tee -a "$PROGRESS"; abort "시작 점검 실패 (위 FAIL 줄, 자세한 건 tools.log)"; }
  step login u_login || abort "데모 계정 로그인 준비 실패 (smoke 가 401 로 멈춘다)"
  step onprem-ctx u_onprem_ctx || abort "온프레 출발 컨텍스트 없음 (가져오기가 context was not found 로 멈춘다)"
  APPLIED=1
  step gke-apply u_gke & gpid=$!; BGPIDS=$gpid
  step vpc-apply u_vpc || abort "aws/env (EKS 없이) apply 실패"
  step b1-facts u_facts || abort "B1 실패"
  step b2-relay u_relay || abort "B2 중계기·터널 실패"
  step b3-env u_envfile || abort "B3 실패"
  step b4-rds-start u_rds_start || abort "B4 시작 실패"
  step eks-add u_eks_add || abort "EKS 더하기 실패"
  wait $gpid; grc=$?; BGPIDS=""
  [ $grc -eq 0 ] || { FAILED="$FAILED gke-apply"; abort "GKE apply 실패"; }
  step kubeconfig u_kubeconfig || abort "kubeconfig 실패"
  step nat-env u_nat_env || abort "도착 고정 출구 IP 실패"
  step served-by u_served_by || abort "served-by 실패"
  step cf-env u_cf_env
  step b4-rds-wait u_rds_wait || abort "B4 RDS 실패"
  step_soft preflight u_preflight
  step_soft warmup u_warm
  finish
}

do_up_serial() {
  log "up 시작 (예전 순서) dry=$DRY profile=$AWS_PROFILE gcp=$GCP_PROJECT 도착=$GCP_TARGET eks=$EKS_CONTEXT gke=$GKE_CONTEXT"
  mkdir -p "$STATE" && chmod 700 "$STATE"
  step stale u_stale || abort "지난 회차 정리 실패"
  step tools u_tools || { grep -E '^(FAIL|없는 도구|플랫폼 DB|~/.ssh)' "$DEMO_DAY_LOG_DIR/tools.log" 2>/dev/null | tee -a "$PROGRESS"; abort "시작 점검 실패 (위 FAIL 줄, 자세한 건 tools.log)"; }
  step login u_login || abort "데모 계정 로그인 준비 실패 (smoke 가 401 로 멈춘다)"
  step onprem-ctx u_onprem_ctx || abort "온프레 출발 컨텍스트 없음 (가져오기가 context was not found 로 멈춘다)"
  APPLIED=1
  par gke-apply u_gke eks-apply u_eks || abort "클러스터 apply 실패"
  step kubeconfig u_kubeconfig || abort "kubeconfig 실패"
  step nat-env u_nat_env || abort "도착 고정 출구 IP 실패"
  # 아래 셋은 변수를 다음 단계로 넘기므로 하위 셸 없이 부른다 (출력은 단계 로그로)
  log "step=served-by start"; t=$(now_s); u_served_by >> "$DEMO_DAY_LOG_DIR/served-by.log" 2>&1; rc=$?; log "step=served-by end rc=$rc sec=$(( $(now_s) - t ))"; [ $rc -eq 0 ] || { FAILED="$FAILED served-by"; abort "served-by 실패"; }
  log "step=b1-facts start"; t=$(now_s); u_facts >> "$DEMO_DAY_LOG_DIR/b1-facts.log" 2>&1; rc=$?; log "step=b1-facts end rc=$rc sec=$(( $(now_s) - t ))"; [ $rc -eq 0 ] || { FAILED="$FAILED b1-facts"; abort "B1 실패"; }
  log "step=b2-relay start"; t=$(now_s); u_relay >> "$DEMO_DAY_LOG_DIR/b2-relay.log" 2>&1; rc=$?; log "step=b2-relay end rc=$rc sec=$(( $(now_s) - t ))"; [ $rc -eq 0 ] || { FAILED="$FAILED b2-relay"; abort "B2 중계기·터널 실패"; }
  step b3-env u_envfile || abort "B3 실패"
  step b4-rds u_rds || abort "B4 RDS 실패"
  step_soft preflight u_preflight
  step_soft warmup u_warm
  finish
}

# ---------------- down ----------------
# GATE: 두 클러스터를 동시에 (apply-served-by down 은 이제 --timeout=300s 라 최악 5분씩). 실패해도 넘어간다: 남은 LB 는 aws_orphans·gcp_orphans 가 API 로 지운다
d_served_by() {
  local p1 p2
  run bash deploy/cloud-demo/apply-served-by.sh down "$EKS_CONTEXT" & p1=$!
  run bash deploy/cloud-demo/apply-served-by.sh down "$GKE_CONTEXT" & p2=$!
  wait $p1; wait $p2
  return 0
}
d_elb_zero() {
  local vpc i n
  [ "$DRY" = 1 ] && { echo "DRY: ELB 0 확인" >> "$PROGRESS"; return 0; }
  vpc=$(terraform -chdir="$TFA" output -raw vpc_id 2>/dev/null)
  [ -n "$vpc" ] || { echo "aws/env 에 vpc 없음 → ELB 확인 생략"; return 0; }
  # Z38 R8-28: 조회가 실패하면 0 으로 치지 않는다
  local a b
  # UPREV-B: k8s LB 가 사라지는 데 보통 1~4분 → 기본 5분 (ELB_ZERO_WAIT_SEC). 180초는 짧아 VPC 삭제가 ENI 에 막혔다
  local tries=$(( ${ELB_ZERO_WAIT_SEC:-300} / 5 ))
  [ "$tries" -ge 1 ] || tries=1
  for i in $(seq 1 "$tries"); do
    a=$(aws elb describe-load-balancers --query "length(LoadBalancerDescriptions[?VPCId=='$vpc'])" --output text 2>/dev/null) || { echo "ELB 조회 실패 (classic)"; return 1; }
    b=$(aws elbv2 describe-load-balancers --query "length(LoadBalancers[?VpcId=='$vpc'])" --output text 2>/dev/null) || { echo "ELB 조회 실패 (v2)"; return 1; }
    n=$((a + b))
    [ "$n" -eq 0 ] && { echo "ELB 0 (${i}번째 확인)"; return 0; }
    sleep 5
  done
  echo "ELB $n 개 남음 (${ELB_ZERO_WAIT_SEC:-300}초)"; return 1
}
# npm run 은 아래에 sh·tsx·node 를 띄운다. 맨 위 pid 만 끄면 워커가 살아남아 작업을 계속 집는다. 자식부터 끈다
# PF FM-CLD-15·FM-ORC-14: 가장 깊은 자식부터 끄면 terraform 아래 provider 플러그인이 terraform 보다 먼저 죽어, 만들던 RDS·Cloud SQL 이 state 밖 고아가 됐다.
#   terraform 을 만나면 그 아래로 내려가지 않고 terraform 에만 INT (새 자원 시작 안 함 + 진행 중 것 끝내고 state 씀). 끝은 아래 tf_wait_idle 이 기다린다
killtree() {
  local c n; n=$(ps -p "$1" -o comm= 2>/dev/null)
  case "$n" in *terraform) kill -INT "$1" 2>/dev/null; echo "terraform pid $1 에 INT 만 (provider 는 안 건드림, state 를 쓰고 끝나게)"; return 0 ;; esac
  for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null; return 0
}
# UPREV-A: pid 파일의 pid 가 재사용돼 남의 프로세스일 수 있다(맥 pid 는 돈다) → 우리가 띄운 종류(npm·node·tsx·터널·ssh)일 때만 끈다
proc_ours() { local c; c=$(ps -p "$1" -o command= 2>/dev/null) || return 1; case "$c" in *npm*|*node*|*tsx*|*demo-tunnel*|*ssh*) return 0 ;; esac; return 1; }
# STUCKLOCK: 이 회차에서 멈춘 이전(paused·failed·rolling_back)을 정식 API 길로 닫는다 → 환경 잠금이 풀려 다음 up 승인이 409 ENV_BUSY 로 안 막힌다.
#   api·worker 가 아직 떠 있을 때(procs 전) 부른다. paused 는 rollback 작업이 돌아야 끝나기 때문.
#   DRAFT(ai): failed 는 cancel {manualCleanupConfirmed:true} 로 닫는다. 이 뒤 down 이 자원을 지우고 cloud-zero 가 0 을 확인하는 것을
#   "수동 정리 확인"으로 본다 (cloud-zero 가 FAIL 이면 그 줄을 보고 사람이 남은 자원을 치운다). 대안 "잠금 청소 대상에 paused·failed 추가"는 버림:
#   반쯤 만든 자원이 있을 수 있어 사람이 보라고 남긴 잠금이다 (packages/core/src/envlock.ts).
#   api 가 이미 없으면(두 번째 down 등) 실패로 치지 않고 손 명령만 알린다
d_close_stuck() {
  if [ "$DRY" = 1 ]; then echo "DRY: npx tsx tools/close-stuck.ts" >> "$PROGRESS"; return 0; fi
  local rc
  [ -d node_modules ] && curl -fs -m 3 -o /dev/null "http://localhost:${API_PORT:-3000}/healthz" || { echo "api 가 없어 못 닫음 → api·worker 를 띄운 뒤 손으로: npx tsx tools/close-stuck.ts"; return 0; }
  env API_PORT="${API_PORT:-3000}" npx tsx tools/close-stuck.ts < /dev/null; rc=$?
  [ $rc -eq 2 ] && { echo "api 가 없어 못 닫음 → api·worker 를 띄운 뒤 손으로: npx tsx tools/close-stuck.ts"; return 0; }
  return $rc
}
d_procs() {
  local f pid
  for f in worker api tunnel smoke; do
    [ -f "$STATE/$f.pid" ] || continue
    pid=$(cat "$STATE/$f.pid")
    if [ -n "$pid" ] && proc_ours "$pid"; then run killtree "$pid"; else echo "$f pid ${pid:-?} 는 이미 끝났거나 우리 프로세스가 아님 → 건너뜀"; fi
    [ "$DRY" = 1 ] || rm -f "$STATE/$f.pid"
  done
  # FM-ORC-22: pid 파일 밖에 남은 워커(npm 만 꺼져 고아가 된 node·tsx, 지표 포트 9465~ LISTEN, cwd */apps/worker)도 트리째 끈다 (pkill -f 안 씀)
  local left
  . tools/proc-leftovers.sh
  left=$(pl_workers | tr '\n' ' ')
  if [ -n "${left% }" ]; then
    if [ "$DRY" = 1 ]; then echo "DRY: 남은 워커 pid ${left% } 를 트리째 끔" >> "$PROGRESS"
    else echo "남은 워커 pid ${left% } (pid 파일 밖) → 트리째 끔"; pl_kill $left; fi
  fi
  return 0
}
# GATE: 다른 terraform(끊긴 smoke 의 apply — TERM 을 받아도 만들던 자원은 끝까지 만들고 state 에 적는다)이 끝날 때까지 기다린다.
#   안 기다리면 destroy 가 state 잠금에 60초 막혀 실패하고, 만들던 RDS 는 state 밖 고아가 된다
tf_wait_idle() {
  local i max=$(( ${TF_WAIT_SEC:-900} / 15 ))
  for i in $(seq 1 "$max"); do
    pgrep -x terraform >/dev/null 2>&1 || return 0
    [ "$i" -eq 1 ] && echo "다른 terraform 이 아직 돈다 (끊긴 smoke 의 apply?) → 끝날 때까지 최대 ${TF_WAIT_SEC:-900}초 기다림"
    sleep 15
  done
  echo "terraform 이 ${TF_WAIT_SEC:-900}초 안에 안 끝남 → 그대로 destroy 시도"; return 1
}
# 이전별 작업 폴더(tf:real list) 중 state 에 자원이 남은 것만 destroy.
#   GATE: 목록 줄은 "<이전 id>  <회사>  <환경>  state 자원 N개  <폴더>" (tools/tf-real.ts) → 4번째 칸이 state, 6번째가 N개.
#   예전 awk($3·$5)는 이 모양과 안 맞아 한 줄도 안 골랐다 → RDS 를 영영 안 지워 cloud-zero 가 RDS 1 로 FAIL 하게 돼 있었다.
#   잠금 파일만 남은 폴더(끊긴 apply)는 도는 terraform 이 없을 때 치운다. destroy 는 60초 간격 3번
d_migration_tf() {
  local rows ids id rc=0 i dir lock
  if [ "$DRY" = 1 ]; then echo "DRY: npm run tf:real -- list → state 자원 >0 인 이전마다 npm run tf:real -- destroy <id> (60초 간격 3번)" >> "$PROGRESS"; return 0; fi
  # UPREV-B: 목록 조회가 실패하면(DB 가 꺼진 재실행 등) 예전엔 조용히 "할 것 없음" 으로 지나갔다. 알리고 넘어간다 — 남은 자원은 마지막 cloud-zero 가 잡는다
  if ! rows=$(npm run -s tf:real -- list); then echo "이전별 terraform 목록 조회 실패 → 이 단계는 건너뜀 (남은 자원은 cloud-zero 가 판정)"; return 0; fi
  ids=$(printf '%s\n' "$rows" | awk '$4 == "state" && $5 == "자원" && $6 != "0개" { print $1 }')
  [ -n "$ids" ] || { echo "state 에 자원이 남은 이전 없음"; return 0; }
  echo "destroy 할 이전: $(echo $ids | tr '\n' ' ')"
  tf_wait_idle || true
  # GATE-aws: 끊긴 smoke 의 RDS 가 아직 creating·backing-up 이면 destroy 가 InvalidDBInstanceState 로 실패할 수 있다 → 그 상태가 끝날 때까지
  rds_settle || true
  for id in $ids; do
    dir=$(printf '%s\n' "$rows" | awk -v id="$id" '$1 == id { print $NF }')
    if ! pgrep -x terraform >/dev/null 2>&1; then
      for lock in "$dir/.terraform.tfstate.lock.info" "$dir/root/.terraform.tfstate.lock.info"; do [ -f "$lock" ] && { echo "남은 잠금 파일 치움: $lock"; rm -f "$lock"; }; done
    fi
    for i in 1 2 3; do
      npm run -s tf:real -- destroy "$id" && break
      if [ "$i" -lt 3 ]; then echo "destroy $id ${i}번째 실패 → 60초 뒤 다시"; sleep 60; else rc=1; fi
    done
  done
  return $rc
}
# GATE-v1: 실세션 connect 가 만든 연결 스택(svc-connect-<환경 8자>; 역할 svc-observe·svc-operate 는 고정 이름) — 남으면 다음 회차 connect 가
#   "already exists"·ExternalId 불일치로 실패한다. 스택으로 만든 것만 지운다(스택 밖 역할은 손으로). 안에는 IAM 역할·정책·EKS 접근 항목뿐이라 요금 없음, 1분 안쪽.
#   EKS 접근 항목이 들어 있어 eks-destroy 보다 먼저 지운다. DEMO_DAY_CONNECT_STACK=0 이면 건너뜀(연결을 남겨 두고 싶을 때)
d_connect_stack() {
  local r s stacks="" rc=0
  [ "${DEMO_DAY_CONNECT_STACK:-1}" = 1 ] || { echo "DEMO_DAY_CONNECT_STACK=0 → 연결 스택은 안 지움"; return 0; }
  if [ "$DRY" = 1 ]; then echo "DRY: aws cloudformation describe-stack-resources --physical-resource-id svc-observe|svc-operate + describe-stacks svc-connect-* → delete-stack → wait stack-delete-complete" >> "$PROGRESS"; return 0; fi
  for r in svc-observe svc-operate; do
    s=$(aws cloudformation describe-stack-resources --physical-resource-id "$r" --query 'StackResources[0].StackName' --output text 2>/dev/null)
    case "$s" in ''|None) ;; *) case " $stacks " in *" $s "*) ;; *) stacks="$stacks $s" ;; esac ;; esac
  done
  # RV-04: 만들다 실패해 되돌린 스택(ROLLBACK_COMPLETE·CREATE_FAILED 등)은 역할이 없어 위 조회로 안 잡힌다. cloud-zero 는 이름(svc-connect-*)으로 세므로
  #   같은 기준으로 한 번 더 모은다 (지워진 스택은 describe-stacks 에 안 나옴)
  for s in $(aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'svc-connect-')].StackName" --output text 2>/dev/null); do
    case "$s" in ''|None) ;; *) case " $stacks " in *" $s "*) ;; *) stacks="$stacks $s" ;; esac ;; esac
  done
  [ -n "$stacks" ] || { echo "연결 스택 없음"; return 0; }
  for s in $stacks; do echo "연결 스택 지움: $s"; aws cloudformation delete-stack --stack-name "$s" >/dev/null 2>&1 || { echo "  delete-stack 실패 (콘솔에서 확인)"; rc=1; }; done
  for s in $stacks; do
    if aws cloudformation wait stack-delete-complete --stack-name "$s" >/dev/null 2>&1; then echo "  $s 지워짐"
    else echo "  $s 삭제 완료를 못 확인 (DELETE_FAILED 면 콘솔에서 남은 자원 확인) → cloud-zero 가 판정"; rc=1; fi
  done
  return $rc
}
# HUNT-CLD-01: GCP 쪽 연결 정리 — 플랫폼 회사 전용 SA(t-*)와 그 SA 를 주체로 한 바인딩 (AWS connect-stack 과 짝). 고객 SA(svc-*)·커스텀 역할은 남긴다
#   (역할은 지우면 같은 ID 를 37일 못 만듦). 이전별 destroy(빌린 SA 를 쓸 수 있음) 뒤에 돈다. DEMO_DAY_CONNECT_STACK=0 이면 건너뜀
#   다음 회차: gcp-platform-tenant-sa.sh → gcp-connect.sh 를 다시 돌려야 빌리기가 된다
d_connect_gcp() {
  [ "${DEMO_DAY_CONNECT_STACK:-1}" = 1 ] || { echo "DEMO_DAY_CONNECT_STACK=0 → 회사 전용 SA 는 안 지움"; return 0; }
  run env GCP_PROJECT="$GCP_PROJECT" bash tools/gcp-tenant-sa.sh purge
}
d_relay() { tf_has_state "$TFR" || return 0
  # Z38 R8-27: 모듈의 data "aws_vpc" 가 destroy 때도 vpc_id 를 읽는다 → 아직 살아 있는 env 의 진짜 값을 넘긴다 (나머지는 쓰지 않는 자리값)
  local vpc
  if ! vpc=$(tfout "$TFA" vpc_id) || [ -z "$vpc" ]; then
    # UPREV-B: 재실행에서 env 가 이미 지워졌으면 vpc_id 가 없다. 중계기 상태에 남은 게 없으면 이미 지운 것 → 성공 (예전엔 늘 실패라 재실행이 영영 FAIL)
    if [ -z "$(terraform -chdir="$TFR" state list 2>/dev/null)" ]; then echo "중계기 상태 비어 있음 → 이미 지움"; return 0; fi
    echo "aws/env 출력 vpc_id 없음 → 중계기 destroy 를 못 함 (env 보다 먼저 지워야 한다)"; return 1
  fi
  run terraform -chdir="$TFR" destroy -input=false -auto-approve -var "vpc_id=$vpc" -var public_subnet_id=x -var ssh_public_key=x -var 'ssh_cidrs_json=["127.0.0.1/32"]'; }
# GATE-aws: RDS 가 지울 수 있는 상태가 될 때까지 (만드는 중·백업 중·바꾸는 중이면 기다림). $1 = VPC(비우면 리전 전체). RDS_WAIT_SEC(기본 1200) 20초 간격
#   새 RDS 는 available 직후 첫 백업(backing-up)도 한다. deleting·available·failed·stopped·storage-optimization 은 기다리지 않는다
RDS_BUSY='creating backing-up modifying rebooting starting stopping upgrading renaming resetting-master-credentials maintenance configuring-enhanced-monitoring configuring-iam-database-auth configuring-log-exports moving-to-vpc converting-to-vpc'
rds_busy() { # $1 = VPC(선택). 바쁜 RDS "이름=상태" 목록. 조회 실패면 1
  local q='DBInstances[].[DBInstanceIdentifier,DBInstanceStatus]' out id st b
  [ -n "${1:-}" ] && q="DBInstances[?DBSubnetGroup.VpcId=='$1'].[DBInstanceIdentifier,DBInstanceStatus]"
  out=$(aws rds describe-db-instances --query "$q" --output text 2>/dev/null) || return 1
  printf '%s\n' "$out" | while read -r id st; do [ -n "$id" ] || continue; for b in $RDS_BUSY; do [ "$st" = "$b" ] && echo "$id=$st"; done; done
  return 0   # (위 반복의 마지막 비교가 거짓이면 rc 1 이 되어 "조회 실패" 로 읽히던 것 — moto 시험에서 잡음)
}
rds_settle() {
  local i busy max=$(( ${RDS_WAIT_SEC:-1200} / 20 ))
  [ "$DRY" = 1 ] && return 0
  for i in $(seq 1 "$max"); do
    busy=$(rds_busy "${1:-}") || { echo "RDS 상태 조회 실패 → 기다리지 않고 지우기 시도"; return 1; }
    [ -z "$busy" ] && { [ "$i" -gt 1 ] && echo "RDS 지울 수 있는 상태 ($(( (i - 1) * 20 ))초 기다림)"; return 0; }
    [ "$i" -eq 1 ] && echo "RDS 가 아직 바쁨: $(echo $busy | tr '\n' ' ') → 지울 수 있을 때까지 최대 ${RDS_WAIT_SEC:-1200}초"
    sleep 20
  done
  echo "RDS 가 ${RDS_WAIT_SEC:-1200}초 뒤에도 바쁨: $(echo $busy | tr '\n' ' ') → 그대로 지우기 시도"; return 1
}
# GATE-aws: terraform state 밖에 남은 RDS (smoke 의 terraform 이 강제로 끊겨 state 에 못 적었거나, tf:real 목록 조회 실패로 이전별 destroy 를 건너뜀).
#   env VPC 안의 RDS 는 어차피 지워야 VPC·서브넷이 지워진다 → 그 VPC 의 것만 API 로 지운다(마지막 스냅숏 없음, 자동 백업도 지움) → 지워질 때까지 기다림.
#   그다음 그 VPC 의 DB 서브넷 그룹, 태그 managed-by=platform 인 파라미터 그룹(이 VPC 의 RDS 가 0 일 때만)
aws_rds_orphans() {
  local vpc=$1 ids id g pg i n
  [ -n "$vpc" ] || return 0
  ids=$(aws rds describe-db-instances --query "DBInstances[?DBSubnetGroup.VpcId=='$vpc' && DBInstanceStatus!='deleting'].DBInstanceIdentifier" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$' | grep -v '^[[:space:]]*$')
  if [ -n "$ids" ]; then
    rds_settle "$vpc" || true
    for id in $ids; do
      echo "state 밖 RDS 지움: $id"
      # 삭제 보호가 켜진 것은 끔(데모 VPC 안의 것만 여기 온다)
      aws rds modify-db-instance --db-instance-identifier "$id" --no-deletion-protection --apply-immediately >/dev/null 2>&1 || true
      aws rds delete-db-instance --db-instance-identifier "$id" --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1 || echo "  delete-db-instance 실패 (다음 시도)"
    done
  fi
  # deleting 인 것까지 사라질 때까지 (보통 3~6분, 최대 15분)
  for i in $(seq 1 45); do
    n=$(aws rds describe-db-instances --query "length(DBInstances[?DBSubnetGroup.VpcId=='$vpc'])" --output text 2>/dev/null) || break
    [ "$n" = 0 ] && break
    [ "$i" -eq 1 ] && echo "VPC 안 RDS ${n}개가 지워지기를 기다림 (최대 900초)"
    sleep 20
  done
  [ "${n:-0}" = 0 ] || { echo "VPC 안 RDS 가 아직 ${n}개 → 서브넷 그룹은 다음 시도"; return 0; }
  for g in $(aws rds describe-db-subnet-groups --query "DBSubnetGroups[?VpcId=='$vpc'].DBSubnetGroupName" --output text 2>/dev/null | tr '\t' '\n'); do
    [ "$g" = None ] && continue; echo "state 밖 DB 서브넷 그룹 지움: $g"; aws rds delete-db-subnet-group --db-subnet-group-name "$g" >/dev/null 2>&1 || true
  done
  # 파라미터 그룹은 VPC 가 없다 → 기본(default.*) 아닌 것 중 태그 managed-by=platform 인 것만 (태그는 그룹마다 직접 조회)
  for pg in $(aws rds describe-db-parameter-groups --query "DBParameterGroups[?!starts_with(DBParameterGroupName, 'default.')].DBParameterGroupArn" --output text 2>/dev/null | tr '\t' '\n'); do
    [ "$pg" = None ] && continue
    [ "$(aws rds list-tags-for-resource --resource-name "$pg" --query "length(TagList[?Key=='managed-by' && Value=='platform'])" --output text 2>/dev/null)" = 1 ] || continue
    echo "state 밖 DB 파라미터 그룹 지움: ${pg##*:}"; aws rds delete-db-parameter-group --db-parameter-group-name "${pg##*:}" >/dev/null 2>&1 || true
  done
  return 0
}
# GATE-aws: destroy 가 한 번 실패한 뒤(클러스터·노드·RDS 가 지워진 뒤)에만: VPC 안의 기본 아닌 보안 그룹 전부와 떠 있는(available) ENI.
#   aws/env 모듈은 보안 그룹을 만들지 않는다(EKS 클러스터 SG 는 EKS 가 스스로 지움) → 남은 SG 는 RDS·중계기·k8s 가 남긴 고아.
#   서로 참조하는 규칙이 있으면 못 지우니 먼저 규칙을 비운다
aws_vpc_sweep() {
  local vpc=$1 sg eni pj
  [ -n "$vpc" ] || return 0
  pj=$(mktemp "${TMPDIR:-/tmp}/sg-perm.XXXXXX")
  for eni in $(aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$vpc" Name=status,Values=available --query 'NetworkInterfaces[].NetworkInterfaceId' --output text 2>/dev/null | tr '\t' '\n'); do
    [ "$eni" = None ] && continue; echo "떠 있는 ENI 지움: $eni"; aws ec2 delete-network-interface --network-interface-id "$eni" >/dev/null 2>&1 || true
  done
  for sg in $(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null | tr '\t' '\n'); do
    [ "$sg" = None ] && continue
    aws ec2 describe-security-groups --group-ids "$sg" --query 'SecurityGroups[0].IpPermissions' --output json 2>/dev/null > "$pj" &&
      [ "$(tr -d '[:space:]' < "$pj")" != "[]" ] && aws ec2 revoke-security-group-ingress --group-id "$sg" --ip-permissions "file://$pj" >/dev/null 2>&1
  done
  for sg in $(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null | tr '\t' '\n'); do
    [ "$sg" = None ] && continue; echo "남은 보안 그룹 지움: $sg"; aws ec2 delete-security-group --group-id "$sg" >/dev/null 2>&1 || echo "  (아직 쓰는 중 → 다음 시도)"
  done
  rm -f "$pj"
  return 0
}
# GATE: served-by(Service LoadBalancer)가 안 지워진 채 destroy 하면 ELB 와 k8s-elb-* 보안 그룹이 서브넷·VPC 삭제를 막는다
#   (kubectl 이 안 될 때 — 플러그인·컨텍스트 없음). terraform state 밖 자원이라 API 로 직접 지운 뒤 destroy 를 다시 한다 (최대 3번)
aws_orphans() {
  local vpc=$1 n a i sg
  [ -n "$vpc" ] || return 0
  for n in $(aws elb describe-load-balancers --query "LoadBalancerDescriptions[?VPCId=='$vpc'].LoadBalancerName" --output text 2>/dev/null | tr '\t' '\n'); do
    [ "$n" = None ] && continue; echo "고아 클래식 ELB 지움: $n"; aws elb delete-load-balancer --load-balancer-name "$n" >/dev/null 2>&1 || true
  done
  for a in $(aws elbv2 describe-load-balancers --query "LoadBalancers[?VpcId=='$vpc'].LoadBalancerArn" --output text 2>/dev/null | tr '\t' '\n'); do
    [ "$a" = None ] && continue; echo "고아 ALB/NLB 지움: ${a##*/}"; aws elbv2 delete-load-balancer --load-balancer-arn "$a" >/dev/null 2>&1 || true
  done
  # ELB 가 쥐고 있던 ENI 가 풀릴 때까지 (최대 5분)
  for i in $(seq 1 30); do
    n=$(aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$vpc" "Name=description,Values=ELB *" --query 'length(NetworkInterfaces)' --output text 2>/dev/null)
    [ "${n:-0}" = 0 ] && break; sleep 10
  done
  # k8s 가 만든 보안 그룹(k8s-elb-*). 다른 그룹이 아직 참조하면 못 지우니 실패는 넘긴다 (클러스터가 지워진 다음 시도에서 된다)
  for sg in $(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" "Name=group-name,Values=k8s-*" --query 'SecurityGroups[].GroupId' --output text 2>/dev/null | tr '\t' '\n'); do
    [ "$sg" = None ] && continue; echo "고아 보안 그룹 지움: $sg"; aws ec2 delete-security-group --group-id "$sg" >/dev/null 2>&1 || echo "  (아직 참조 중 → 다음 시도)"
  done
  return 0
}
d_eks() {
  local vpc i
  tf_has_state "$TFA" || return 0
  aws_account_var || return 1
  vpc=$(tfout "$TFA" vpc_id 2>/dev/null)
  [ "$DRY" = 1 ] || { aws_orphans "$vpc"; aws_rds_orphans "$vpc"; }
  for i in 1 2 3; do
    # (aws_account_var 를 같은 줄에: up-preflight 의 tfvars:wiring 점검이 줄 단위로 본다. 이미 받았으면 바로 0)
    aws_account_var && run terraform -chdir="$TFA" destroy -input=false -auto-approve -var create_eks=true && return 0
    echo "aws/env destroy ${i}번째 실패 → 고아 자원(ELB·RDS·떠 있는 ENI·남은 보안 그룹) 정리 뒤 60초 쉬고 다시"
    [ "$DRY" = 1 ] || { aws_orphans "$vpc"; aws_rds_orphans "$vpc"; aws_vpc_sweep "$vpc"; sleep 60; }
  done
  return 1
}
# GATE: GKE 안 Service LoadBalancer(served-by)를 안 지운 채 클러스터를 지우면 전달 규칙·대상 풀·상태 확인·k8s 방화벽이 남아
#   네트워크 삭제가 막힌다 (cloud-zero R8-10 줄들, GKE 가 만든 것이라 state 에 없음). 프로젝트는 데모 전용이라 k8s 가 만든 LB 자원을 전부 지운다.
#   Service 가 아직 살아 있으면(kubectl 실패) 컨트롤러가 다시 만들지만, 클러스터가 지워진 다음 시도에서 끝난다
# GATE-gcp: GKE 가 만든 LB 자원(terraform state 에 없음)을 API 로 지운다. 순서 = 전달 규칙 → 백엔드 서비스 → 대상 풀 → 상태 확인 → NEG → 방화벽
#   (앞의 것이 뒤의 것을 쓰고 있으면 뒤의 것이 안 지워진다). 기본(주석 없는 LoadBalancer)은 대상 풀 방식, k8s2-* 는 l4-rbs 주석일 때만 생긴다.
#   클러스터가 살아 있고 Service 가 남아 있으면 GKE 가 다시 만들 수 있다 → d_gke 가 destroy 성공 뒤에 한 번 더 부르고 남은 수를 센다.
#   $2=after 이면 클러스터가 없을 때만 남는 gke-<클러스터>-* 방화벽도 지운다. 끝 코드 = 지운 뒤 다시 센 남은 수가 0 이면 0
# FM-CLD-12: 같은 프로젝트에 우리 말고 다른 GKE 클러스터가 있으면(또는 목록을 못 읽으면) "좁힌 모드":
#   대상 풀은 인스턴스가 gke-$CLUSTER_NAME-* 인 것만, 전달 규칙은 그 풀을 가리키는 것만 지운다.
#   이름만으로는 어느 클러스터 것인지 모르는 k8s2-* 백엔드·상태 확인·NEG, k8s-* 상태 확인은 건너뛰고 경고만 (cloud-zero 가 판정).
#   방화벽은 원래도 우리 VPC($net)로 좁혀져 있어 그대로. 다른 클러스터가 없을 때만 예전처럼 프로젝트 전체
gcp_orphans() {
  local net=$1 when=${2:-} r n reg z left cl others=unknown pools="" tgt ins
  gq() { gcloud "$@" --project "$GCP_TARGET" 2>/dev/null; }
  gd() { gcloud "$@" --project "$GCP_TARGET" --quiet >/dev/null 2>&1 || true; }
  if cl=$(gcloud container clusters list --project "$GCP_TARGET" --format='value(name)' 2>/dev/null); then
    others=$(printf '%s\n' "$cl" | grep -v -x -e "$CLUSTER_NAME" -e '' | grep -c . || true)
  fi
  if [ "$others" != 0 ]; then
    if [ "$others" = unknown ]; then echo "GKE 클러스터 목록을 못 읽음"; else echo "같은 프로젝트에 다른 GKE 클러스터 ${others}개"; fi
    echo "→ 우리 노드(gke-$CLUSTER_NAME-*)를 가리키는 LB 만 지움"
    while read -r n reg ins; do
      [ -n "$n" ] && [ -n "$reg" ] || continue
      case "$ins" in */gke-"$CLUSTER_NAME"-*) ;; *) continue ;; esac
      pools="$pools $n"
      gq compute forwarding-rules list --filter="target~/targetPools/$n\$" --format='value(name,region.basename())' |
        while read -r r z; do [ -n "$r" ] || continue; echo "고아 전달 규칙 지움: $r"; gd compute forwarding-rules delete "$r" --region "${z:-$reg}"; done
      echo "고아 대상 풀 지움: $n"; gd compute target-pools delete "$n" --region "$reg"
    done <<EOF_POOLS
$(gq compute target-pools list --filter='description~kubernetes.io/service-name' --format='value(name,region.basename(),instances.list())')
EOF_POOLS
    echo "건너뜀: k8s2-* 백엔드·상태 확인·NEG, k8s-* 상태 확인 (어느 클러스터 것인지 이름으로 모름 → cloud-zero 판정)"
  else
  # 전달 규칙: 전역 규칙이면 region 칸이 빈다 → --global 로 (GATE g1: 예전엔 --region "" 로 실패)
  gq compute forwarding-rules list --filter='description~kubernetes.io/service-name' --format='value(name,region.basename())' |
    while read -r n reg; do [ -n "$n" ] || continue; echo "고아 전달 규칙 지움: $n ${reg:-전역}"
      if [ -n "$reg" ]; then gd compute forwarding-rules delete "$n" --region "$reg"; else gd compute forwarding-rules delete "$n" --global; fi; done
  gq compute backend-services list --filter='name~^k8s2-' --format='value(name,region.basename())' |
    while read -r n reg; do [ -n "$n" ] && [ -n "$reg" ] || continue; echo "고아 백엔드 서비스 지움: $n"; gd compute backend-services delete "$n" --region "$reg"; done
  gq compute target-pools list --filter='description~kubernetes.io/service-name' --format='value(name,region.basename())' |
    while read -r n reg; do [ -n "$n" ] && [ -n "$reg" ] || continue; echo "고아 대상 풀 지움: $n"; gd compute target-pools delete "$n" --region "$reg"; done
  # 상태 확인: 공유 노드용 k8s-<id>-node, externalTrafficPolicy=Local 이면 서비스마다 a<uid> (설명에 service-name)
  for r in $(gq compute http-health-checks list --filter='name~^k8s- OR description~kubernetes.io/service-name' --format='value(name)'); do
    echo "고아 상태 확인 지움: $r"; gd compute http-health-checks delete "$r"
  done
  gq compute health-checks list --filter='name~^k8s2-' --format='value(name,region.basename())' |
    while read -r n reg; do [ -n "$n" ] || continue; echo "고아 상태 확인(새 방식) 지움: $n"
      if [ -n "$reg" ]; then gd compute health-checks delete "$n" --region "$reg"; else gd compute health-checks delete "$n" --global; fi; done
  gq compute network-endpoint-groups list --filter='name~^k8s2-' --format='value(name,zone.basename())' |
    while read -r n z; do [ -n "$n" ] && [ -n "$z" ] || continue; echo "고아 NEG 지움: $n"; gd compute network-endpoint-groups delete "$n" --zone "$z"; done
  fi
  for r in $(gq compute firewall-rules list --filter="network~/$net\$ AND name~^k8s" --format='value(name)'); do
    echo "고아 k8s 방화벽 지움: $r"; gd compute firewall-rules delete "$r"
  done
  # 클러스터가 정말 없을 때만(목록 조회 성공 + 이름 없음) GKE 자체 방화벽 gke-<이름>-* 를 지운다. 조회가 실패하면 건드리지 않는다
  if [ "$when" = after ] && n=$(gcloud container clusters list --project "$GCP_TARGET" --filter="name~^$CLUSTER_NAME\$" --format='value(name)' 2>/dev/null) && [ -z "$n" ]; then
    for r in $(gq compute firewall-rules list --filter="network~/$net\$ AND name~^gke-$CLUSTER_NAME-" --format='value(name)'); do
      echo "고아 GKE 방화벽 지움: $r"; gd compute firewall-rules delete "$r"
    done
  fi
  if [ "$others" != 0 ]; then
    # 좁힌 모드: 남은 것도 우리 것만 센다 (남의 LB 가 있다고 down 이 실패하지 않게)
    left=$( { for n in $pools; do gq compute target-pools list --filter="name=$n" --format='value(name)'
                gq compute forwarding-rules list --filter="target~/targetPools/$n\$" --format='value(name)'; done
              gq compute firewall-rules list --filter="network~/$net\$ AND name~^k8s" --format='value(name)'; } | grep -c . )
  else
  left=$( { gq compute forwarding-rules list --filter='description~kubernetes.io/service-name' --format='value(name)'
            gq compute target-pools list --filter='description~kubernetes.io/service-name' --format='value(name)'
            gq compute firewall-rules list --filter="network~/$net\$ AND name~^k8s" --format='value(name)'; } | grep -c . )
  fi
  [ "${left:-0}" -eq 0 ] || echo "아직 남은 GKE LB 자원 ${left}개"
  [ "${left:-0}" -eq 0 ]
}
# GATE-gcp: tf:real destroy 가 못 지운 Cloud SQL(끊긴 smoke·state 잠금·state 잃음)을 gcloud 로 지운다. 우리 모듈이 붙이는 라벨(managed-by=platform)만.
#   Cloud SQL 이 남으면 PSA 피어링·네트워크도 못 지워 gcp/env destroy 까지 막힌다. 복제본 먼저. delete 는 끝날 때까지 기다린다(보통 1~5분)
#   DRAFT(ai): 라벨만 보고 지운다(삭제 보호 꺼짐 여부는 terraform 쪽 값이라 API 에선 안 막음). 남기려면 DEMO_DAY_SQL_SWEEP=0
gcp_sql_sweep() {
  local n t list
  [ "${DEMO_DAY_SQL_SWEEP:-1}" = 1 ] || { echo "Cloud SQL 쓸어 담기 꺼짐 (DEMO_DAY_SQL_SWEEP=0)"; return 0; }
  if [ "$DRY" = 1 ]; then echo "DRY: gcloud sql instances list (라벨 managed-by=platform) → 복제본 먼저 delete" >> "$PROGRESS"; return 0; fi
  if ! list=$(gcloud sql instances list --project "$GCP_TARGET" --filter='settings.userLabels.managed-by=platform' --format='value(name,instanceType)' 2>&1); then
    case "$list" in *"not enabled"*|*"has not been used"*|*SERVICE_DISABLED*) echo "Cloud SQL API 꺼짐 → 남은 Cloud SQL 없음"; return 0 ;; esac
    echo "Cloud SQL 목록 조회 실패 → 건너뜀 (cloud-zero 가 판정)"; return 0
  fi
  for t in READ_REPLICA_INSTANCE CLOUD_SQL_INSTANCE; do
    printf '%s\n' "$list" | while read -r n ty; do
      [ -n "$n" ] && [ "$ty" = "$t" ] || continue
      echo "남은 Cloud SQL 지움 ($t): $n"
      gcloud sql instances delete "$n" --project "$GCP_TARGET" --quiet >/dev/null 2>&1 || echo "  지우기 실패: $n (이미 지우는 중이면 괜찮다)"
    done
  done
  return 0
}
# UPREV: GCP PSA 피어링이 남으면 연결·주소·네트워크 destroy 가 code 9 로 실패한다 (11/2 맥: platform-target-psa 주소 남음).
#   ⓪ (GATE-gcp) 남은 Cloud SQL 을 먼저 지움 ① 피어링을 gcloud 로 지움(없으면 지나감) ② state 에 연결이 남아 있으면 state 에서만 뺌
#   ③ destroy, 실패하면 고아 LB 정리·30초 쉬고 최대 3번 ④ (GATE-gcp) 성공 뒤에도 고아 LB 를 한 번 더 지우고 남은 수를 봄
#   (destroy 가 성공해도 전달 규칙·대상 풀·상태 확인은 네트워크에 안 묶여 남을 수 있다 → cloud-zero FAIL 이 되던 길)
d_gke() {
  local net=${GCP_NETWORK:-$CLUSTER_NAME} i j
  gcp_sql_sweep
  if ! tf_has_state "$TFG"; then
    # state 가 없어도 지난 회차의 고아 LB 는 남아 있을 수 있다 (state 를 잃었거나 앞 down 이 destroy 만 끝내고 멈춤)
    [ "$DRY" = 1 ] || gcp_orphans "$net" after
    return 0
  fi
  run gcloud compute networks peerings delete servicenetworking-googleapis-com --network "$net" --project "$GCP_TARGET" --quiet 2>&1 | tail -1 || true
  if [ "$DRY" = 1 ] || terraform -chdir="$TFG" state list 2>/dev/null | grep -qx 'google_service_networking_connection.psa'; then
    run terraform -chdir="$TFG" state rm google_service_networking_connection.psa
  fi
  [ "$DRY" = 1 ] || gcp_orphans "$net"
  for i in 1 2 3; do
    if run terraform -chdir="$TFG" destroy -input=false -auto-approve -var "project_id=$GCP_TARGET" -var "zone=$GCP_ZONE" -var "name=$CLUSTER_NAME"; then
      [ "$DRY" = 1 ] && return 0
      for j in 1 2 3; do gcp_orphans "$net" after && return 0; echo "고아 LB 다시 확인 ${j}/3"; sleep 20; done
      echo "gcp/env 는 지웠지만 GKE LB 자원이 남음 → cloud-zero 가 판정"; return 1
    fi
    echo "gcp/env destroy ${i}번째 실패 → 피어링·고아 LB 자원 정리 뒤 30초 쉬고 다시"
    [ "$DRY" = 1 ] || { gcp_orphans "$net" after; sleep 30; }
    run gcloud compute networks peerings delete servicenetworking-googleapis-com --network "$net" --project "$GCP_TARGET" --quiet 2>&1 | tail -1 || true
  done
  return 1
}
# RV-05: ECS 출발 샘플(ecs-source)도 down 이 지운다. 실세션이 ecs-up 뒤(ecs-import 등)에서 실패하면 감시 창은 jeong-down 만 치는데,
#   예전 down 은 ECS 를 안 지워 Fargate 가 계속 과금되고 cloud-zero 가 영영 FAIL 이었다. 상태 파일에 ECS 자원이 있을 때만 부른다 (조회는 파일만, 클라우드 호출 0)
#   상태 위치: 모듈 폴더(지금 실제 위치, FM-CLD-13) 또는 ECS_SOURCE_STATE. 남기려면 DEMO_DAY_ECS_DOWN=0
d_ecs_source() {
  local st found=""
  [ "${DEMO_DAY_ECS_DOWN:-1}" = 1 ] || { echo "DEMO_DAY_ECS_DOWN=0 → ECS 출발 샘플은 안 지움"; return 0; }
  if [ "$DRY" = 1 ]; then echo "DRY: (ECS 상태 있으면) bash tools/ecs-source.sh down" >> "$PROGRESS"; return 0; fi
  for st in infra/modules/aws/ecs-source/terraform.tfstate "${ECS_SOURCE_STATE:-$HOME/.svc-tf/ecs-source}/terraform.tfstate"; do
    # PF FM-CLD-hunt-cloud-24: 클러스터 만들기 전에 실패해도 보안 그룹·로그 그룹·IAM 역할이 남는다 → aws 자원이 하나라도 있으면 down
    #   (예전: aws_ecs_* 가 있을 때만. data 만 있는 상태여도 destroy 는 아무것도 안 지우고 끝나 해 없음)
    [ -s "$st" ] && grep -q '"type": *"aws_' "$st" && found=$st
  done
  [ -n "$found" ] || { echo "ECS 출발 샘플 상태에 자원 없음 → 건너뜀"; return 0; }
  echo "ECS 출발 샘플 상태 있음 ($found) → ecs-source.sh down"
  bash tools/ecs-source.sh down
}
# UPREV-B: 지운 직후엔 NAT·EKS·RDS·ENI 가 "지우는 중"으로 한동안 남는다 → 10분까지 30초마다 다시 본다 (0 이면 바로 통과)
# pf-d FM-TRF-09: Cloudflare LB → pool → 모니터 (cf-check 이름만). 워커를 끈 뒤(procs) 지운다. 토큰이 없으면 건너뜀 (남은 것은 cloud-zero cf 줄이 판정)
d_cf() {
  if [ -z "${CLOUDFLARE_API_TOKEN:-}${CF_API_TOKEN:-}" ] && ! grep -Eq '^(CLOUDFLARE|CF)_API_TOKEN=.' .env 2>/dev/null; then echo "Cloudflare 토큰 없음 → 건너뜀"; return 0; fi
  if [ -f .env ]; then run node --env-file=.env --import tsx scripts/cf-check.ts --cleanup --apply --force; else run node --import tsx scripts/cf-check.ts --cleanup --apply --force; fi
}
d_zero() { CLOUD_ZERO_WAIT_SEC=${CLOUD_ZERO_WAIT_SEC:-600} run bash tools/cloud-zero.sh; }

do_down() {
  log "down 시작 dry=$DRY"
  step served-by-down d_served_by
  step elb-zero d_elb_zero
  step close-stuck d_close_stuck
  step procs d_procs
  step cf-lb-delete d_cf
  step migration-destroy d_migration_tf
  step secrets-purge secrets_purge
  step connect-stack d_connect_stack
  step connect-gcp d_connect_gcp
  step relay-destroy d_relay
  step ecs-source-down d_ecs_source
  par eks-destroy d_eks gke-destroy d_gke
  if [ "$DRY" = 0 ] && [ -f "$ENVF" ] && [ -z "$FAILED" ]; then rm -f "$ENVF"; fi
  step cloud-zero d_zero
  # WRONGROOT: 다 지웠으면 up 폴더 표를 치운다 (다음 회차가 다른 폴더에서 up 해도 되게)
  [ "$DRY" = 0 ] && [ -z "$FAILED" ] && rm -f "$UPROOT"
  finish
}

# WRONGROOT (FM-OPS-05 맥): terraform 상태는 모듈 폴더(로컬 tfstate)에 있다. 다른 레포 폴더(예: Service-impl1103 대신 Service)에서 down 을 치면
#   destroy 를 전부 "상태 흔적 없음 → 생략" 으로 건너뛰고 cloud-zero 만 FAIL → 자원이 남아 과금된다. up 이 친 폴더(실제 경로)를 STATE/up-root 에 남기고
#   down 은 시작 전에 대조해 다르면 멈춘다(끝 코드 2). 그 폴더가 지워졌으면(infra/ 없음) 막지 않는다. 여기서 하려면 DEMO_DAY_ANY_ROOT=1
UPROOT="$STATE/up-root"
ROOTP=$(cd "$ROOT" && pwd -P)
if [ "$DRY" = 0 ] || [ "${DEMO_DAY_ROOT_CHECK_ONLY:-0}" = 1 ]; then
  if [ "$CMD" = up ]; then mkdir -p "$STATE" && echo "$ROOTP" > "$UPROOT"
  else
    ur=$(cat "$UPROOT" 2>/dev/null)
    if [ -n "$ur" ] && [ "$ur" != "$ROOTP" ] && [ -d "$ur/infra" ] && [ "${DEMO_DAY_ANY_ROOT:-0}" != 1 ]; then
      log "멈춤: 이 down 은 $ROOTP 에서 쳤는데 up 은 $ur 에서 했다 (terraform 상태가 거기 있다) → 그 폴더에서: sh $ur/tools/jeong-down.sh   (여기서 하려면 DEMO_DAY_ANY_ROOT=1)"
      FINISHED=1; exit 2
    fi
  fi
fi
# 시험 전용: 위 대조만 하고 끝 (진짜 up·down 단계를 하나도 안 돈다)
[ "${DEMO_DAY_ROOT_CHECK_ONLY:-0}" = 1 ] && { FINISHED=1; exit 0; }
if [ "$CMD" = up ]; then if [ "$SERIAL" = 1 ]; then do_up_serial; else do_up; fi; else do_down; fi
