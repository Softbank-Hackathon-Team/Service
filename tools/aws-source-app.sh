#!/usr/bin/env bash
# AWS 출발 샘플 앱 올리기·채우기·내리기 (상태 DRAFT(ai)). 이미 있는 EKS·RDS PostgreSQL 에 앱만 올린다 (EKS·RDS 는 만들지 않음).
# tools/gcp-source.sh 의 app·seed·down 과 같은 일. 값을 채운 명령은 bash tools/team-env.sh <slot> source 가 등록부에서 찍는다.
#   bash tools/aws-source-app.sh app  [--dry-run]   네임스페이스 → Secret(api-secrets 랜덤, shop-db-app = DB 비밀번호) → sample-3tier-eks.yaml.tpl (이미지 digest 고정)
#   bash tools/aws-source-app.sh seed [--dry-run]   EKS 안 일회용 Job 으로 orders 표 + 100행 (다시 돌려도 100행 그대로)
#   bash tools/aws-source-app.sh down [--dry-run]   네임스페이스만 지운다 (라벨 m-import=1 인 것만). EKS·RDS·orders 표는 그대로
# 환경 변수: KUBE_CONTEXT(필수, 현재 컨텍스트는 안 씀) NS(real-app) AWS_REGION(ap-northeast-2)
#   DB_HOST(app·seed 필수, RDS 엔드포인트) DB_NAME(postgres) DB_USER(비밀 JSON 의 username, 없으면 postgres)
#   DB_PASSWORD_FILE(비밀번호 한 줄 파일) 또는 DB_PASSWORD_SECRET_ID(Secrets Manager id·ARN, RDS 관리 비밀번호 JSON 이면 password 키)
#   WEB_IMAGE·API_IMAGE·SEED_IMAGE(gcp-source.sh 와 같은 기본값. 태그면 digest 로 바꿈, @sha256 로 주면 그대로) AWS_SOURCE_STATE(~/.svc-tf/aws-source: 로그)
# 비밀값·계정 번호를 찍지 않는다. 명령 출력은 로그 파일에만, 화면에는 단계와 끝 코드만. 끝 코드: 0 정상  1 실패  2 인자·입력 잘못
set -u
cd "$(dirname "$0")/.." || exit 1
CMD=${1:-}; shift || true
DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) echo "모르는 옵션: $a" >&2; exit 2 ;; esac; done
case "$CMD" in app|seed|down) ;; -h|--help|"") sed -n '2,12p' "$0"; [ -n "$CMD" ]; exit $? ;; *) echo "app·seed·down 중 하나" >&2; exit 2 ;; esac

KCTX=${KUBE_CONTEXT:-}
NS=${NS:-real-app}
AWS_REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}
DB_HOST=${DB_HOST:-}
DB_NAME=${DB_NAME:-postgres}
DB_USER=${DB_USER:-}
PW_FILE=${DB_PASSWORD_FILE:-}
PW_SECRET=${DB_PASSWORD_SECRET_ID:-}
WEB_IMAGE=${WEB_IMAGE:-docker.io/library/nginx:1.27-alpine}   # gcp-source.sh·real-session.sh 기본값과 같음
API_IMAGE=${API_IMAGE:-docker.io/hashicorp/http-echo:1.0}
SEED_IMAGE=${SEED_IMAGE:-docker.io/library/postgres:16-alpine}
STATE=${AWS_SOURCE_STATE:-$HOME/.svc-tf/aws-source}
TPL=tools/real/flow/sample-3tier-eks.yaml.tpl
LOGF=$STATE/$CMD-$(date -u +%Y%m%dT%H%M%SZ).log
# 화면 글자는 계정 번호(12자리)를 가린다 (컨텍스트·비밀 ARN 에 들어 있을 수 있음)
say() { echo "$(date -u +%H:%M:%SZ) aws-source $*" | sed -E 's/(^|[^0-9])[0-9]{12}([^0-9]|$)/\1************\2/g'; }
bad() { echo "aws-source: $*" >&2; exit 2; }

