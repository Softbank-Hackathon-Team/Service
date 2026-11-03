#!/bin/sh
# 플랫폼 DB 마이그레이션 검사 (작업 Z9, DRAFT(ai)). CI 와 맥에서 같은 명령으로 돈다. POSIX sh
#
# 정적 검사 (DB 없이)
#   S1 파일 이름 NNNN_소문자.sql, 번호 중복·빈 번호 없음
#   S2 파일 안에 BEGIN/COMMIT/ROLLBACK, CONCURRENTLY, VACUUM 없음 (실행기가 파일 하나를 트랜잭션 하나로 감싼다)
#   S3 CREATE ROLE 은 "있으면 건너뛰기"(pg_roles 확인) 안에서만
#   S4 파일마다 "-- Down Migration" 또는 "forward-only" 표시
#   S5 db-migrate.sh 의 baseline 표시 쿼리(marker_sql)가 모든 번호에 있다
#   S6 environments 에 넣는 파일(시드)은 app.tenant_id 를 표시한다 (주인이 슈퍼유저가 아니어도 FORCE RLS 통과)
# 동적 검사 (LINT_ADMIN_URL 이 있으면. 임시 DB lint_z9_* 를 만들고 끝나면 지운다)
#   D1 빈 DB 에 실행기로 전부 넣기
#   D2 한 번 더 돌리면 0개 (다시 돌려도 안전)
#   D3 같은 클러스터의 두 번째 DB 에도 들어간다 (역할 중복 생성 없음)
#   D4 나눠 넣기(1..k 넣고 나머지) 결과 스키마 = 한 번에 넣은 스키마 (pg_dump -s 비교). LINT_SPLIT=all 이면 모든 k
#   D5 회사 표(tenant_id 칸이 있는 public 표)는 전부 RLS + FORCE + app.tenant_id 정책
#   D6 app_user: 슈퍼유저·BYPASSRLS 아님, public 표 주인 아님, 쌓기 전용 표에 UPDATE/DELETE 없음, TRUNCATE 없음
#   D7 SECURITY DEFINER 함수: search_path 고정, PUBLIC 실행 권한 없음, 주인이 슈퍼유저 아님
#   D8 상태 CHECK 목록 = packages/contracts 의 목록 (migrations.status, environments.connection_status)
#   D9 외래 키 칼럼이 인덱스 앞부분에 없음 → 경고만 (부모를 지우는 길이 지금은 없다)
#
# 사용
#   sh tools/db-lint.sh                                   정적 검사만
#   LINT_ADMIN_URL=postgres://platform_owner:owner_pw@localhost:5432/postgres sh tools/db-lint.sh
# 끝 코드: 0 = 통과, 1 = 실패 있음
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
DIR=${MIGRATIONS_DIR:-$ROOT/db/migrations}
CONTRACTS=${CONTRACTS_DIR:-$ROOT/packages/contracts/src}
APPEND_ONLY="audit_events plan_approvals agent_steps cost_estimates"
NO_TENANT_OK="tenants"

FAIL=0
ok()   { echo "  ok   $*"; }
bad()  { echo "  FAIL $*"; FAIL=1; }
warn() { echo "  warn $*"; }

echo "== 정적 검사 ($DIR)"
FILES=$(ls "$DIR" | grep -E '\.sql$' | sort)
BADNAME=$(echo "$FILES" | grep -vE '^[0-9]{4}_[a-z0-9_]+\.sql$' || true)
[ -z "$BADNAME" ] && ok "S1 이름 규칙" || bad "S1 이름 규칙 위반: $BADNAME"
DUP=$(echo "$FILES" | cut -c1-4 | uniq -d)
[ -z "$DUP" ] && ok "S1 번호 중복 없음" || bad "S1 번호 중복: $DUP"
i=1; GAP=""
for v in $(echo "$FILES" | cut -c1-4 | uniq); do
  want=$(printf '%04d' $i); [ "$v" = "$want" ] || GAP="$GAP $want(대신 $v)"; i=$((i + 1))
done
[ -z "$GAP" ] && ok "S1 빈 번호 없음" || bad "S1 번호가 이어지지 않음:$GAP"

for f in $FILES; do
  p="$DIR/$f"
  # 주석(--) 뒤는 빼고 본다
  body=$(sed 's/--.*$//' "$p")
  echo "$body" | grep -qiE '^[[:space:]]*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)[[:space:]]*;' && bad "S2 $f: 트랜잭션 문장"
  echo "$body" | grep -qiE 'CONCURRENTLY|^[[:space:]]*VACUUM' && bad "S2 $f: 트랜잭션 안에서 못 도는 문장(CONCURRENTLY/VACUUM)"
  if echo "$body" | grep -qiE 'CREATE[[:space:]]+ROLE'; then
    echo "$body" | grep -q 'pg_roles' || bad "S3 $f: CREATE ROLE 에 '있으면 건너뛰기' 없음"
  fi
  grep -qE '^-- Down Migration|forward-only' "$p" || bad "S4 $f: '-- Down Migration' 또는 'forward-only' 표시 없음"
  if echo "$body" | grep -qiE '(INSERT INTO|UPDATE)[[:space:]]+environments'; then
    grep -q "set_config('app.tenant_id'" "$p" || bad "S6 $f: environments 에 넣는데 app.tenant_id 표시 없음"
  fi
