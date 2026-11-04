#!/usr/bin/env bash
# 클라우드 사전 점검 (z75-51, 작업 Z78). 조회만 한다(만들기·고치기 없음). 10초 안. demo-day.sh up 시작 점검이 부른다. 따로 쳐도 된다.
#   bash tools/cloud-precheck.sh
# 항목 (줄마다 "OK|FAIL|WARN <항목> <설명>", 마지막 줄 "판정 PASS|FAIL 항목 N개 FAIL n WARN m 초 s")
#   region       AWS_REGION = ap-northeast-2, GCP_ZONE 이 asia-northeast3-  (AWS_REGION 이 비면 demo-day 와 같은 ap-northeast-2)
#   aws-auth     aws sts get-caller-identity → 12자리 계정 번호 (SSO 만료·프로필 틀림을 up 도중이 아니라 여기서 잡는다. 계정 번호는 안 찍음)
#   gcp-auth     gcloud auth print-access-token 이 되는가 (토큰은 안 찍음)
#   gcp-apis     gcloud services list --enabled 에 serviceusage (FAIL), 나머지(sqladmin·container·compute·iam·iamcredentials…)는 gcp/env apply 가 켬 → 꺼져 있으면 WARN
#   gcp-billing  gcloud billing projects describe → billingEnabled true
#   sql-tier     (z75-52) 규칙: CLOUDSQL_DB_VERSION(POSTGRES_16, adapters gcp 기본) 이 16 이상이면 infra/modules/gcp/app/main.tf 에
#                edition 이 글자 그대로 있어야 한다. 없으면 FAIL (PG16+ 기본 ENTERPRISE_PLUS 는 db-f1-micro·db-g1-small 을 "Invalid Tier" 로 거절, 10/31 맥).
#                edition 이 ENTERPRISE_PLUS 인데 티어가 공유 코어(db-f1-micro·db-g1-small)여도 FAIL. 변수로 바뀌면 CLOUDSQL_EDITION 으로 덮는다
#                gcloud sql tiers list 는 CLOUDSQL_TIER(db-f1-micro) 가 있는지만 본다 (맥 실조회: 키가 DiskQuota·RAM·kind·region·tier 뿐, edition 칸 없음)
#   aws-quota-*  service-quotas 한도 − 지금 쓰는 수 ≥ 필요 수. VPC(vpc L-F678F1CE) 1, EIP(ec2 L-0263D0A3) 1(NAT), RDS(rds L-7B6409FD) 1,
#                vCPU(ec2 L-1216C47A, 표준 인스턴스) NEED_VCPU 6 = EKS 노드 t3.medium 2대(4) + 중계기 t4g.nano(2)  (GATE)
#                한도를 못 읽으면(권한 없음 등) WARN, 모자라면 FAIL
#   gcp-quota    (GATE) 지역 한도 CPUS 남은 것 ≥ NEED_GCP_CPUS 4 (e2-standard-2 2대), IN_USE_ADDRESSES ≥ NEED_GCP_ADDR 2 (Cloud NAT + LB)
# 끝 코드: 0 = FAIL 없음, 1 = FAIL 있음
# 환경 변수: AWS_REGION TARGET_PROJECT_ID(도착 전용 프로젝트, 있으면 GCP 점검은 여기) GCP_PROJECT(finals-demo) GCP_ZONE(asia-northeast3-a) CLOUDSQL_TIER CLOUDSQL_EDITION(직접 정하기)
#            PRECHECK_CALL_SEC(30, 명령 하나 최대. gcloud 첫 호출이 18초 걸린 적 있음) NEED_VPC(1) NEED_EIP(1) NEED_RDS(1) NEED_VCPU(6) NEED_GCP_CPUS(4) NEED_GCP_ADDR(2)
set -u
cd "$(dirname "$0")/.." || exit 1
T0=$(date +%s)
CALL=${PRECHECK_CALL_SEC:-30}
# RV-22: 전체 제한. 부르는 쪽(up-preflight tmo 60)보다 짧아야 이 스크립트가 스스로 끝나며 어느 점검이 시간에 걸렸는지 남긴다.
#   (예전: 호출당 30초 × gcloud 5개 차례 × 시간 초과 때 한 번 더 = 최악 300초 > 바깥 60초 → 바깥이 먼저 끊어 이유 없는 FAIL)
#   각 호출 제한 = min(PRECHECK_CALL_SEC, 남은 시간). 다 쓰면 남은 호출은 바로 124 + "총 제한" 표시. 다시 하기는 남은 시간이 있을 때만
TOTAL=${PRECHECK_TOTAL_SEC:-50}
case "$TOTAL" in ''|*[!0-9]*) TOTAL=50 ;; esac
DEADLINE=$((T0 + TOTAL))
# 결정 3 A안: GCP 점검(API·결제·티어·한도)은 도착 자원이 생기는 전용 프로젝트(TARGET_PROJECT_ID)를 본다. 없으면 예전처럼 GCP_PROJECT
P=${TARGET_PROJECT_ID:-${GCP_PROJECT:-finals-demo}}
ZONE=${GCP_ZONE:-asia-northeast3-a}
# UPREV-A: demo-day.sh 와 같은 기본값. 예전엔 AWS_REGION 이 비면 "서울 아님" FAIL, AWS_PROFILE 이 비면 기본 프로필(다른 계정)을 조회했다
export AWS_PROFILE=${AWS_PROFILE:-finals}
REGION=${AWS_REGION:-ap-northeast-2}
export AWS_DEFAULT_REGION=$REGION
TIER=${CLOUDSQL_TIER:-db-f1-micro}
MAIN_TF=infra/modules/gcp/app/main.tf
DBV=${CLOUDSQL_DB_VERSION:-POSTGRES_16}
if [ -n "${CLOUDSQL_EDITION:-}" ]; then ED=$CLOUDSQL_EDITION; ED_FROM="환경 변수"
else
  ED=$(sed -n 's/^[[:space:]]*edition[[:space:]]*=[[:space:]]*"\([A-Z_]*\)".*/\1/p' "$MAIN_TF" 2>/dev/null | head -n 1); ED_FROM="main.tf"