# 입력 검사 (dry-run 도 같다. 무엇이 틀렸는지 한 줄)
[ -n "$KCTX" ] || bad "KUBE_CONTEXT 가 없음 (aws eks update-kubeconfig --alias 로 만든 컨텍스트. bash tools/team-env.sh <slot> source 가 찍는다)"
NS_RE='^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$'
[[ "$NS" =~ $NS_RE ]] || bad "NS 가 네임스페이스 이름 모양이 아님: $NS"
case "$NS" in default|kube-*) bad "NS=$NS 는 시스템 네임스페이스라 쓰지 않는다" ;; esac
if [ "$CMD" != down ]; then
  HOST_RE='^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'; ID_RE='^[A-Za-z_][A-Za-z0-9_]{0,62}$'; REGION_RE='^[a-z]{2}(-[a-z]+)+-[0-9]+$'
  [ -n "$DB_HOST" ] || bad "DB_HOST 가 없음 (RDS 엔드포인트)"
  [ "$DB_HOST" != None ] || bad "DB_HOST=None: 그 리전에서 PostgreSQL RDS 를 못 찾음 (리전·AWS 계정 확인, 또는 DB_HOST 를 직접 준다)"
  [[ "$DB_HOST" =~ $HOST_RE ]] || bad "DB_HOST 가 호스트 이름 모양이 아님"
  [[ "$DB_NAME" =~ $ID_RE ]] || bad "DB_NAME 모양이 아님: $DB_NAME"
  [ -z "$DB_USER" ] || [[ "$DB_USER" =~ $ID_RE ]] || bad "DB_USER 모양이 아님"
  [[ "$AWS_REGION" =~ $REGION_RE ]] || bad "AWS_REGION 모양이 아님: $AWS_REGION"
  [ -z "$PW_FILE" ] || [ -z "$PW_SECRET" ] || bad "DB_PASSWORD_FILE·DB_PASSWORD_SECRET_ID 중 하나만 준다"
  [ -n "$PW_FILE$PW_SECRET" ] || bad "DB 비밀번호 위치가 없음: DB_PASSWORD_FILE(한 줄 파일, 600) 또는 DB_PASSWORD_SECRET_ID(Secrets Manager id)"
  [ "$PW_SECRET" != None ] || bad "DB_PASSWORD_SECRET_ID=None: RDS 가 Secrets Manager 관리 비밀번호가 아님 → DB_PASSWORD_FILE 로 준다"
fi

# run: dry-run 이면 명령만 찍고, 아니면 로그 파일에 출력을 남기며 실행 (인자 그대로, 셸 합치기 없음)
run() {
  if [ "$DRY" = 1 ]; then say "DRY: $*"; return 0; fi
  "$@" >> "$LOGF" 2>&1; local rc=$?; [ $rc -eq 0 ] || say "실패 rc=$rc: $* (로그 $LOGF)"; return $rc
}
K() { kubectl --context "$KCTX" "$@"; }
[ "$DRY" = 1 ] || { mkdir -p "$STATE" && chmod 700 "$STATE" || exit 1; }
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/aws-source.XXXXXX")" || exit 1; chmod 700 "$TMPD"
trap 'rm -rf "$TMPD"' EXIT

