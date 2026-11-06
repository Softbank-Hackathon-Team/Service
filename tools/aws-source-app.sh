#!/usr/bin/env bash
# AWS 출발 샘플 앱 올리기·채우기·내리기 (상태 DRAFT(ai)). 이미 있는 EKS·RDS PostgreSQL 에 앱만 올린다 (EKS·RDS 는 만들지 않음).
# tools/gcp-source.sh 의 app·seed·down 과 같은 일. 값을 채운 명령은 bash tools/team-env.sh <slot> source 가 등록부(cluster·db_instance)에서 찍는다.
#   app  [--dry-run]  네임스페이스 → Secret(api-secrets·shop-db-app 랜덤, 있으면 그대로) → sample-3tier-eks.yaml.tpl (DB_USER=shop_app, 이미지 digest 고정)
#   seed [--dry-run]  RDS 마스터로 붙는 일회용 Job: 앱 계정 shop_app(비밀번호 = shop-db-app) + orders 표 + 100행. 마스터 비밀 Secret 은 Job 뒤 지운다
#   down [--dry-run]  네임스페이스만 지운다 (라벨 m-import=1 인 것만). EKS·RDS·orders 표·shop_app 은 그대로
# 환경 변수: KUBE_CONTEXT(필수, 현재 컨텍스트는 안 씀) NS(real-app) AWS_REGION(ap-northeast-2) DB_HOST(app·seed 필수, RDS 엔드포인트)
#   DB_INSTANCE(RDS 식별자. 주면 DB_HOST 가 그 RDS 엔드포인트인지 본다) DB_NAME(shop)
#   seed 만: DB_PASSWORD_SECRET_ID(RDS 관리 마스터 비밀 id·ARN, JSON 이면 username·password) 또는 DB_PASSWORD_FILE(마스터 비밀번호 한 줄 파일)
#            DB_MASTER_USER(비우면 비밀 JSON 의 username, 없으면 postgres)
#   WEB_IMAGE·API_IMAGE·SEED_IMAGE(기본은 gcp-source.sh 와 같은 태그 → docker buildx 로 digest. repo@sha256:… 로 주면 Docker 없이 그대로)
#   AWS_SOURCE_STATE(~/.svc-tf/aws-source: 로그)
# 거부(끝 코드 2): DB_HOST·DB_INSTANCE 에 platform-db(같은 계정의 플랫폼 DB)가 들어 있음, DB_NAME 이 postgres·template0·template1·rdsadmin
# 앱 계정은 RDS 마스터가 아니다 (마스터면 복제 점검 DB-08 이 이전을 멈춤). shop-db-app 에는 shop_app 비밀번호만 둔다
# 비밀값·계정 번호를 찍지 않는다. 명령 출력은 로그 파일에만, 화면에는 단계와 끝 코드만. 끝 코드: 0 정상  1 실패  2 인자·입력 잘못
set -u
cd "$(dirname "$0")/.." || exit 1
CMD=${1:-}; shift || true
DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) echo "모르는 옵션: $a" >&2; exit 2 ;; esac; done
case "$CMD" in app|seed|down) ;; -h|--help|"") sed -n '2,15p' "$0"; [ -n "$CMD" ]; exit $? ;; *) echo "app·seed·down 중 하나" >&2; exit 2 ;; esac

