#!/bin/sh
# Jeong 직접 실행 줄 2/2 (z75-46): 결선 당일 클라우드 내리기. 맥 분류기가 막는 terraform destroy 가 여기 들어 있다. 터널도 끈다.
#   sh tools/jeong-down.sh
# 하는 일: bash tools/demo-day.sh down --fg. 뒤에서 돈다. 끝 줄 "JEONG down end rc=0" + demo-day 판정 PASS 면 자원 0
cd "$(dirname "$0")/.." || exit 1
JSELF=tools/jeong-down.sh
. tools/jeong-lib.sh
j_bg down "$@"
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
