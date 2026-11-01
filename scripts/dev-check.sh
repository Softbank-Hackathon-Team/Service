#!/usr/bin/env bash
# dev-check.sh: 스켈레톤을 띄우기 전에 내 노트북 상태를 점검한다.
# 아무것도 설치·삭제·변경하지 않는다. 읽기만 한다.
# 쓰는 법: Service 폴더(package.json 있는 곳)에서  bash scripts/dev-check.sh
# 맥(Intel·Apple Silicon)의 기본 bash 3.2 와 리눅스 bash 5 둘 다에서 돈다.

cd "$(dirname "$0")/.." || exit 1

FAIL=0
WARN=0
ok()   { printf '  [OK]   %s\n' "$1"; }
warn() { printf '  [주의] %s\n' "$1"; [ -n "$2" ] && printf '         -> %s\n' "$2"; WARN=$((WARN+1)); }
bad()  { printf '  [실패] %s\n' "$1"; [ -n "$2" ] && printf '         -> %s\n' "$2"; FAIL=$((FAIL+1)); }
has()  { command -v "$1" >/dev/null 2>&1; }

# .env 에서 값 하나 읽기 (없으면 기본값)
env_get() {
  v=""
  [ -f .env ] && v=$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '"'"'"' \r')
  [ -n "$v" ] && printf '%s' "$v" || printf '%s' "$2"
}

# 포트를 누가 잡고 있는지 한 줄로. 비어 있으면 빈 문자열
port_owner() {
  p=$1
  if has lsof; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'
  elif has ss; then
    ss -ltnpH "sport = :$p" 2>/dev/null | head -n 1 | sed -E 's/.*users:\(\("([^"]+)",pid=([0-9]+).*/\1 (pid \2)/'
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && echo "알 수 없는 프로그램"
  fi
}

