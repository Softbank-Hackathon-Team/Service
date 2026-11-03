#!/usr/bin/env bash
# REALECS: 실클라우드 회차용 "ECS 출발" 샘플 올리기·내리기 (작업 REALECS, 상태 DRAFT(ai)). infra/modules/aws/ecs-source 를 부르기만 한다.
# 비용이 드는 도구다. 맥에서만 진짜로 돌린다. 클라우드 VM 에서는 --dry-run 으로 명령 순서만 본다.
#   bash tools/ecs-source.sh up   [--dry-run]   기본 VPC 서브넷에 ECS 클러스터·Fargate 서비스 1개 (이미지 digest 고정, 태그 app=shop)
#   bash tools/ecs-source.sh down [--dry-run]   terraform destroy 후 ECS 클러스터·서비스·태스크 0 확인
# 진짜 apply/destroy 는 맥 분류기가 막는 명령이라 Jeong 이 sh tools/jeong-ecs-up.sh / jeong-ecs-down.sh 를 친다(이 스크립트를 DEMO_DAY_JEONG=1 로 부름).
# 환경 변수: AWS_PROFILE(finals) AWS_REGION(ap-northeast-2) ECS_IMAGE(기본 docker.io/hashicorp/http-echo:1.0, 태그면 digest 로 바꿈) ECS_APP(shop)
#   ECS_SOURCE_STATE(기본 ~/.svc-tf/ecs-source): terraform 상태·작업 폴더. 레포 밖 (상태 파일은 커밋 안 됨)
# 비밀값·계정 ID 를 찍지 않는다. terraform 출력은 로그 파일에만, 화면에는 단계와 끝 코드만.
set -u
cd "$(dirname "$0")/.." || exit 1
CMD=${1:-}; shift || true
DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) echo "모르는 옵션: $a" >&2; exit 2 ;; esac; done
case "$CMD" in up|down) ;; -h|--help|"") sed -n '2,10p' "$0"; [ -n "$CMD" ]; exit $? ;; *) echo "up 또는 down" >&2; exit 2 ;; esac

export AWS_PROFILE=${AWS_PROFILE:-finals}
export AWS_REGION=${AWS_REGION:-ap-northeast-2}
APP=${ECS_APP:-shop}
IMAGE=${ECS_IMAGE:-docker.io/hashicorp/http-echo:1.0}
STATE=${ECS_SOURCE_STATE:-$HOME/.svc-tf/ecs-source}
MOD=infra/modules/aws/ecs-source
LOGF=$STATE/$CMD-$(date -u +%Y%m%dT%H%M%SZ).log
say() { echo "$(date -u +%H:%M:%SZ) ecs-source $*"; }
# run: dry-run 이면 명령만 찍고, 아니면 로그 파일에 출력을 남기며 실행 (인자 그대로, 셸 합치기 없음)
run() {
  if [ "$DRY" = 1 ]; then say "DRY: $*"; return 0; fi
  "$@" >> "$LOGF" 2>&1; local rc=$?; [ $rc -eq 0 ] || say "실패 rc=$rc: $* (로그 $LOGF)"; return $rc
}
tf() { run terraform -chdir="$MOD" "$@"; }
TFENV() { export TF_DATA_DIR="$STATE/tfdata" TF_IN_AUTOMATION=1; }
[ "$DRY" = 1 ] || { mkdir -p "$STATE" && chmod 700 "$STATE" || exit 1; }
TFENV

digest_ref() { # 태그 → repo@sha256:…
  case "$IMAGE" in *@sha256:*) echo "$IMAGE"; return 0 ;; esac
  [ "$DRY" = 1 ] && { echo "${IMAGE%:*}@sha256:<dry-digest>"; return 0; }
  local d
  d=$(docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest 2>/dev/null)
  case "$d" in sha256:*) echo "${IMAGE%:*}@$d" ;; *) return 1 ;; esac
}

zero_check() { # ECS 클러스터·서비스·태스크가 0 인지 (조회만)
  [ "$DRY" = 1 ] && { say "DRY: aws ecs list-clusters → 클러스터마다 list-services·list-tasks 가 0"; return 0; }
  local n=0 c
  for c in $(aws ecs list-clusters --query 'clusterArns[]' --output text 2>/dev/null); do
    n=$((n + 1 + $(aws ecs list-services --cluster "$c" --query 'length(serviceArns)' --output text 2>/dev/null) + $(aws ecs list-tasks --cluster "$c" --query 'length(taskArns)' --output text 2>/dev/null)))
  done
  say "ECS 남은 것: $n (클러스터+서비스+태스크)"; [ "$n" -eq 0 ]
}

if [ "$CMD" = up ]; then
  say "up 시작 dry=$DRY profile=$AWS_PROFILE region=$AWS_REGION app=$APP"
  REF=$(digest_ref | tail -1) || { say "이미지 digest 를 못 구함: ECS_IMAGE 에 repo@sha256:… 로 주면 됨"; exit 1; }
  [ "$DRY" = 1 ] || zero_check >/dev/null 2>&1 || say "알림: 이미 ECS 자원이 있음(다른 것일 수 있음). 가져오기는 IMPORT_AWS_ECS_CLUSTER=realecs-src 로 고른다"
  tf init -input=false || exit 1
  tf apply -input=false -auto-approve -var "image=$REF" -var "app=$APP" -var "region=$AWS_REGION" || exit 1
  if [ "$DRY" = 1 ]; then say "DRY: 서비스 안정화 기다림 aws ecs wait services-stable (최대 10분)"; else
    aws ecs wait services-stable --cluster realecs-src --services realecs-src-api >> "$LOGF" 2>&1 || { say "서비스가 10분 안에 안정되지 않음 (가져오기는 정의만 읽음)"; }
  fi
  say "up 끝"
else
  say "down 시작 dry=$DRY"
  REF=$(digest_ref | tail -1) || REF="docker.io/x@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  tf init -input=false || exit 1
  tf destroy -input=false -auto-approve -var "image=$REF" -var "app=$APP" -var "region=$AWS_REGION" || exit 1
  zero_check || { say "판정 FAIL down (ECS 가 남음)"; exit 1; }
  say "판정 PASS down"
fi
