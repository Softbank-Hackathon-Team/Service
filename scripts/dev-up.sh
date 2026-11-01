#!/usr/bin/env bash
# dev-up.sh: 스켈레톤을 정해진 순서대로 띄운다.
#   점검 -> (필요하면 npm install) -> DB -> 워커 -> API -> 웹 -> smoke
# 각 단계 로그는 .dev-logs/ 에 남는다. 띄운 프로그램은 스크립트가 끝나도 계속 돈다.
#
# 쓰는 법 (Service 폴더에서)
#   bash scripts/dev-up.sh          모두 띄우고 smoke 까지
#   bash scripts/dev-up.sh status   지금 무엇이 떠 있는지
#   bash scripts/dev-up.sh stop     이 스크립트가 띄운 워커·API·웹 끄기 (DB 는 남김)
#   bash scripts/dev-up.sh logs     로그 끝부분 보기
# DB 까지 끄려면 npm run db:down, 데이터까지 지우려면 docker compose down -v (직접 판단해서)

cd "$(dirname "$0")/.." || exit 1
LOG=.dev-logs
mkdir -p "$LOG"
T0=$(date +%s)

step() { printf '\n[%3ss] == %s\n' "$(( $(date +%s) - T0 ))" "$1"; }
info() { printf '        %s\n' "$1"; }
die()  { printf '\n[중단] %s\n' "$1"; [ -n "$2" ] && printf '  -> %s\n' "$2"; [ -n "$3" ] && { printf '  로그 끝부분 (%s):\n' "$3"; grep -vE 'undefined,$|^ *at |^\s*$' "$3" | tail -n 12 | sed 's/^/    /'; }; exit 1; }

env_get() {
  v=""
  [ -f .env ] && v=$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '"'"'"' \r')
  [ -n "$v" ] && printf '%s' "$v" || printf '%s' "$2"
}
API_PORT=$(env_get API_PORT 3000)
API="http://localhost:$API_PORT"

# 자식 프로세스까지 같이 끄기 (npm -> tsx -> node 로 이어짐)
kill_tree() {
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill "$1" 2>/dev/null
}
alive() { [ -f "$LOG/$1.pid" ] && kill -0 "$(cat "$LOG/$1.pid")" 2>/dev/null; }

do_stop() {
  for n in web api worker; do
    if alive "$n"; then kill_tree "$(cat "$LOG/$n.pid")"; echo "끔: $n"; fi
    rm -f "$LOG/$n.pid"
  done
  echo "DB 는 그대로 둠. 끄려면 npm run db:down"
}

do_status() {
  CID=$(docker compose ps -q db 2>/dev/null)
  if [ -n "$CID" ]; then echo "db     : $(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CID")"; else echo "db     : 없음"; fi
  for n in worker api web; do
    if alive "$n"; then echo "$n$(printf '%*s' $((7-${#n})) ''): 실행 중 (pid $(cat "$LOG/$n.pid"), 로그 $LOG/$n.log)"; else echo "$n$(printf '%*s' $((7-${#n})) ''): 꺼짐"; fi
  done
  curl -sf -m 2 "$API/readyz" >/dev/null 2>&1 && echo "API readyz: ok" || echo "API readyz: 응답 없음"
}

