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
export AWS_PROFILE=${AWS_PROFILE:-finals}
export AWS_REGION=${AWS_REGION:-ap-northeast-2}
# UPREV-A: AWS CLI 는 AWS_REGION 이 아니라 AWS_DEFAULT_REGION 을 읽는다(프로필 리전이 서울이 아니면 rds·elb 조회가 엉뚱한 리전을 본다 → ELB 0 오판)
export AWS_DEFAULT_REGION=$AWS_REGION
GCP_PROJECT=${GCP_PROJECT:-finals-demo}
GCP_ZONE=${GCP_ZONE:-asia-northeast3-a}
CLUSTER_NAME=${CLUSTER_NAME:-platform-target}
EKS_CONTEXT=${EKS_CONTEXT:-eks-platform-target}
GKE_CONTEXT=${GKE_CONTEXT:-gke_${GCP_PROJECT}_${GCP_ZONE}_${CLUSTER_NAME}}
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
PROGRESS="$DEMO_DAY_LOG_DIR/progress.log"
[ "$DRY" = 1 ] && STATE="$DEMO_DAY_LOG_DIR/state"
ENVF="$STATE/demo-day.env"
# UPREV-A: 중계기 ssh 는 회차마다 새 호스트 키라, 맥 ~/.ssh/known_hosts 에 같은 IP 의 옛 키가 있으면 "키 바뀜" 으로 거절된다 → 이 상태 폴더의 known_hosts 만 쓰고 up 시작 때 지운다
RELAY_SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$STATE/known_hosts"

# 뒤로 보내기: 같은 인자로 자기 자신을 nohup 으로 다시 부른다
if [ "$FG" = 0 ] && [ -z "${DEMO_DAY_CHILD:-}" ]; then
  DEMO_DAY_CHILD=1 nohup bash "$SELF" "$CMD" --fg $([ "$DRY" = 1 ] && echo --dry-run) $([ "$SERIAL" = 1 ] && echo --serial) > "$DEMO_DAY_LOG_DIR/stdout.log" 2>&1 &
  echo "뒤에서 시작 (pid $!). 진행: tail -f $PROGRESS"
  exit 0
fi

now_s() { date +%s; }
BGPIDS=""
APPLIED=0   # apply 를 하나라도 시작했나 (멈출 때 자동 down 여부)
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(iso) $*" | tee -a "$PROGRESS"; }
mask_ip() { echo "$1" | awk -F. 'NF == 4 { print $1 "." $2 ".x.x"; next } { print substr($0, 1, 12) "…" }'; }
T_ALL=$(now_s)
FAILED=""

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
  log "판정 $v $CMD 총 ${total}초 (기준 ≤$((LIMIT / 60))분)${FAILED:+ 실패:$FAILED}"
  # z75-50: timeline(TL_MODE=allow) 이 기다리는 끝 줄. jeong-up/down 과 같은 진행 파일
  if [ "$DRY" = 0 ]; then mkdir -p "$STATE" && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DEMODAY $CMD end rc=$([ -z "${v%%PASS*}" ] && echo 0 || echo 1) sec=$total log=$PROGRESS" >> "$STATE/jeong-progress.log"; fi
  case "$v" in PASS*) exit 0 ;; *) exit 1 ;; esac
}
# UPREV: 멈출 때 뒤에서 돌던 apply(GKE 등)를 그냥 두고 끝내면 고아 terraform 이 자원을 계속 만들고 state 잠금을 쥔다
#   (20:2xZ 1차: aws rc=1 로 끝났는데 GKE 7개가 남아 2차 cloud-zero 가 막힘). 그래서 끝날 때까지 기다린 뒤 down 으로 자원 0 을 만든다
abort() {
  local p
  log "멈춤: $1"
  for p in $BGPIDS; do kill -0 "$p" 2>/dev/null && { log "뒤에서 도는 단계(pid $p)가 끝날 때까지 기다림 (terraform 을 중간에 끊지 않음)"; wait "$p"; }; done
  if [ "$CMD" = up ] && [ "$DRY" = 0 ] && [ "$APPLIED" = 1 ] && [ "${DEMO_DAY_AUTO_DOWN:-1}" = 1 ]; then
    log "자원 0 으로 되돌림: down 시작 (남기려면 DEMO_DAY_AUTO_DOWN=0)"
    ( DEMO_DAY_CHILD=1 DEMO_DAY_LOG_DIR="$DEMO_DAY_LOG_DIR/auto-down" bash "$SELF" down --fg ); log "자동 down 끝 rc=$?"
  else
    if [ "$APPLIED" = 0 ]; then log "apply 를 시작하기 전에 멈춤 → 만든 자원 없음. 위 FAIL 줄을 고치고 up 을 다시 친다"
    else log "만든 자원은 'bash tools/demo-day.sh down' 으로 지우거나, DEMO_DAY_RESUME=1 로 up 을 다시 쳐서 이어 간다"; fi
  fi
  finish
}
# UPREV: 지난 회차의 워커·API·터널이 살아 있으면 새 API 가 3000 을 못 잡고, readyz 는 예전 API 가 대답해 거짓 통과한다 → 먼저 끈다
u_stale() {
  # 워커·API·터널·smoke 는 UPREV-A d_procs (pid 재사용 대비: 우리 프로세스일 때만 끔)
  d_procs
  [ "$DRY" = 1 ] || rm -f "$STATE/relay_ip" "$STATE/known_hosts" "$ENVF"
  echo "지난 회차 프로세스 정리, relay_ip·known_hosts·demo-day.env 지움"
  if [ "$DRY" = 0 ] && command -v lsof >/dev/null 2>&1 && lsof -ti tcp:3000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "3000 포트를 다른 프로세스가 쓰고 있다 (예전 dev:api?). 끄고 다시: lsof -ti tcp:3000 -sTCP:LISTEN"; return 1
  fi
}

