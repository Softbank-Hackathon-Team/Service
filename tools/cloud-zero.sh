#!/usr/bin/env bash
# 클라우드 자원이 0인지 조회만 한다 (Z75-21). 지우지 않는다. terraform destroy 뒤에 돌린다
#
# 사용
#   bash tools/cloud-zero.sh                AWS + GCP
#   bash tools/cloud-zero.sh aws            AWS 만
#   bash tools/cloud-zero.sh gcp            GCP 만
# 환경 변수
#   AWS_PROFILE        그대로 쓴다 (.env 의 finals)
#   AWS_REGION         기본 ap-northeast-2 (서울)
#   GCP_PROJECT        없으면 gcloud 기본 프로젝트
#   CLOUD_ZERO_IGNORE  모든 줄(AWS 태그 조회·AWS·GCP 개별 조회)의 결과에서 빼 둘 확장 정규식 (z75-39). 기본 없음
#                      예: 다른 회차 GKE 를 일부러 켜 둔 채 Cloud SQL 만 0 인지 볼 때 CLOUD_ZERO_IGNORE='gke-|app-demo' bash tools/cloud-zero.sh
#                      뺀 것이 있으면 그 줄에 "예외: <정규식> 로 N개 뺌", 끝 줄은 "OK zero (예외: <정규식>)" 로 예외 없는 0 과 구별한다
# 태그 조회 결과는 종류별로 직접 조회해 NotFound·terminated 면 "stale" 로 빼고 개수만 한 줄 찍는다 (R7-4)
# 출력: "항목: 개수" 표. 합이 0 이면 마지막 줄 "OK zero" + 끝 코드 0, 하나라도 있으면 남은 것 목록 + 끝 코드 1
#       조회 자체가 실패하면(자격 없음·권한 없음) 그 줄에 "조회 실패", 끝 코드 2 (0 이라고 말하지 않는다)
set -u

REGION=${AWS_REGION:-ap-northeast-2}
WHAT=${1:-all}
TOTAL=0
FAILED=0
LEFT=""
IGNORED=0

# Z38 REVIEW-7 R7-2: 오류 파일은 이 실행만의 임시 파일 (고정 /tmp 이름은 다른 실행·다른 사용자와 겹친다)
ERR=$(mktemp "${TMPDIR:-/tmp}/cloud-zero.XXXXXX")
STALE_LIST=$(mktemp "${TMPDIR:-/tmp}/cloud-zero-stale.XXXXXX")
trap 'rm -f "$ERR" "$STALE_LIST"' EXIT

row() { printf '%-34s %s\n' "$1:" "$2"; }

