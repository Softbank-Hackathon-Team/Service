#!/usr/bin/env bash
# 온프레 도착 DB(k3s + CloudNativePG)와 출발 RDS 를 "처음 이전하는 고객" 상태로 되돌린다.
# AWS→온프레 이전 시험을 반복할 때 시험과 시험 사이에 온프레 VM 에서 사람이 돌린다.
# 로컬판 tools/load/live-app/reset-shop-db.sh 와 같은 차례(접속 끊기 → 구독 → 슬롯 → DB 다시 만들기)를 따른다.
# 맥 bash 3.2 에서도 돈다 (연관 배열·mapfile 안 씀).
#
# 쓰는 법 (서비스 폴더 맨 위에서)
#   bash tools/onprem-db-reset.sh <앱이름>                       도착(온프레 CNPG)만
#   bash tools/onprem-db-reset.sh <앱이름> --source              도착 + 출발 RDS
#   bash tools/onprem-db-reset.sh <앱이름> [--source] --dry-run  지울 것 목록만 찍는다 (읽기만, 아무것도 안 바꾼다)
#
# 하는 일
#   도착 (네임스페이스 app-<앱> 의 CNPG Cluster 마다. 이름·DB·주인은 Cluster spec.bootstrap.initdb 에서 읽는다)
#     t1 앱 DB 접속 끊기 (pg_terminate_backend, 자기 자신 제외)
#     t2 그 DB 의 구독 전부: DISABLE → SET (slot_name = NONE) → DROP
#     t3 그 DB 의 논리 복제 슬롯 삭제 (롤백용 역방향 repl_<key>_rev 포함. 물리 슬롯 = CNPG 대기 복제용은 안 건드린다)
#     t4 DB 를 지우고 CNPG initdb 와 같은 모양으로 다시 만든다 (CREATE DATABASE <db> OWNER <owner>)
#     t5 임시 복제 계정(repl_<key>_fwd_u / _rev_u, packages/replication repluser.ts) 삭제
#     t6 확인: 구독 0, 논리 슬롯 0, 사용자 표 0, 임시 계정 0. 하나라도 아니면 끝 코드 1
#   출발 (--source. 접속 문자열은 SOURCE_DATABASE_URL, 화면에 찍지 않는다)
#     s1 이전이 만든 구독 삭제 (컷오버 뒤 옛 출발에 생기는 역방향 repl_<key>_rev). 도착 단계보다 먼저 한다
#     s2 이전이 만든 슬롯 삭제 (repl_<key>_fwd·_rev)
#     s3 이전이 만든 발행 삭제 (repl_<key>_fwd·_rev)
#     s4 컷오버 울타리 걷기 (packages/replication fence.ts unfenceSql 과 같은 규칙):
#          _repl.fence_saved 저장본이 있으면 그 권한을 계정마다 되돌린다. 앱 계정 저장본이 없으면 앱 계정에 읽기·쓰기 전체를 준다.
#          DB 의 default_transaction_read_only 를 푼다. 관리자에게 준 역방향 적용 권한(_repl.apply_grants)을 회수한다.
#          그 뒤 _repl 스키마(표지·저장본)를 지운다
#     s5 임시 복제 계정 삭제 (다른 DB 에 권한이 걸린 계정은 건너뛴다)
#     s6 확인: 발행 0, 슬롯 0, 구독 0, 임시 계정 0, read_only 0, 앱 계정이 스키마의 모든 표에 INSERT 가능
#
# 하지 않는 일
#   - 출발 DB 의 앱 데이터는 안 건드린다 (표·행 그대로). 도착은 DB 를 통째로 비운다 (사용자 표 0)
#   - 출발에서 이름이 repl_<key>_fwd/rev 가 아닌 발행·슬롯·구독은 안 건드린다 (고객이 따로 쓰는 복제일 수 있다)
#   - CNPG 가 관리하는 역할(소유 역할, svc_migrate)·Secret·Cluster 리소스, 다른 네임스페이스, 다른 DB 는 안 건드린다
#   - 출발 앱 연결 계정 svc_link_<이전 앞 8자>(source-db-link) 는 지우지 않는다. 울타리 저장본이 있으면 권한만 되돌린다
#   - 앱 Deployment 를 멈추거나 다시 시작하지 않는다. 앱이 시작할 때 스키마를 만드는 앱이면 t6 사용자 표 확인이 실패할 수 있다
#   - 플랫폼 DB(이전 줄·감사 기록)는 안 건드린다. 그건 tools/demo-reset.sh 몫이다
#
# 환경 변수
#   ONPREM_KUBE_CONTEXT   쓸 kubectl 컨텍스트. 없으면 지금 컨텍스트. k3s-*, k3d-* 가 아니면 거부한다 (tools/demo-reset.sh 와 같은 기준)
#                         (k3s 기본 kubeconfig 의 컨텍스트 이름은 "default" 라 거부된다: kubectl config rename-context default k3s-onprem)
#   SOURCE_DATABASE_URL   --source 일 때 필수. 출발 RDS 관리자 접속 문자열 (postgres://…). 화면·로그에 찍지 않는다
#   SOURCE_APP_ROLE       --source 일 때 필수. 출발 앱 계정 (이전 끝점 appRole, REPL_SOURCE_APP_ROLE 과 같은 값)
#   SOURCE_SCHEMA         기본 public
# 끝 코드: 0 = 끝까지 돌고 확인 통과, 1 = 단계 실패 또는 확인 실패, 2 = 잘못된 인자·환경
set -u
set -o pipefail

