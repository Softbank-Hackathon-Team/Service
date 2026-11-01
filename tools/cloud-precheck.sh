#!/usr/bin/env bash
# 클라우드 사전 점검 (z75-51, 작업 Z78). 조회만 한다(만들기·고치기 없음). 10초 안. demo-day.sh up 시작 점검이 부른다. 따로 쳐도 된다.
#   bash tools/cloud-precheck.sh
# 항목 (줄마다 "OK|FAIL|WARN <항목> <설명>", 마지막 줄 "판정 PASS|FAIL 항목 N개 FAIL n WARN m 초 s")
#   region       AWS_REGION = ap-northeast-2, GCP_ZONE 이 asia-northeast3-
#   gcp-apis     gcloud services list --enabled 에 sqladmin·container·compute
#   gcp-billing  gcloud billing projects describe → billingEnabled true
#   sql-tier     (z75-52) 규칙: CLOUDSQL_DB_VERSION(POSTGRES_16, adapters gcp 기본) 이 16 이상이면 infra/modules/gcp/app/main.tf 에
#                edition 이 글자 그대로 있어야 한다. 없으면 FAIL (PG16+ 기본 ENTERPRISE_PLUS 는 db-f1-micro·db-g1-small 을 "Invalid Tier" 로 거절, 10/31 맥).
#                edition 이 ENTERPRISE_PLUS 인데 티어가 공유 코어(db-f1-micro·db-g1-small)여도 FAIL. 변수로 바뀌면 CLOUDSQL_EDITION 으로 덮는다
#                gcloud sql tiers list 는 CLOUDSQL_TIER(db-f1-micro) 가 있는지만 본다 (맥 실조회: 키가 DiskQuota·RAM·kind·region·tier 뿐, edition 칸 없음)
#   aws-quota-*  service-quotas 한도 − 지금 쓰는 수 ≥ 필요 수. VPC(vpc L-F678F1CE) 1, EIP(ec2 L-0263D0A3) 1(NAT), RDS(rds L-7B6409FD) 1
#                한도를 못 읽으면(권한 없음 등) WARN, 모자라면 FAIL
# 끝 코드: 0 = FAIL 없음, 1 = FAIL 있음
# 환경 변수: AWS_REGION GCP_PROJECT(finals-demo) GCP_ZONE(asia-northeast3-a) CLOUDSQL_TIER CLOUDSQL_EDITION(직접 정하기)
#            PRECHECK_CALL_SEC(8, 명령 하나 최대) NEED_VPC(1) NEED_EIP(1) NEED_RDS(1)
set -u
cd "$(dirname "$0")/.." || exit 1
T0=$(date +%s)
CALL=${PRECHECK_CALL_SEC:-8}
P=${GCP_PROJECT:-finals-demo}
ZONE=${GCP_ZONE:-asia-northeast3-a}
REGION=${AWS_REGION:-}
TIER=${CLOUDSQL_TIER:-db-f1-micro}
MAIN_TF=infra/modules/gcp/app/main.tf
DBV=${CLOUDSQL_DB_VERSION:-POSTGRES_16}
if [ -n "${CLOUDSQL_EDITION:-}" ]; then ED=$CLOUDSQL_EDITION; ED_FROM="환경 변수"
else
  ED=$(sed -n 's/^[[:space:]]*edition[[:space:]]*=[[:space:]]*"\([A-Z_]*\)".*/\1/p' "$MAIN_TF" 2>/dev/null | head -n 1); ED_FROM="main.tf"
fi
W=$(mktemp -d "${TMPDIR:-/tmp}/precheck.XXXXXX") || exit 1
trap 'rm -rf "$W"' EXIT

# tmo <초> <명령…>: macOS 에 timeout 이 없어서 직접. 시간 넘기면 자손까지 끄고 끝 코드 124
#   출력은 파일로 받아 찍는다(파이프로 받으면 꺼진 명령의 자식이 파이프를 잡고 있어 $(...) 가 안 끝난다)
#   감시자가 끄기 전에 "<출력>.to" 를 남긴다: 자식이 먼저 꺼져 래퍼가 0 으로 끝나도 124 로 본다 (Z38 R8-45)
killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -TERM "$1" 2>/dev/null; }
tmo() {
  local s=$1 o rc; shift
  o=$(mktemp "$W/o.XXXXXX")
  "$@" > "$o" & local p=$!
  ( sleep "$s"; : > "$o.to"; killtree "$p" ) >/dev/null 2>&1 & local k=$!
  wait "$p" 2>/dev/null; rc=$?
  kill "$k" 2>/dev/null; wait "$k" 2>/dev/null
  [ -f "$o.to" ] && rc=124
  cat "$o"; rm -f "$o" "$o.to"
  return $rc
}
say() { echo "$1 $2 $3" >> "$W/$2.res"; }

