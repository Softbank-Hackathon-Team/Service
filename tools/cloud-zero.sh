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
#   CLOUD_ZERO_REGIONS 조회할 AWS 리전 목록 (공백·쉼표). 기본은 AWS_REGION 하나. 여러 개면 줄 이름 앞에 리전이 붙는다
#                      예: CLOUD_ZERO_REGIONS='ap-northeast-2 us-east-1' (UPREV-B: 엉뚱한 리전에 만든 자원도 잡으려면)
#   CLOUD_ZERO_WAIT_SEC  0 이 아니면 "남은 것"·"조회 실패"일 때 이 시간(초)까지 CLOUD_ZERO_RETRY_SEC(기본 30)마다 다시 조회한다.
#                      지우는 중인 것(NAT·EKS·RDS·ENI·LB 는 지운 뒤 몇 분 걸림)을 남은 것으로 오해하지 않게 (UPREV-B). 기본 0 = 한 번만
#   GCP_PROJECT        없으면 gcloud 기본 프로젝트
#   GCP_TARGET_PROJECT 결정 3번 A안: 이전 전용 프로젝트. 있으면 GCP 줄을 이 프로젝트에서도 한 번 더 센다 (도착 자원은 여기에 생김)
#   CLOUD_ZERO_IGNORE  모든 줄(AWS 태그 조회·AWS·GCP 개별 조회)의 결과에서 빼 둘 확장 정규식 (z75-39). 기본 없음
#                      예: 다른 회차 GKE 를 일부러 켜 둔 채 Cloud SQL 만 0 인지 볼 때 CLOUD_ZERO_IGNORE='gke-|app-demo' bash tools/cloud-zero.sh
#                      뺀 것이 있으면 그 줄에 "예외: <정규식> 로 N개 뺌", 끝 줄은 "OK zero (예외: <정규식>)" 로 예외 없는 0 과 구별한다
# 태그 조회 결과는 종류별로 직접 조회해 NotFound·terminated 면 "stale" 로 빼고 개수만 한 줄 찍는다 (R7-4)
# 출력: "항목: 개수" 표. 합이 0 이면 마지막 줄 "OK zero" + 끝 코드 0, 하나라도 있으면 남은 것 목록 + 끝 코드 1
#       조회 자체가 실패하면(자격 없음·권한 없음) 그 줄에 "조회 실패", 끝 코드 2 (0 이라고 말하지 않는다)
set -u

REGION=${AWS_REGION:-ap-northeast-2}
REGIONS=$(printf '%s' "${CLOUD_ZERO_REGIONS:-$REGION}" | tr ',' ' ')
WAIT_SEC=${CLOUD_ZERO_WAIT_SEC:-0}
RETRY_SEC=${CLOUD_ZERO_RETRY_SEC:-30}
case "$WAIT_SEC$RETRY_SEC" in *[!0-9]*) echo "CLOUD_ZERO_WAIT_SEC·CLOUD_ZERO_RETRY_SEC 는 숫자" >&2; exit 2 ;; esac
[ "$RETRY_SEC" -ge 1 ] || RETRY_SEC=30
WHAT=${1:-all}
TOTAL=0
FAILED=0
LEFT=""
IGNORED=0

# Z38 REVIEW-7 R7-2: 오류 파일은 이 실행만의 임시 파일 (고정 /tmp 이름은 다른 실행·다른 사용자와 겹친다)
ERR=$(mktemp "${TMPDIR:-/tmp}/cloud-zero.XXXXXX")
STALE_LIST=$(mktemp "${TMPDIR:-/tmp}/cloud-zero-stale.XXXXXX")
OUTF=$(mktemp "${TMPDIR:-/tmp}/cloud-zero-out.XXXXXX")
trap 'rm -f "$ERR" "$STALE_LIST" "$OUTF"' EXIT

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