usage() { sed -n '2,45p' "$0"; }

APP=""
DO_SOURCE=0
DRY=0
for a in "$@"; do
  case "$a" in
    --source) DO_SOURCE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "모르는 옵션: $a" >&2; exit 2 ;;
    *) if [ -n "$APP" ]; then echo "앱 이름은 하나만: $APP, $a" >&2; exit 2; fi; APP=$a ;;
  esac
done
[ -n "$APP" ] || { usage >&2; exit 2; }
# 네임스페이스 이름(app-<앱>, 63자)이 되는 글자만. Z66 앱 구역 = app-<앱> (apps/worker/src/gitops/bundle.ts)
echo "$APP" | grep -Eq '^[a-z0-9]([-a-z0-9]{0,57}[a-z0-9])?$' || { echo "앱 이름이 k8s 이름 규칙(소문자·숫자·-, 59자 이하)에 안 맞는다: $APP" >&2; exit 2; }
NS="app-$APP"

# 이전 객체 이름 규칙 (packages/replication names.ts namesFor: repl_<key 40자 이하 [a-z0-9_]>_fwd|_rev, repluser.ts replUserOf: + "_u")
REPL_RE='^repl_[a-z0-9_]+_(fwd|rev)$'
REPL_USER_RE='^repl_[a-z0-9_]+_(fwd|rev)_u$'
# DRAFT(ai): 활성 슬롯 끊고 지우기 재시도 횟수·간격. 구독 쪽이 wal_retrieve_retry_interval(기본 5초)마다 다시 붙으므로 그 사이에 지운다
SLOT_TRIES=3
SCHEMA=${SOURCE_SCHEMA:-public}

ts() { date -u +%H:%M:%SZ; }
log() { printf '%s %s\n' "$(ts)" "$*"; }
begin() { log "[$1] 시작: $2"; }
finish() { log "[$1] 끝: $2"; }
would() { log "    (dry-run) $*"; }
die() { log "실패: $*" >&2; exit 1; }
CHECK_FAIL=0

# ---------------------------------------------------------------- psql 감싸기
# psql 변수(:'x' :"x")로 이름을 넘긴다 (따옴표 처리는 psql 이). -c 는 변수를 안 풀어서 SQL 은 늘 표준 입력으로 보낸다.
# 주의: kubectl exec -i 가 표준 입력을 먹으므로 이 함수를 "while read" 고리 안에서 부르지 않는다 (목록은 변수로 받아 for 로 돈다)
POD=""
KCTX=""
tq() {  # tq <db> <sql> [psql -v 인자…]
  local db=$1 sql=$2; shift 2
  printf '%s\n' "$sql" | kubectl --context "$KCTX" -n "$NS" exec -i "$POD" -c postgres -- \
    psql -X -U postgres -d "$db" -v ON_ERROR_STOP=1 -qtA "$@"
}
sq() {  # sq <sql> [psql -v 인자…]  출발. 접속 문자열은 인자로만 넘기고 찍지 않는다
  local sql=$1; shift
  printf '%s\n' "$sql" | psql -X -d "$SOURCE_DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"
}
count_lines() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }
indent() { [ -z "$1" ] || printf '%s\n' "$1" | sed 's/^/    - /'; }

# ---------------------------------------------------------------- 공통 SQL
# 임시 복제 계정 목록. 출발은 같은 RDS 에 다른 DB 가 있을 수 있어서 "이 DB 밖에 권한·소유가 걸린 계정"은 빼고 따로 보인다
ROLES_HERE_SQL="SELECT r.rolname FROM pg_roles r WHERE r.rolname ~ :'ure'
  AND NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid
                   AND d.dbid <> 0 AND d.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database()))
  ORDER BY 1"
ROLES_ELSEWHERE_SQL="SELECT r.rolname FROM pg_roles r WHERE r.rolname ~ :'ure'
  AND EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid
               AND d.dbid <> 0 AND d.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database()))
  ORDER BY 1"
