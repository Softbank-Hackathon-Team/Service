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
# NOTTY: 뒤로 띄운 줄(j_bg·nohup)이 터미널 입력을 물려받으면 gcloud·aws 가 묻는 창(프롬프트·페이저)에서 터미널을 읽다 멈춘다
#   (11/3 5차: Jeong 터미널에서 띄운 up 만 cloud-precheck gcp-billing 이 30초 넘게 멈춤, 맥 RC 에선 2~4초) → 묻지 않게·페이저 끄기
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 AWS_PAGER="" PAGER=cat
JSTATE=${DEMO_DAY_STATE:-$HOME/.svc-tf/demo-day}
# UPREV: gke-gcloud-auth-plugin 이 gcloud SDK bin 에만 있고 PATH 에 없을 때(맥 실측 /usr/local/share/google-cloud-sdk/bin) PATH 앞에 더함. 뒤로 띄우는 것도 물려받음
if ! command -v gke-gcloud-auth-plugin >/dev/null 2>&1 && command -v gcloud >/dev/null 2>&1; then
  _sdk=$(gcloud info --format='value(installation.sdk_root)' 2>/dev/null)
  [ -n "$_sdk" ] && [ -x "$_sdk/bin/gke-gcloud-auth-plugin" ] && export PATH="$_sdk/bin:$PATH"