# $1 = 이름, 나머지 = 결과를 한 줄에 하나씩 내는 명령
count() {
  name=$1; shift
  if ! out=$("$@" 2>"$ERR"); then
    row "$name" "조회 실패 ($(head -c 120 "$ERR" | tr '\n' ' '))"
    FAILED=1; return
  fi
  out=$(printf '%s\n' "$out" | tr '\t' '\n' | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
  # z75-39: 예외 정규식은 여기 한 곳에서 모든 줄에 같이 건다 (예전엔 AWS 태그 조회 줄에만)
  ign=0
  if [ -n "${CLOUD_ZERO_IGNORE:-}" ] && [ -n "$out" ]; then
    kept=$(printf '%s\n' "$out" | grep -Ev -- "$CLOUD_ZERO_IGNORE" || true)
    ign=$(( $(printf '%s' "$out" | grep -c . || true) - $(printf '%s' "$kept" | grep -c . || true) ))
    out=$kept; IGNORED=$((IGNORED + ign))
  fi
  n=$(printf '%s' "$out" | grep -c . || true)
  if [ "$ign" -gt 0 ]; then row "$name" "$n (예외: $CLOUD_ZERO_IGNORE 로 ${ign}개 뺌)"; else row "$name" "$n"; fi
  TOTAL=$((TOTAL + n))
  [ "$n" -gt 0 ] && LEFT="$LEFT
[$name]
$out"
  return 0
}

# 아래 함수들은 count 가 "$@" 로 부른다 (shellcheck 는 못 봄)
# shellcheck disable=SC2329
aws_q() { aws --region "$REGION" --output text "$@"; }

# R7-4: 태그 조회(get-resources)는 지운 지 얼마 안 된 자원의 ARN 을 한동안 그대로 돌려준다 (맥 실측: 인스턴스·NAT·ENI·서브넷·EKS 가
#   직접 조회하면 전부 NotFound·terminated). 종류별로 직접 조회해 없거나 끝난 것은 뺀다. 모르는 종류·다른 오류는 남은 것으로 센다(보수적)
# $1 = ARN. 끝 코드 0 = 살아 있음(또는 판단 못 함), 1 = 없음·끝남(stale)
aws_alive() {
  arn=$1; svc=$(printf '%s' "$arn" | cut -d: -f3); res=$(printf '%s' "$arn" | cut -d: -f6-)
  # Z38 R8-6: 자원 칸은 "종류/번호"(ec2·eks) 와 "종류:이름"(rds·secretsmanager) 두 모양. 예전엔 / 만 봐서 rds·비밀은 늘 "모르는 종류"
  rtype=${res%%[:/]*}; rid=${res#*[:/]}; rid=${rid%%/*}
  st=""
  case "$svc:$rtype" in
    ec2:instance)          st=$(aws_q ec2 describe-instances --instance-ids "$rid" --query 'Reservations[].Instances[].State.Name' 2>"$ERR") ;;
    ec2:natgateway)        st=$(aws_q ec2 describe-nat-gateways --nat-gateway-ids "$rid" --query 'NatGateways[].State' 2>"$ERR") ;;
    ec2:network-interface) st=$(aws_q ec2 describe-network-interfaces --network-interface-ids "$rid" --query 'NetworkInterfaces[].Status' 2>"$ERR") ;;
    ec2:subnet)            st=$(aws_q ec2 describe-subnets --subnet-ids "$rid" --query 'Subnets[].State' 2>"$ERR") ;;
    ec2:vpc)               st=$(aws_q ec2 describe-vpcs --vpc-ids "$rid" --query 'Vpcs[].State' 2>"$ERR") ;;
    ec2:security-group)    st=$(aws_q ec2 describe-security-groups --group-ids "$rid" --query 'SecurityGroups[].GroupId' 2>"$ERR") ;;
    ec2:route-table)       st=$(aws_q ec2 describe-route-tables --route-table-ids "$rid" --query 'RouteTables[].RouteTableId' 2>"$ERR") ;;
    ec2:internet-gateway)  st=$(aws_q ec2 describe-internet-gateways --internet-gateway-ids "$rid" --query 'InternetGateways[].InternetGatewayId' 2>"$ERR") ;;
    ec2:volume)            st=$(aws_q ec2 describe-volumes --volume-ids "$rid" --query 'Volumes[].State' 2>"$ERR") ;;
    ec2:elastic-ip)        st=$(aws_q ec2 describe-addresses --allocation-ids "$rid" --query 'Addresses[].AllocationId' 2>"$ERR") ;;
    ec2:launch-template)   st=$(aws_q ec2 describe-launch-templates --launch-template-ids "$rid" --query 'LaunchTemplates[].LaunchTemplateId' 2>"$ERR") ;;
    # eks: cluster/<이름>, nodegroup/<클러스터>/…, addon/<클러스터>/…, podidentityassociation/<클러스터>/… → 클러스터가 없으면 딸린 것도 없다
    eks:*)                 st=$(aws_q eks describe-cluster --name "$rid" --query 'cluster.status' 2>"$ERR") ;;
    # Z38 R8-6: B 회차(RDS 만)가 만들고 지우는 것. 지운 RDS 는 태그 조회에 남아 B 뒤 cloud-zero 가 늘 1 이 됨
    ec2:key-pair)          st=$(aws_q ec2 describe-key-pairs --key-pair-ids "$rid" --query 'KeyPairs[].KeyPairId' 2>"$ERR") ;;
    rds:db)                st=$(aws_q rds describe-db-instances --db-instance-identifier "$rid" --query 'DBInstances[].DBInstanceStatus' 2>"$ERR") ;;
    rds:subgrp)            st=$(aws_q rds describe-db-subnet-groups --db-subnet-group-name "$rid" --query 'DBSubnetGroups[].DBSubnetGroupName' 2>"$ERR") ;;
    rds:pg)                st=$(aws_q rds describe-db-parameter-groups --db-parameter-group-name "$rid" --query 'DBParameterGroups[].DBParameterGroupName' 2>"$ERR") ;;
    ecr:repository)        st=$(aws_q ecr describe-repositories --repository-names "${res#repository/}" --query 'repositories[].repositoryName' 2>"$ERR") ;;
    # 비밀: 삭제 예약(복구 창 7일, terraform recovery_window_in_days)이면 DeletedDate 가 찍힘 → 남은 것 아님 (예약 중엔 요금 없음【추정】)
    secretsmanager:secret) st=$(aws_q secretsmanager describe-secret --secret-id "$arn" --query 'DeletedDate' 2>"$ERR")
                           rc=$?
                           [ "$rc" -ne 0 ] && { grep -qiE 'NotFound|ResourceNotFoundException|marked for deletion' "$ERR" && return 1; return 0; }
                           st=$(printf '%s' "$st" | tr -d '[:space:]')
                           { [ -z "$st" ] || [ "$st" = None ]; } && return 0
                           return 1 ;;
    *) return 0 ;;
  esac
  rc=$?
  if [ "$rc" -ne 0 ]; then
    grep -qiE 'NotFound|ResourceNotFoundException|does not exist' "$ERR" && return 1
    return 0
  fi
  st=$(printf '%s' "$st" | tr '\t' '\n' | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
  [ -z "$st" ] && return 1
  printf '%s\n' "$st" | grep -qvE '^(terminated|deleted|DELETING)$' || return 1
  return 0
}