case "${1:-up}" in
  stop)   do_stop; exit 0 ;;
  status) do_status; exit 0 ;;
  logs)   for f in "$LOG"/*.log; do echo "== $f"; tail -n 10 "$f"; done; exit 0 ;;
  up)     ;;
  *)      echo "쓰는 법: bash scripts/dev-up.sh [up|status|stop|logs]"; exit 1 ;;
esac

# 백그라운드로 띄우고 pid 저장
start_bg() {
  name=$1; shift
  if alive "$name"; then info "이미 실행 중: $name (pid $(cat "$LOG/$name.pid")). 건너뜀"; return 1; fi
  : > "$LOG/$name.log"
  nohup "$@" > "$LOG/$name.log" 2>&1 &
  echo $! > "$LOG/$name.pid"
  info "시작 pid $! , 로그 $LOG/$name.log"
  return 0
}
# 조건이 참이 될 때까지 기다림. 프로세스가 죽으면 바로 실패
wait_until() {
  name=$1; secs=$2; shift 2
  i=0
  while [ "$i" -lt $((secs*2)) ]; do
    "$@" && return 0
    if [ -n "$name" ]; then
      alive "$name" || return 2
      # tsx watch 는 프로그램이 죽어도 자기는 살아서 파일 변경을 기다린다. 그래서 로그로 판단
      grep -qE '^Node\.js v[0-9]|Failed running|EADDRINUSE' "$LOG/$name.log" 2>/dev/null && return 2
    fi
    sleep 0.5; i=$((i+1))
  done
  return 1
}
db_healthy() {
  CID=$(docker compose ps -q db 2>/dev/null)
  [ -n "$CID" ] && [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CID" 2>/dev/null)" = healthy ]
}
db_exited() {
  CID=$(docker compose ps -aq db 2>/dev/null)
  [ -n "$CID" ] && [ "$(docker inspect -f '{{.State.Status}}' "$CID" 2>/dev/null)" = exited ]
}

step "1/7 점검 (dev-check.sh)"
bash scripts/dev-check.sh > "$LOG/check.log" 2>&1
RC=$?
grep -E '\[(실패|주의)\]|->' "$LOG/check.log" | sed 's/^/  /'
if [ "$RC" -ne 0 ]; then
  # node_modules 만 없는 경우는 다음 단계에서 해결되므로 실패로 보지 않는다
  die "점검 실패. 위 [실패] 줄을 먼저 고치기" "전체 결과: cat $LOG/check.log"
fi
info "통과"

step "2/7 의존성 (npm install)"
if [ -d node_modules/tsx ]; then
  info "이미 설치돼 있음. 건너뜀"
else
  info "처음이라 설치함 (1~3분)"
  npm install > "$LOG/npm-install.log" 2>&1 || die "npm install 실패" "네트워크·node 버전 확인" "$LOG/npm-install.log"
  info "끝"
fi

step "3/7 DB (npm run db:up)"
npm run db:up > "$LOG/db.log" 2>&1
if [ $? -ne 0 ]; then
  if grep -q '429' "$LOG/db.log"; then
    die "Docker Hub 내려받기 횟수 제한(429)" "docker pull mirror.gcr.io/library/postgres:16-alpine 그다음 docker tag mirror.gcr.io/library/postgres:16-alpine postgres:16-alpine 그다음 다시 실행" "$LOG/db.log"
  fi
  if grep -qiE 'address already in use|port is already allocated' "$LOG/db.log"; then
    die "5432 포트를 다른 프로그램이 잡고 있음" "bash scripts/dev-check.sh 로 누가 잡았는지 확인" "$LOG/db.log"
  fi
  die "DB 컨테이너를 못 띄움" "" "$LOG/db.log"
fi
db_settled() { db_healthy || db_exited; }
wait_until "" 90 db_settled
if ! db_healthy; then
  docker compose logs db > "$LOG/db-container.log" 2>&1
  if grep -q 'Permission denied' "$LOG/db-container.log"; then
    die "DB 가 마이그레이션 파일을 못 읽음" "chmod -R a+rX db 그다음 docker compose down -v 그다음 다시 실행" "$LOG/db-container.log"
  fi
  die "DB 가 90초 안에 healthy 가 안 됨" "docker compose logs db 확인" "$LOG/db-container.log"
fi
info "healthy"
docker compose logs db 2>/dev/null | grep -q 'initdb.d/0001' && info "새 DB 라서 db/migrations/*.sql 을 처음부터 실행함"

step "4/7 워커 (npm run dev:worker)"
if start_bg worker npm run dev:worker; then
  wait_until worker 60 grep -q 'worker ready' "$LOG/worker.log"
  case $? in
    0) info "$(grep -m1 'worker ready' "$LOG/worker.log")" ;;
    2) grep -qE 'password authentication failed|role "app_user" does not exist' "$LOG/worker.log" &&
         die "워커가 DB 에 app_user 로 못 붙음" "옛 DB 볼륨이 남아 있음. docker compose down -v 그다음 다시 실행 (DB 데이터가 지워짐)" "$LOG/worker.log"
       grep -q 'ECONNREFUSED' "$LOG/worker.log" && die "워커가 DB(5432)에 못 붙음" "docker compose ps 로 DB 가 떠 있는지 확인" "$LOG/worker.log"
       die "워커가 죽음" "" "$LOG/worker.log" ;;
    *) die "워커가 60초 안에 ready 를 안 찍음" "" "$LOG/worker.log" ;;
  esac
fi

step "5/7 API (npm run dev:api, 포트 $API_PORT)"
if start_bg api npm run dev:api; then
  wait_until api 60 curl -sf -m 2 "$API/readyz" -o /dev/null
  case $? in
    0) info "healthz $(curl -s "$API/healthz"), readyz $(curl -s "$API/readyz")" ;;
    2) grep -q 'EADDRINUSE' "$LOG/api.log" && die "포트 $API_PORT 를 다른 프로그램이 잡고 있음" ".env 의 API_PORT 를 바꾸거나 그 프로그램 끄기" "$LOG/api.log"
       die "API 가 죽음" "" "$LOG/api.log" ;;
    *) die "API 가 60초 안에 readyz 를 안 줌" "" "$LOG/api.log" ;;
  esac
fi

step "6/7 웹 화면 (npm run dev:web, 포트 5173)"
if API_URL="$API" start_bg web npm run dev:web; then
  wait_until web 60 curl -sf -m 2 http://localhost:5173/api/healthz -o /dev/null
  case $? in
    0) info "http://localhost:5173 열림 (API 프록시 정상)" ;;
    2) die "웹 서버가 죽음" "5173 포트를 다른 프로그램이 잡았는지 확인" "$LOG/web.log" ;;
    *) die "웹이 60초 안에 API 를 못 부름" "" "$LOG/web.log" ;;
  esac
fi

step "7/7 smoke (이전 1건을 끝까지)"
API_PORT="$API_PORT" npm run smoke 2>&1 | tee "$LOG/smoke.log" | sed -n '/POST \/migrations/,$p' | sed 's/^/        /'
grep -q '^completed after' "$LOG/smoke.log" || die "smoke 가 completed 까지 못 감" "워커 로그를 같이 볼 것: $LOG/worker.log" "$LOG/smoke.log"

printf '\n[%3ss] 끝. 모두 떠 있음\n' "$(( $(date +%s) - T0 ))"
echo "  화면    : http://localhost:5173"
echo "  API     : $API/api/v1  (회사 헤더 x-dev-tenant 필요)"
echo "  상태    : bash scripts/dev-up.sh status"
echo "  로그    : bash scripts/dev-up.sh logs"
echo "  끄기    : bash scripts/dev-up.sh stop  그다음 npm run db:down"
