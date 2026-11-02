#!/bin/sh
# Jeong 직접 실행 줄 (REALECS): ECS 출발 샘플 내리기. 맥 분류기가 막는 terraform destroy 가 들어 있다.
#   sh tools/jeong-ecs-down.sh
# 끝 줄 "JEONG ecs-down end rc=0" 이면 ECS 클러스터·서비스·태스크 0
cd "$(dirname "$0")/.." || exit 1
JSELF=tools/jeong-ecs-down.sh
. tools/jeong-lib.sh
j_bg ecs-down "$@"
j_begin ecs-down
bash tools/ecs-source.sh down "$@"
rc=$?
j_end ecs-down $rc "${ECS_SOURCE_STATE:-$HOME/.svc-tf/ecs-source}"
exit $rc