fi
# NOTTY: 뒤로 띄운 줄(j_bg·nohup)이 터미널 입력을 물려받으면 gcloud·aws 가 묻는 창(프롬프트·페이저)에서 터미널을 읽다 멈춘다
#   (11/3 5차: Jeong 터미널에서 띄운 up 만 cloud-precheck gcp-billing 이 30초 넘게 멈춤, 맥 RC 에선 2~4초) → 묻지 않게·페이저 끄기
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 AWS_PAGER="" PAGER=cat
W=$(mktemp -d "${TMPDIR:-/tmp}/precheck.XXXXXX") || exit 1
trap 'rm -rf "$W"' EXIT

# tmo <초> <명령…>: macOS 에 timeout 이 없어서 직접. 시간 넘기면 자손까지 끄고 끝 코드 124
#   출력은 파일로 받아 찍는다(파이프로 받으면 꺼진 명령의 자식이 파이프를 잡고 있어 $(...) 가 안 끝난다)
#   감시자가 끄기 전에 "<출력>.to" 를 남긴다: 자식이 먼저 꺼져 래퍼가 0 으로 끝나도 124 로 본다 (Z38 R8-45)
killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -TERM "$1" 2>/dev/null; }
tmo() {
  local s=$1 o rc left; shift
  left=$((DEADLINE - $(date +%s)))
  if [ "$left" -le 0 ]; then echo "$(date -u +%H:%M:%SZ) 총 제한 ${TOTAL}초를 다 씀 → 안 부름: $1 $2 $3" >> "$W/retry.log"; return 124; fi
  [ "$s" -gt "$left" ] && s=$left
  o=$(mktemp "$W/o.XXXXXX")
  "$@" < /dev/null > "$o" & local p=$!   # NOTTY: 터미널 입력을 안 물려줌
  ( sleep "$s"; : > "$o.to"; killtree "$p" ) >/dev/null 2>&1 & local k=$!
  wait "$p" 2>/dev/null; rc=$?
  kill "$k" 2>/dev/null; wait "$k" 2>/dev/null
  [ -f "$o.to" ] && rc=124
  cat "$o"; rm -f "$o" "$o.to"
  return $rc
}
say() { echo "$1 $2 $3" >> "$W/$2.res"; }
# GBILLRETRY (11/3 9회차 앞): gcloud 를 5개 동시에 띄우면 자격 갱신이 몰려 가끔(6~7번에 1번) 한 호출이 시간 초과(124). 단독이면 2.5초.
#   → gcloud 는 동시에 띄우지 않고 한 줄로 차례로(gcp_all), 각 호출은 124 일 때만 한 번 더 (gtmo). aws 쪽은 그대로 동시에
gtmo() { local rc; tmo "$@"; rc=$?; [ $rc -eq 124 ] || return $rc; [ $((DEADLINE - $(date +%s))) -gt 2 ] || return 124; echo "$(date -u +%H:%M:%SZ) 시간 초과 → 한 번 더: $2 $3" >> "$W/retry.log"; tmo "$@"; }