done
ok "S2·S3·S4·S6 파일 $(echo "$FILES" | wc -l | tr -d ' ')개 확인 (위에 FAIL 없으면 통과)"

MISSING=""
for v in $(echo "$FILES" | cut -c1-4); do
  grep -qE "^[[:space:]]*$v\)" "$HERE/db-migrate.sh" || MISSING="$MISSING $v"
done
[ -z "$MISSING" ] && ok "S5 baseline 표시 쿼리" || bad "S5 tools/db-migrate.sh marker_sql 에 없는 번호:$MISSING"

if [ -z "${LINT_ADMIN_URL:-}" ]; then
  echo "== 동적 검사 건너뜀 (LINT_ADMIN_URL 없음)"
  [ $FAIL = 0 ] && echo "PASS (정적)" || echo "FAIL"
  exit $FAIL
fi

command -v psql >/dev/null || { echo "psql 이 없다"; exit 1; }
# LINT_ADMIN_URL 의 DB 이름만 바꾼 연결 문자열 (postgres://u:p@h:port/DB?opts 와 postgresql:///DB?host=… 둘 다)
url_for() { echo "$LINT_ADMIN_URL" | sed -E "s#^(postgres(ql)?://[^/]*/)[^?]*#\1$1#"; }
adm() { psql "$LINT_ADMIN_URL" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }
in_db() { psql "$(url_for "$1")" -X -q -At -v ON_ERROR_STOP=1 -c "$2"; }
DBS=""
mkdb() { adm "DROP DATABASE IF EXISTS $1" 2>/dev/null; adm "CREATE DATABASE $1" && DBS="$DBS $1"; }
cleanup() { for d in $DBS; do adm "DROP DATABASE IF EXISTS $d" >/dev/null 2>&1; done; }
trap cleanup EXIT
migrate() { DB_ADMIN_URL=$(url_for "$1") MIGRATIONS_DIR="$2" sh "$HERE/db-migrate.sh" 2>&1; }
dump() { pg_dump -s "$(url_for "$1")" | grep -vE '^\\(un)?restrict|^-- Dumped (from|by)|migrate\.applied|SCHEMA migrate'; }

TAG=$$
A=lint_z9_${TAG}_a; B=lint_z9_${TAG}_b
echo "== 동적 검사"
mkdb $A || exit 1
out=$(migrate $A "$DIR"); echo "$out" | grep -q '^done' && ok "D1 빈 DB 에 전부 넣기 ($(echo "$out" | grep -c '^applied'))" || { bad "D1"; echo "$out" | tail -5; exit 1; }
out=$(migrate $A "$DIR"); echo "$out" | grep -q 'done: 0개' && ok "D2 다시 돌리면 0개" || bad "D2 두 번째 실행: $out"
mkdb $B; out=$(migrate $B "$DIR"); echo "$out" | grep -q '^done' && ok "D3 같은 클러스터 두 번째 DB" || { bad "D3"; echo "$out" | tail -5; }

if command -v pg_dump >/dev/null; then
  T=$(mktemp -d "${TMPDIR:-/tmp}/db-lint.XXXXXX")
  dump $A > "$T/full.sql"
  N=$(echo "$FILES" | wc -l | tr -d ' ')
  if [ "${LINT_SPLIT:-last}" = all ]; then KS=$(seq 1 $((N - 1))); else KS=$((N - 1)); fi
  for k in $KS; do
    mkdir -p "$T/k$k"; echo "$FILES" | head -n $k | while read -r f; do cp "$DIR/$f" "$T/k$k/"; done
    C=lint_z9_${TAG}_k$k; mkdb $C
    migrate $C "$T/k$k" >/dev/null && migrate $C "$DIR" >/dev/null
    dump $C > "$T/k$k.sql"
    if diff -q "$T/full.sql" "$T/k$k.sql" >/dev/null; then ok "D4 1..$k 넣고 나머지 = 한 번에 넣기"; else bad "D4 나눠 넣기(k=$k) 스키마가 다르다"; diff "$T/full.sql" "$T/k$k.sql" | head -10; fi
    adm "DROP DATABASE $C"
  done
  rm -rf "$T"
else
  warn "D4 pg_dump 없음 → 건너뜀"
fi

