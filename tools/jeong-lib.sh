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
# j_bg <이름> "$@": 처음 부르면 자기 자신을 nohup 으로 다시 띄우고 끝낸다. 뒤에서 도는 쪽은 그냥 지나간다
j_bg() {
  local name=$1; shift
  [ -n "${JEONG_CHILD:-}" ] && return 0
  # z75-50 (Z38 R8-44): Jeong 터미널에서만. 맥 RC(터미널 아님)가 부르면 멈춘다. VM 시험만 JEONG_ALLOW_NOTTY=1
  [ -t 1 ] || [ -n "${JEONG_ALLOW_NOTTY:-}" ] || { echo "Jeong 터미널에서만 치는 줄이다 (맥 RC 는 부르지 않는다)"; exit 2; }
  mkdir -p "$JSTATE" && chmod 700 "$JSTATE" || exit 1
  JEONG_CHILD=1 nohup sh "$JSELF" "$@" > "$JSTATE/jeong-$name.out" 2>&1 &
  echo "뒤에서 시작 (pid $!). 이 창은 닫아도 된다. 진행: tail -f $JPROG"
  exit 0
}
j_begin() {
  local name=$1 req w="?"
  req=$(cat "$JSTATE/jeong-request-$name" 2>/dev/null)
  [ -n "$req" ] && w=$(( $(date +%s) - req ))
  J_T0=$(date +%s)
  echo "$(j_iso) JEONG $name start wait=${w}" >> "$JPROG"
}
j_end() {
  local name=$1 rc=$2 logp=${3:-}
  rm -f "$JSTATE/jeong-request-$name"
  echo "$(j_iso) JEONG $name end rc=$rc sec=$(( $(date +%s) - J_T0 )) log=${logp:-$JSTATE/jeong-$name.out}" >> "$JPROG"
}
