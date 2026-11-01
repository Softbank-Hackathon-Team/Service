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
#   DEMO_DAY_UP_LIMIT_SEC(1500) DEMO_DAY_DOWN_LIMIT_SEC(900) TUNNEL_WAIT_SEC(중계기 뒤 사람이 터널을 열 때까지, 900)
#
# Jeong 직접 실행 묶음 (z75-46): terraform apply/destroy 와 터널은 맥 분류기가 막는 명령이라, 진짜 실행은
#   Jeong 이 sh tools/jeong-up.sh / sh tools/jeong-down.sh 한 번씩 친다(이 스크립트를 DEMO_DAY_JEONG=1 로 부름). 맥 RC 는 --dry-run 과 진행 파일 읽기만.
# 역방향 터널(ssh -R)은 맥 RC 가 열지 않는다 (Z38 R8-39). 맥 분류기가 막는 명령이라 사람 터미널에서
# bash tools/demo-tunnel.sh 를 친다(끊기면 스스로 다시 붙음). up 은 "기다림: 터널" 줄에서 그걸 기다린다.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)

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

export AWS_PROFILE=${AWS_PROFILE:-finals}
export AWS_REGION=${AWS_REGION:-ap-northeast-2}
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

# 뒤로 보내기: 같은 인자로 자기 자신을 nohup 으로 다시 부른다
if [ "$FG" = 0 ] && [ -z "${DEMO_DAY_CHILD:-}" ]; then
  DEMO_DAY_CHILD=1 nohup bash "$0" "$CMD" --fg $([ "$DRY" = 1 ] && echo --dry-run) $([ "$SERIAL" = 1 ] && echo --serial) > "$DEMO_DAY_LOG_DIR/stdout.log" 2>&1 &
  echo "뒤에서 시작 (pid $!). 진행: tail -f $PROGRESS"
  exit 0
fi

now_s() { date +%s; }
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
finish() {
  local total=$(( $(now_s) - T_ALL )) v=PASS
  [ -z "$FAILED" ] || v=FAIL
  [ "$total" -le "$LIMIT" ] || v="FAIL(${LIMIT}초 넘김)"
  [ "$DRY" = 1 ] && v="$v(dry-run)"
  log "판정 $v $CMD 총 ${total}초 (기준 ≤$((LIMIT / 60))분)${FAILED:+ 실패:$FAILED}"
  # z75-50: timeline(TL_MODE=allow) 이 기다리는 끝 줄. jeong-up/down 과 같은 진행 파일
  if [ "$DRY" = 0 ]; then mkdir -p "$STATE" && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DEMODAY $CMD end rc=$([ -z "${v%%PASS*}" ] && echo 0 || echo 1) sec=$total log=$PROGRESS" >> "$STATE/jeong-progress.log"; fi
  case "$v" in PASS*) exit 0 ;; *) exit 1 ;; esac
}
abort() { log "멈춤: $1. 만든 자원은 'bash tools/demo-day.sh down' 으로 지운다"; finish; }