# shellcheck disable=SC2329
aws_tagged() {
  # Z38 REVIEW-7 R7-1: aws 가 실패하면(tag:GetResources 권한 없음 등) 실패로 돌려준다.
  #   예전엔 파이프 끝 "|| true" 가 aws 의 실패까지 삼켜 0개 → 다른 조회가 다 되면 "OK zero" 라고 거짓으로 말했다
  raw=$(aws_q resourcegroupstaggingapi get-resources --query 'ResourceTagMappingList[].ResourceARN') || return 1
  # 예외(CLOUD_ZERO_IGNORE)는 count 가 모든 줄에 같이 건다 (z75-39). 여기서는 빼지 않는다 → 이 줄에도 "예외: … N개 뺌" 이 찍힌다
  arns=$(printf '%s\n' "$raw" | tr '\t' '\n' | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
  for a in $arns; do
    if aws_alive "$a"; then printf '%s\n' "$a"; else echo "$a" >> "$STALE_LIST"; fi
  done
  return 0
}

if [ "$WHAT" = all ] || [ "$WHAT" = aws ]; then
  if ! command -v aws >/dev/null 2>&1; then row "AWS" "조회 실패 (aws 명령 없음)"; FAILED=1; else
    echo "== AWS ($REGION, profile ${AWS_PROFILE:-기본})"
    count "태그 붙은 자원(get-resources)" aws_tagged
    n_stale=$(grep -c . "$STALE_LIST" || true)
    # Z38 R8-6: 무엇을 뺐는지 종류별 개수도 (예: ec2:instance 1, rds:db 1, secretsmanager:secret 3)
    kinds=$(cut -d: -f3,6 "$STALE_LIST" | sed -E 's#^([^:]*):([^:/]*).*#\1:\2#' | sort | uniq -c | awk '{printf "%s%s %s", s, $2, $1; s=", "}')
    [ "$n_stale" -gt 0 ] && echo "  (태그 조회에만 남은 stale ${n_stale}개 제외: ${kinds}. 직접 조회하면 없음·종료·삭제 예약)"
    count "EKS 클러스터" aws_q eks list-clusters --query 'clusters[]'
    count "로드 밸런서(ALB·NLB)" aws_q elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerArn'
    count "클래식 로드 밸런서" aws_q elb describe-load-balancers --query 'LoadBalancerDescriptions[].LoadBalancerName'
    count "탄력적 IP" aws_q ec2 describe-addresses --query 'Addresses[].AllocationId'
    count "NAT 게이트웨이(살아 있는 것)" aws_q ec2 describe-nat-gateways \
      --filter Name=state,Values=pending,available,deleting --query 'NatGateways[].NatGatewayId'
    count "EC2 인스턴스(종료 제외)" aws_q ec2 describe-instances \
      --filters Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId'
    count "EBS 볼륨" aws_q ec2 describe-volumes --query 'Volumes[].VolumeId'
    count "EBS 스냅숏(내 것)" aws_q ec2 describe-snapshots --owner-ids self --query 'Snapshots[].SnapshotId'
    count "RDS 인스턴스" aws_q rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier'
    count "RDS 스냅숏(수동)" aws_q rds describe-db-snapshots --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier'
  fi
fi

if [ "$WHAT" = all ] || [ "$WHAT" = gcp ]; then
  if ! command -v gcloud >/dev/null 2>&1; then row "GCP" "조회 실패 (gcloud 명령 없음)"; FAILED=1; else
    P=${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}
    echo "== GCP (project ${P:-없음})"
    # shellcheck disable=SC2329
    g() { gcloud --project "$P" "$@" --format='value(name)'; }
    count "GKE 클러스터" g container clusters list
    count "전달 규칙(LB)" g compute forwarding-rules list
    count "고정 IP 주소" g compute addresses list
    count "디스크" g compute disks list
    count "VM 인스턴스" g compute instances list
    count "Cloud SQL 인스턴스" g sql instances list
    # Z38 REVIEW-8 (z77-bprime): GKE 안 LoadBalancer Service(z77-src-lb 등)를 지우기 전에 클러스터를 지우면
    #   전달 규칙 말고도 대상 풀·상태 확인·k8s 방화벽이 남는다 (GKE 가 만든 것이라 terraform state 에 없음)
    count "대상 풀(LB 뒤)" g compute target-pools list
    count "HTTP 상태 확인(LB)" g compute http-health-checks list
    count "방화벽(k8s 자동 생성)" g compute firewall-rules list --filter='name~^k8s'
  fi
fi

EXC=""
[ -n "${CLOUD_ZERO_IGNORE:-}" ] && EXC=" (예외: $CLOUD_ZERO_IGNORE, 뺀 것 ${IGNORED}개)"
echo "합계: $TOTAL$EXC"
if [ "$FAILED" = 1 ]; then echo "확인 못 함 (위 '조회 실패' 줄)"; exit 2; fi
if [ "$TOTAL" -eq 0 ]; then echo "OK zero$EXC"; exit 0; fi
echo "남은 것:$LEFT"
exit 1