# ---------------- up ----------------
u_tools() {
  local t miss=""
  for t in terraform aws gcloud kubectl jq curl ssh npm python3 pgrep; do command -v "$t" >/dev/null 2>&1 || miss="$miss $t"; done
  if [ "$DRY" = 1 ]; then echo "dry-run: 없는 도구${miss:- 0개}${miss:+:$miss} (dry-run 은 막지 않음). 사전 점검 tools/cloud-precheck.sh 는 맥에서만"; return 0; fi
  [ -z "$miss" ] || { echo "없는 도구:$miss"; return 1; }
  [ -f "$HOME/.ssh/id_ed25519.pub" ] || { echo "~/.ssh/id_ed25519.pub 없음 (Z77 B2 첫 줄로 만든다)"; return 1; }
  # UPREV: apply 전에 실패할 수 있는 것을 전부 본다(인증·ADC·필수 변수·남은 state·자원 0·한도·출발 DB·8080·validate·plan).
  #   PASS 가 아니면 여기서 멈춰 apply 를 하나도 시작하지 않는다 (DEMO_DAY_RESUME=1 이면 남은 state·자원은 WARN)
  run bash "${UP_PREFLIGHT:-tools/up-preflight.sh}"
}
u_gke() { run terraform -chdir="$TFG" init -input=false && run terraform -chdir="$TFG" apply -input=false -auto-approve -var "project_id=$GCP_PROJECT" -var "zone=$GCP_ZONE" -var "name=$CLUSTER_NAME"; }
u_eks() { aws_account_var && run terraform -chdir="$TFA" init -input=false && run terraform -chdir="$TFA" apply -input=false -auto-approve -var create_eks=true; }
u_kubeconfig() {
  run gcloud container clusters get-credentials "$CLUSTER_NAME" --zone "$GCP_ZONE" --project "$GCP_PROJECT" &&
  run aws eks update-kubeconfig --name "$(tfout "$TFA" cluster_name)" --alias "$EKS_CONTEXT" --region "$AWS_REGION"
}
wait_addr() {
  local ctx=$1 i a
  [ "$DRY" = 1 ] && { echo "<dry:addr-$ctx>"; return 0; }
  for i in $(seq 1 36); do
    a=$(bash deploy/cloud-demo/apply-served-by.sh addr "$ctx" 2>/dev/null)
    [ -n "$a" ] && { echo "$a"; return 0; }
    sleep 5
  done
  return 1
}
u_served_by() {
  run bash deploy/cloud-demo/apply-served-by.sh up "$EKS_CONTEXT" aws-app-demo &&
  run bash deploy/cloud-demo/apply-served-by.sh up "$GKE_CONTEXT" gcp-app-demo || return 1
  SRC_ORIGIN=$(wait_addr "$EKS_CONTEXT") && TGT_ORIGIN=$(wait_addr "$GKE_CONTEXT") || { echo "공개 주소가 180초 안에 안 나옴"; return 1; }
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
  local sub myip ip
  if [ "$DRY" = 1 ]; then myip="<dry:myip>"; sub="<dry:subnet>"; else
    # UPREV-A: 파이프 뒤 rc 는 tr 의 것이라 curl 실패가 가려졌다 → 값 모양을 직접 본다 (빈 값이면 ["/32"] 로 terraform 이 늦게 거절)
    myip=$(curl -fsS -m 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
    case "$myip" in *[!0-9.]*|"") echo "맥 공인 IP 를 못 받음 (checkip.amazonaws.com)"; return 1 ;; esac
    sub=$(echo "$TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON" | jq -r '.[0] // empty')
    [ -n "$sub" ] || { echo "공개 서브넷 ID 가 없음 (aws/env 출력 public_subnet_ids 비었음)"; return 1; }
    [ -n "${TF_FACT_VPC_ID:-}" ] || { echo "vpc_id 가 없음 (b1-facts 먼저)"; return 1; }
  fi
  MYIP=$myip
  run terraform -chdir="$TFR" init -input=false &&
  run terraform -chdir="$TFR" apply -input=false -auto-approve -var "vpc_id=$TF_FACT_VPC_ID" -var "public_subnet_id=$sub" \
    -var "ssh_public_key=$(cat "$HOME/.ssh/id_ed25519.pub" 2>/dev/null)" -var "ssh_cidrs_json=[\"$myip/32\"]" || return 1
  RELAY_IP=$(tfout "$TFR" public_ip) && RELAY_PRIV=$(tfout "$TFR" private_ip) || { echo "중계기 출력(public_ip·private_ip)을 못 읽음"; return 1; }
  [ -n "$RELAY_IP" ] && [ -n "$RELAY_PRIV" ] || { echo "중계기 IP 가 비었다"; return 1; }
  [ "$DRY" = 1 ] && { echo "DRY: 터널은 사람 터미널에서 bash tools/demo-tunnel.sh → tunnel-ok 기다림 (최대 ${TUNNEL_WAIT_SEC}초)" >> "$PROGRESS"; return 0; }
  mkdir -p "$STATE" && chmod 700 "$STATE" && echo "$RELAY_IP" > "$STATE/relay_ip"
  # 중계기가 SSH 를 받을 때까지 최대 120초
  for i in $(seq 1 24); do ssh $RELAY_SSH_OPTS -o ConnectTimeout=5 "ec2-user@$RELAY_IP" true 2>/dev/null && break; sleep 5; done
  # 역방향 터널은 맥 RC 가 열지 않는다 (Z38 R8-39: 맥 분류기가 막는 명령이라 사람이 직접 친다). 열릴 때까지 기다린다
  # z75-46: Jeong 이 tools/jeong-up.sh 로 이 스크립트를 부른 경우(DEMO_DAY_JEONG=1)엔 이미 사람 터미널에서 도는 것이라 여기서 바로 연다
  if [ "${DEMO_DAY_JEONG:-0}" = 1 ]; then
    nohup bash tools/demo-tunnel.sh > "$DEMO_DAY_LOG_DIR/tunnel.log" 2>&1 &
    echo "터널: Jeong 실행 묶음 안에서 뒤로 엶 (로그 tunnel.log)" | tee -a "$PROGRESS"
  else
    echo "기다림: 터널. 사람 터미널에서 bash tools/demo-tunnel.sh" | tee -a "$PROGRESS"
  fi
  tunnel_wait "$TUNNEL_WAIT_SEC"
}
# 중계기에서 5432 가 열려 있으면 0. 최대 $1 초 5초 간격으로 본다
tunnel_wait() {
  local i
  for i in $(seq 1 $(( ($1 + 4) / 5 ))); do
    ssh $RELAY_SSH_OPTS -o ConnectTimeout=5 "ec2-user@$RELAY_IP" 'timeout 3 bash -c "</dev/tcp/127.0.0.1/5432" && echo tunnel-ok' 2>/dev/null | grep -q tunnel-ok && { echo tunnel-ok; return 0; }
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
    kv DB_PEER_CIDRS "$MYIP/32,$RELAY_PRIV/32"
    kv DB_PUBLIC "1"
    kv DB_DISPOSABLE "1"
    kv REPL_TARGET_CA_FILE "$STATE/rds-ap-northeast-2-bundle.pem"
    kv REPL_TARGET_SSLMODE "verify-full"
    kv REPL_TARGET_URL "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/shop_api"
    kv REPL_TARGET_PEER_URL "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/shop_api?sslmode=require"
    kv REPL_TARGET_PROVIDER "rds"
    kv REPL_SOURCE_PEER_URL "$peer"
    kv REPL_SOURCE_SSLMODE "disable"
    kv CF_CHECK_SOURCE_ORIGIN "${SRC_ORIGIN:-}"
    kv CF_CHECK_TARGET_ORIGIN "${TGT_ORIGIN:-}"
    # z75-36: 관찰 시간 4초로 고정 (VM 2·4·6초 비교에서 S4 10.4초·최대 대기 4.6초, 대본 문단 3 읽기 32~39초 안). 맥 .env 엔 값이 없어 기본 30초가 된다
    kv TRAFFIC_OBSERVE_SEC "${TRAFFIC_OBSERVE_SEC:-4}"
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
    SMOKE_TIMEOUT_MS=1200000 ROLLBACK_WINDOW_SEC=3 npm run -s smoke > "$DEMO_DAY_LOG_DIR/rds-smoke.log" 2>&1 &
  RDS_PID=$!
  echo "$RDS_PID" > "$STATE/smoke.pid"   # UPREV-A: down·다음 up 이 남은 smoke 를 끌 수 있게
  echo "smoke 뒤에서 시작 (pid $RDS_PID, 로그 rds-smoke.log)"
}
u_rds_wait() {
  local rc st
  [ "$DRY" = 1 ] && { echo "DRY: smoke 끝 기다림 → aws rds describe-db-instances 로 available 확인" >> "$PROGRESS"; return 0; }
  [ -n "$RDS_PID" ] || { echo "smoke 가 시작되지 않았다"; return 1; }
  # 9분 넘게 지났으니 터널이 아직 살아 있는지 본다. 끊겼으면 demo-tunnel.sh 가 2초 뒤 다시 붙으므로 60초까지 기다린다
  tunnel_wait 60 || echo "경고: 터널이 안 보인다. demo-tunnel.sh 창을 확인"
  wait "$RDS_PID"; rc=$?
  tail -n 3 "$DEMO_DAY_LOG_DIR/rds-smoke.log"
  [ $rc -eq 0 ] || return $rc
  st=$(aws rds describe-db-instances --query 'DBInstances[].DBInstanceStatus' --output text 2>/dev/null)
  echo "RDS 상태: ${st:-(없음)}"
  echo "$st" | grep -q available
}
u_workers() {
  local i
  if [ "$DRY" = 1 ]; then echo "DRY: MOCK_IAC= GITOPS_DISABLE=1 nohup npm run dev:worker / dev:api & (PLAN_ACKS=$([ "${DEMO_DAY_PLAN_ACKS:-}" = 1 ] && echo 1 || echo 기본))" >> "$PROGRESS"; return 0; fi
  # UPREV-A: 3000 에 이미 API 가 있으면 새 API 는 못 뜨는데 아래 readyz 검사는 옛 API 로 통과해 버린다 → 먼저 막는다
  if curl -sf -m 2 http://localhost:3000/readyz >/dev/null 2>&1; then echo "localhost:3000 에 이미 API 가 떠 있다(옛 회차?). 끄고 다시: bash tools/demo-day.sh down 또는 lsof -ti :3000"; return 1; fi
  ( set -a; . "$ENVF"; set +a; MOCK_IAC= GITOPS_DISABLE=1 \
    nohup npm run dev:worker > "$DEMO_DAY_LOG_DIR/worker.log" 2>&1 & echo $! > "$STATE/worker.pid" )
  # WEBUP: 발표 화면(8080 컨테이너)이 host.docker.internal 로 붙으므로 IPv4 루프백에 확실히 연다 ("localhost" 는 맥에서 ::1 만 될 수 있음)
  # DEMOFLAGS DRAFT(ai): 계획 승인 확인 항목 게이트(회의 D5)는 기본 꺼둔다. 발표 화면(8080)이 아직 acks 를 안 보내서 켜면 화면 승인이 409 ACKS_MISSING 이다
  #   (notes/impl-1103/WEB-GAPS.md §2). 스크립트(smoke·real-flow)만 쓰는 회차나 화면이 acks 를 보내게 된 뒤엔 DEMO_DAY_PLAN_ACKS=1 로 켠다
  ( env API_HOST=127.0.0.1 $([ "${DEMO_DAY_PLAN_ACKS:-}" = 1 ] && echo PLAN_ACKS=1) nohup npm run dev:api > "$DEMO_DAY_LOG_DIR/api.log" 2>&1 & echo $! > "$STATE/api.pid" )
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

do_up() {
  local gpid grc
  log "up 시작 (겹치기 순서) dry=$DRY profile=$AWS_PROFILE gcp=$GCP_PROJECT eks=$EKS_CONTEXT gke=$GKE_CONTEXT"
  mkdir -p "$STATE" && chmod 700 "$STATE"
  # 지난 회차 중계기 IP·호스트 키·프로세스를 치움 → demo-tunnel 은 이번 up 이 relay_ip 를 새로 적을 때까지 기다린다
  step stale u_stale || abort "지난 회차 정리 실패"
  step tools u_tools || abort "시작 점검 실패 (자원이 이미 있거나 도구 없음)"
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
  step served-by u_served_by || abort "served-by 실패"
  step cf-env u_cf_env
  step b4-rds-wait u_rds_wait || abort "B4 RDS 실패"
  step preflight u_preflight
  step warmup u_warm
  finish
}

do_up_serial() {
  log "up 시작 (예전 순서) dry=$DRY profile=$AWS_PROFILE gcp=$GCP_PROJECT eks=$EKS_CONTEXT gke=$GKE_CONTEXT"
  mkdir -p "$STATE" && chmod 700 "$STATE"
  step stale u_stale || abort "지난 회차 정리 실패"
  step tools u_tools || abort "시작 점검 실패 (자원이 이미 있거나 도구 없음)"
  APPLIED=1
  par gke-apply u_gke eks-apply u_eks || abort "클러스터 apply 실패"
  step kubeconfig u_kubeconfig || abort "kubeconfig 실패"
  # 아래 셋은 변수를 다음 단계로 넘기므로 하위 셸 없이 부른다 (출력은 단계 로그로)
  log "step=served-by start"; t=$(now_s); u_served_by >> "$DEMO_DAY_LOG_DIR/served-by.log" 2>&1; rc=$?; log "step=served-by end rc=$rc sec=$(( $(now_s) - t ))"; [ $rc -eq 0 ] || { FAILED="$FAILED served-by"; abort "served-by 실패"; }
  log "step=b1-facts start"; t=$(now_s); u_facts >> "$DEMO_DAY_LOG_DIR/b1-facts.log" 2>&1; rc=$?; log "step=b1-facts end rc=$rc sec=$(( $(now_s) - t ))"; [ $rc -eq 0 ] || { FAILED="$FAILED b1-facts"; abort "B1 실패"; }
  log "step=b2-relay start"; t=$(now_s); u_relay >> "$DEMO_DAY_LOG_DIR/b2-relay.log" 2>&1; rc=$?; log "step=b2-relay end rc=$rc sec=$(( $(now_s) - t ))"; [ $rc -eq 0 ] || { FAILED="$FAILED b2-relay"; abort "B2 중계기·터널 실패"; }
  step b3-env u_envfile || abort "B3 실패"
  step b4-rds u_rds || abort "B4 RDS 실패"
  step preflight u_preflight
  step warmup u_warm
  finish
}

# ---------------- down ----------------
d_served_by() {
  run bash deploy/cloud-demo/apply-served-by.sh down "$EKS_CONTEXT"
  run bash deploy/cloud-demo/apply-served-by.sh down "$GKE_CONTEXT"
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
killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null; return 0; }
# UPREV-A: pid 파일의 pid 가 재사용돼 남의 프로세스일 수 있다(맥 pid 는 돈다) → 우리가 띄운 종류(npm·node·tsx·터널·ssh)일 때만 끈다
proc_ours() { local c; c=$(ps -p "$1" -o command= 2>/dev/null) || return 1; case "$c" in *npm*|*node*|*tsx*|*demo-tunnel*|*ssh*) return 0 ;; esac; return 1; }
d_procs() {
  local f pid
  for f in worker api tunnel smoke; do
    [ -f "$STATE/$f.pid" ] || continue
    pid=$(cat "$STATE/$f.pid")
    if [ -n "$pid" ] && proc_ours "$pid"; then run killtree "$pid"; else echo "$f pid ${pid:-?} 는 이미 끝났거나 우리 프로세스가 아님 → 건너뜀"; fi
    [ "$DRY" = 1 ] || rm -f "$STATE/$f.pid"
  done
  return 0
}
d_migration_tf() {
  local ids id rc=0
  if [ "$DRY" = 1 ]; then echo "DRY: npm run tf:real -- list → 이전마다 npm run tf:real -- destroy <id>" >> "$PROGRESS"; return 0; fi
  # UPREV-B: 목록 조회가 실패하면(DB 가 꺼진 재실행 등) 예전엔 조용히 "할 것 없음" 으로 지나갔다. 알리고 넘어간다 — 남은 자원은 마지막 cloud-zero 가 잡는다
  if ! ids=$(npm run -s tf:real -- list); then echo "이전별 terraform 목록 조회 실패 → 이 단계는 건너뜀 (남은 자원은 cloud-zero 가 판정)"; return 0; fi
  ids=$(printf '%s\n' "$ids" | awk '$3 == "state" && $5 != "0개" { print $1 }')
  for id in $ids; do npm run -s tf:real -- destroy "$id" || rc=1; done
  return $rc
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
d_eks() { tf_has_state "$TFA" || return 0; aws_account_var && run terraform -chdir="$TFA" destroy -input=false -auto-approve -var create_eks=true; }
# UPREV: GCP PSA 피어링이 남으면 연결·주소·네트워크 destroy 가 code 9 로 실패한다 (11/2 맥: platform-target-psa 주소 남음).
#   ① 피어링을 gcloud 로 먼저 지움(없으면 지나감) ② state 에 연결이 남아 있으면 state 에서만 뺌(클라우드엔 영향 없음, 예전 state 는 ABANDON 이 아님)
#   ③ destroy, 실패하면 30초 쉬고 최대 3번 (피어링 지우기가 늦게 반영되는 경우)
d_gke() {
  local net=${GCP_NETWORK:-$CLUSTER_NAME} i
  tf_has_state "$TFG" || return 0
  run gcloud compute networks peerings delete servicenetworking-googleapis-com --network "$net" --project "$GCP_PROJECT" --quiet 2>&1 | tail -1 || true
  if [ "$DRY" = 1 ] || terraform -chdir="$TFG" state list 2>/dev/null | grep -qx 'google_service_networking_connection.psa'; then
    run terraform -chdir="$TFG" state rm google_service_networking_connection.psa
  fi
  for i in 1 2 3; do
    run terraform -chdir="$TFG" destroy -input=false -auto-approve -var "project_id=$GCP_PROJECT" -var "zone=$GCP_ZONE" -var "name=$CLUSTER_NAME" && return 0
    echo "gcp/env destroy ${i}번째 실패 → 30초 뒤 다시"; sleep 30
    run gcloud compute networks peerings delete servicenetworking-googleapis-com --network "$net" --project "$GCP_PROJECT" --quiet 2>&1 | tail -1 || true
  done
  return 1
}
# UPREV-B: 지운 직후엔 NAT·EKS·RDS·ENI 가 "지우는 중"으로 한동안 남는다 → 10분까지 30초마다 다시 본다 (0 이면 바로 통과)
d_zero() { CLOUD_ZERO_WAIT_SEC=${CLOUD_ZERO_WAIT_SEC:-600} run bash tools/cloud-zero.sh; }

do_down() {
  log "down 시작 dry=$DRY"
  step served-by-down d_served_by
  step elb-zero d_elb_zero
  step procs d_procs
  step migration-destroy d_migration_tf
  step relay-destroy d_relay
  par eks-destroy d_eks gke-destroy d_gke
  if [ "$DRY" = 0 ] && [ -f "$ENVF" ] && [ -z "$FAILED" ]; then rm -f "$ENVF"; fi
  step cloud-zero d_zero
  finish
}

if [ "$CMD" = up ]; then if [ "$SERIAL" = 1 ]; then do_up_serial; else do_up; fi; else do_down; fi
