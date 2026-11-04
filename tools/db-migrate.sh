#!/bin/sh
# 플랫폼 DB 마이그레이션 실행기 (작업 Z9, DRAFT(ai)). POSIX sh: 맥 bash 3.2, 리눅스 dash, postgres:16-alpine ash 모두 된다
#
# 하는 일
#   - db/migrations/NNNN_*.sql 을 번호 순서로, 아직 안 들어간 것만 넣는다
#   - 파일 하나 = 트랜잭션 하나. 중간에 깨지면 그 파일은 통째로 없던 일이 된다
#   - 넣은 기록은 migrate.applied 표 (번호, 파일 이름, sha256, 시각). 이미 넣은 파일 내용이 바뀌면 멈춘다
#   - 두 개가 동시에 돌아도 advisory lock 으로 하나씩만 넣는다
#   - 앞으로만 간다(forward-only). 되돌리기는 각 파일 끝 "-- Down Migration" 을 사람이 돌린다
#
# 사용
#   DB_ADMIN_URL=postgres://platform_owner:owner_pw@localhost:5432/platform sh tools/db-migrate.sh
#   sh tools/db-migrate.sh --status            넣은 것 / 남은 것 보기
#   sh tools/db-migrate.sh --dry-run           넣을 파일 이름만 출력
#   sh tools/db-migrate.sh --baseline auto     docker 초기화 폴더로 이미 만든 DB: 있는 표를 보고 기록만 채운다 (실행 안 함)
#   sh tools/db-migrate.sh --baseline 0005     0001~0005 는 이미 들어갔다고 기록만 한다
#   sh tools/db-migrate.sh --db platform_test_tpl   같은 서버의 다른 DB 에 넣는다 (URL 의 DB 이름만 바꿈, 다른 옵션 앞에 쓴다. 작업 Z76 시험 틀 DB 용)
# 환경 변수
#   DB_ADMIN_URL   표 주인 계정 연결 (기본: OWNER_DATABASE_URL, 그것도 없으면 위 로컬 기본값)
#   MIGRATIONS_DIR 기본: 이 스크립트 옆 ../db/migrations
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DIR=${MIGRATIONS_DIR:-$HERE/../db/migrations}
URL=${DB_ADMIN_URL:-${OWNER_DATABASE_URL:-postgres://platform_owner:owner_pw@localhost:5432/platform}}
MODE=apply
BASE=""
if [ "${1:-}" = --db ]; then
  DBNAME=${2:?"--db 뒤에 DB 이름"}
  echo "$DBNAME" | grep -Eq '^[a-z][a-z0-9_]{0,62}$' || { echo "DB 이름은 소문자·숫자·_ 만: $DBNAME" >&2; exit 2; }
  URL=$(echo "$URL" | sed -E "s#^(postgres(ql)?://[^/]*/)[^?]*#\1$DBNAME#")
  # Z38 REVIEW-6 R6-3: URL 에 DB 경로가 없으면(postgres://u:p@h:5432, ?만 있음, key=value 형식) 위 sed 가 아무것도 안 바꿔
  #   조용히 기본 DB 에 넣었다. 바꾼 결과의 DB 이름이 정말 $DBNAME 인지 확인하고 아니면 멈춘다
  echo "$URL" | grep -Eq "^postgres(ql)?://[^/]*/$DBNAME(\?|\$)" || {
    echo "--db: 접속 URL 에 DB 이름 자리가 없어 $DBNAME 로 바꿀 수 없다 (postgres://사용자:비번@호스트:포트/DB 모양이어야 한다)" >&2; exit 2; }
  shift 2
fi
case "${1:-}" in
  --status) MODE=status ;;
  --dry-run) MODE=dry ;;
  --baseline) MODE=baseline; BASE=${2:?"--baseline 뒤에 auto 또는 NNNN"} ;;
  "") ;;
  *) echo "모르는 옵션: $1" >&2; exit 2 ;;
esac

if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
sum() { $SHA "$1" | cut -d' ' -f1; }
q() { psql "$URL" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }

