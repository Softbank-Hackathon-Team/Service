#!/bin/sh
# Jeong 직접 실행 줄 (REALECS): 실클라우드 회차의 ECS 출발 샘플 올리기. 맥 분류기가 막는 terraform apply 가 들어 있다.
#   sh tools/jeong-ecs-up.sh
# 뒤에서 돈다. 진행: ~/.svc-tf/demo-day/jeong-progress.log 의 "JEONG ecs-up end rc=0"
cd "$(dirname "$0")/.." || exit 1
JSELF=tools/jeong-ecs-up.sh
. tools/jeong-lib.sh
j_bg ecs-up "$@"
j_begin ecs-up
bash tools/ecs-source.sh up "$@"
rc=$?
j_end ecs-up $rc "${ECS_SOURCE_STATE:-$HOME/.svc-tf/ecs-source}"
exit $rc