# 계정 하나 지우기 (repluser.ts dropReplUser 와 같은 차례: 접속 끊기 → 자기에게 주기(PF-E15, 실패 무시) → DROP OWNED → DROP ROLE)
DROP_ROLE_SQL="SELECT set_config('reset.r', :'r', false) AS x \\gset
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = :'r' \\gset
DO \$g\$ BEGIN EXECUTE format('GRANT %I TO CURRENT_USER', current_setting('reset.r')); EXCEPTION WHEN OTHERS THEN NULL; END \$g\$;
DROP OWNED BY :\"r\";
DROP ROLE IF EXISTS :\"r\";"
# 슬롯 하나 지우기. 붙어 있는 walsender 를 먼저 끊는다. 이미 없으면 아무것도 안 한다
DROP_SLOT_SQL="SELECT count(pg_terminate_backend(active_pid)) FROM pg_replication_slots WHERE slot_name = :'s' AND active_pid IS NOT NULL \\gset
SELECT count(pg_drop_replication_slot(slot_name)) FROM pg_replication_slots WHERE slot_name = :'s' \\gset"
# 구독 하나 지우기 (reset-shop-db.sh 와 같은 3문장. slot_name = NONE 이라 상대 슬롯은 따로 지운다)
DROP_SUB_SQL="ALTER SUBSCRIPTION :\"s\" DISABLE;
ALTER SUBSCRIPTION :\"s\" SET (slot_name = NONE);
DROP SUBSCRIPTION IF EXISTS :\"s\";"

drop_slot_retry() {  # drop_slot_retry <t|s> <db> <slot>
  local side=$1 db=$2 s=$3 i out=""
  for i in $(seq 1 "$SLOT_TRIES"); do
    if [ "$side" = t ]; then out=$(tq "$db" "$DROP_SLOT_SQL" -v s="$s" 2>&1) && return 0
    else out=$(sq "$DROP_SLOT_SQL" -v s="$s" 2>&1) && return 0; fi
    [ "$i" -lt "$SLOT_TRIES" ] && sleep 1
  done
  log "    슬롯 $s 를 ${SLOT_TRIES}번 시도했지만 못 지웠다: $(printf '%s' "$out" | tail -n 1)" >&2
  return 1
}

# ================================================================ 도착
target_preflight() {
  begin t0 "kubectl 컨텍스트·네임스페이스 확인"
  command -v kubectl >/dev/null 2>&1 || { echo "kubectl 이 없다" >&2; exit 2; }
  KCTX=${ONPREM_KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null)}
  case "$KCTX" in
    k3s-*|k3d-*) ;;
    *) echo "로컬 컨텍스트가 아니다: '${KCTX}'. k3s-*, k3d-* 만 건드린다 (tools/demo-reset.sh 와 같은 기준)" >&2; exit 2 ;;
  esac
  kubectl config get-contexts -o name 2>/dev/null | grep -qx "$KCTX" || { echo "컨텍스트가 kubeconfig 에 없다: $KCTX" >&2; exit 2; }
  kubectl --context "$KCTX" --request-timeout=5s get ns "$NS" >/dev/null 2>&1 || die "네임스페이스 $NS 가 없다 (앱 이름 확인)"
  # 이름·DB·주인은 차트(gitops/charts/app/templates/cnpg.yaml)가 만든 Cluster 리소스에서 그대로 읽는다 (cnpgName·dbIdentityFor 를 다시 계산하지 않는다)
  CLUSTERS=$(kubectl --context "$KCTX" -n "$NS" get clusters.postgresql.cnpg.io \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.bootstrap.initdb.database}{" "}{.spec.bootstrap.initdb.owner}{"\n"}{end}' 2>/dev/null) \
    || die "$NS 의 CNPG Cluster 를 못 읽었다 (CNPG CRD 가 없나?)"
  [ -n "$CLUSTERS" ] || die "$NS 에 CNPG Cluster 가 없다"
  finish t0 "컨텍스트 $KCTX, 네임스페이스 $NS, Cluster $(count_lines "$CLUSTERS")개"
  indent "$CLUSTERS"
}

