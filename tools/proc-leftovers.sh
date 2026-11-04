# FM-ORC-22: 남은 워커 찾기·끄기 (demo-day·up-preflight 가 source). pkill -f 는 안 쓴다(남의 프로세스까지 맞을 수 있음)
#   npm pid 만 kill 하면 그 아래 node(tsx) 워커가 고아로 살아남아 옛 설정으로 다음 작업을 집는다.
#   남은 워커 = (가) 지표 포트 9465~9474 를 LISTEN 하는 node·tsx  (나) 작업 폴더(cwd)가 */apps/worker 인 node·tsx
#   (레포 사본이 달라도 같은 플랫폼 DB 의 큐를 집으므로 폴더를 가리지 않는다)
# 시험: PL_PS·PL_LSOF·PL_CWD 로 ps·lsof·cwd 읽기를 바꾼다
pl_ps() { if [ -n "${PL_PS:-}" ]; then $PL_PS; else ps -axo pid=,command= 2>/dev/null; fi; }
pl_cwd() {
  if [ -n "${PL_CWD:-}" ]; then $PL_CWD "$1"; return; fi
  if [ -d "/proc/$1" ]; then readlink "/proc/$1/cwd" 2>/dev/null; return; fi
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}
pl_port_pids() {
  local p
  for p in 9465 9466 9467 9468 9469 9470 9471 9472 9473 9474; do
    if [ -n "${PL_LSOF:-}" ]; then $PL_LSOF "$p"; else lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null; fi
  done
}
# 남은 워커 pid 를 한 줄에 하나 (자기 자신·부모 셸 제외)
pl_workers() {
  local pid cmd c out=""
  while read -r pid cmd; do
    [ -n "$pid" ] || continue
    case "$pid" in *[!0-9]*) continue ;; esac
    [ "$pid" = "$$" ] && continue
    case "$cmd" in *node*|*tsx*) ;; *) continue ;; esac
    case "$cmd" in *npm*) continue ;; esac
    c=$(pl_cwd "$pid")
    case "$c" in */apps/worker) out="$out $pid" ;; esac
  done <<PLEOF
$(pl_ps)
PLEOF
  for pid in $(pl_port_pids); do
    cmd=$(pl_ps | awk -v p="$pid" '$1 == p { $1 = ""; print; exit }')
    case "$cmd" in *node*|*tsx*) out="$out $pid" ;; esac
  done
  for pid in $out; do echo "$pid"; done | sort -un
}
# 트리째 끄기: 자식부터 TERM → 10초 기다림 → 남으면 KILL
pl_killtree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do pl_killtree "$c"; done; kill "$1" 2>/dev/null; return 0; }
pl_kill() {
  local p i left
  [ $# -gt 0 ] || return 0
  for p in "$@"; do pl_killtree "$p"; done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    left=""; for p in "$@"; do kill -0 "$p" 2>/dev/null && left="$left $p"; done
    [ -z "$left" ] && return 0
    sleep 1
  done
  for p in $left; do kill -9 "$p" 2>/dev/null; done
  echo "TERM 10초 뒤에도 남아 KILL:$left"
  return 0
}
