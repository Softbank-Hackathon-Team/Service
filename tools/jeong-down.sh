#!/bin/sh
# Jeong 직접 실행 줄 2/2 (z75-46): 결선 당일 클라우드 내리기. 맥 분류기가 막는 terraform destroy 가 여기 들어 있다. 터널도 끈다.
#   sh tools/jeong-down.sh
# 하는 일: bash tools/demo-day.sh down --fg. 뒤에서 돈다. 끝 줄 "JEONG down end rc=0" + demo-day 판정 PASS 면 자원 0
cd "$(dirname "$0")/.." || exit 1
JSELF=tools/jeong-down.sh
. tools/jeong-lib.sh
# UPREV-B: 이미 도는 down 이 있으면 두 번째를 띄우지 않는다 (같은 terraform 상태에 destroy 두 개 → 잠금 오류·터널 중복 종료). 잠금 파일의 pid 가 살아 있고 이 스크립트일 때만
JLOCK="$JSTATE/down.lock"
if ! j_is_child down && [ -f "$JLOCK" ]; then
  LP=$(cat "$JLOCK" 2>/dev/null)
  if [ -n "$LP" ] && kill -0 "$LP" 2>/dev/null && ps -p "$LP" -o command= 2>/dev/null | grep -q "jeong-down"; then
    echo "이미 내리는 중 (pid $LP). 진행: tail -f $JPROG   끝 줄 'JEONG down end' 를 기다린다"; exit 0
  fi
  rm -f "$JLOCK"   # 죽은 잠금
fi
j_bg down "$@"
echo $$ > "$JLOCK"
# 신호로 죽어도 끝 줄을 남긴다 (맥 쪽이 "end" 를 기다리다 시간 초과로 헛도는 걸 막는다). 다시 치면 이어서 지운다 (destroy 는 재실행해도 안전)
trap 'j_end down 143 "${DEMO_DAY_LOG_DIR:+$DEMO_DAY_LOG_DIR/progress.log}"; rm -f "$JLOCK"; exit 143' TERM INT HUP
trap 'rm -f "$JLOCK"' EXIT
j_begin down
j_trap down
# 터널부터 끈다 (재접속 고리라 안 끄면 중계기가 지워지는 동안 다시 붙으려 한다)
if [ -f "$JSTATE/tunnel.pid" ]; then
  killtree() { for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null; return 0; }
  tp=$(cat "$JSTATE/tunnel.pid")
  # UPREV-A: pid 가 재사용됐을 수 있으니 터널(demo-tunnel·ssh)일 때만 끈다
  if [ -n "$tp" ] && ps -p "$tp" -o command= 2>/dev/null | grep -Eq 'demo-tunnel|ssh'; then
    killtree "$tp"; echo "$(j_iso) JEONG down tunnel-stopped" >> "$JPROG"
  else
    echo "$(j_iso) JEONG down tunnel-pid-stale (pid $tp 는 터널이 아님 → 건너뜀)" >> "$JPROG"
  fi
  rm -f "$JSTATE/tunnel.pid"
fi
# 로그 폴더를 여기서 정해 진행 파일에 경로를 적는다 (demo-day 기본 규칙과 같음)
if [ -z "${DEMO_DAY_LOG_DIR:-}" ]; then
  if [ -d ../measurements ]; then DEMO_DAY_LOG_DIR=../measurements/demo-day-down-$(date -u +%Y%m%dT%H%M%SZ); else DEMO_DAY_LOG_DIR=tools/measure/out/demo-day-down-$(date -u +%Y%m%dT%H%M%SZ); fi
fi
DEMO_DAY_LOG_DIR=$(j_abs "$DEMO_DAY_LOG_DIR")
export DEMO_DAY_LOG_DIR
bash tools/demo-day.sh down --fg "$@"
rc=$?
j_end down $rc "$DEMO_DAY_LOG_DIR/progress.log"
exit $rc
