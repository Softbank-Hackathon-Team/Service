#!/bin/sh
# Jeong 직접 실행 줄 1/2 (z75-46): 결선 당일 클라우드 올리기. 맥 분류기가 막는 terraform apply 와 역방향 터널이 여기 다 들어 있다.
#   sh tools/jeong-up.sh
# 하는 일: bash tools/demo-day.sh up --fg 를 DEMO_DAY_JEONG=1 로 (터널도 이 안에서 연다). 뒤에서 돈다.
# 진행: ~/.svc-tf/demo-day/jeong-progress.log 의 "JEONG up end rc=0" 이 끝. 자세한 단계는 demo-day 의 progress.log
cd "$(dirname "$0")/.." || exit 1
JSELF=tools/jeong-up.sh
. tools/jeong-lib.sh
j_bg up "$@"
j_begin up
# 로그 폴더를 여기서 정해 진행 파일에 경로를 적는다 (demo-day 기본 규칙과 같음)
if [ -z "${DEMO_DAY_LOG_DIR:-}" ]; then
  if [ -d ../measurements ]; then DEMO_DAY_LOG_DIR=../measurements/demo-day-up-$(date -u +%Y%m%dT%H%M%SZ); else DEMO_DAY_LOG_DIR=tools/measure/out/demo-day-up-$(date -u +%Y%m%dT%H%M%SZ); fi
fi
export DEMO_DAY_LOG_DIR
DEMO_DAY_JEONG=1 bash tools/demo-day.sh up --fg "$@"
rc=$?
j_end up $rc "$DEMO_DAY_LOG_DIR/progress.log"
exit $rc