fi
JPROG="$JSTATE/jeong-progress.log"
j_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# UPREV-A: 경로가 상대면 지금 폴더 기준 절대 경로로 (진행 파일에 적힌 log= 를 맥 스레드가 어디서든 읽도록)
j_abs() { case "$1" in /*) echo "$1" ;; *) echo "$(pwd)/$1" ;; esac; }
# UPREV-A: 우리 줄(jeong-*·demo-day)로 도는 살아 있는 pid 인가. pid 재사용으로 남의 프로세스를 우리 것으로 착각하지 않게 명령 이름도 본다
j_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null && ps -p "$1" -o command= 2>/dev/null | grep -Eq 'jeong-|demo-day'; }
# 이미 도는 jeong 줄(up·down 공통 자물쇠)이 있으면 그 pid 를 찍는다
# 18:3xZ 사고 (3): 잠금이 STATE 안에만 있어 다른 STATE(시험의 임시 폴더)로 부르면 안 보였다 → 작업 폴더(레포 맨 위) 잠금도 같이 본다.
#   jeong 스크립트는 lib 를 부르기 전에 레포 맨 위로 cd 한다. .jeong-run.lock 은 .gitignore
J_RLOCK="$(pwd)/.jeong-run.lock"
j_busy() { local p
  p=$(cat "$JSTATE/jeong.lock/pid" 2>/dev/null); if j_alive "$p"; then echo "$p"; return 0; fi
  p=$(cat "$J_RLOCK/pid" 2>/dev/null); if j_alive "$p"; then echo "$p"; return 0; fi
  return 1; }
# j_bg <이름> "$@": 처음 부르면 자기 자신을 nohup 으로 다시 띄우고 끝낸다. 뒤에서 도는 쪽은 그냥 지나간다
# WATCHREQ (방법론 v1 ⑧, F14): 감시 창(tools/jeong-watch.sh)이 떠 있나. 떠 있으면 0. watch.lock 의 pid 가 살아 있고 jeong-watch 일 때만
j_watch_alive() { local wp
  wp=$(cat "$JSTATE/watch.lock" 2>/dev/null) || return 1
  [ -n "$wp" ] && kill -0 "$wp" 2>/dev/null && ps -p "$wp" -o command= 2>/dev/null | grep -q 'jeong-watch'; }
# WATCHREQ 게이트: 감시 창이 없으면 안내를 찍고 4. 뒤에서 도는 자식(JEONG_CHILD)·JEONG_NO_WATCH=1 은 0.
#   시험은 이 함수만 부른다 — jeong-up.sh 자체를 시험에서 띄우지 않는다(18:28Z 사고: JEONG_CHILD 를 물려받은 시험이 진짜 up 을 띄움)
# 18:28Z 사고 (3): 예전 JEONG_CHILD=1 은 아무 자손에게나 물려져, 진짜 up 안에서 도는 시험이 jeong-up 을 부르면
#   tty 검사·이미 도는 줄 검사(j_busy·jeong.lock)를 다 건너뛰고 그 자리에서 up 을 돌렸다(임시 STATE 라 잠금도 안 보임).
#   → j_bg 가 한 번 쓰는 표(STATE/jeong-<이름>.child)를 만들고 자식은 그 값과 같을 때만 자식으로 본다. 자식은 표를 지우고 JEONG_CHILD 를 풀어 자손에게 안 물려준다
j_is_child() { [ -n "${JEONG_CHILD:-}" ] && [ "$JEONG_CHILD" = "$(cat "$JSTATE/jeong-$1.child" 2>/dev/null)" ]; }
j_watch_gate() {
  j_is_child up && return 0
  [ "${JEONG_NO_WATCH:-0}" = 1 ] && return 0
  j_watch_alive && return 0
  echo "감시 창이 없다. 다른 터미널 창에서 먼저: sh tools/jeong-watch.sh   (감시 없이 올리려면 JEONG_NO_WATCH=1 sh tools/jeong-up.sh)"; return 4; }
j_bg() {
  local name=$1; shift
  if [ -n "${JEONG_CHILD:-}" ]; then
    if j_is_child "$name"; then rm -f "$JSTATE/jeong-$name.child"; unset JEONG_CHILD; return 0; fi
    echo "JEONG_CHILD 가 이 줄이 띄운 자식 표와 다름 → 물려받은 값으로 보고 처음부터 검사"; unset JEONG_CHILD
  fi
  # z75-50 (Z38 R8-44): Jeong 터미널에서만. 맥 RC(터미널 아님)가 부르면 멈춘다. VM 시험만 JEONG_ALLOW_NOTTY=1
  [ -t 1 ] || [ -n "${JEONG_ALLOW_NOTTY:-}" ] || { echo "Jeong 터미널에서만 치는 줄이다 (맥 RC 는 부르지 않는다)"; exit 2; }
  mkdir -p "$JSTATE" && chmod 700 "$JSTATE" || exit 1
  # UPREV-A: up·down 이 동시에(또는 up 두 번) 돌면 terraform 상태 잠금과 터널 pid 가 꼬인다 → 먼저 도는 게 있으면 시작하지 않는다
  if b=$(j_busy); then echo "이미 도는 jeong 줄이 있다 (pid $b). 끝난 뒤 다시 친다: tail -f $JPROG"; exit 3; fi
  _tok="$$-$(od -An -N8 -tx8 /dev/urandom 2>/dev/null | tr -d ' \n')"; ( umask 077; echo "$_tok" > "$JSTATE/jeong-$name.child" )
  JEONG_CHILD="$_tok" nohup sh "$JSELF" "$@" < /dev/null > "$JSTATE/jeong-$name.out" 2>&1 &   # NOTTY: 터미널 입력을 안 물려줌
  echo "뒤에서 시작 (pid $!). 이 창은 닫아도 된다. 진행: tail -f $JPROG"
  exit 0
}
# MACAWAKE (FM-OPS-04): up 25분·down 15분 동안 맥이 잠들면 terraform·터널·워커가 끊긴다 → 이 줄이 도는 동안만 caffeinate 로 잠자기를 막는다.
#   -i 유휴 잠자기, -m 디스크, -s 전원 연결 시 시스템 잠자기. -w <pid>: 그 pid 가 끝나면 caffeinate 도 같이 끝난다(남는 프로세스 없음).
#   뚜껑을 닫거나 배터리만이면 -s 가 안 먹으니 전원 연결·뚜껑 열기는 사람 몫. caffeinate 가 없는 곳(리눅스 VM)은 그냥 지나간다. JEONG_NO_AWAKE=1 이면 끔
j_awake() {
  [ "${JEONG_NO_AWAKE:-0}" = 1 ] && return 0
  _caf=${JEONG_CAFFEINATE:-caffeinate}   # 시험에서만 바꾼다
  command -v "$_caf" >/dev/null 2>&1 || return 0
  "$_caf" -i -m -s -w "$1" < /dev/null > /dev/null 2>&1 &
  return 0
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
  j_awake $$
  # 작업 폴더 잠금: STATE 가 달라도 같은 레포에서 jeong 줄은 하나만
  if ! mkdir "$J_RLOCK" 2>/dev/null; then
    b=$(cat "$J_RLOCK/pid" 2>/dev/null)
    if [ -n "$b" ] && [ "$b" != "$$" ] && j_alive "$b"; then
      rm -rf "$JSTATE/jeong.lock"; echo "$(j_iso) JEONG $name end rc=3 sec=0 log=이 레포에서 이미 도는 줄 pid $b" >> "$JPROG"; exit 3
    fi
    rm -rf "$J_RLOCK"; mkdir "$J_RLOCK" || exit 1
  fi
  echo $$ > "$J_RLOCK/pid"
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
  [ "$(cat "$J_RLOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$J_RLOCK"
  rm -f "$JSTATE/jeong-request-$name"
  echo "$(j_iso) JEONG $name end rc=$rc sec=$(( $(date +%s) - J_T0 )) log=${logp:-$JSTATE/jeong-$name.out}" >> "$JPROG"
}