target_reset_cluster() {  # <cluster> <db> <owner>
  local C=$1 DB=$2 OWNER=$3 list n s before after out
  log "== Cluster $C (DB $DB, 주인 $OWNER)"
  case "$DB" in ""|postgres|template0|template1) die "Cluster $C 의 initdb database 가 비었거나 시스템 DB 다: '$DB'" ;; esac
  [ -n "$OWNER" ] || die "Cluster $C 의 initdb owner 가 비었다"
  POD=$(kubectl --context "$KCTX" -n "$NS" get pod -l "cnpg.io/cluster=$C,cnpg.io/instanceRole=primary" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [ -n "$POD" ] || die "Cluster $C 의 primary 파드(cnpg.io/instanceRole=primary)가 없다"
  log "   primary 파드 $POD"
  local EXISTS
  EXISTS=$(tq postgres "SELECT count(*) FROM pg_database WHERE datname = :'db'" -v db="$DB") || die "primary 에 psql 접속 실패"

  # t1 접속 끊기
  begin t1 "$DB 접속 끊기"
  list=$(tq postgres "SELECT pid || ' ' || coalesce(usename, '-') || ' ' || coalesce(nullif(application_name, ''), backend_type)
                        FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid() ORDER BY 1" -v db="$DB") || die "접속 목록 읽기 실패"
  n=$(count_lines "$list")
  if [ "$n" = 0 ]; then finish t1 "접속 없음, 건너뜀"
  elif [ "$DRY" = 1 ]; then indent "$list"; would "pg_terminate_backend ${n}개"; finish t1 "dry-run"
  else
    tq postgres "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid() \\gset" -v db="$DB" \
      || die "접속 끊기 실패"
    finish t1 "${n}개 끊음"
  fi

  # t2 구독 (그 DB 의 것 전부. pg_subscription 은 공유 카탈로그라 postgres DB 에서 읽고, 지우기는 그 DB 에 붙어서)
  begin t2 "$DB 구독 지우기"
  list=$(tq postgres "SELECT s.subname FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = :'db' ORDER BY 1" -v db="$DB") \
    || die "구독 목록 읽기 실패"
  n=$(count_lines "$list")
  if [ "$n" = 0 ]; then finish t2 "구독 없음, 건너뜀"
  else
    local IFS=$'\n'
    for s in $list; do
      if [ "$DRY" = 1 ]; then would "ALTER SUBSCRIPTION $s DISABLE; … SET (slot_name = NONE); DROP SUBSCRIPTION $s"
      else tq "$DB" "$DROP_SUB_SQL" -v s="$s" >/dev/null || die "구독 $s 지우기 실패"; log "    - 구독 $s 지움"; fi
    done
    unset IFS
    finish t2 "${n}개$([ "$DRY" = 1 ] && echo " (dry-run)")"
  fi

  # t3 논리 슬롯 (그 DB 의 것. 물리 슬롯 = CNPG HA 대기 복제용 _cnpg_* 는 database 가 NULL 이고 slot_type physical 이라 안 걸린다)
  begin t3 "$DB 논리 복제 슬롯 지우기"
  list=$(tq postgres "SELECT slot_name || CASE WHEN active THEN ' (active)' ELSE '' END FROM pg_replication_slots
                        WHERE slot_type = 'logical' AND database = :'db' ORDER BY 1" -v db="$DB") || die "슬롯 목록 읽기 실패"
  n=$(count_lines "$list")
  if [ "$n" = 0 ]; then finish t3 "슬롯 없음, 건너뜀"
  else
    local IFS=$'\n'
    for s in $list; do
      s=${s% (active)}
      if [ "$DRY" = 1 ]; then would "활성 walsender 끊기 → pg_drop_replication_slot('$s')"
      else drop_slot_retry t postgres "$s" || die "슬롯 $s 지우기 실패"; log "    - 슬롯 $s 지움"; fi
    done
    unset IFS
    finish t3 "${n}개$([ "$DRY" = 1 ] && echo " (dry-run)")"
  fi

  # t4 DB 다시 만들기
  # DRAFT(ai): CNPG initdb 는 클러스터 기본 인코딩·로캘(initdb 단계)로 만든 template1 에서 "CREATE DATABASE <db> OWNER <owner>" 로 앱 DB 를 만든다 【추정: CNPG 1.30 동작 기억, 소스 미대조】.
  #   그래서 템플릿·로캘을 따로 주지 않고 같은 문장으로 만든다. 지우기 전·뒤 인코딩·정렬·주인을 찍어서 달라졌으면 경고한다
  begin t4 "$DB 지우고 다시 만들기 (주인 $OWNER)"
  local DBINFO="SELECT pg_encoding_to_char(d.encoding) || ' ' || d.datcollate || ' ' || d.datctype || ' owner=' || pg_get_userbyid(d.datdba)
                  FROM pg_database d WHERE d.datname = :'db'"
  before=$(tq postgres "$DBINFO" -v db="$DB") || die "DB 정보 읽기 실패"
  if [ -n "$before" ]; then log "    지우기 전: $before"; else log "    지우기 전: DB 없음"; fi
  tq postgres "SELECT 1 FROM pg_roles WHERE rolname = :'o'" -v o="$OWNER" | grep -q 1 || die "주인 역할 $OWNER 가 없다 (CNPG 가 만든 역할이어야 한다)"
  if [ "$DRY" = 1 ]; then
    would "DROP DATABASE IF EXISTS $DB WITH (FORCE); CREATE DATABASE $DB OWNER $OWNER"
    finish t4 "dry-run"
  else
    out=$(tq postgres "DROP DATABASE IF EXISTS :\"db\" WITH (FORCE);
                       CREATE DATABASE :\"db\" OWNER :\"o\";" -v db="$DB" -v o="$OWNER" 2>&1) || die "DB 다시 만들기 실패: $out"
    after=$(tq postgres "$DBINFO" -v db="$DB") || die "DB 정보 읽기 실패"
    log "    다시 만든 뒤: $after"
    if [ -n "$before" ] && [ "$before" != "$after" ]; then log "    경고: 지우기 전과 인코딩·정렬·주인이 다르다 (CNPG 처음 상태와 다를 수 있음)" >&2; fi
    finish t4 "$([ "$EXISTS" = 1 ] && echo "지우고 다시 만듦" || echo "없어서 새로 만듦")"
  fi

  # t5 임시 복제 계정 (도착이 발행자였던 역방향 repl_<key>_rev_u 가 여기 생긴다)
  begin t5 "임시 복제 계정 지우기"
  list=$(tq postgres "$ROLES_HERE_SQL" -v ure="$REPL_USER_RE") || die "계정 목록 읽기 실패"
  out=$(tq postgres "$ROLES_ELSEWHERE_SQL" -v ure="$REPL_USER_RE") || die "계정 목록 읽기 실패"
  [ -z "$out" ] || { log "    건너뜀 (postgres DB 등 다른 DB 에 권한이 걸려 있음, 손으로 확인):"; indent "$out"; }
  n=$(count_lines "$list")
  if [ "$n" = 0 ]; then finish t5 "임시 계정 없음, 건너뜀"
  else
    local IFS=$'\n'
    for s in $list; do
      if [ "$DRY" = 1 ]; then would "접속 끊기 → DROP OWNED BY $s → DROP ROLE $s"
      else tq postgres "$DROP_ROLE_SQL" -v r="$s" >/dev/null || die "계정 $s 지우기 실패"; log "    - 계정 $s 지움"; fi
    done
    unset IFS
    finish t5 "${n}개$([ "$DRY" = 1 ] && echo " (dry-run)")"
  fi

  # t6 확인
  begin t6 "$DB 확인"
  local subs slots roles tables
  subs=$(tq postgres "SELECT count(*) FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = :'db'" -v db="$DB")
  slots=$(tq postgres "SELECT count(*) FROM pg_replication_slots WHERE slot_type = 'logical' AND database = :'db'" -v db="$DB")
  roles=$(tq postgres "SELECT count(*) FROM pg_roles WHERE rolname ~ :'ure'" -v ure="$REPL_USER_RE")
  if [ "$DRY" = 1 ] && [ "$EXISTS" = 1 ]; then tables=$(tq "$DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'")
  elif [ "$DRY" = 1 ]; then tables=0
  else tables=$(tq "$DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'"); fi
  log "    subscription=${subs:-?} logical_slot=${slots:-?} user_table=${tables:-?} repl_user=${roles:-?}"
  if [ "$DRY" = 1 ]; then finish t6 "dry-run (지금 상태. 판정 안 함)"
  elif [ "$subs" = 0 ] && [ "$slots" = 0 ] && [ "$tables" = 0 ] && [ "$roles" = 0 ]; then finish t6 "OK"
  else CHECK_FAIL=1; finish t6 "FAIL (위 값 중 0 이 아닌 것이 있다)"; fi
}

# ================================================================ 출발
source_preflight() {
  begin s0 "출발 DB 접속 확인"
  command -v psql >/dev/null 2>&1 || { echo "psql 이 없다 (--source 는 VM 에 psql 이 있어야 한다)" >&2; exit 2; }
  [ -n "${SOURCE_DATABASE_URL:-}" ] || { echo "--source 는 SOURCE_DATABASE_URL 이 필요하다" >&2; exit 2; }
  [ -n "${SOURCE_APP_ROLE:-}" ] || { echo "--source 는 SOURCE_APP_ROLE(출발 앱 계정)이 필요하다" >&2; exit 2; }
  SDB=$(sq "SELECT current_database()" 2>/dev/null) || die "출발 DB 접속 실패 (접속 문자열은 찍지 않는다. psql 로 직접 확인)"
  sq "SELECT 1 FROM pg_roles WHERE rolname = :'r'" -v r="$SOURCE_APP_ROLE" | grep -q 1 || die "출발에 앱 계정 $SOURCE_APP_ROLE 이 없다"
  sq "SELECT 1 FROM pg_namespace WHERE nspname = :'sch'" -v sch="$SCHEMA" | grep -q 1 || die "출발에 스키마 $SCHEMA 가 없다"
  finish s0 "DB $SDB, 앱 계정 $SOURCE_APP_ROLE, 스키마 $SCHEMA"
}

source_subscriptions() {
  local list n s
  begin s1 "출발 구독 지우기 (repl_*_fwd|rev)"
  list=$(sq "SELECT s.subname FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid
              WHERE d.datname = current_database() AND s.subname ~ :'re' ORDER BY 1" -v re="$REPL_RE") || die "구독 목록 읽기 실패"
  n=$(count_lines "$list")
  if [ "$n" = 0 ]; then finish s1 "구독 없음, 건너뜀"; return; fi
  local IFS=$'\n'
  for s in $list; do
    if [ "$DRY" = 1 ]; then would "ALTER SUBSCRIPTION $s DISABLE; … SET (slot_name = NONE); DROP SUBSCRIPTION $s"
    else sq "$DROP_SUB_SQL" -v s="$s" >/dev/null || die "구독 $s 지우기 실패"; log "    - 구독 $s 지움"; fi
  done
  unset IFS
  finish s1 "${n}개$([ "$DRY" = 1 ] && echo " (dry-run)")"
}

source_rest() {
  local list n s out
  # s2 슬롯
  begin s2 "출발 슬롯 지우기 (repl_*_fwd|rev)"
  list=$(sq "SELECT slot_name FROM pg_replication_slots WHERE database = current_database() AND slot_name ~ :'re' ORDER BY 1" -v re="$REPL_RE") \
    || die "슬롯 목록 읽기 실패"
  n=$(count_lines "$list")
  if [ "$n" = 0 ]; then finish s2 "슬롯 없음, 건너뜀"
  else
    local IFS=$'\n'
    for s in $list; do
      if [ "$DRY" = 1 ]; then would "활성 walsender 끊기 → pg_drop_replication_slot('$s')"
      else drop_slot_retry s - "$s" || die "슬롯 $s 지우기 실패"; log "    - 슬롯 $s 지움"; fi
    done
    unset IFS
    finish s2 "${n}개$([ "$DRY" = 1 ] && echo " (dry-run)")"
  fi

  # s3 발행
  begin s3 "출발 발행 지우기 (repl_*_fwd|rev)"
  list=$(sq "SELECT pubname FROM pg_publication WHERE pubname ~ :'re' ORDER BY 1" -v re="$REPL_RE") || die "발행 목록 읽기 실패"
  n=$(count_lines "$list")
  if [ "$n" = 0 ]; then finish s3 "발행 없음, 건너뜀"
  else
    local IFS=$'\n'
    for s in $list; do
      if [ "$DRY" = 1 ]; then would "DROP PUBLICATION $s"
      else sq "DROP PUBLICATION IF EXISTS :\"s\";" -v s="$s" >/dev/null || die "발행 $s 지우기 실패"; log "    - 발행 $s 지움"; fi
    done
    unset IFS
    finish s3 "${n}개$([ "$DRY" = 1 ] && echo " (dry-run)")"
  fi

  # s4 울타리 걷기
  begin s4 "출발 쓰기 권한 되돌리기 ($SOURCE_APP_ROLE, 스키마 $SCHEMA)"
  out=$(sq "SELECT
      (SELECT count(*) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = current_database() AND s.setrole = 0 AND 'default_transaction_read_only=on' = ANY(s.setconfig)) AS read_only,
      CASE WHEN to_regclass('_repl.fence_saved') IS NULL THEN '-' ELSE 'y' END AS saved_tbl,
      CASE WHEN to_regclass('_repl.apply_grants') IS NULL THEN '-' ELSE 'y' END AS apply_tbl,
      (SELECT count(*) FROM pg_namespace WHERE nspname = '_repl') AS repl_schema,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = :'sch' AND c.relkind IN ('r', 'p') AND NOT has_table_privilege(:'r', c.oid, 'INSERT')) AS no_insert" \
      -v sch="$SCHEMA" -v r="$SOURCE_APP_ROLE" -F ' ') || die "울타리 상태 읽기 실패"
  local ro saved_tbl apply_tbl repl_schema no_insert
  read -r ro saved_tbl apply_tbl repl_schema no_insert <<EOF
$out
EOF
  local saved="" applied=""
  [ "$saved_tbl" = y ] && saved=$(sq "SELECT app_role || ': ' || jsonb_array_length(grants) || '개 저장' FROM _repl.fence_saved WHERE schema_name = :'sch' ORDER BY 1" -v sch="$SCHEMA")
  [ "$apply_tbl" = y ] && applied=$(sq "SELECT kind || ' ' || obj || ' ' || privilege || ' → ' || grantee FROM _repl.apply_grants ORDER BY 1")
  log "    지금: read_only=$ro, INSERT 없는 표=$no_insert, _repl 스키마=$repl_schema"
  [ -n "$saved" ] && { log "    울타리 저장본:"; indent "$saved"; }
  [ -n "$applied" ] && { log "    관리자에게 준 역방향 적용 권한:"; indent "$applied"; }
  if [ "$DRY" = 1 ]; then
    [ "$ro" = 0 ] || would "ALTER DATABASE $SDB RESET default_transaction_read_only"
    if printf '%s\n' "$saved" | grep -q "^$SOURCE_APP_ROLE: "; then would "저장본대로 GRANT (계정마다) → 저장본 지움"
    else [ -z "$saved" ] || would "저장본 있는 계정만 저장본대로 GRANT"; would "GRANT USAGE ON SCHEMA $SCHEMA; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES TO $SOURCE_APP_ROLE"; fi
    [ -z "$applied" ] || would "REVOKE (위 역방향 적용 권한)"
    [ "$repl_schema" = 0 ] || would "DROP SCHEMA _repl CASCADE"
    finish s4 "dry-run"
  else
    # fence.ts unfenceSql·unfenceExtraSql·revokeApplyGrants 와 같은 허용 목록·규칙. 바꾸는 일은 전부 DO 블록 하나(= 한 트랜잭션)라 중간에 깨지면 아무것도 안 바뀐다
    # DRAFT(ai): ALTER DATABASE 는 DB 주인만 된다. RDS 마스터가 주인이 아니면 그 한 줄만 건너뛰고 결과에 적는다 (나머지는 진행)
    out=$(sq "SELECT set_config('reset.schema', :'sch', false) AS x, set_config('reset.role', :'r', false) AS y \\gset
DO \$reset\$
DECLARE sch text := current_setting('reset.schema'); app text := current_setting('reset.role');
  r record; g jsonb; obj text; kind text; priv text; n int := 0; app_saved boolean := false; ro text := 'reset'; rv int := 0;
BEGIN
  BEGIN EXECUTE format('ALTER DATABASE %I RESET default_transaction_read_only', current_database());
  EXCEPTION WHEN insufficient_privilege THEN ro := 'skipped(not owner)'; END;
  IF to_regclass('_repl.fence_saved') IS NOT NULL THEN
    FOR r IN EXECUTE 'SELECT app_role, grants FROM _repl.fence_saved WHERE schema_name = \$1' USING sch LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.app_role);
      IF r.app_role = app THEN app_saved := true; END IF;
      FOR g IN SELECT * FROM jsonb_array_elements(r.grants) LOOP
        kind := g->>'kind'; priv := g->>'privilege';
        CONTINUE WHEN NOT ((kind = 'table' AND priv IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) OR (kind = 'sequence' AND priv IN ('USAGE', 'UPDATE')));
        obj := format('%I.%I', sch, g->>'name');
        CONTINUE WHEN to_regclass(obj) IS NULL;
        EXECUTE format('GRANT %s ON %s %s TO %I%s', priv, CASE kind WHEN 'sequence' THEN 'SEQUENCE' ELSE 'TABLE' END, obj, r.app_role,
                       CASE WHEN (g->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
        n := n + 1;
      END LOOP;
    END LOOP;
  END IF;
  IF NOT app_saved THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', sch, app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', sch, app);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', sch, app);
  END IF;
  IF to_regclass('_repl.apply_grants') IS NOT NULL THEN
    FOR r IN EXECUTE 'SELECT kind, obj, privilege, grantee FROM _repl.apply_grants' LOOP
      CONTINUE WHEN NOT ((r.kind = 'table' AND r.privilege IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) OR (r.kind = 'sequence' AND r.privilege IN ('USAGE', 'UPDATE')));
      CONTINUE WHEN to_regclass(r.obj) IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.grantee);
      EXECUTE format('REVOKE %s ON %s %s FROM %I', r.privilege, CASE r.kind WHEN 'sequence' THEN 'SEQUENCE' ELSE 'TABLE' END, r.obj, r.grantee);
      rv := rv + 1;
    END LOOP;
  END IF;
  DROP SCHEMA IF EXISTS _repl CASCADE;
  PERFORM set_config('reset.result', format('read_only=%s grants=%s apply_revoked=%s', ro,
          CASE WHEN app_saved THEN 'saved:' || n ELSE 'default+saved:' || n END, rv), false);
END \$reset\$;
SELECT current_setting('reset.result');" -v sch="$SCHEMA" -v r="$SOURCE_APP_ROLE" 2>&1) || die "쓰기 권한 되돌리기 실패 (한 트랜잭션이라 바뀐 것 없음): $out"
    finish s4 "$out, _repl 스키마 지움"
  fi

  # s5 임시 복제 계정
  begin s5 "출발 임시 복제 계정 지우기"
  list=$(sq "$ROLES_HERE_SQL" -v ure="$REPL_USER_RE") || die "계정 목록 읽기 실패"
  out=$(sq "$ROLES_ELSEWHERE_SQL" -v ure="$REPL_USER_RE") || die "계정 목록 읽기 실패"
  [ -z "$out" ] || { log "    건너뜀 (같은 서버의 다른 DB 에 권한이 걸려 있음 = 다른 이전 것일 수 있다):"; indent "$out"; }
  n=$(count_lines "$list")
  if [ "$n" = 0 ]; then finish s5 "임시 계정 없음, 건너뜀"
  else
    local IFS=$'\n'
    for s in $list; do
      if [ "$DRY" = 1 ]; then would "접속 끊기 → DROP OWNED BY $s → DROP ROLE $s"
      else sq "$DROP_ROLE_SQL" -v r="$s" >/dev/null || die "계정 $s 지우기 실패"; log "    - 계정 $s 지움"; fi
    done
    unset IFS
    finish s5 "${n}개$([ "$DRY" = 1 ] && echo " (dry-run)")"
  fi

  # s6 확인
  begin s6 "출발 확인"
  out=$(sq "SELECT
      (SELECT count(*) FROM pg_publication WHERE pubname ~ :'re'),
      (SELECT count(*) FROM pg_replication_slots WHERE database = current_database() AND slot_name ~ :'re'),
      (SELECT count(*) FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() AND s.subname ~ :'re'),
      (SELECT count(*) FROM pg_roles r WHERE r.rolname ~ :'ure'
         AND NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid
                          AND d.dbid <> 0 AND d.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database()))),
      (SELECT count(*) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = current_database() AND s.setrole = 0 AND 'default_transaction_read_only=on' = ANY(s.setconfig)),
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = :'sch' AND c.relkind IN ('r', 'p')),
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = :'sch' AND c.relkind IN ('r', 'p') AND NOT has_table_privilege(:'r', c.oid, 'INSERT'))" \
      -v re="$REPL_RE" -v ure="$REPL_USER_RE" -v sch="$SCHEMA" -v r="$SOURCE_APP_ROLE" -F ' ') || die "확인 질의 실패"
  local pubs slots subs roles ro2 tables noins
  read -r pubs slots subs roles ro2 tables noins <<EOF
$out
EOF
  log "    publication=$pubs slot=$slots subscription=$subs repl_user=$roles read_only=$ro2 tables=$tables insert_missing=$noins"
  if [ "$DRY" = 1 ]; then finish s6 "dry-run (지금 상태. 판정 안 함)"
  elif [ "$pubs" = 0 ] && [ "$slots" = 0 ] && [ "$subs" = 0 ] && [ "$roles" = 0 ] && [ "$ro2" = 0 ] && [ "$tables" != 0 ] && [ "$noins" = 0 ]; then
    finish s6 "OK ($SOURCE_APP_ROLE 이 표 ${tables}개 모두 INSERT 가능)"
  else
    CHECK_FAIL=1
    [ "$tables" = 0 ] && log "    $SCHEMA 에 표가 없다 (앱 계정 INSERT 를 확인할 수 없음)" >&2
    finish s6 "FAIL (위 값 확인)"
  fi
}