# 이미지 태그 → repo@sha256:… (gcp-source.sh 의 digest_ref 와 같음)
digest_ref() {
  case "$1" in *@sha256:*) echo "$1"; return 0 ;; esac
  [ "$DRY" = 1 ] && { echo "${1%:*}@sha256:<dry-digest>"; return 0; }
  local d
  d=$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest 2>/dev/null)
  case "$d" in sha256:*) echo "${1%:*}@$d" ;; *) return 1 ;; esac
}
# 클러스터 연결 확인: 이름을 준 컨텍스트에만 쓴다 (없으면 만들지 않고 멈춤)
need_ctx() {
  [ "$DRY" = 1 ] && { say "DRY: kubectl 컨텍스트 $KCTX 확인"; return 0; }
  kubectl config get-contexts -o name 2>/dev/null | grep -qxF -- "$KCTX" && return 0
  say "kubectl 컨텍스트 $KCTX 없음 → aws eks update-kubeconfig --name <EKS> --region $AWS_REGION --alias $KCTX 뒤 다시"; return 1
}
# k8s Secret 을 파일에서 만들거나 갈아 끼운다 (값은 파이프로만, 화면·로그에 안 남음)
put_secret() { # 이름 키 파일
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS create secret generic $1 --from-file=$2=<임시 파일> | kubectl apply -f -"; return 0; fi
  K -n "$NS" create secret generic "$1" --from-file="$2=$3" --dry-run=client -o yaml | K apply -f - >> "$LOGF" 2>&1 \
    || { say "Secret $1 만들기 실패 (로그 $LOGF)"; return 1; }
}
ensure_ns() {
  if [ "$DRY" = 1 ]; then say "DRY: kubectl create namespace $NS --dry-run=client -o yaml | kubectl apply -f -"; return 0; fi
  K create namespace "$NS" --dry-run=client -o yaml | K apply -f - >> "$LOGF" 2>&1 || { say "네임스페이스 실패 (로그 $LOGF)"; return 1; }
}
# DB 비밀번호 → $TMPD/pw (600). Secrets Manager 값이 JSON(RDS 관리 비밀번호)이면 password, DB_USER 가 비면 username 도 쓴다
read_pw() {
  if [ "$DRY" = 1 ]; then
    if [ -n "$PW_FILE" ]; then say "DRY: DB 비밀번호 = DB_PASSWORD_FILE 첫 줄 → <임시 파일(600)> (화면·로그에 안 찍음)"
    else say "DRY: aws secretsmanager get-secret-value --secret-id <DB_PASSWORD_SECRET_ID> --region $AWS_REGION → <임시 파일(600)>"; fi
    return 0
  fi
  if [ -n "$PW_SECRET" ]; then command -v jq >/dev/null 2>&1 || { say "jq 가 없음 (Secrets Manager 값을 읽는 데 필요)"; return 1; }; fi
  ( umask 077
    if [ -n "$PW_FILE" ]; then
      [ -r "$PW_FILE" ] || exit 1
      head -n 1 "$PW_FILE" | tr -d '\r\n' > "$TMPD/pw"
    else
      aws secretsmanager get-secret-value --secret-id "$PW_SECRET" --region "$AWS_REGION" --query SecretString --output text > "$TMPD/raw" 2>> "$LOGF" || exit 1
      if jq -e 'type == "object"' "$TMPD/raw" >/dev/null 2>&1; then
        jq -r '.password // empty' "$TMPD/raw" | tr -d '\r\n' > "$TMPD/pw"
        jq -r '.username // empty' "$TMPD/raw" | tr -d '\r\n' > "$TMPD/user"
      else
        head -n 1 "$TMPD/raw" | tr -d '\r\n' > "$TMPD/pw"
      fi
      rm -f "$TMPD/raw"
    fi
  ) || { say "DB 비밀번호를 못 읽음 (DB_PASSWORD_FILE 이 있는지, 또는 Secrets Manager 권한·id·리전. 로그 $LOGF)"; return 1; }
  [ -s "$TMPD/pw" ] || { say "DB 비밀번호가 비었음"; return 1; }
  [ -n "$DB_USER" ] || DB_USER=$(cat "$TMPD/user" 2>/dev/null)
  return 0
}