KCTX=${KUBE_CONTEXT:-}
NS=${NS:-real-app}
AWS_REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-2}}
DB_HOST=${DB_HOST:-}
DB_INSTANCE=${DB_INSTANCE:-}
DB_NAME=${DB_NAME:-shop}                 # 샘플 DB (정본 샘플과 같음). postgres 등 시스템 DB 에는 시드하지 않는다
DB_MASTER_USER=${DB_MASTER_USER:-}
APP_USER=shop_app                        # 앱 계정 (마스터와 다름). 정본 샘플·relay 시험의 앱 계정 이름
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
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# 입력 검사 (dry-run 도 같다. 무엇이 틀렸는지 한 줄)
[ -n "$KCTX" ] || bad "KUBE_CONTEXT 가 없음 (aws eks update-kubeconfig --alias 로 만든 컨텍스트. bash tools/team-env.sh <slot> source 가 찍는다)"
NS_RE='^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$'
[[ "$NS" =~ $NS_RE ]] || bad "NS 가 네임스페이스 이름 모양이 아님: $NS"
case "$NS" in default|kube-*) bad "NS=$NS 는 시스템 네임스페이스라 쓰지 않는다" ;; esac
ID_RE='^[A-Za-z_][A-Za-z0-9_]{0,62}$'
if [ "$CMD" != down ]; then
  HOST_RE='^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'; REGION_RE='^[a-z]{2}(-[a-z]+)+-[0-9]+$'; RDS_ID_RE='^[A-Za-z][A-Za-z0-9-]{0,62}$'
  [ -n "$DB_HOST" ] || bad "DB_HOST 가 없음 (RDS 엔드포인트. 등록부 db_instance 로 찾는 줄을 bash tools/team-env.sh <slot> source 가 찍는다)"
  [ "$DB_HOST" != None ] || bad "DB_HOST=None: 그 이름의 RDS 를 못 찾음 (등록부 db_instance·리전·AWS 계정 확인)"
  [[ "$DB_HOST" =~ $HOST_RE ]] || bad "DB_HOST 가 호스트 이름 모양이 아님"
  # 같은 AWS 계정에 플랫폼 자기 DB(platform-db)가 있다. 샘플 시드·앱 계정을 거기에 만들지 않는다
  case "$(lower "$DB_HOST $DB_INSTANCE")" in
    *platform-db*) bad "DB_HOST·DB_INSTANCE 에 platform-db 가 들어 있음: 플랫폼 자기 DB 라 출발 샘플로 쓰지 않는다 (등록부 db_instance 에 자기 샘플 RDS 식별자를 적는다)" ;;
  esac
  if [ -n "$DB_INSTANCE" ]; then
    [[ "$DB_INSTANCE" =~ $RDS_ID_RE ]] || bad "DB_INSTANCE 가 RDS 식별자 모양이 아님: $DB_INSTANCE"
    case "$(lower "$DB_HOST")" in
      "$(lower "$DB_INSTANCE")".*) ;;
      *) bad "DB_HOST 가 DB_INSTANCE=$DB_INSTANCE 의 엔드포인트(<식별자>.<…>.rds.amazonaws.com)가 아님" ;;
    esac
  fi
  [[ "$DB_NAME" =~ $ID_RE ]] || bad "DB_NAME 모양이 아님: $DB_NAME"
  case "$(lower "$DB_NAME")" in
    postgres|template0|template1|rdsadmin) bad "DB_NAME=$DB_NAME 은 시스템·템플릿 DB 라 쓰지 않는다 (샘플 DB 는 shop: RDS 를 만들 때 초기 DB 이름 shop)" ;;
  esac
  [[ "$AWS_REGION" =~ $REGION_RE ]] || bad "AWS_REGION 모양이 아님: $AWS_REGION"
fi
if [ "$CMD" = seed ]; then
  [ -z "$PW_FILE" ] || [ -z "$PW_SECRET" ] || bad "DB_PASSWORD_FILE·DB_PASSWORD_SECRET_ID 중 하나만 준다"
  [ -n "$PW_FILE$PW_SECRET" ] || bad "RDS 마스터 비밀번호 위치가 없음: DB_PASSWORD_SECRET_ID(Secrets Manager id) 또는 DB_PASSWORD_FILE(한 줄 파일, 600)"
  [ "$PW_SECRET" != None ] || bad "DB_PASSWORD_SECRET_ID=None: RDS 가 Secrets Manager 관리 비밀번호가 아님 → DB_PASSWORD_FILE 로 준다"
  [ -z "$DB_MASTER_USER" ] || [[ "$DB_MASTER_USER" =~ $ID_RE ]] || bad "DB_MASTER_USER 모양이 아님"
  [ "$DB_MASTER_USER" != "$APP_USER" ] || bad "DB_MASTER_USER=$APP_USER: 앱 계정이 RDS 마스터면 컷오버 울타리가 안 먹는다 (DB-08). 마스터는 다른 이름이어야 한다"
fi

