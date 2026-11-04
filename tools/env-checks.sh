# 맥 환경 점검 함수 (MACENV, FM-ENV-02·05). tools/up-preflight.sh 가 source 한다. 상태: AI 초안
# 줄 모양은 up-preflight 와 같다: ok/fail/warn <항목> <설명> (부르는 쪽이 ok·fail·warn 함수를 정의). 조회만 하고 아무것도 바꾸지 않는다.
# 맥(BSD)·리눅스 둘 다: df -Pk(POSIX 칸 고정), node -p, docker info --format 만 쓴다.
# DRAFT(ai): 문턱값 = node 22 이상, 빈 디스크 3GB 미만 FAIL·10GB 미만 WARN (terraform 공급자 4벌 ≈1.5GB + node_modules·로그), Docker 메모리 4GB 미만 WARN
EC_NODE_MIN=${EC_NODE_MIN:-22}
EC_DISK_FAIL_KB=${EC_DISK_FAIL_KB:-3145728}
EC_DISK_WARN_KB=${EC_DISK_WARN_KB:-10485760}
EC_DOCKER_MEM_WARN=${EC_DOCKER_MEM_WARN:-4294967296}
# node 큰 버전 (CLAUDE.md 스택: Node.js 22). 다른 큰 버전이면 tsx·npm ci 가 다르게 돌 수 있다
ec_node() {
  command -v node >/dev/null 2>&1 || return 0   # 없는 건 tools 줄이 이미 FAIL
  local nv maj
  nv=$(node -p 'process.versions.node' 2>/dev/null)
  maj=${nv%%.*}
  case "$maj" in ''|*[!0-9]*) fail node-version "node 버전을 못 읽음 (${nv:-빈 값})"; return 0 ;; esac
  if [ "$maj" -ge "$EC_NODE_MIN" ]; then ok node-version "$nv (≥$EC_NODE_MIN)"
  else fail node-version "$nv (node $EC_NODE_MIN 이상 필요: brew install node@22 후 PATH 앞에 node@22 bin)"; fi
}
# FM-ENV-02: kubectl 버전 차이. 쿠버네티스는 클라이언트·서버 차이를 작은 버전 ±1 까지만 지원한다.
#   기준 = aws/env 의 k8s_version 기본값(EKS 도착). DRAFT(ai): 1 넘게 낮으면 WARN (apply·rollout status 의 일부 필드가 안 보일 수 있음), 못 읽으면 WARN
ec_kubectl() {
  command -v kubectl >/dev/null 2>&1 || return 0
  local tf=${1:-infra/modules/aws/env/main.tf} want cv cmin wmin
  want=$(sed -n '/variable "k8s_version"/,/}/s/^[[:space:]]*default[[:space:]]*=[[:space:]]*"\([0-9.]*\)".*/\1/p' "$tf" 2>/dev/null | head -n 1)
  cv=$(kubectl version --client -o json 2>/dev/null | sed -n 's/.*"gitVersion": *"v\([0-9][0-9.]*\).*/\1/p' | head -n 1)
  [ -n "$cv" ] || { warn kubectl-version "kubectl 버전을 못 읽음"; return 0; }
  [ -n "$want" ] || { ok kubectl-version "$cv (기준 버전 못 읽음)"; return 0; }
  cmin=$(echo "$cv" | cut -d. -f2); wmin=$(echo "$want" | cut -d. -f2)
  case "$cmin$wmin" in *[!0-9]*|'') warn kubectl-version "$cv (비교 못 함)"; return 0 ;; esac
  if [ "$cmin" -ge $((wmin - 1)) ] && [ "$cmin" -le $((wmin + 1)) ]; then ok kubectl-version "$cv (EKS $want 과 ±1 안)"
  else warn kubectl-version "$cv 가 EKS $want 과 작은 버전 1 넘게 차이 → brew upgrade kubectl"; fi
}
# 빈 디스크: 레포 폴더와 상태 폴더(~/.svc-tf) 쪽. df -P 의 4번째 칸 = 남은 KB (BSD·GNU 같음)
ec_disk() {
  local p a worst="" wp=""
  for p in "$@"; do
    [ -e "$p" ] || continue
    a=$(df -Pk "$p" 2>/dev/null | awk 'NR == 2 { print $4 }')
    case "$a" in ''|*[!0-9]*) continue ;; esac
    if [ -z "$worst" ] || [ "$a" -lt "$worst" ]; then worst=$a; wp=$p; fi
  done
  if [ -z "$worst" ]; then warn disk "남은 디스크를 못 읽음 (df -Pk)"; return 0; fi
  local gb=$(( worst / 1048576 ))
  if [ "$worst" -lt "$EC_DISK_FAIL_KB" ]; then fail disk "$wp 쪽 남은 디스크 ${gb}GB (3GB 미만이면 terraform init·로그에서 멈춤 → 휴지통·~/Library/Caches·docker system prune)"
  elif [ "$worst" -lt "$EC_DISK_WARN_KB" ]; then warn disk "$wp 쪽 남은 디스크 ${gb}GB (10GB 미만)"
  else ok disk "남은 디스크 ${gb}GB"; fi
}
# Docker: 플랫폼 DB(docker compose db)·발표 화면(8080 web)이 Docker 위. 꺼져 있으면 demo-day 가 DB 를 못 켠다
ec_docker() {
  if ! command -v docker >/dev/null 2>&1; then warn docker "docker 명령 없음 (플랫폼 DB·8080 화면이 docker 면 up 이 멈춘다)"; return 0; fi
  local m
  if ! m=$(${EC_TMO:-} docker info --format '{{.MemTotal}}' 2>/dev/null) || [ -z "$m" ]; then
    warn docker "Docker 가 대답 안 함 (Docker Desktop 꺼짐?) → 켜고 다시. 플랫폼 DB 가 docker 면 up 이 멈춘다"; return 0
  fi
  case "$m" in *[!0-9]*) warn docker "Docker 메모리 값을 못 읽음 ($m)"; return 0 ;; esac
  if [ "$m" -lt "$EC_DOCKER_MEM_WARN" ]; then warn docker "Docker 메모리 $(( m / 1048576 ))MB (4GB 미만 → DB·web 컨테이너가 죽을 수 있음, Docker Desktop 설정 → Resources)"
  else ok docker "Docker 응답, 메모리 $(( m / 1073741824 ))GB"; fi
}
# DISPOSABLE (FM-OPS-11): 데모 DB(RDS·Cloud SQL)는 DB_DISPOSABLE=1 이어야 삭제 보호·마지막 스냅샷이 꺼져 down 이 지운다.
#   아니면 down 의 destroy 가 DeletionProtection 으로 막혀 DB 가 남아 과금된다. 워커는 demo-day.env(up 이 씀) → .env 순으로 받는다
#   ① demo-day.sh 가 아직 kv DB_DISPOSABLE "1" 을 쓰는가 ② .env 가 1 이 아닌 값으로 두지 않았나(demo-day.env 없이 뜬 워커가 그 값을 씀)
#   ③ 이미 있는 demo-day.env(이어 하기)가 1 인가
ec_disposable() {
  local dd=$1 envf=$2 ddenv=$3 v
  if ! grep -qE "^[[:space:]]*kv DB_DISPOSABLE \"1\"" "$dd" 2>/dev/null; then fail db-disposable "$dd 에 kv DB_DISPOSABLE \"1\" 줄이 없음 → 데모 DB 삭제 보호가 켜져 down 이 못 지움"; return 0; fi
  v=$(sed -n 's/^[[:space:]]*DB_DISPOSABLE=//p' "$envf" 2>/dev/null | tail -n 1 | tr -d "\"' ")
  if [ -n "$v" ] && [ "$v" != 1 ]; then fail db-disposable ".env 의 DB_DISPOSABLE=$v → demo-day.env 없이 뜬 워커는 삭제 보호를 켠다. .env 에서 그 줄을 지우거나 1 로"; return 0; fi
  if [ -f "$ddenv" ]; then
    v=$(sed -n 's/^DB_DISPOSABLE=//p' "$ddenv" | tail -n 1 | tr -d "\"' ")
    [ "$v" = 1 ] || { fail db-disposable "$ddenv 의 DB_DISPOSABLE=${v:-없음} (이어 하는 회차) → 1 이어야"; return 0; }
  fi
  ok db-disposable "데모 DB 삭제 보호 끔 (DB_DISPOSABLE=1)"
}