case "$CMD" in
app)
  say "app 시작 dry=$DRY ctx=$KCTX ns=$NS"
  need_ctx || exit 1
  WEB_REF=$(digest_ref "$WEB_IMAGE") && API_REF=$(digest_ref "$API_IMAGE") \
    || { say "이미지 digest 를 못 구함 (docker buildx 필요): WEB_IMAGE·API_IMAGE 에 repo@sha256:… 로 주면 됨"; exit 1; }
  say "이미지 web=$WEB_REF api=$API_REF"
  # 템플릿은 그대로 쓴다. 자리표시 네 개만 채운다 (gcp-source.sh·real-session.sh deploy 단계와 같음)
  sed -e "s#__NS__#${NS}#g" -e "s#__WEB_IMAGE__#${WEB_REF}#g" -e "s#__API_IMAGE__#${API_REF}#g" -e "s#__DB_HOST__#${DB_HOST}#g" "$TPL" > "$TMPD/sample.yaml" || exit 1
  if grep -q '__[A-Z_]*__' "$TMPD/sample.yaml"; then say "템플릿에 못 채운 자리표시가 남음: $(grep -o '__[A-Z_]*__' "$TMPD/sample.yaml" | sort -u | tr '\n' ' ')"; exit 1; fi
  say "매니페스트 렌더 OK ($(grep -c '^kind:' "$TMPD/sample.yaml")개 객체)"
  read_pw || exit 1
  ensure_ns || exit 1
  # api-secrets 는 시험용 랜덤 값. 이미 있으면 그대로 둔다 (다시 돌려도 API_TOKEN 이 안 바뀜 → 진행 중인 이전의 비밀 복사와 안 어긋남)
  if [ "$DRY" = 1 ]; then say "DRY: (api-secrets 가 없을 때만) kubectl -n $NS create secret generic api-secrets --from-file=API_TOKEN=<임시 파일(랜덤)> | kubectl apply -f -"
  elif [ -n "$(K -n "$NS" get secret api-secrets --ignore-not-found -o name 2>> "$LOGF")" ]; then say "api-secrets 있음 → 그대로"
  else
    ( umask 077; openssl rand -hex 24 | tr -d '\n' > "$TMPD/s1" ) || exit 1
    put_secret api-secrets API_TOKEN "$TMPD/s1" || exit 1
  fi
  # shop-db-app = 진짜 DB 비밀번호 (앱이 RDS 에 붙는 연결 비밀. 이전 때 tools/secret-copy.py 가 도착 비밀 저장소로 옮긴다)
  put_secret shop-db-app password "$TMPD/pw" || exit 1
  rm -f "$TMPD/pw"
  run kubectl --context "$KCTX" apply -f "$TMPD/sample.yaml" || exit 1
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS wait --for=condition=Available deployment --all --timeout=300s"
  elif K -n "$NS" wait --for=condition=Available deployment --all --timeout=300s >> "$LOGF" 2>&1; then say "Deployment Available"
  else say "300초 안에 Available 아님 (kubectl -n $NS get pods 로 확인)"; exit 1; fi
  say "app 끝 (다음: seed)"
  ;;