c_region() {
  local bad=""
  [ "$REGION" = ap-northeast-2 ] || bad="AWS_REGION=${REGION:-비어 있음}"
  case "$ZONE" in asia-northeast3-*) ;; *) bad="$bad GCP_ZONE=$ZONE" ;; esac
  if [ -z "$bad" ]; then say OK region "서울 (ap-northeast-2, $ZONE)"; else say FAIL region "서울 아님:$bad"; fi
}
c_aws_auth() {
  local out rc
  out=$(tmo "$CALL" aws sts get-caller-identity --query Account --output text 2>"$W/awsauth.err"); rc=$?
  case "$out" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) [ $rc -eq 0 ] && { say OK aws-auth "프로필 $AWS_PROFILE 로 로그인됨"; return; } ;;
  esac
  say FAIL aws-auth "AWS 자격 안 됨 rc=$rc 프로필 $AWS_PROFILE ($(head -c 100 "$W/awsauth.err" | tr '\n' ' ')) → aws sso login --profile $AWS_PROFILE"
}
c_gcp_auth() {
  local rc
  gtmo "$CALL" gcloud auth print-access-token > /dev/null 2>"$W/gauth.err"; rc=$?
  if [ $rc -eq 0 ]; then say OK gcp-auth "gcloud 로그인됨"; else say FAIL gcp-auth "gcloud 토큰 못 받음 rc=$rc → gcloud auth login"; fi
}
c_apis() {
  local out rc miss="" late="" a
  out=$(gtmo "$CALL" gcloud services list --enabled --project "$P" --format='value(config.name)' 2>"$W/apis.err"); rc=$?
  [ $rc -eq 0 ] || { say FAIL gcp-apis "조회 실패 rc=$rc ($(head -c 120 "$W/apis.err" | tr '\n' ' '))"; return; }
  # GATE-gcp: serviceusage 가 꺼져 있으면 gcp/env 의 google_project_service(나머지 API 켜기)부터 실패한다 → FAIL.
  #   servicenetworking·artifactregistry·secretmanager 는 apply 가 켜 주지만, 켜는 직후 몇 분은 "has not been used" 로 실패할 수 있다 → WARN (미리 켜 두면 안전)
  # FM-CLD-14: iam(앱 SA)·iamcredentials(고객 SA 빌리기)는 이제 gcp/env apply 가 켠다(google_project_service), 앱 층 API(redis·run·pubsub…)는
  #   gcp/root 가 IR 종류를 보고 켠다 → 손으로 gcloud services enable 할 일 없음. 켜는 직후 몇 분 지연만 WARN
  #   serviceusage 만 FAIL: 나머지를 켜는 API 라 terraform 이 켤 수 없다
  for a in serviceusage; do echo "$out" | grep -qx "$a.googleapis.com" || miss="$miss $a"; done
  for a in sqladmin container compute servicenetworking artifactregistry secretmanager iam iamcredentials; do echo "$out" | grep -qx "$a.googleapis.com" || late="$late $a"; done
  if [ -n "$miss" ]; then say FAIL gcp-apis "꺼진 API:$miss (gcloud services enable <이름>.googleapis.com --project $P)"
  elif [ -n "$late" ]; then say WARN gcp-apis "apply 가 켤 API:$late (미리 켜 두면 안전: gcloud services enable <이름>.googleapis.com --project $P)"
  else say OK gcp-apis "sqladmin·container·compute·serviceusage·servicenetworking·artifactregistry·secretmanager·iam·iamcredentials 켜짐"; fi
}
c_billing() {
  local out rc
  out=$(gtmo "$CALL" gcloud billing projects describe "$P" --format='value(billingEnabled)' 2>"$W/bill.err"); rc=$?
  [ $rc -eq 0 ] || { say FAIL gcp-billing "조회 실패 rc=$rc"; return; }
  case "$out" in True|true) say OK gcp-billing "결제 계정 연결됨" ;; *) say FAIL gcp-billing "결제 계정 연결 안 됨 ($out)" ;; esac
}
c_tier() {
  local rc major=${DBV##*_} rule=""
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  if [ "$major" -ge 16 ] && [ -z "$ED" ]; then rule="FAIL $DBV 인데 main.tf 에 edition 이 없음 (기본 ENTERPRISE_PLUS 가 $TIER 를 거절한다)"
  elif [ "$ED" = ENTERPRISE_PLUS ]; then case "$TIER" in db-f1-micro|db-g1-small) rule="FAIL ENTERPRISE_PLUS 는 공유 코어 $TIER 를 받지 않음" ;; esac
  fi
  gtmo "$CALL" gcloud sql tiers list --project "$P" --format='value(tier)' > "$W/tiers.txt" 2>"$W/tiers.err"; rc=$?
  if [ -n "$rule" ]; then say FAIL sql-tier "${rule#FAIL } ($ED_FROM)"; return; fi
  [ $rc -eq 0 ] || { say FAIL sql-tier "티어 목록 조회 실패 rc=$rc"; return; }
  if grep -qx "$TIER" "$W/tiers.txt"; then say OK sql-tier "$TIER 있음, $DBV, 에디션 ${ED:-기본}($ED_FROM)"
  else say FAIL sql-tier "$TIER 가 티어 목록에 없음"; fi
}
# q <항목> <서비스> <코드> <필요> <지금 쓰는 수 명령…>
q() {
  local name=$1 svc=$2 code=$3 need=$4; shift 4
  local lim used rc
  lim=$(tmo "$CALL" aws service-quotas get-service-quota --region "$REGION" --service-code "$svc" --quota-code "$code" --query Quota.Value --output text 2>/dev/null); rc=$?
  [ $rc -eq 0 ] && [ -n "$lim" ] || { say WARN "aws-quota-$name" "한도 못 읽음 rc=$rc ($svc $code)"; return; }
  used=$(tmo "$CALL" "$@" 2>/dev/null); rc=$?
  [ $rc -eq 0 ] && [ -n "$used" ] || { say WARN "aws-quota-$name" "지금 수 못 읽음 rc=$rc"; return; }
  lim=${lim%%.*}
  # UPREV-A: "None"·빈 값이 산술에서 0 으로 읽혀 조용히 통과/오판하던 것을 막는다
  case "$lim$used" in *[!0-9]*|"") say WARN "aws-quota-$name" "한도·사용 값이 숫자가 아님 (한도 '$lim', 사용 '$used')"; return ;; esac
  case "$lim" in "") say WARN "aws-quota-$name" "한도 값이 비었음"; return ;; esac
  if [ $((lim - used)) -ge "$need" ]; then say OK "aws-quota-$name" "한도 $lim, 사용 $used, 필요 $need"
  else say FAIL "aws-quota-$name" "모자람: 한도 $lim, 사용 $used, 필요 $need (Service Quotas 에서 증설 요청)"; fi
}
c_vpc() { q vpc vpc L-F678F1CE "${NEED_VPC:-1}" aws ec2 describe-vpcs --region "$REGION" --query 'length(Vpcs)' --output text; }
c_eip() { q eip ec2 L-0263D0A3 "${NEED_EIP:-1}" aws ec2 describe-addresses --region "$REGION" --query 'length(Addresses)' --output text; }
c_rds() { q rds rds L-7B6409FD "${NEED_RDS:-1}" aws rds describe-db-instances --region "$REGION" --query 'length(DBInstances)' --output text; }
# GATE: 표준 인스턴스 vCPU 한도가 모자라면 EKS 노드 그룹(apply 뒤 ≈15분)에서 멈춘다. 쓰는 수 = 켜진 인스턴스의 코어×스레드 합
vcpu_used() { aws ec2 describe-instances --region "$REGION" --filters Name=instance-state-name,Values=pending,running --query 'Reservations[].Instances[].CpuOptions.[CoreCount,ThreadsPerCore]' --output json | jq '[.[] | ((.[0] // 1) * (.[1] // 1))] | add // 0'; }
c_vcpu() { if command -v jq >/dev/null 2>&1; then q vcpu ec2 L-1216C47A "${NEED_VCPU:-6}" vcpu_used; else say WARN aws-quota-vcpu "jq 없음"; fi; }
# GATE: GCP 한도. 지역(asia-northeast3) + 전역(프로젝트). "남은 것(limit-usage) ≥ 필요" 인지 본다
#   GATE-gcp DRAFT(ai) 필요 수: CPUS 4·INSTANCES 2 (e2-standard-2 노드 2대), IN_USE_ADDRESSES 2 (Cloud NAT + LB),
#   SSD_TOTAL_GB 200 (GKE 노드 부팅 디스크 기본 pd-balanced 100GB ×2 — pd-balanced 는 SSD 한도로 셈【추정, GKE 기본값】),
#   전역 NETWORKS 1·FIREWALLS 10 (GKE 자체 5 + LB 2 + 여유)·ROUTERS 1·GLOBAL_INTERNAL_ADDRESSES 1 (PSA 범위)·CPUS_ALL_REGIONS 4
#   한도 항목이 응답에 없으면(새 프로젝트 모양 차이) 그 항목만 WARN. 모자라면 FAIL → apply 전에 멈춤
GCP_NEED_REGION=${GCP_NEED_REGION:-"CPUS=${NEED_GCP_CPUS:-4} INSTANCES=2 IN_USE_ADDRESSES=${NEED_GCP_ADDR:-2} SSD_TOTAL_GB=200"}
GCP_NEED_GLOBAL=${GCP_NEED_GLOBAL:-"NETWORKS=1 FIREWALLS=10 ROUTERS=1 GLOBAL_INTERNAL_ADDRESSES=1 CPUS_ALL_REGIONS=4"}
# quota_eval <json 파일> <필요 목록> → 줄마다 "OK|FAIL|MISS 이름 남은 필요"
quota_eval() { python3 - "$1" "$2" <<'PY2'
import json, sys
try: q = {x.get("metric"): x for x in json.load(open(sys.argv[1])).get("quotas", [])}
except Exception: print("ERR - - -"); sys.exit(0)
for item in sys.argv[2].split():
    m, need = item.split("="); need = float(need)
    if m not in q or "limit" not in q[m]: print("MISS", m, "-", int(need)); continue
    left = float(q[m]["limit"]) - float(q[m].get("usage", 0))
    print("OK" if left >= need else "FAIL", m, int(left), int(need))
PY2
}
c_gcp_quota() {
  local rc reg=${ZONE%-*} res bad="" miss="" okl=""
  gtmo "$CALL" gcloud compute regions describe "$reg" --project "$P" --format=json > "$W/gq-r.json" 2>"$W/gq.err"; rc=$?
  [ $rc -eq 0 ] || { say WARN gcp-quota "지역 한도 못 읽음 rc=$rc"; return; }
  gtmo "$CALL" gcloud compute project-info describe --project "$P" --format=json > "$W/gq-g.json" 2>>"$W/gq.err"; rc=$?
  [ $rc -eq 0 ] || { say WARN gcp-quota "전역 한도 못 읽음 rc=$rc"; return; }
  res=$( { quota_eval "$W/gq-r.json" "$GCP_NEED_REGION"; quota_eval "$W/gq-g.json" "$GCP_NEED_GLOBAL"; } )
  case "$res" in *ERR*) say WARN gcp-quota "한도 응답을 못 읽음 (JSON 아님)"; return ;; esac
  while read -r v m l n; do
    case "$v" in OK) okl="$okl $m:$l/$n" ;; FAIL) bad="$bad $m 남은 $l<필요 $n" ;; MISS) miss="$miss $m" ;; esac
  done <<EOF