# run: dry-run 이면 명령만 찍고, 아니면 로그 파일에 출력을 남기며 실행 (인자 그대로, 셸 합치기 없음)
run() {
  if [ "$DRY" = 1 ]; then say "DRY: $*"; return 0; fi
  "$@" >> "$LOGF" 2>&1; local rc=$?; [ $rc -eq 0 ] || say "실패 rc=$rc: $* (로그 $LOGF)"; return $rc
}
K() { kubectl --context "$KCTX" "$@"; }
[ "$DRY" = 1 ] || { mkdir -p "$STATE" && chmod 700 "$STATE" || exit 1; }
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/aws-source.XXXXXX")" || exit 1; chmod 700 "$TMPD"
# 마스터 비밀을 담은 임시 Secret·Job·SQL 은 어떻게 끝나든(실패·Ctrl-C) 지운다
SEED_CLEANUP=0
seed_cleanup() {
  [ "$SEED_CLEANUP" = 1 ] || return 0
  SEED_CLEANUP=0
  run kubectl --context "$KCTX" -n "$NS" delete job/shop-seed secret/shop-seed-db configmap/shop-seed-sql --ignore-not-found --wait=true
}
trap 'seed_cleanup; rm -rf "$TMPD"' EXIT

# 이미지 태그 → repo@sha256:… (gcp-source.sh 의 digest_ref 와 같음). @sha256 로 주면 Docker 없이 그대로
digest_ref() {
  case "$1" in *@sha256:*) echo "$1"; return 0 ;; esac
  [ "$DRY" = 1 ] && { echo "${1%:*}@sha256:<dry-digest>"; return 0; }
  command -v docker >/dev/null 2>&1 || return 1
  local d
  d=$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest 2>/dev/null)
  case "$d" in sha256:*) echo "${1%:*}@$d" ;; *) return 1 ;; esac
}
NO_DIGEST="기본 이미지는 태그라 docker buildx 가 필요. Docker 가 없으면 repo@sha256:<digest> 로 준다 (그러면 Docker 없이 그대로 씀)"
# 클러스터 연결 확인: 이름을 준 컨텍스트에만 쓴다 (없으면 만들지 않고 멈춤)
need_ctx() {
  [ "$DRY" = 1 ] && { say "DRY: kubectl 컨텍스트 $KCTX 확인"; return 0; }
  kubectl config get-contexts -o name 2>/dev/null | grep -qxF -- "$KCTX" && return 0
  say "kubectl 컨텍스트 $KCTX 없음 → aws eks update-kubeconfig --name <EKS> --region $AWS_REGION --alias $KCTX 뒤 다시"; return 1
}
# k8s Secret 을 파일에서 만들거나 갈아 끼운다 (값은 파이프로만, 화면·로그에 안 남음). DRY 줄에는 키와 값의 출처만
put_secret() { # 이름 출처 키=파일…
  local n="$1" what="$2" kv; shift 2
  if [ "$DRY" = 1 ]; then
    say "DRY: kubectl -n $NS create secret generic $n $(for kv in "$@"; do printf -- '--from-file=%s=<임시 파일> ' "${kv%%=*}"; done)| kubectl apply -f -  # 값: $what"
    return 0
  fi
  local a=(); for kv in "$@"; do a+=("--from-file=$kv"); done
  K -n "$NS" create secret generic "$n" "${a[@]}" --dry-run=client -o yaml | K apply -f - >> "$LOGF" 2>&1 \
    || { say "Secret $n 만들기 실패 (로그 $LOGF)"; return 1; }
}
# 랜덤 값 Secret. 이미 있으면 그대로 둔다 (다시 돌려도 값이 안 바뀜 → 도는 Pod·진행 중인 이전의 비밀 복사와 안 어긋남)
ensure_random_secret() { # 이름 키 설명
  if [ "$DRY" = 1 ]; then put_secret "$1" "랜덤, $1 이 없을 때만 ($3)" "$2=x"; return 0; fi
  local out
  out=$(K -n "$NS" get secret "$1" --ignore-not-found -o name 2>> "$LOGF") || { say "Secret $1 조회 실패 (로그 $LOGF)"; return 1; }
  if [ -n "$out" ]; then say "$1 있음 → 그대로"; return 0; fi
  ( umask 077; openssl rand -hex 24 | tr -d '\n' > "$TMPD/rand-$1" ) && [ -s "$TMPD/rand-$1" ] || { say "랜덤 값을 못 만듦 (openssl)"; return 1; }
  put_secret "$1" "랜덤 ($3)" "$2=$TMPD/rand-$1" || return 1
  rm -f "$TMPD/rand-$1"; say "$1 만듦 (랜덤)"
}
ensure_ns() {
  if [ "$DRY" = 1 ]; then say "DRY: kubectl create namespace $NS --dry-run=client -o yaml | kubectl apply -f -"; return 0; fi
  K create namespace "$NS" --dry-run=client -o yaml | K apply -f - >> "$LOGF" 2>&1 || { say "네임스페이스 실패 (로그 $LOGF)"; return 1; }
}
# RDS 마스터 비밀번호 → $TMPD/pw, 사용자 → $TMPD/user (600). seed 만 쓴다. Secrets Manager 값이 JSON(RDS 관리 비밀번호)이면 password·username
read_master() {
  if [ "$DRY" = 1 ]; then
    if [ -n "$PW_FILE" ]; then say "DRY: 마스터 비밀번호 = DB_PASSWORD_FILE 첫 줄 → <임시 파일(600)> (화면·로그에 안 찍음)"
    else say "DRY: aws secretsmanager get-secret-value --secret-id <DB_PASSWORD_SECRET_ID> --region $AWS_REGION → 마스터 username·password <임시 파일(600)>"; fi
    : > "$TMPD/user"; : > "$TMPD/pw"
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
        jq -r '.username // empty' "$TMPD/raw" | tr -d '\r\n' > "$TMPD/user.secret"
      else
        head -n 1 "$TMPD/raw" | tr -d '\r\n' > "$TMPD/pw"
      fi
      rm -f "$TMPD/raw"
    fi
  ) || { say "마스터 비밀번호를 못 읽음 (DB_PASSWORD_FILE 이 있는지, 또는 Secrets Manager 권한·id·리전. 로그 $LOGF)"; return 1; }
  [ -s "$TMPD/pw" ] || { say "마스터 비밀번호가 비었음"; return 1; }
  local u="$DB_MASTER_USER"
  [ -n "$u" ] || u=$(cat "$TMPD/user.secret" 2>/dev/null)
  [ -n "$u" ] || u=postgres
  [[ "$u" =~ $ID_RE ]] || { say "마스터 사용자 이름 모양이 아님 (DB_MASTER_USER 를 직접 준다)"; return 1; }
  [ "$u" != "$APP_USER" ] || { say "RDS 마스터 사용자가 $APP_USER 임: 앱 계정 = 마스터면 DB-08 이 이전을 멈춘다. 마스터 이름이 다른 RDS 를 쓴다"; return 1; }
  ( umask 077; printf '%s' "$u" > "$TMPD/user" ) || return 1
}

