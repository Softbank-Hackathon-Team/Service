#!/bin/sh
# Jeong 직접 실행 줄 1/2 (z75-46): 결선 당일 클라우드 올리기. 맥 분류기가 막는 terraform apply 와 역방향 터널이 여기 다 들어 있다.
#   sh tools/jeong-up.sh
# 하는 일: bash tools/demo-day.sh up --fg 를 DEMO_DAY_JEONG=1 로 (터널도 이 안에서 연다). 뒤에서 돈다.
# 진행: ~/.svc-tf/demo-day/jeong-progress.log 의 "JEONG up end rc=0" 이 끝. 자세한 단계는 demo-day 의 progress.log
cd "$(dirname "$0")/.." || exit 1
JSELF=tools/jeong-up.sh
. tools/jeong-lib.sh
# WATCHREQ (방법론 v1 ⑧, F14): 감시 창이 없으면 up 이 중간에 실패해도 아무도 jeong-down 을 안 쳐서 자원이 남는다(11/3 감시 창 꺼짐) → 시작하지 않는다.
#   DRAFT(ai): 감시 없이 올릴 때만 JEONG_NO_WATCH=1. 뒤에서 도는 자식(JEONG_CHILD)은 이미 본 뒤라 안 본다
j_watch_gate || exit 4
j_bg up "$@"
j_begin up
j_trap up
# 로그 폴더를 여기서 정해 진행 파일에 경로를 적는다 (demo-day 기본 규칙과 같음)
if [ -z "${DEMO_DAY_LOG_DIR:-}" ]; then
  if [ -d ../measurements ]; then DEMO_DAY_LOG_DIR=../measurements/demo-day-up-$(date -u +%Y%m%dT%H%M%SZ); else DEMO_DAY_LOG_DIR=tools/measure/out/demo-day-up-$(date -u +%Y%m%dT%H%M%SZ); fi
fi
DEMO_DAY_LOG_DIR=$(j_abs "$DEMO_DAY_LOG_DIR")   # 절대 경로 (진행 파일에 적힌다)
export DEMO_DAY_LOG_DIR
DEMO_DAY_JEONG=1 bash tools/demo-day.sh up --fg "$@"
rc=$?
j_end up $rc "$DEMO_DAY_LOG_DIR/progress.log"
exit $rc