$res
EOF
  if [ -n "$bad" ]; then say FAIL gcp-quota "모자람 ($reg·전역):$bad (콘솔 IAM 및 관리자 → 할당량에서 증설 요청)"
  elif [ -n "$miss" ]; then say WARN gcp-quota "응답에 없는 한도:$miss (나머지 OK:$okl)"
  else say OK gcp-quota "남은/필요$okl"; fi
}

c_region
gcp_all() { c_gcp_auth; c_apis; c_billing; c_tier; c_gcp_quota; }   # 자격 확인(토큰 갱신)을 먼저 한 번 → 뒤 호출은 그 토큰을 씀
for c in c_aws_auth c_vpc c_eip c_rds c_vcpu gcp_all; do $c & done
wait
[ -s "$W/retry.log" ] && sed 's/^/참고 /' "$W/retry.log"
cat "$W"/*.res
n=$(cat "$W"/*.res | wc -l | tr -d ' ')
nf=$(cat "$W"/*.res | grep -c '^FAIL')
nw=$(cat "$W"/*.res | grep -c '^WARN')
v=PASS; [ "$nf" -eq 0 ] || v=FAIL
el=$(( $(date +%s) - T0 ))
[ "$el" -ge "$TOTAL" ] && echo "참고 총 제한 ${TOTAL}초에 걸림: 위에서 rc=124 인 항목이 시간에 걸린 점검 (PRECHECK_TOTAL_SEC 로 바꿈)"
echo "판정 $v 항목 ${n}개 FAIL $nf WARN $nw 초 $(( $(date +%s) - T0 ))"
[ "$nf" -eq 0 ]