R=$(in_db $A "
  SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity
              AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd = '*'
                            AND (p.polroles = '{0}' OR 'app_user'::regrole::oid = ANY (p.polroles))
                            AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.tenant_id%'
                            AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app.tenant_id%'))")
[ -z "$R" ] && ok "D5 회사 표 RLS+FORCE+정책" || bad "D5 회사 벽 빠진 표: $R"
R=$(in_db $A "
  SELECT c.relname FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id')
     -- DBLINTDYN: 회사 번호 칸이 없어도 app_user 가 직접 만질 수 없는 표(DEFINER 함수로만 접근, 예: llm_spend_global)는 회사 벽이 필요 없다
     AND (has_table_privilege('app_user', c.oid, 'SELECT') OR has_table_privilege('app_user', c.oid, 'INSERT')
          OR has_table_privilege('app_user', c.oid, 'UPDATE') OR has_table_privilege('app_user', c.oid, 'DELETE'))
     AND c.relname NOT IN ($(echo $NO_TENANT_OK | sed "s/[a-z_]*/'&'/g; s/ /,/g"))")
[ -z "$R" ] && ok "D5 tenant_id 없는 public 표는 허용 목록 또는 app_user 권한 없는 표뿐" || bad "D5 tenant_id 없는 표(허용 목록 밖): $R"
R=$(in_db $A "SELECT relname FROM pg_class WHERE relname = 'tenants' AND relnamespace = 'public'::regnamespace AND NOT relrowsecurity")
[ -z "$R" ] && ok "D5 tenants 회사 벽" || warn "D5 tenants 에 RLS 없음 (다른 회사 이름이 보임)"

R=$(in_db $A "SELECT rolname FROM pg_roles WHERE rolname IN ('app_user','svc_maintenance','svc_metrics') AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)")
[ -z "$R" ] && ok "D6 앱·서비스 역할에 특권 없음" || bad "D6 특권 있는 역할: $R"
R=$(in_db $A "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relowner = 'app_user'::regrole")
[ -z "$R" ] && ok "D6 app_user 는 public 표 주인 아님" || bad "D6 app_user 가 주인인 표: $R"
for t in $APPEND_ONLY; do
  R=$(in_db $A "SELECT to_regclass('public.$t') IS NOT NULL AND (has_table_privilege('app_user','public.$t','UPDATE') OR has_table_privilege('app_user','public.$t','DELETE'))")
  [ "$R" = f ] || bad "D6 쌓기 전용 $t 에 app_user UPDATE/DELETE 있음"
done
R=$(in_db $A "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND has_table_privilege('app_user', oid, 'TRUNCATE')")
[ -z "$R" ] && ok "D6 쌓기 전용 표·TRUNCATE 권한" || bad "D6 app_user TRUNCATE 가능: $R"

R=$(in_db $A "
  SELECT p.proname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
     AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) x WHERE x LIKE 'search_path=%')
          OR p.proacl IS NULL
          OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          OR r.rolsuper)")
[ -z "$R" ] && ok "D7 SECURITY DEFINER 함수 $(in_db $A "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef")개" || bad "D7 위험한 SECURITY DEFINER: $R"

list_ts() { sed -n "/$2/,/\]/p" "$1" | tr -d ' \n' | grep -oE '"[a-z_]+"' | tr -d '"' | grep -v "^$3\$" | sort | tr '\n' ' '; }
list_db() { in_db $A "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '$1'" | grep -oE "'[a-z_]+'" | tr -d "'" | sort | tr '\n' ' '; }
check_enum() {
  ts=$(list_ts "$1" "$2" "$3"); db=$(list_db "$4")
  if [ -z "$db" ]; then bad "D8 $4 CHECK 없음"; elif [ "$ts" = "$db" ]; then ok "D8 $4 = contracts ($(echo $ts | wc -w | tr -d ' ')개)"; else bad "D8 $4 와 contracts 가 다르다: contracts=[$ts] db=[$db]"; fi
}
[ -f "$CONTRACTS/migration.ts" ] && check_enum "$CONTRACTS/migration.ts" "MIGRATION_STATUSES = \[" "zz" migrations_status_check || warn "D8 contracts 없음"
[ -f "$CONTRACTS/environment.ts" ] && check_enum "$CONTRACTS/environment.ts" "ConnectionStatus = z.enum(\[" "zz" environments_connection_status_check

R=$(in_db $A "
  SELECT c.conrelid::regclass || '(' || (SELECT string_agg(attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                                          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) || ')'
    FROM pg_constraint c
   WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
     AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
                       AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey
                       AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] <@ c.conkey)
   ORDER BY 1")
[ -z "$R" ] && ok "D9 외래 키 인덱스" || warn "D9 인덱스 없는 외래 키 $(echo "$R" | wc -l | tr -d ' ')개 (부모 행을 지우는 길이 생기면 추가): $(echo $R | tr '\n' ' ')"

[ $FAIL = 0 ] && echo "PASS" || echo "FAIL"
exit $FAIL