# ---------------- up ----------------
u_tools() {
  local t miss=""
  for t in terraform aws gcloud kubectl jq curl ssh npm; do command -v "$t" >/dev/null 2>&1 || miss="$miss $t"; done
  if [ "$DRY" = 1 ]; then echo "dry-run: 없는 도구${miss:- 0개}${miss:+:$miss} (dry-run 은 막지 않음). 사전 점검 tools/cloud-precheck.sh 는 맥에서만"; return 0; fi
  [ -z "$miss" ] || { echo "없는 도구:$miss"; return 1; }
  [ -f "$HOME/.ssh/id_ed25519.pub" ] || { echo "~/.ssh/id_ed25519.pub 없음 (Z77 B2 첫 줄로 만든다)"; return 1; }
  run bash tools/cloud-zero.sh || return 1
  # z75-51: 클라우드 사전 점검 (GCP API·결제·Cloud SQL 티어·에디션, AWS 한도, 서울 고정. 조회만, 10초 안)
  run bash tools/cloud-precheck.sh
}
u_gke() { run terraform -chdir="$TFG" init -input=false && run terraform -chdir="$TFG" apply -input=false -auto-approve -var "project_id=$GCP_PROJECT"; }
u_eks() { run terraform -chdir="$TFA" init -input=false && run terraform -chdir="$TFA" apply -input=false -auto-approve -var create_eks=true; }
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
    myip=$(curl -s -m 10 https://checkip.amazonaws.com | tr -d '[:space:]') || return 1
    sub=$(echo "$TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON" | jq -r '.[0]')
  fi
  MYIP=$myip
  run terraform -chdir="$TFR" init -input=false &&
  run terraform -chdir="$TFR" apply -input=false -auto-approve -var "vpc_id=$TF_FACT_VPC_ID" -var "public_subnet_id=$sub" \
    -var "ssh_public_key=$(cat "$HOME/.ssh/id_ed25519.pub" 2>/dev/null)" -var "ssh_cidrs_json=[\"$myip/32\"]" || return 1
  RELAY_IP=$(tfout "$TFR" public_ip); RELAY_PRIV=$(tfout "$TFR" private_ip)
  [ "$DRY" = 1 ] && { echo "DRY: 터널은 사람 터미널에서 bash tools/demo-tunnel.sh → tunnel-ok 기다림 (최대 ${TUNNEL_WAIT_SEC}초)" >> "$PROGRESS"; return 0; }
  mkdir -p "$STATE" && chmod 700 "$STATE" && echo "$RELAY_IP" > "$STATE/relay_ip"
  # 중계기가 SSH 를 받을 때까지 최대 120초
  for i in $(seq 1 24); do ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "ec2-user@$RELAY_IP" true 2>/dev/null && break; sleep 5; done
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
    ssh -o BatchMode=yes -o ConnectTimeout=5 "ec2-user@$RELAY_IP" 'timeout 3 bash -c "</dev/tcp/127.0.0.1/5432" && echo tunnel-ok' 2>/dev/null | grep -q tunnel-ok && { echo tunnel-ok; return 0; }
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
u_vpc() { run terraform -chdir="$TFA" init -input=false && run terraform -chdir="$TFA" apply -input=false -auto-approve -var create_eks=false; }
u_eks_add() { run terraform -chdir="$TFA" apply -input=false -auto-approve -var create_eks=true; }
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
  if [ "$DRY" = 1 ]; then echo "DRY: MOCK_IAC= GITOPS_DISABLE=1 nohup npm run dev:worker / dev:api &" >> "$PROGRESS"; return 0; fi
  ( set -a; . "$ENVF"; set +a; MOCK_IAC= GITOPS_DISABLE=1 \
    nohup npm run dev:worker > "$DEMO_DAY_LOG_DIR/worker.log" 2>&1 & echo $! > "$STATE/worker.pid" )
  ( nohup npm run dev:api > "$DEMO_DAY_LOG_DIR/api.log" 2>&1 & echo $! > "$STATE/api.pid" )
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
u_preflight() {
  local rc=0
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
  mkdir -p "$STATE"
  step tools u_tools || abort "시작 점검 실패 (자원이 이미 있거나 도구 없음)"
  step gke-apply u_gke & gpid=$!
  step vpc-apply u_vpc || abort "aws/env (EKS 없이) apply 실패"
  step b1-facts u_facts || abort "B1 실패"
  step b2-relay u_relay || abort "B2 중계기·터널 실패"
  step b3-env u_envfile || abort "B3 실패"
  step b4-rds-start u_rds_start || abort "B4 시작 실패"
  step eks-add u_eks_add || abort "EKS 더하기 실패"
  wait $gpid; grc=$?
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
  mkdir -p "$STATE"
  step tools u_tools || abort "시작 점검 실패 (자원이 이미 있거나 도구 없음)"
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
  for i in $(seq 1 36); do
    a=$(aws elb describe-load-balancers --query "length(LoadBalancerDescriptions[?VPCId=='$vpc'])" --output text 2>/dev/null) || { echo "ELB 조회 실패 (classic)"; return 1; }
    b=$(aws elbv2 describe-load-balancers --query "length(LoadBalancers[?VpcId=='$vpc'])" --output text 2>/dev/null) || { echo "ELB 조회 실패 (v2)"; return 1; }
    n=$((a + b))
    [ "$n" -eq 0 ] && { echo "ELB 0 (${i}번째 확인)"; return 0; }
    sleep 5
  done
  echo "ELB $n 개 남음 (180초)"; return 1
}
# npm run 은 아래에 sh·tsx·node 를 띄운다. 맨 위 pid 만 끄면 워커가 살아남아 작업을 계속 집는다. 자식부터 끈다
killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null; return 0; }
d_procs() {
  local f
  for f in worker api tunnel; do
    [ -f "$STATE/$f.pid" ] || continue
    run killtree "$(cat "$STATE/$f.pid")"
    [ "$DRY" = 1 ] || rm -f "$STATE/$f.pid"
  done
  return 0
}
d_migration_tf() {
  local ids id rc=0
  if [ "$DRY" = 1 ]; then echo "DRY: npm run tf:real -- list → 이전마다 npm run tf:real -- destroy <id>" >> "$PROGRESS"; return 0; fi
  ids=$(npm run -s tf:real -- list | awk '$3 == "state" && $5 != "0개" { print $1 }')
  for id in $ids; do npm run -s tf:real -- destroy "$id" || rc=1; done
  return $rc
}
d_relay() { [ -d "$TFR/.terraform" ] || [ "$DRY" = 1 ] || { echo "중계기 init 흔적 없음 → 생략"; return 0; }
  # Z38 R8-27: 모듈의 data "aws_vpc" 가 destroy 때도 vpc_id 를 읽는다 → 아직 살아 있는 env 의 진짜 값을 넘긴다 (나머지는 쓰지 않는 자리값)
  local vpc
  vpc=$(tfout "$TFA" vpc_id) && [ -n "$vpc" ] || { echo "aws/env 출력 vpc_id 없음 → 중계기 destroy 를 못 함 (env 보다 먼저 지워야 한다)"; return 1; }
  run terraform -chdir="$TFR" destroy -input=false -auto-approve -var "vpc_id=$vpc" -var public_subnet_id=x -var ssh_public_key=x -var 'ssh_cidrs_json=["127.0.0.1/32"]'; }
d_eks() { run terraform -chdir="$TFA" destroy -input=false -auto-approve -var create_eks=true; }
d_gke() { run terraform -chdir="$TFG" destroy -input=false -auto-approve -var "project_id=$GCP_PROJECT"; }
d_zero() { run bash tools/cloud-zero.sh; }

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