# ================================================================ 차례
log "onprem-db-reset: 앱 $APP, 도착 $NS$([ "$DO_SOURCE" = 1 ] && echo " + 출발")$([ "$DRY" = 1 ] && echo ", dry-run (아무것도 안 바꾼다)")"
target_preflight
if [ "$DO_SOURCE" = 1 ]; then
  source_preflight
  # 옛 출발의 역방향 구독을 먼저 지운다. 아니면 도착 rev 슬롯을 지우는 사이 그 구독이 다시 붙어 "slot is active" 가 된다
  source_subscriptions
fi
IFS_SAVE=$IFS; IFS=$'\n'
for line in $CLUSTERS; do
  IFS=$IFS_SAVE
  # shellcheck disable=SC2086 # 이름·DB·주인 세 칸을 공백으로 나눈다 (k8s 이름·Postgres 이름에 공백 없음)
  set -- $line
  target_reset_cluster "${1:-}" "${2:-}" "${3:-}"
  IFS=$'\n'
done
IFS=$IFS_SAVE
[ "$DO_SOURCE" = 1 ] && source_rest

if [ "$DRY" = 1 ]; then log "dry-run 끝. 바뀐 것 없음"; exit 0; fi
if [ "$CHECK_FAIL" = 1 ]; then log "끝: 확인 실패 (위 FAIL 줄)" >&2; exit 1; fi
log "끝: 처음 이전하는 고객 상태"