# 파일 이름 검사: 4자리 번호_소문자.sql, 번호 중복 금지
FILES=$(ls "$DIR" | grep -E '^[0-9]{4}_[a-z0-9_]+\.sql$' | sort)
BAD=$(ls "$DIR" | grep -E '\.sql$' | grep -vE '^[0-9]{4}_[a-z0-9_]+\.sql$' || true)
[ -z "$BAD" ] || { echo "이름 규칙(NNNN_소문자.sql) 위반: $BAD" >&2; exit 1; }
DUP=$(echo "$FILES" | cut -c1-4 | uniq -d)
[ -z "$DUP" ] || { echo "번호 중복: $DUP" >&2; exit 1; }

q "SET client_min_messages TO warning;
   SELECT pg_advisory_xact_lock(hashtext('svc:db-migrate'));
   CREATE SCHEMA IF NOT EXISTS migrate;
   CREATE TABLE IF NOT EXISTS migrate.applied (
     version text PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL,
     applied_at timestamptz NOT NULL DEFAULT now(), how text NOT NULL DEFAULT 'run');
   REVOKE ALL ON SCHEMA migrate FROM PUBLIC;" >/dev/null

applied_sum() { q "SELECT sha256 FROM migrate.applied WHERE version = '$1'"; }

# docker 초기화 폴더로 만든 DB 는 기록이 없다. 파일마다 "그 파일이 만든 것"이 있는지 보고 어디까지 들어갔는지 정한다
# 새 마이그레이션을 더하면 여기 한 줄을 더한다 (tools/db-lint.sh 가 빠졌는지 검사)
marker_sql() {
  case "$1" in
    0001) echo "to_regclass('public.audit_events') IS NOT NULL" ;;
    0002) echo "EXISTS (SELECT 1 FROM public.tenants WHERE id = '11111111-1111-4111-8111-111111111111')" ;;
    0003) echo "to_regclass('public.idempotency_keys') IS NOT NULL" ;;
    0004) echo "to_regclass('public.plan_approvals') IS NOT NULL" ;;
    0005) echo "EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'environments_id_tenant')" ;;
    0006) echo "to_regclass('public.agent_steps') IS NOT NULL" ;;
    0007) echo "to_regclass('public.cost_estimates') IS NOT NULL" ;;
    0008) echo "EXISTS (SELECT 1 FROM public.environments WHERE id = '44444444-4444-4444-8444-444444444444')" ;;
    0009) echo "to_regclass('public.temp_credentials') IS NOT NULL" ;;
    0010) echo "to_regprocedure('public.metrics_snapshot(float8[],float8[],int)') IS NOT NULL" ;;
    0011) echo "to_regclass('public.audit_events_tenant_seq') IS NOT NULL" ;;
    0012) echo "EXISTS (SELECT 1 FROM public.environments WHERE id = '22222222-2222-4222-8222-222222222222' AND account_id IS NOT NULL)" ;;
    0013) echo "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'temp_credentials' AND column_name = 'expired_at')" ;;
    0014) echo "to_regclass('public.temp_credentials_migration_all') IS NOT NULL" ;;
    0015) echo "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'temp_credentials' AND column_name = 'renew_seq')" ;;
    0016) echo "EXISTS (SELECT 1 FROM public.environments WHERE id = '55555555-5555-4555-8555-555555555555')" ;;
    0017) echo "to_regclass('public.traffic_progress') IS NOT NULL" ;;
    0018) echo "to_regclass('public.agent_reports') IS NOT NULL" ;;
    0019) echo "to_regclass('public.auth_sessions') IS NOT NULL" ;;
    0020) echo "to_regclass('public.agent_llm_cache') IS NOT NULL" ;;
    0021) echo "to_regclass('public.llm_spend') IS NOT NULL" ;;
    0022) echo "EXISTS (SELECT 1 FROM public.tenants WHERE id = '66666666-6666-4666-8666-666666666666')" ;;
    0023) echo "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='spec_versions' AND column_name='spec_v2')" ;;
    0024) echo "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='environments' AND column_name='verify_failures')" ;;
    0026) echo "to_regprocedure('public.maint_verify_due(integer)') IS NOT NULL" ;;
    0031) echo "EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spec_versions_spec_v2_object')" ;;
    0032) echo "EXISTS (SELECT 1 FROM pg_roles r JOIN pg_class c ON c.relowner = r.oid WHERE r.rolname = 'svc_spend' AND c.oid = 'public.llm_spend_global'::regclass)" ;;
    0030) echo "has_column_privilege('app_user', 'public.agent_enroll_tokens', 'expires_at', 'UPDATE')" ;;
    0029) echo "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'gcp_platform_sa')" ;;
    0028) echo "to_regclass('public.personal_tokens') IS NOT NULL" ;;
    0025) echo "EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_kind_check' AND pg_get_constraintdef(oid) LIKE '%failure_analysis%')" ;;
    0027) echo "to_regclass('public.agent_enroll_tokens') IS NOT NULL" ;;
    0033) echo "to_regclass('public.infra_ready') IS NOT NULL" ;;
    0034) echo "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'github_id')" ;;
    0035) echo "to_regclass('public.metric_tokens') IS NOT NULL" ;;
    *) echo "" ;;
  esac
}