c_region() {
  local bad=""
  [ "$REGION" = ap-northeast-2 ] || bad="AWS_REGION=${REGION:-비어 있음}"
  case "$ZONE" in asia-northeast3-*) ;; *) bad="$bad GCP_ZONE=$ZONE" ;; esac
  if [ -z "$bad" ]; then say OK region "서울 (ap-northeast-2, $ZONE)"; else say FAIL region "서울 아님:$bad"; fi
}
c_apis() {
  local out rc miss="" a
  out=$(tmo "$CALL" gcloud services list --enabled --project "$P" --format='value(config.name)' 2>"$W/apis.err"); rc=$?
  [ $rc -eq 0 ] || { say FAIL gcp-apis "조회 실패 rc=$rc ($(head -c 120 "$W/apis.err" | tr '\n' ' '))"; return; }
  for a in sqladmin container compute; do echo "$out" | grep -qx "$a.googleapis.com" || miss="$miss $a"; done
  if [ -z "$miss" ]; then say OK gcp-apis "sqladmin·container·compute 켜짐"; else say FAIL gcp-apis "꺼진 API:$miss (gcloud services enable <이름>.googleapis.com)"; fi
}
c_billing() {
  local out rc
  out=$(tmo "$CALL" gcloud billing projects describe "$P" --format='value(billingEnabled)' 2>"$W/bill.err"); rc=$?
  [ $rc -eq 0 ] || { say FAIL gcp-billing "조회 실패 rc=$rc"; return; }
  case "$out" in True|true) say OK gcp-billing "결제 계정 연결됨" ;; *) say FAIL gcp-billing "결제 계정 연결 안 됨 ($out)" ;; esac
}
c_tier() {
  local rc major=${DBV##*_} rule=""
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  if [ "$major" -ge 16 ] && [ -z "$ED" ]; then rule="FAIL $DBV 인데 main.tf 에 edition 이 없음 (기본 ENTERPRISE_PLUS 가 $TIER 를 거절한다)"
  elif [ "$ED" = ENTERPRISE_PLUS ]; then case "$TIER" in db-f1-micro|db-g1-small) rule="FAIL ENTERPRISE_PLUS 는 공유 코어 $TIER 를 받지 않음" ;; esac
  fi
  tmo "$CALL" gcloud sql tiers list --project "$P" --format='value(tier)' > "$W/tiers.txt" 2>"$W/tiers.err"; rc=$?
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
  if [ $((lim - used)) -ge "$need" ]; then say OK "aws-quota-$name" "한도 $lim, 사용 $used, 필요 $need"
  else say FAIL "aws-quota-$name" "모자람: 한도 $lim, 사용 $used, 필요 $need (Service Quotas 에서 증설 요청)"; fi
}
c_vpc() { q vpc vpc L-F678F1CE "${NEED_VPC:-1}" aws ec2 describe-vpcs --region "$REGION" --query 'length(Vpcs)' --output text; }
c_eip() { q eip ec2 L-0263D0A3 "${NEED_EIP:-1}" aws ec2 describe-addresses --region "$REGION" --query 'length(Addresses)' --output text; }
c_rds() { q rds rds L-7B6409FD "${NEED_RDS:-1}" aws rds describe-db-instances --region "$REGION" --query 'length(DBInstances)' --output text; }

c_region
for c in c_apis c_billing c_tier c_vpc c_eip c_rds; do $c & done
wait
cat "$W"/*.res
n=$(cat "$W"/*.res | wc -l | tr -d ' ')
nf=$(cat "$W"/*.res | grep -c '^FAIL')
nw=$(cat "$W"/*.res | grep -c '^WARN')
v=PASS; [ "$nf" -eq 0 ] || v=FAIL
echo "판정 $v 항목 ${n}개 FAIL $nf WARN $nw 초 $(( $(date +%s) - T0 ))"
[ "$nf" -eq 0 ]