# 참고 줄: 합계에 넣지 않는다 (지운 EKS 의 로그 그룹처럼 지워지지 않는 게 정상인 것)
info() {
  name=$1; shift
  if out=$("$@" 2>"$ERR"); then
    out=$(printf '%s\n' "$out" | tr '\t' '\n' | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
    row "$name" "$(printf '%s' "$out" | grep -c . || true) (참고, 합계 제외)"
  else row "$name" "조회 실패 (참고, 합계 제외)"; fi
  return 0
}

# 아래 함수들은 count 가 "$@" 로 부른다 (shellcheck 는 못 봄)
# shellcheck disable=SC2329
aws_q() { aws --region "$REGION" --output text "$@"; }

# REALECS: ECS 서비스·태스크는 클러스터마다 조회 (클러스터가 0 이면 비어 있음). 조회 실패는 count 가 실패 줄로 센다
# VNEW: 예전엔 $(…) 안 list-clusters 실패·파이프 뒤 list-services 실패가 끝 코드에 안 남아 "0" 으로 셌다 → 단계마다 실패를 돌려준다
# shellcheck disable=SC2329
ecs_each() { # $1 = list-services | list-tasks, $2 = 결과 키
  cs=$(aws_q ecs list-clusters --query 'clusterArns[]') || return 1
  for c in $(printf '%s\n' "$cs" | tr '\t' '\n' | grep -v '^None$'); do
    aws_q ecs "$1" --cluster "$c" --query "$2[]" || return 1
    echo
  done
}

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

aws_checks() {
  for REGION in $REGIONS; do
    PFX=""; [ "$MULTI" = 1 ] && PFX="$REGION "
    echo "== AWS ($REGION, profile ${AWS_PROFILE:-기본})"
    : > "$STALE_LIST"
    count "${PFX}태그 붙은 자원(get-resources)" aws_tagged
    n_stale=$(grep -c . "$STALE_LIST" || true)
    # Z38 R8-6: 무엇을 뺐는지 종류별 개수도 (예: ec2:instance 1, rds:db 1, secretsmanager:secret 3)
    kinds=$(cut -d: -f3,6 "$STALE_LIST" | sed -E 's#^([^:]*):([^:/]*).*#\1:\2#' | sort | uniq -c | awk '{printf "%s%s %s", s, $2, $1; s=", "}')
    [ "$n_stale" -gt 0 ] && echo "  (태그 조회에만 남은 stale ${n_stale}개 제외: ${kinds}. 직접 조회하면 없음·종료·삭제 예약)"
    count "${PFX}EKS 클러스터" aws_q eks list-clusters --query 'clusters[]'
    count "${PFX}ECS 클러스터" aws_q ecs list-clusters --query 'clusterArns[]'
    count "${PFX}ECS 서비스" ecs_each list-services serviceArns
    count "${PFX}ECS 태스크" ecs_each list-tasks taskArns
    count "${PFX}ECR 저장소" aws_q ecr describe-repositories --query 'repositories[].repositoryName'
    count "${PFX}로드 밸런서(ALB·NLB)" aws_q elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerArn'
    count "${PFX}클래식 로드 밸런서" aws_q elb describe-load-balancers --query 'LoadBalancerDescriptions[].LoadBalancerName'
    count "${PFX}탄력적 IP" aws_q ec2 describe-addresses --query 'Addresses[].AllocationId'
    count "${PFX}NAT 게이트웨이(살아 있는 것)" aws_q ec2 describe-nat-gateways \
      --filter Name=state,Values=pending,available,deleting --query 'NatGateways[].NatGatewayId'
    count "${PFX}EC2 인스턴스(종료 제외)" aws_q ec2 describe-instances \
      --filters Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down --query 'Reservations[].Instances[].InstanceId'
    # UPREV-B: 지운 LB·EKS 의 ENI 와 기본 아닌 VPC 가 남으면 서브넷·VPC 삭제가 막혀 다음 회차 up 이 깨진다
    count "${PFX}네트워크 인터페이스(ENI)" aws_q ec2 describe-network-interfaces --query 'NetworkInterfaces[].NetworkInterfaceId'
    count "${PFX}VPC(기본 제외)" aws_q ec2 describe-vpcs --filters Name=is-default,Values=false --query 'Vpcs[].VpcId'
    count "${PFX}EBS 볼륨" aws_q ec2 describe-volumes --filters Name=status,Values=creating,available,in-use,error --query 'Volumes[].VolumeId'
    count "${PFX}EBS 스냅숏(내 것)" aws_q ec2 describe-snapshots --owner-ids self --query 'Snapshots[].SnapshotId'
    count "${PFX}RDS 인스턴스" aws_q rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier'
    count "${PFX}RDS 클러스터" aws_q rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier'
    count "${PFX}RDS 스냅숏(수동)" aws_q rds describe-db-snapshots --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier'
    # EKS 가 스스로 만든 제어부 로그 그룹은 클러스터를 지워도 남는 게 정상이다 → 세지 않는다
    info "${PFX}로그 그룹 /aws/eks·/aws/ecs" aws_q logs describe-log-groups --log-group-name-prefix /aws/ --query 'logGroups[].logGroupName'
  done
  # GATE: IAM 은 리전이 없어 한 번만. demo-day(aws/env)가 만드는 이름만 센다 — state 를 잃고 남으면 다음 up 의 EKS 더하기가 EntityAlreadyExists 로 멈춘다
  count "IAM 역할(platform-target-*)" aws --output text iam list-roles --query "Roles[?starts_with(RoleName,'platform-target-')].RoleName"
  count "IAM 정책(platform-app-boundary)" aws --output text iam list-policies --scope Local --query "Policies[?PolicyName=='platform-app-boundary'].PolicyName"
  # GATE-v1: 실세션 connect 가 만든 연결 스택(svc-connect-*; 역할 svc-observe·svc-operate). 남으면 다음 회차 connect 가 실패 → down 의 connect-stack 단계가 지움
  count "연결 스택(svc-connect-*)" aws --output text cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'svc-connect-')].StackName"
  count "IAM 역할(svc-observe·svc-operate·svc-deploy)" aws --output text iam list-roles --query "Roles[?RoleName=='svc-observe' || RoleName=='svc-operate' || RoleName=='svc-deploy'].RoleName"
  count "IAM 정책(svc-operate-policy)" aws --output text iam list-policies --scope Local --query "Policies[?PolicyName=='svc-operate-policy'].PolicyName"
  # PF02 FM-CLD-16: 이전 apply·smoke 가 만드는 앱 IAM 역할은 이름이 전부 app-* (실행 역할 정책이 role/app-* 만 허용).
  #   IAM 은 전역이라 서울 태그 조회(get-resources)에 안 나올 수 있다 【추정】 → 이름으로도 센다 (destroy 실패로 남으면 다음 apply EntityAlreadyExists)
  count "IAM 역할(app-*, 앱 apply 가 만든 것)" aws --output text iam list-roles --query "Roles[?starts_with(RoleName,'app-')].RoleName"
  # PF FM-CLD-hunt-cloud-24: ECS 출발 샘플(infra/modules/aws/ecs-source, 이름 realecs-src)의 작업·실행 역할. 전역이라 리전 조회에 안 잡힌다
  count "IAM 역할(realecs-src-*, ECS 출발 샘플)" aws --output text iam list-roles --query "Roles[?starts_with(RoleName,'realecs-src-')].RoleName"
  #   전역 자원 태그 조회는 us-east-1 에서만 나오는 경우가 있어 IAM 종류만 한 번 더 (참고 줄: 태그 조회는 지운 자원도 한동안 돌려줘서 합계에 안 넣음. 이름 줄이 진짜 판정)
  info "IAM 태그 붙은 역할·정책(us-east-1 조회)" aws --region us-east-1 --output text resourcegroupstaggingapi get-resources \
    --resource-type-filters iam:role iam:policy --tag-filters Key=managed-by,Values=platform --query 'ResourceTagMappingList[].ResourceARN'
}