if [ "$MODE" = baseline ]; then
  N=$(q "SELECT count(*) FROM migrate.applied")
  [ "$N" = 0 ] || { echo "기록이 이미 ${N}줄 있다. baseline 은 빈 기록에서만 한다" >&2; exit 1; }
  for f in $FILES; do
    v=$(echo "$f" | cut -c1-4)
    if [ "$BASE" = auto ]; then
      m=$(marker_sql "$v")
      [ -n "$m" ] || { echo "$v: 표시 쿼리가 없다 → 여기서 멈춤"; break; }
      # 0002 의 시드 줄은 회사 벽 뒤라 주인이 슈퍼유저가 아니면 안 보인다 → 회사 표시를 하고 본다
      ok=$(psql "$URL" -X -q -At -v ON_ERROR_STOP=1 -c "SELECT set_config('app.tenant_id','11111111-1111-4111-8111-111111111111',false)" -c "SELECT $m" | tail -1)
      [ "$ok" = t ] || { echo "$v: DB 에 없음 → 여기서 멈춤"; break; }
    else
      [ "$v" \> "$BASE" ] && break
    fi
    q "INSERT INTO migrate.applied (version, name, sha256, how) VALUES ('$v', '$f', '$(sum "$DIR/$f")', 'baseline')"
    echo "baseline $f"
  done
  exit 0
fi

PENDING=""
for f in $FILES; do
  v=$(echo "$f" | cut -c1-4)
  s=$(applied_sum "$v")
  if [ -n "$s" ]; then
    if [ "$s" != "$(sum "$DIR/$f")" ]; then
      echo "이미 넣은 $f 의 내용이 바뀌었다 (기록 sha256 ${s}). 고치지 말고 새 번호로 만든다" >&2; exit 1
    fi
    [ "$MODE" = status ] && echo "applied  $f"
  else
    PENDING="$PENDING $f"
    [ "$MODE" = status ] && echo "pending  $f"
  fi
done

if [ "$MODE" != apply ]; then
  [ "$MODE" = dry ] && for f in $PENDING; do echo "$f"; done
  exit 0
fi

# 기록은 비었는데 표가 있으면 docker 초기화 폴더로 만든 DB 다
if [ "$(q "SELECT count(*) FROM migrate.applied")" = 0 ] && [ "$(q "SELECT to_regclass('public.tenants') IS NOT NULL")" = t ]; then
  echo "기록 없이 표가 이미 있다 (docker 초기화로 만든 DB). 먼저: sh tools/db-migrate.sh --baseline auto" >&2; exit 1
fi

TMP=$(mktemp "${TMPDIR:-/tmp}/db-migrate.XXXXXX")
trap 'rm -f "$TMP"' EXIT
n=0
for f in $PENDING; do
  v=$(echo "$f" | cut -c1-4)
  sha=$(sum "$DIR/$f")
  cat > "$TMP" <<SQL
\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('svc:db-migrate'));
SELECT EXISTS (SELECT 1 FROM migrate.applied WHERE version = '$v') AS already \\gset
\\if :already
  \\echo 'skip $f'
\\else
  \\i '$DIR/$f'
  INSERT INTO migrate.applied (version, name, sha256) VALUES ('$v', '$f', '$sha');
\\endif
COMMIT;
SQL
  start=$(date +%s)
  res=$(psql "$URL" -X -q -At -v ON_ERROR_STOP=1 -f "$TMP") || { echo "실패: $f (이 파일은 통째로 되돌려졌다)" >&2; exit 1; }
  case "$res" in
    *"skip $f"*) echo "skip $f (다른 실행기가 먼저 넣음)" ;;
    *) echo "applied $f ($(( $(date +%s) - start ))s)"; n=$((n + 1)) ;;
  esac
done
echo "done: ${n}개 넣음"