echo "== 1. 운영체제"
OS=$(uname -s); ARCH=$(uname -m)
case "$OS/$ARCH" in
  Darwin/arm64)  ok "macOS Apple Silicon ($ARCH)" ;;
  Darwin/x86_64) ok "macOS Intel ($ARCH)" ;;
  Linux/*)       ok "Linux ($ARCH)" ;;
  *)             warn "$OS/$ARCH 는 확인해 보지 않은 환경" "Windows 라면 WSL2 안의 Ubuntu 에서 실행" ;;
esac

echo "== 2. 도구"
if has node; then
  NV=$(node -v | sed 's/^v//'); NMAJ=${NV%%.*}
  if [ "$NMAJ" -ge 22 ] 2>/dev/null; then ok "node v$NV"
  else bad "node v$NV 는 너무 낮음 (22 이상 필요, 24 권장)" "nodejs.org 에서 LTS 설치 또는 nvm install 24"; fi
else
  bad "node 없음" "nodejs.org 에서 LTS(24) 설치"
fi
if has npm; then ok "npm $(npm -v)"; else bad "npm 없음" "node 를 설치하면 같이 깔림"; fi

if has docker; then
  ok "docker $(docker version --format '{{.Client.Version}}' 2>/dev/null)"
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null)"
  else
    bad "docker compose(v2) 없음" "Docker Desktop 최신판, 리눅스는 docker-compose-plugin 패키지"
  fi
  if docker info >/dev/null 2>&1; then
    ok "docker 엔진 실행 중"
  else
    if [ "$OS" = Darwin ]; then
      bad "docker 엔진이 꺼져 있음" "Docker Desktop 앱을 켜고 고래 아이콘이 멈출 때까지 기다림"
    else
      bad "docker 엔진에 못 붙음" "sudo systemctl start docker, 또는 내 계정을 docker 그룹에 추가"
    fi
  fi
else
  bad "docker 없음" "맥: Docker Desktop(칩 종류에 맞는 판), 리눅스: Docker Engine"
fi
if has curl; then ok "curl 있음"; else warn "curl 없음" "dev-up.sh 가 상태 확인에 씀"; fi

echo "== 3. 프로젝트 파일"
if [ -f package.json ] && grep -q '"dev:api"' package.json; then ok "Service 폴더 맞음 ($(pwd))"
else bad "여기는 Service 폴더가 아님 ($(pwd))" "package.json 이 있는 폴더에서 실행"; fi

if [ -f .env ]; then
  ok ".env 있음"
  grep -q '^DATABASE_URL=' .env && ok "DATABASE_URL 있음" || bad ".env 에 DATABASE_URL 없음" "cp .env.example .env 로 새로 만들기"
else
  bad ".env 없음" "cp .env.example .env"
fi

if [ -d node_modules/tsx ]; then ok "node_modules 있음 (npm install 끝남)"
else warn "node_modules 없음" "npm install (dev-up.sh 는 없으면 자동으로 함)"; fi

if [ -d db/migrations ]; then
  UNREAD=$(find db/migrations -type f ! -perm -o=r 2>/dev/null | head -n 1)
  if [ -n "$UNREAD" ]; then
    warn "db/migrations 파일을 다른 사용자가 못 읽음 ($UNREAD)" "chmod -R a+rX db  그다음 docker compose down -v  (리눅스에서 tgz 를 풀었을 때 생김)"
  else
    ok "db/migrations 읽기 권한 정상"
  fi
fi

echo "== 4. 포트"
API_PORT=$(env_get API_PORT 3000)
DB_RUNNING=""
if docker info >/dev/null 2>&1; then
  CID=$(docker compose ps -q db 2>/dev/null)
  [ -n "$CID" ] && DB_RUNNING=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CID" 2>/dev/null)
fi

O=$(port_owner 5432)
if [ -z "$O" ]; then ok "5432 비어 있음 (DB 자리)"
elif [ -n "$DB_RUNNING" ]; then ok "5432 는 우리 DB 컨테이너가 쓰는 중 ($DB_RUNNING)"
else
  case "$O" in
    postgres*|postmaste*) bad "5432 를 다른 Postgres 가 잡고 있음: $O" "맥 Homebrew: brew services stop postgresql@16 (버전은 brew services list 로 확인). 리눅스: sudo systemctl stop postgresql" ;;
    *) bad "5432 를 다른 프로그램이 잡고 있음: $O" "그 프로그램을 끄거나 docker ps 로 다른 DB 컨테이너가 있는지 확인" ;;
  esac
fi
if has brew && brew services list 2>/dev/null | grep -E '^postgresql' | grep -q started; then
  warn "Homebrew Postgres 가 켜져 있음 (재부팅하면 5432 를 다시 잡을 수 있음)" "brew services stop postgresql@16"
fi

check_app_port() {
  p=$1; name=$2; probe=$3
  O=$(port_owner "$p")
  if [ -z "$O" ]; then ok "$p 비어 있음 ($name 자리)"
  elif [ -n "$probe" ] && curl -sf -m 2 "$probe" >/dev/null 2>&1; then warn "$p 에 이미 $name 서버가 떠 있는 것 같음: $O" "새로 띄울 거면 그 터미널에서 Ctrl+C, dev-up.sh 로 띄웠다면 bash scripts/dev-up.sh stop"
  else bad "$p 를 다른 프로그램이 잡고 있음: $O" "그 프로그램을 끄거나, $name 포트를 바꾸기 (QUICKSTART 의 오류 표 참고)"; fi
}
check_app_port "$API_PORT" "API" "http://localhost:$API_PORT/healthz"
check_app_port 5173 "웹 화면" "http://localhost:5173/"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "결과: 실패 $FAIL, 주의 $WARN. [실패] 줄의 -> 안내부터 고친 뒤 다시 실행."
  exit 1
fi
echo "결과: 실패 0, 주의 $WARN. 띄울 준비 됨."
exit 0