gcp_checks() {
  P=${1:-${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}}
  echo "== GCP (project ${P:-없음})"
  # UPREV-B: 프로젝트가 비면 gcloud 가 엉뚱한 오류를 내거나 기본 프로젝트만 봐서 0 이라고 거짓말한다 → 조회 실패로 막는다
  if [ -z "$P" ] || [ "$P" = "(unset)" ]; then row "GCP" "조회 실패 (프로젝트 없음: GCP_PROJECT 를 주거나 gcloud config set project)"; FAILED=1; return; fi
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
  # UPREV-B: terraform 이 만든 VPC·라우터(Cloud NAT)가 지우기 중간에 실패하면 남는다
  count "VPC 네트워크(default 제외)" g compute networks list --filter='name!=default'
  count "라우터(Cloud NAT)" g compute routers list
  # GATE: Artifact Registry 저장소(platform)는 안 세던 것. 남으면 다음 gcp/env apply 가 "already exists" 로 멈춘다. API 가 꺼진 새 프로젝트는 0 으로 본다
  # shellcheck disable=SC2329
  ar_list() { local o; if o=$(gcloud --project "$P" artifacts repositories list --location "${GCP_REGION:-asia-northeast3}" --format='value(name)' 2>"$ERR"); then printf '%s\n' "$o"; return 0; fi
    grep -qiE 'not enabled|has not been used|SERVICE_DISABLED' "$ERR" && return 0; return 1; }
  count "Artifact Registry 저장소" ar_list
  # GATE-gcp: 안 세던 것. ① l4-rbs 방식 LB(백엔드 서비스·새 상태 확인·NEG) ② 우리 앱 모듈(gcp/app)이 만드는 시크릿·앱 SA
  #   — 이름이 이전마다 같아서(app-<앱>-db-password, app-<앱>-…) 남으면 다음 gcp 도착 apply 가 409 already exists 로 멈춘다 (참고 줄)
  count "백엔드 서비스(LB)" g compute backend-services list
  count "상태 확인(새 방식 LB)" g compute health-checks list
  count "NEG(LB 뒤)" g compute network-endpoint-groups list
  # shellcheck disable=SC2329
  api_off_zero() { local o; if o=$("$@" 2>"$ERR"); then printf '%s\n' "$o"; return 0; fi
    grep -qiE 'not enabled|has not been used|SERVICE_DISABLED' "$ERR" && return 0; return 1; }
  # FM-CLD-10: GCP 도착 종류(gcp/kinds cache·queue·object-store·service-cloudrun·job)가 만드는 것. 안 세면 tf:real destroy 가 실패해도 "OK zero"
  #   모듈이 다 붙이는 labels.managed-by=platform 로 거른다(남의 자원은 안 셈). Scheduler 는 라벨이 없어 지역 안 전부를 센다 — DRAFT(ai): 데모 프로젝트 전용 가정
  #   API 가 꺼진 프로젝트는 0 (api_off_zero). Memorystore 는 시간당 요금이 붙는다
  GR=${GCP_REGION:-asia-northeast3}
  count "Memorystore Redis(managed-by=platform)" api_off_zero gcloud --project "$P" redis instances list --region "$GR" --filter='labels.managed-by=platform' --format='value(name)'
  count "Pub/Sub 토픽(managed-by=platform)" api_off_zero gcloud --project "$P" pubsub topics list --filter='labels.managed-by=platform' --format='value(name)'
  count "Pub/Sub 구독(managed-by=platform)" api_off_zero gcloud --project "$P" pubsub subscriptions list --filter='labels.managed-by=platform' --format='value(name)'
  count "Cloud Storage 버킷(managed-by=platform)" api_off_zero gcloud --project "$P" storage buckets list --filter='labels.managed-by=platform' --format='value(name)'
  count "Cloud Run 서비스(managed-by=platform)" api_off_zero gcloud --project "$P" run services list --region "$GR" --filter='metadata.labels.managed-by=platform' --format='value(metadata.name)'
  count "Cloud Run 잡(managed-by=platform)" api_off_zero gcloud --project "$P" run jobs list --region "$GR" --filter='metadata.labels.managed-by=platform' --format='value(metadata.name)'
  count "Cloud Scheduler 잡" api_off_zero gcloud --project "$P" scheduler jobs list --location "$GR" --format='value(name)'
  # ②는 참고 줄(합계 제외): 요금이 거의 없고 이번 up(onprem→aws)은 안 쓴다. 0 이 아니면 GCP 도착 이전 전에 지우라는 표시
  info "Secret Manager 비밀(managed-by=platform)" api_off_zero gcloud --project "$P" secrets list --filter='labels.managed-by=platform' --format='value(name)'
  # HUNT-CLD-01: 플랫폼 회사 전용 SA(t-*, onboarding/gcp-platform-tenant-sa.sh)와 그 SA 를 주체로 한 바인딩(프로젝트·연결 SA 정책).
  #   남으면 데모가 끝난 뒤에도 워커 → t-* → svc-operate 빌리기 고리가 살아 있다. down 의 connect-gcp 단계가 지운다
  count "회사 전용 SA(t-*)" env GCP_PROJECT="$P" bash "$(dirname "$0")/gcp-tenant-sa.sh" list-sa
  count "t-* 주체 IAM 바인딩" env GCP_PROJECT="$P" bash "$(dirname "$0")/gcp-tenant-sa.sh" list-bindings
  info "연결 SA(svc-observe·plan·operate, 고객 쪽·안 지움)" gcloud --project "$P" iam service-accounts list --filter='email~^svc-(observe|plan|operate)@' --format='value(email)'
  info "앱 서비스 계정(app-*)" gcloud --project "$P" iam service-accounts list --filter='email~^app-' --format='value(email)'
}