case "$CMD" in
app)
  say "app 시작 dry=$DRY ctx=$KCTX ns=$NS db=${DB_INSTANCE:-?}/$DB_NAME"
  need_ctx || exit 1
  WEB_REF=$(digest_ref "$WEB_IMAGE") && API_REF=$(digest_ref "$API_IMAGE") \
    || { say "이미지 digest 를 못 구함: $NO_DIGEST (WEB_IMAGE·API_IMAGE)"; exit 1; }
  say "이미지 web=$WEB_REF api=$API_REF"
  # 템플릿은 그대로 쓴다. 자리표시 네 개를 채우고 (gcp-source.sh·real-session.sh deploy 단계와 같음)
  sed -e "s#__NS__#${NS}#g" -e "s#__WEB_IMAGE__#${WEB_REF}#g" -e "s#__API_IMAGE__#${API_REF}#g" -e "s#__DB_HOST__#${DB_HOST}#g" "$TPL" > "$TMPD/sample.raw.yaml" || exit 1
  if grep -q '__[A-Z_]*__' "$TMPD/sample.raw.yaml"; then say "템플릿에 못 채운 자리표시가 남음: $(grep -o '__[A-Z_]*__' "$TMPD/sample.raw.yaml" | sort -u | tr '\n' ' ')"; exit 1; fi
  # shop-api 에 DB_NAME·DB_USER 를 더한다 (정본 샘플과 같이 앱은 shop_app 으로 붙는다. 마스터가 아님). DB_PORT 바로 뒤, 꼭 한 번
  awk -v db="$DB_NAME" -v u="$APP_USER" '
    { print }
    prev ~ /^ *- name: DB_PORT$/ && $0 ~ /^ *value: "5432"$/ {
      ind = $0; sub(/[^ ].*$/, "", ind); li = substr(ind, 3)
      print li "- name: DB_NAME"; print ind "value: \"" db "\""
      print li "- name: DB_USER"; print ind "value: \"" u "\""; n++
    }
    { prev = $0 }
    END { exit (n == 1 ? 0 : 3) }' "$TMPD/sample.raw.yaml" > "$TMPD/sample.yaml" \
    || { say "템플릿에서 shop-api 의 DB_PORT 자리를 못 찾음 ($TPL 모양이 바뀜)"; exit 1; }
  say "매니페스트 렌더 OK ($(grep -c '^kind:' "$TMPD/sample.yaml")개 객체, shop-api env DB_NAME=$DB_NAME DB_USER=$APP_USER)"
  ensure_ns || exit 1
  ensure_random_secret api-secrets API_TOKEN "시험용 API 토큰" || exit 1
  # shop-db-app = 앱 계정 shop_app 의 비밀번호 (랜덤). RDS 마스터 비밀번호는 넣지 않는다. seed 가 shop_app 을 이 값으로 맞춘다
  ensure_random_secret shop-db-app password "앱 계정 $APP_USER 비밀번호. seed 가 RDS 에 맞춘다" || exit 1
  run kubectl --context "$KCTX" apply -f "$TMPD/sample.yaml" || exit 1
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS wait --for=condition=Available deployment --all --timeout=300s"
  elif K -n "$NS" wait --for=condition=Available deployment --all --timeout=300s >> "$LOGF" 2>&1; then say "Deployment Available"
  else say "300초 안에 Available 아님 (kubectl -n $NS get pods 로 확인)"; exit 1; fi
  say "app 끝 (다음: seed)"
  ;;