seed)
  say "seed 시작 dry=$DRY ctx=$KCTX ns=$NS"
  need_ctx || exit 1
  SEED_REF=$(digest_ref "$SEED_IMAGE") || { say "seed 이미지 digest 를 못 구함: SEED_IMAGE 에 repo@sha256:… 로 주면 됨"; exit 1; }
  read_pw || exit 1
  [ -n "$DB_USER" ] || [ "$DRY" = 1 ] || DB_USER=postgres   # dry-run 은 비밀을 안 읽으므로 자리 값으로 둔다
  [ -z "$DB_USER" ] || [[ "$DB_USER" =~ $ID_RE ]] || { say "DB 사용자 이름 모양이 아님 (DB_USER 를 직접 준다)"; exit 1; }
  # 끝나면(실패해도) Job·Secret 을 지운다
  cleanup_seed() { run kubectl --context "$KCTX" -n "$NS" delete job shop-seed secret shop-seed-db --ignore-not-found --wait=true; rm -f "$TMPD/pw"; }
  ensure_ns || exit 1
  run kubectl --context "$KCTX" -n "$NS" delete job shop-seed --ignore-not-found --wait=true || exit 1
  put_secret shop-seed-db PGPASSWORD "$TMPD/pw" || { cleanup_seed; exit 1; }
  rm -f "$TMPD/pw"
  # 표 모양·SQL = gcp-source.sh seed. 다시 돌려도 100행을 넘지 않게: 모자란 만큼만 넣는다 (100 이상이면 0행)
  cat > "$TMPD/seed-job.yaml" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: shop-seed
  namespace: ${NS}
  labels: { app: shop-seed }
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 300
  template:
    metadata:
      labels: { app: shop-seed }
    spec:
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 70 }
      containers:
        - name: psql
          image: ${SEED_REF}
          command: ["psql", "-v", "ON_ERROR_STOP=1", "-At",
            "-c", "create table if not exists orders (id bigserial primary key, item text, qty int, created_at timestamptz default now())",
            "-c", "insert into orders (item, qty) select 'item-' || g, (g % 5) + 1 from generate_series(1, greatest(0, 100 - (select count(*) from orders))) g",
            "-c", "select 'orders=' || count(*) from orders"]
          env:
            - { name: PGHOST, value: "${DB_HOST}" }
            - { name: PGPORT, value: "5432" }
            - { name: PGDATABASE, value: "${DB_NAME}" }
            - { name: PGUSER, value: "${DB_USER:-<비밀의 username 또는 postgres>}" }
            - { name: PGSSLMODE, value: require }
            - { name: PGCONNECT_TIMEOUT, value: "10" }
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef: { name: shop-seed-db, key: PGPASSWORD }
          resources:
            requests: { cpu: 50m, memory: 32Mi }
EOF
  run kubectl --context "$KCTX" apply -f "$TMPD/seed-job.yaml" || { cleanup_seed; exit 1; }
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS wait --for=condition=complete job/shop-seed --timeout=300s → logs 의 orders=N"; rc=0
  elif K -n "$NS" wait --for=condition=complete job/shop-seed --timeout=300s >> "$LOGF" 2>&1; then
    N=$(K -n "$NS" logs job/shop-seed 2>> "$LOGF" | grep -o 'orders=[0-9]*' | tail -1)
    say "seed 끝 ${N:-orders=?}"; rc=0
  else
    K -n "$NS" logs job/shop-seed >> "$LOGF" 2>&1
    say "seed Job 이 300초 안에 안 끝남: RDS 보안 그룹이 EKS 에서 5432 를 받는지, DB_NAME·DB_USER 가 맞는지 (로그 $LOGF)"; rc=1
  fi
  cleanup_seed
  exit $rc
  ;;
down)
  say "down 시작 dry=$DRY ctx=$KCTX ns=$NS"
  need_ctx || exit 1
  # 이 샘플 템플릿이 붙인 라벨(m-import=1)이 있는 네임스페이스만 지운다 (NS 를 잘못 줘도 남의 것은 안 지움)
  if [ "$DRY" = 1 ]; then say "DRY: kubectl get namespaces -l m-import=1 -o name 에 namespace/$NS 가 있는지 확인"
  else
    out=$(K get namespaces -l m-import=1 -o name 2>> "$LOGF") || { say "네임스페이스 조회 실패 (로그 $LOGF)"; exit 1; }
    if ! printf '%s\n' "$out" | grep -qxF "namespace/$NS"; then
      if [ -z "$(K get namespace "$NS" --ignore-not-found -o name 2>> "$LOGF")" ]; then say "네임스페이스 $NS 없음 → 할 일 없음"; exit 0; fi
      say "네임스페이스 $NS 에 라벨 m-import=1 이 없음 → 이 샘플이 만든 것이 아니라 지우지 않는다"; exit 1
    fi
  fi
  run kubectl --context "$KCTX" delete namespace "$NS" --ignore-not-found --wait=true --timeout=300s || exit 1
  say "down 끝 (EKS·RDS·orders 표는 그대로. 지우려면 사람이 직접)"
  ;;
esac
