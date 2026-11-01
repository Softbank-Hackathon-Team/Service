#!/usr/bin/env bash
# 데모 초기화 (z75-29, 작업 Z78). 리허설과 리허설 사이에 데모 회사 한 곳만 "처음 상태"로 되돌린다.
# 맥 bash 3.2 에서도 돈다 (연관 배열·mapfile·date +%N 안 씀).
#
# 하는 일 (차례대로, 각 단계 걸린 초를 찍는다)
#   1. db      데모 회사(기본 1111…)의 이전과 거기 딸린 줄(계획·승인·명세·잠금·임시 자격·비용·에이전트 실행),
#              같은 회사의 감사 줄 전체, Idempotency-Key 기록, pg-boss 작업을 지운다.
#              부하 시험이 남긴 환경(이름 load-…, tools/load/lib.ts)도 지운다. 시드 환경 4개와 다른 이름 환경은 그대로 둔다.
#              회사 표시(app.tenant_id)를 켠 채 지워서 회사 벽(RLS) 안에서만 지운다. 모든 DELETE 에 tenant_id 조건도 같이 건다
#              (도커 Postgres 의 platform_owner 는 슈퍼유저라 RLS 를 건너뛰기 때문).
#              다른 회사의 이전·감사 줄 수를 지우기 전후로 세어, 하나라도 달라지면 통째로 되돌리고 멈춘다.
#              감사 체인은 회사마다 따로라서 그 회사 줄을 전부 지우면 다음 줄이 genesis 부터 다시 이어진다 (검증 깨짐 없음).
#   2. seed    환경 시드를 다시 넣는다: 0002·0008 의 환경 4개(이미 있으면 그대로), 0012 계정 번호, 0016 온프레 환경 파일 그대로.
#              시드 환경의 연결 상태가 바뀌어 있으면 connected 로 돌린다. 1·2 는 한 트랜잭션이다.
#   3. traffic Cloudflare LB 가중치를 출발 100 / 도착 0 으로 (트래픽 어댑터 setAndVerify 1회). TRAFFIC_PROVIDER 가 cloudflare 가 아니면 SKIP.
#   4. k8s     로컬 k3d 의 app-shop 구역 Deployment 를 다시 시작하고 준비될 때까지 기다린다. 컨텍스트·구역이 없으면 SKIP.
#              로컬 컨텍스트(k3s-*, k3d-*)만 건드린다. EKS·GKE 컨텍스트는 이름을 줘도 거부한다.
#
# 쓰는 법 (서비스 폴더 맨 위에서)
#   bash tools/demo-reset.sh                 개발 모양 (psql 로 OWNER_DATABASE_URL 접속, 없으면 docker compose 의 db)
#   bash tools/demo-reset.sh --prod          운영 모양 (docker compose -f docker-compose.prod.yml 의 db)
#   bash tools/demo-reset.sh --dry-run       지울 줄 수만 세고 되돌린다 (traffic·k8s 는 하지 않는다)
#   bash tools/demo-reset.sh --no-traffic --no-k8s
#   DEMO_TENANT=<다른 회사> bash tools/demo-reset.sh --force   데모 회사가 아니면 --force 없이는 거부
# 환경 변수
#   DEMO_TENANT            기본 11111111-1111-4111-8111-111111111111 (시드 재삽입은 이 회사일 때만)
#   PSQL_MAIN              psql 명령 통째로 바꾸기 (demo.sh 와 같은 이름). 예: "docker compose exec -T db psql -U platform_owner -d platform"
#   OWNER_DATABASE_URL     없으면 .env 의 같은 줄을 읽는다 (화면에 찍지 않는다)
#   ONPREM_KUBE_CONTEXT    기본 k3s-onprem
#   RESET_ROLLOUT_TIMEOUT  기본 15s
#   RESET_LIMIT_SEC        판정 기준 초, 기본 20
#   RESET_LOG              주면 결과 줄을 이 파일 끝에 덧붙인다
# 끝 코드: 0 = 전부 OK/SKIP 이고 기준 시간 안, 1 = 어느 단계 실패, 2 = 잘못된 옵션, 4 = 기준 시간 넘김
set -u
CALLER_PWD=$(pwd)
cd "$(dirname "$0")/.." || exit 1
case "${RESET_LOG:-}" in ""|/*) ;; *) RESET_LOG="$CALLER_PWD/$RESET_LOG" ;; esac

TENANT=${DEMO_TENANT:-11111111-1111-4111-8111-111111111111}
DEV_TENANT=11111111-1111-4111-8111-111111111111
SEED_ENV_IDS="'22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'"
KCTX=${ONPREM_KUBE_CONTEXT:-k3s-onprem}
NS=app-shop
ROLLOUT_TIMEOUT=${RESET_ROLLOUT_TIMEOUT:-15s}
LIMIT_SEC=${RESET_LIMIT_SEC:-20}
MODE=dev
DRY=0
DO_TRAFFIC=1
DO_K8S=1
FORCE=0

for a in "$@"; do
  case "$a" in
    --prod) MODE=prod ;;
    --dry-run) DRY=1; DO_TRAFFIC=0; DO_K8S=0 ;;
    --no-traffic) DO_TRAFFIC=0 ;;
    --no-k8s) DO_K8S=0 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $a" >&2; exit 2 ;;
  esac
done
# Z38 R8-29: 데모 회사가 아니면 그 회사 감사 기록을 통째로 지우게 되므로 --force 를 요구한다
if [ "$TENANT" != "$DEV_TENANT" ] && [ "$FORCE" != 1 ]; then echo "DEMO_TENANT 가 데모 회사(1111…)가 아니다. 그 회사 감사 기록까지 지워진다. 정말이면 --force" >&2; exit 2; fi
echo "$TENANT" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || { echo "DEMO_TENANT 가 UUID 가 아니다" >&2; exit 2; }

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000' 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))'; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", (b - a) / 1000 }'; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# psql 고르기. 접속 문자열(비밀번호 포함)은 화면·로그에 찍지 않는다
if [ -z "${PSQL_MAIN:-}" ]; then
  if [ "$MODE" = prod ]; then
    PSQL_MAIN="docker compose -f docker-compose.prod.yml exec -T db psql -U platform_owner -d platform"
  else
    if [ -z "${OWNER_DATABASE_URL:-}" ] && [ -f .env ]; then
      OWNER_DATABASE_URL=$(sed -n 's/^OWNER_DATABASE_URL=//p' .env | tail -n 1 | sed -e 's/^"//' -e 's/"$//')
    fi
    if command -v psql >/dev/null 2>&1; then
      PSQL_MAIN="psql ${OWNER_DATABASE_URL:-postgres://platform_owner:owner_pw@localhost:5432/platform}"
    else
      PSQL_MAIN="docker compose exec -T db psql -U platform_owner -d platform"
    fi
  fi
fi
psql_main() { $PSQL_MAIN -X -q -At -v ON_ERROR_STOP=1 "$@"; }

FAIL=0
LINES=""
report() {
  line="[reset] $1"
  echo "$line"
  LINES="$LINES$line
"
}
T_ALL0=$(now_ms)

# ---------- 1·2. db + seed (한 트랜잭션) ----------
db_sql() {
  cat <<SQL
\\set ON_ERROR_STOP 1
SET client_min_messages TO warning;
BEGIN;
SELECT set_config('app.tenant_id', '$TENANT', true);
CREATE TEMP TABLE z78_reset (k text, n bigint) ON COMMIT DROP;

-- 다른 회사 줄 수 (지우기 전). svc_metrics 는 모든 회사를 읽는 조회 전용 역할 (0010)
SET LOCAL ROLE svc_metrics;
CREATE TEMP TABLE z78_other ON COMMIT DROP AS
  SELECT (SELECT count(*) FROM migrations WHERE tenant_id <> '$TENANT') AS mig,
         (SELECT count(*) FROM audit_events WHERE tenant_id <> '$TENANT') AS aud;
RESET ROLE;

-- 일하는 중인 작업이 있으면 경고만 (워커가 쥐고 있던 작업은 다음 상태 쓰기에서 이전이 없어 조용히 끝난다)
DO \$\$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM pgboss.job WHERE state = ''active'' AND data->>''tenantId'' = \$1' INTO n USING '$TENANT';
  END IF;
  INSERT INTO z78_reset VALUES ('active_jobs', n);
END \$\$;

WITH d AS (DELETE FROM plan_approvals WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'plan_approvals', count(*) FROM d;
WITH d AS (DELETE FROM cost_estimates WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'cost_estimates', count(*) FROM d;
WITH d AS (DELETE FROM agent_steps s USING agent_runs r
           WHERE s.tenant_id = '$TENANT' AND r.tenant_id = '$TENANT' AND s.run_id = r.id AND r.migration_id IS NOT NULL RETURNING 1)
  INSERT INTO z78_reset SELECT 'agent_steps', count(*) FROM d;
WITH d AS (DELETE FROM agent_runs WHERE tenant_id = '$TENANT' AND migration_id IS NOT NULL RETURNING 1) INSERT INTO z78_reset SELECT 'agent_runs', count(*) FROM d;
WITH d AS (DELETE FROM temp_credentials WHERE tenant_id = '$TENANT' AND migration_id IS NOT NULL RETURNING 1) INSERT INTO z78_reset SELECT 'temp_credentials', count(*) FROM d;
WITH d AS (DELETE FROM env_locks WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'env_locks', count(*) FROM d;
WITH d AS (DELETE FROM plans WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'plans', count(*) FROM d;
WITH d AS (DELETE FROM spec_versions WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'spec_versions', count(*) FROM d;
-- z75-60: 트래픽 진행 표(0017, z75-38)·Agent 보고(0018, Z92)는 migrations 를 외래 키로 가리켜서 먼저 지운다. 예전엔 shift 를 한 번이라도 돈 뒤면 초기화가 FK 오류로 통째로 되돌려졌다
DO \$\$ BEGIN
  IF to_regclass('public.traffic_progress') IS NOT NULL THEN
    WITH d AS (DELETE FROM traffic_progress WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'traffic_progress', count(*) FROM d;
  END IF;
  -- Z38b REVIEW-8 §24-14: 온프레 Agent 보고(0018, Z92)도 migration_id 로 migrations 를 가리킨다. 이 회사 보고만 지운다 (키 agent_keys 는 그대로)
  IF to_regclass('public.agent_reports') IS NOT NULL THEN
    WITH d AS (DELETE FROM agent_reports WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'agent_reports', count(*) FROM d;
  END IF;
END \$\$;
WITH d AS (DELETE FROM migrations WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'migrations', count(*) FROM d;
WITH d AS (DELETE FROM idempotency_keys WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'idempotency_keys', count(*) FROM d;
-- 부하 시험(tools/load/lib.ts)이 남긴 환경 load-<tag>-src-N / load-<tag>-dst-N. 이름이 load- 로 시작하고 시드 4개 번호가 아닌 것만.
-- 실 환경(dev-aws·dev-gcp·dev-azure-mock·dev-onprem-k3d)과 사람이 만든 다른 이름의 환경은 건드리지 않는다
WITH d AS (DELETE FROM temp_credentials t USING environments e
           WHERE t.tenant_id = '$TENANT' AND e.tenant_id = '$TENANT' AND t.env_id = e.id AND e.name LIKE 'load-%'
             AND e.id NOT IN ($SEED_ENV_IDS) RETURNING 1)
  INSERT INTO z78_reset SELECT 'load_env_creds', count(*) FROM d;
WITH d AS (DELETE FROM environments WHERE tenant_id = '$TENANT' AND name LIKE 'load-%' AND id NOT IN ($SEED_ENV_IDS) RETURNING 1)
  INSERT INTO z78_reset SELECT 'load_envs', count(*) FROM d;
WITH d AS (DELETE FROM audit_events WHERE tenant_id = '$TENANT' RETURNING 1) INSERT INTO z78_reset SELECT 'audit_events', count(*) FROM d;

-- pg-boss 작업 (회사 번호가 data.tenantId 에 있다). archive 표는 pg-boss 10 부터 없어서 있을 때만
DO \$\$
DECLARE n bigint; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job', 'archive'] LOOP
    IF to_regclass('pgboss.' || t) IS NOT NULL THEN
      EXECUTE format('DELETE FROM pgboss.%I WHERE data->>''tenantId'' = \$1', t) USING '$TENANT';
      GET DIAGNOSTICS n = ROW_COUNT;
      INSERT INTO z78_reset VALUES ('pgboss.' || t, n);
    END IF;
  END LOOP;
END \$\$;
SQL
  if [ "$TENANT" = "$DEV_TENANT" ]; then
    cat <<SQL
-- 시드 다시 넣기 (0002·0008 은 ON CONFLICT 가 없어 같은 줄을 여기 적고, 0012·0016 은 파일 그대로)
INSERT INTO tenants (id, name) VALUES ('$DEV_TENANT', 'dev-company') ON CONFLICT (id) DO NOTHING;
INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
 ('22222222-2222-4222-8222-222222222222', '$DEV_TENANT', 'aws', 'dev-aws', 'connected'),
 ('33333333-3333-4333-8333-333333333333', '$DEV_TENANT', 'gcp', 'dev-gcp', 'connected'),
 ('44444444-4444-4444-8444-444444444444', '$DEV_TENANT', 'azure_mock', 'dev-azure-mock', 'connected')
ON CONFLICT (id) DO NOTHING;
SQL
    grep -v '^[[:space:]]*--' db/migrations/0012_seed_dev_account_ids.sql
    grep -v '^[[:space:]]*--' db/migrations/0016_seed_dev_onprem.sql
    cat <<SQL
SELECT set_config('app.tenant_id', '$TENANT', true);
WITH u AS (UPDATE environments SET connection_status = 'connected'
           WHERE id IN ('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',
                        '44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555')
             AND connection_status IS DISTINCT FROM 'connected' RETURNING 1)
  INSERT INTO z78_reset SELECT 'env_status_fixed', count(*) FROM u;
SQL
  fi
  cat <<SQL
-- 확인: 이 회사 이전·감사 0, 다른 회사 줄 수 그대로
INSERT INTO z78_reset SELECT 'left_migrations', count(*) FROM migrations WHERE tenant_id = '$TENANT';
INSERT INTO z78_reset SELECT 'left_audit', count(*) FROM audit_events WHERE tenant_id = '$TENANT';
INSERT INTO z78_reset SELECT 'envs', count(*) FROM environments WHERE tenant_id = '$TENANT';
SET LOCAL ROLE svc_metrics;
CREATE TEMP TABLE z78_after ON COMMIT DROP AS
  SELECT (SELECT count(*) FROM migrations WHERE tenant_id <> '$TENANT') AS mig,
         (SELECT count(*) FROM audit_events WHERE tenant_id <> '$TENANT') AS aud;
RESET ROLE;
DO \$\$
DECLARE b record; a record;
BEGIN
  SELECT * INTO b FROM z78_other;
  SELECT * INTO a FROM z78_after;
  IF a.mig <> b.mig OR a.aud <> b.aud THEN
    RAISE EXCEPTION 'Z78_OTHER_TENANT_CHANGED 다른 회사 줄 수가 바뀜: 이전 % → %, 감사 % → %', b.mig, a.mig, b.aud, a.aud;
  END IF;
  INSERT INTO z78_reset VALUES ('other_migrations', a.mig), ('other_audit', a.aud);
END \$\$;
SELECT string_agg(k || '=' || n, ' ' ORDER BY k) FROM z78_reset;
SQL
  if [ "$DRY" = 1 ]; then echo "ROLLBACK;"; else echo "COMMIT;"; fi
}

t0=$(now_ms)
out=$(db_sql | psql_main 2>&1)
rc=$?
t1=$(now_ms)
if [ $rc -ne 0 ]; then
  FAIL=1
  report "db+seed $(secs "$t0" "$t1")초 FAIL (되돌림): $(echo "$out" | grep -v '^$' | tail -n 2 | tr '\n' ' ')"
else
  counts=$(echo "$out" | grep '=' | tail -n 1)
  left=$(echo "$counts" | tr ' ' '\n' | sed -n 's/^left_migrations=//p')
  lefta=$(echo "$counts" | tr ' ' '\n' | sed -n 's/^left_audit=//p')
  if [ "$left" != 0 ] || [ "$lefta" != 0 ]; then FAIL=1; st=FAIL; else st=OK; fi
  [ "$DRY" = 1 ] && st="$st(dry-run, 되돌림)"
  report "db+seed $(secs "$t0" "$t1")초 $st $counts"
fi

# ---------- 3. traffic ----------
if [ "$DO_TRAFFIC" = 0 ]; then
  report "traffic SKIP (옵션으로 끔)"
else
  t0=$(now_ms)
  if [ ! -d node_modules ]; then
    report "traffic SKIP (node_modules 없음)"
  else
    out=$(node --env-file-if-exists=.env --import tsx tools/demo-reset-traffic.ts 2>&1)
    rc=$?
    t1=$(now_ms)
    msg=$(echo "$out" | tail -n 1)
    if [ $rc -eq 0 ]; then report "traffic $(secs "$t0" "$t1")초 $msg"; else FAIL=1; report "traffic $(secs "$t0" "$t1")초 FAIL $msg"; fi
  fi
fi

# ---------- 4. k8s ----------
if [ "$DO_K8S" = 0 ]; then
  report "k8s SKIP (옵션으로 끔)"
elif ! command -v kubectl >/dev/null 2>&1; then
  report "k8s SKIP (kubectl 없음)"
else
  case "$KCTX" in
    k3s-*|k3d-*) ok_ctx=1 ;;
    *) ok_ctx=0 ;;
  esac
  if [ $ok_ctx = 0 ]; then
    report "k8s SKIP (로컬 컨텍스트가 아님: $KCTX. k3s-*, k3d-* 만 다시 시작한다)"
  elif ! kubectl config get-contexts -o name 2>/dev/null | grep -qx "$KCTX"; then
    report "k8s SKIP (컨텍스트 $KCTX 없음)"
  elif ! kubectl --context "$KCTX" --request-timeout=3s get ns "$NS" >/dev/null 2>&1; then
    report "k8s SKIP ($KCTX 에 구역 $NS 없음 또는 클러스터 꺼짐)"
  else
    t0=$(now_ms)
    deps=$(kubectl --context "$KCTX" -n "$NS" get deploy -o name 2>/dev/null)
    if [ -z "$deps" ]; then
      report "k8s SKIP ($NS 에 Deployment 없음)"
    elif kubectl --context "$KCTX" -n "$NS" rollout restart deployment >/dev/null 2>&1; then
      kst=OK
      for d in $deps; do
        kubectl --context "$KCTX" -n "$NS" rollout status "$d" --timeout="$ROLLOUT_TIMEOUT" >/dev/null 2>&1 || kst="FAIL($d 준비 안 됨, $ROLLOUT_TIMEOUT)"
      done
      t1=$(now_ms)
      [ "$kst" = OK ] || FAIL=1
      report "k8s $(secs "$t0" "$t1")초 $kst 다시 시작 $(echo $deps | wc -w | tr -d ' ')개"
    else
      t1=$(now_ms)
      FAIL=1
      report "k8s $(secs "$t0" "$t1")초 FAIL rollout restart"
    fi
  fi
fi

T_ALL1=$(now_ms)
TOTAL=$(secs "$T_ALL0" "$T_ALL1")
over=$(awk -v t="$TOTAL" -v l="$LIMIT_SEC" 'BEGIN { print (t > l) ? 1 : 0 }')
if [ $FAIL -ne 0 ]; then verdict="FAIL"; code=1
elif [ "$over" = 1 ]; then verdict="FAIL(${LIMIT_SEC}초 넘김)"; code=4
else verdict="PASS"; code=0; fi
report "판정 $verdict 총 ${TOTAL}초 (기준 ≤${LIMIT_SEC}초) 회사 ${TENANT:0:8}… $(iso)"
if [ -n "${RESET_LOG:-}" ]; then printf '%s' "$LINES" >> "$RESET_LOG"; fi
exit $code