seed)
  say "seed 시작 dry=$DRY ctx=$KCTX ns=$NS db=${DB_INSTANCE:-?}/$DB_NAME"
  need_ctx || exit 1
  SEED_REF=$(digest_ref "$SEED_IMAGE") || { say "seed 이미지 digest 를 못 구함: $NO_DIGEST (SEED_IMAGE)"; exit 1; }
  read_master || exit 1
  ensure_ns || exit 1
  # seed 를 app 보다 먼저 돌려도 되게: 앱 계정 비밀번호 Secret 이 없으면 여기서 랜덤으로 만든다
  ensure_random_secret shop-db-app password "앱 계정 $APP_USER 비밀번호. seed 가 RDS 에 맞춘다" || exit 1
  if [ "$DRY" = 1 ]; then say "DRY: shop-db-app 값이 마스터 비밀번호와 같으면 멈춘다 (값은 안 찍음)"
  else
    # 예전 판·손으로 만든 shop-db-app 에 마스터 비밀번호가 들어 있으면 앱 계정 = 마스터 비밀이 된다 → 멈춘다
    ( set -o pipefail; umask 077; K -n "$NS" get secret shop-db-app -o jsonpath='{.data.password}' 2>> "$LOGF" | base64 --decode > "$TMPD/app" 2>> "$LOGF" ) \
      || { say "shop-db-app 을 못 읽음 (로그 $LOGF)"; exit 1; }
    [ -s "$TMPD/app" ] || { say "shop-db-app 에 password 키가 없음 → kubectl -n $NS delete secret shop-db-app 뒤 app·seed 다시"; exit 1; }
    if cmp -s "$TMPD/app" "$TMPD/pw"; then
      say "shop-db-app 값이 RDS 마스터 비밀번호와 같음 → 멈춤 (앱은 마스터 비밀을 쓰지 않는다, DB-08). kubectl -n $NS delete secret shop-db-app 뒤 app·seed 다시"; exit 1
    fi
    rm -f "$TMPD/app"
  fi
  # 앱 계정 + 표 + 100행. 표 모양·채우는 SQL = gcp-source.sh seed (다시 돌려도 100행: 모자란 만큼만 넣는다)
  #   shop_app 은 LOGIN 역할에 표 권한만 직접 준다 (마스터·rds_superuser 를 물려받지 않음 → 컷오버 울타리 REVOKE 가 먹는다, DB-08)
  cat > "$TMPD/seed.sql" <<'SQL'