run_checks() {
  TOTAL=0; FAILED=0; LEFT=""; IGNORED=0
  if [ "$WHAT" = all ] || [ "$WHAT" = aws ]; then
    if ! command -v aws >/dev/null 2>&1; then row "AWS" "조회 실패 (aws 명령 없음)"; FAILED=1; else aws_checks; fi
  fi
  if [ "$WHAT" = all ] || [ "$WHAT" = gcp ]; then
    if ! command -v gcloud >/dev/null 2>&1; then row "GCP" "조회 실패 (gcloud 명령 없음)"; FAILED=1
    else
      gcp_checks
      # 결정 3번 A안: 전용 프로젝트도 센다 (원래 프로젝트와 같으면 한 번만)
      if [ -n "${GCP_TARGET_PROJECT:-}" ] && [ "${GCP_TARGET_PROJECT}" != "${P:-}" ]; then gcp_checks "${GCP_TARGET_PROJECT}"; fi
    fi
  fi
}

MULTI=0
[ "$(printf '%s\n' $REGIONS | grep -c .)" -gt 1 ] && MULTI=1

T0=$SECONDS; ATTEMPT=1
while :; do
  run_checks > "$OUTF"
  if [ "$FAILED" = 0 ] && [ "$TOTAL" -eq 0 ]; then break; fi
  [ $((SECONDS - T0 + RETRY_SEC)) -le "$WAIT_SEC" ] || break
  echo "재조회 ${ATTEMPT}: $([ "$FAILED" = 1 ] && echo '조회 실패' || echo "남은 것 ${TOTAL}개") → ${RETRY_SEC}초 뒤 다시 (지우는 중일 수 있음, 최대 ${WAIT_SEC}초)" >&2
  sleep "$RETRY_SEC"; ATTEMPT=$((ATTEMPT + 1))
done
# FM-SEC-hunt-cloud-22: 남은 것 ARN·조회 실패 오류(assumed-role ARN)에 계정 번호 12자리가 그대로 나왔다 → 출력에서 가린다 (up-preflight redact 와 같은 규칙)
redact() { sed -E 's/(^|[^0-9])[0-9]{12}([^0-9]|$)/\1<계정>\2/g; s/(^|[^0-9])[0-9]{12}([^0-9]|$)/\1<계정>\2/g'; }
redact < "$OUTF"
[ "$ATTEMPT" -gt 1 ] && echo "(${ATTEMPT}번째 조회, 기다린 시간 $((SECONDS - T0))초)"

EXC=""
[ -n "${CLOUD_ZERO_IGNORE:-}" ] && EXC=" (예외: $CLOUD_ZERO_IGNORE, 뺀 것 ${IGNORED}개)"
echo "합계: $TOTAL$EXC"
if [ "$FAILED" = 1 ]; then echo "확인 못 함 (위 '조회 실패' 줄)"; exit 2; fi
if [ "$TOTAL" -eq 0 ]; then echo "OK zero$EXC"; exit 0; fi
printf '%s\n' "남은 것:$LEFT" | redact
exit 1
