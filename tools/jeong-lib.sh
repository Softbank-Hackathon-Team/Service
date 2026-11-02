# Jeong 직접 실행 묶음 공통 (z75-46, 작업 Z78). tools/jeong-*.sh 가 source 한다. 맥 Cloud SQL 처럼 새 묶음도 이 형식을 따른다.
#
# 형식
#   - 파일 하나 = Jeong 이 치는 줄 하나:  sh tools/jeong-<이름>.sh
#   - 치면 바로 뒤로 돈다(nohup). 화면에는 진행 파일 경로 한 줄만. 창을 닫아도 계속 돈다
#   - 진행 파일 하나: $JSTATE/jeong-progress.log (기본 ~/.svc-tf/demo-day). 맥 스레드는 이 파일만 읽는다(폴링)
#       <시각> JEONG <이름> start wait=<초>      맥이 부탁한 뒤 Jeong 이 칠 때까지 (부탁 파일이 없으면 wait=?)
#       <시각> JEONG <이름> end rc=<끝 코드> sec=<초> log=<로그 경로>
#   - 부탁: 맥 스레드가 Jeong 에게 줄을 보내기 직전에 `date +%s > ~/.svc-tf/demo-day/jeong-request-<이름>` 을 남기면 대기 초가 찍힌다
#   - 비밀값을 찍지 않는다. 클라우드 명령의 출력은 로그 파일에만
JSTATE=${DEMO_DAY_STATE:-$HOME/.svc-tf/demo-day}
JPROG="$JSTATE/jeong-progress.log"
j_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# UPREV-A: 경로가 상대면 지금 폴더 기준 절대 경로로 (진행 파일에 적힌 log= 를 맥 스레드가 어디서든 읽도록)
j_abs() { case "$1" in /*) echo "$1" ;; *) echo "$(pwd)/$1" ;; esac; }
# UPREV-A: 우리 줄(jeong-*·demo-day)로 도는 살아 있는 pid 인가. pid 재사용으로 남의 프로세스를 우리 것으로 착각하지 않게 명령 이름도 본다
j_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null && ps -p "$1" -o command= 2>/dev/null | grep -Eq 'jeong-|demo-day'; }
# 이미 도는 jeong 줄(up·down 공통 자물쇠)이 있으면 그 pid 를 찍는다
j_busy() { local p; p=$(cat "$JSTATE/jeong.lock/pid" 2>/dev/null); if j_alive "$p"; then echo "$p"; return 0; fi; return 1; }
# j_bg <이름> "$@": 처음 부르면 자기 자신을 nohup 으로 다시 띄우고 끝낸다. 뒤에서 도는 쪽은 그냥 지나간다
j_bg() {
  local name=$1; shift
  [ -n "${JEONG_CHILD:-}" ] && return 0
  # z75-50 (Z38 R8-44): Jeong 터미널에서만. 맥 RC(터미널 아님)가 부르면 멈춘다. VM 시험만 JEONG_ALLOW_NOTTY=1
  [ -t 1 ] || [ -n "${JEONG_ALLOW_NOTTY:-}" ] || { echo "Jeong 터미널에서만 치는 줄이다 (맥 RC 는 부르지 않는다)"; exit 2; }
  mkdir -p "$JSTATE" && chmod 700 "$JSTATE" || exit 1
  # UPREV-A: up·down 이 동시에(또는 up 두 번) 돌면 terraform 상태 잠금과 터널 pid 가 꼬인다 → 먼저 도는 게 있으면 시작하지 않는다
  if b=$(j_busy); then echo "이미 도는 jeong 줄이 있다 (pid $b). 끝난 뒤 다시 친다: tail -f $JPROG"; exit 3; fi
  JEONG_CHILD=1 nohup sh "$JSELF" "$@" > "$JSTATE/jeong-$name.out" 2>&1 &
  echo "뒤에서 시작 (pid $!). 이 창은 닫아도 된다. 진행: tail -f $JPROG"
  exit 0
}
j_begin() {
  local name=$1 req w="?" b
  # 자물쇠: 위 검사와 시작 사이에 끼어든 다른 줄이 있으면 여기서 막는다. 죽은 pid 가 남긴 자물쇠는 치운다
  if ! mkdir "$JSTATE/jeong.lock" 2>/dev/null; then
    if b=$(j_busy) && [ "$b" != "$$" ]; then
      echo "$(j_iso) JEONG $name end rc=3 sec=0 log=이미 도는 줄 pid $b" >> "$JPROG"; exit 3
    fi
    rm -rf "$JSTATE/jeong.lock"; mkdir "$JSTATE/jeong.lock" || exit 1
  fi
  echo $$ > "$JSTATE/jeong.lock/pid"
  req=$(cat "$JSTATE/jeong-request-$name" 2>/dev/null)
  [ -n "$req" ] && w=$(( $(date +%s) - req ))
  J_T0=$(date +%s)
  echo "$(j_iso) JEONG $name start wait=${w}" >> "$JPROG"
}
# 신호로 끊겨도 끝 줄(rc=143)을 남겨 맥 스레드가 "끝나지 않은 줄"을 기다리지 않게 한다
j_trap() { trap 'j_end '"$1"' 143; exit 143' TERM HUP INT; }
j_end() {
  local name=$1 rc=$2 logp=${3:-}
  [ "$(cat "$JSTATE/jeong.lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$JSTATE/jeong.lock"
  rm -f "$JSTATE/jeong-request-$name"
  echo "$(j_iso) JEONG $name end rc=$rc sec=$(( $(date +%s) - J_T0 )) log=${logp:-$JSTATE/jeong-$name.out}" >> "$JPROG"
}