DO $$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shop_app') THEN CREATE ROLE shop_app LOGIN; END IF; END$$;
ALTER ROLE shop_app LOGIN PASSWORD :'pw';
GRANT CONNECT ON DATABASE :"DBNAME" TO shop_app;
create table if not exists orders (id bigserial primary key, item text, qty int, created_at timestamptz default now());
insert into orders (item, qty) select 'item-' || g, (g % 5) + 1 from generate_series(1, greatest(0, 100 - (select count(*) from orders))) g;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO shop_app;
GRANT USAGE, SELECT ON SEQUENCE orders_id_seq TO shop_app;
select 'orders=' || count(*) from orders;
SQL
  run kubectl --context "$KCTX" -n "$NS" delete job/shop-seed --ignore-not-found --wait=true || exit 1
  SEED_CLEANUP=1   # 여기부터는 끝날 때(실패·중단 포함) Job·마스터 Secret·SQL ConfigMap 을 지운다
  put_secret shop-seed-db "RDS 마스터 사용자·비밀번호. 임시, seed 끝나면 지움" "PGUSER=$TMPD/user" "PGPASSWORD=$TMPD/pw" || exit 1
  rm -f "$TMPD/pw"
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS create configmap shop-seed-sql --from-file=seed.sql=<임시 파일> | kubectl apply -f -  # 앱 계정 $APP_USER + orders 100행"
  else
    K -n "$NS" create configmap shop-seed-sql --from-file=seed.sql="$TMPD/seed.sql" --dry-run=client -o yaml | K apply -f - >> "$LOGF" 2>&1 \
      || { say "ConfigMap shop-seed-sql 실패 (로그 $LOGF)"; exit 1; }
  fi
  # 마스터(shop-seed-db, 임시)로 붙고, 앱 계정 비밀번호는 shop-db-app 에서 받는다. 비밀번호는 Pod 스펙에 없다
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
          command: ["sh", "-c", "exec psql -v ON_ERROR_STOP=1 -At -v pw=\"\$APP_PW\" -f /seed/seed.sql"]
          env:
            - { name: PGHOST, value: "${DB_HOST}" }
            - { name: PGPORT, value: "5432" }
            - { name: PGDATABASE, value: "${DB_NAME}" }
            - { name: PGSSLMODE, value: require }
            - { name: PGCONNECT_TIMEOUT, value: "10" }
            - name: APP_PW
              valueFrom:
                secretKeyRef: { name: shop-db-app, key: password }
          envFrom:
            - secretRef: { name: shop-seed-db }
          volumeMounts:
            - { name: sql, mountPath: /seed, readOnly: true }
          resources:
            requests: { cpu: 50m, memory: 32Mi }
      volumes:
        - name: sql
          configMap: { name: shop-seed-sql }
EOF
  run kubectl --context "$KCTX" apply -f "$TMPD/seed-job.yaml" || exit 1
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS wait --for=condition=complete job/shop-seed --timeout=300s → logs 의 orders=N"; rc=0
  elif K -n "$NS" wait --for=condition=complete job/shop-seed --timeout=300s >> "$LOGF" 2>&1; then
    N=$(K -n "$NS" logs job/shop-seed 2>> "$LOGF" | grep -o 'orders=[0-9]*' | tail -1)
    say "seed 끝 ${N:-orders=?}, 앱 계정 $APP_USER 비밀번호 = shop-db-app"; rc=0
  else
    K -n "$NS" logs job/shop-seed >> "$LOGF" 2>&1
    say "seed Job 이 300초 안에 안 끝남: RDS 보안 그룹이 EKS 에서 5432 를 받는지, DB $DB_NAME 이 RDS 에 있는지(초기 DB 이름), 마스터 비밀이 맞는지 (로그 $LOGF)"; rc=1
  fi
  seed_cleanup || { say "임시 Secret shop-seed-db 를 못 지움: kubectl -n $NS delete secret shop-seed-db 로 직접"; rc=1; }
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
  say "down 끝 (EKS·RDS·orders 표·shop_app 은 그대로. 지우려면 사람이 직접)"
  ;;
esac
