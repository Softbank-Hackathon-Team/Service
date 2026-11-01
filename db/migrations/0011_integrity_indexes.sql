-- 0011 (작업 Z9 제안, DRAFT(ai)): 값 검사 + 자주 쓰는 조회의 인덱스 + 빠진 회사 묶음 외래 키 + tenants 회사 벽
-- forward-only: 되돌릴 때는 아래 "-- Down Migration" 을 사람이 직접 돌린다 (실행 도구는 앞으로만 간다)
-- 기존 데이터가 규칙을 어겨도 파일 전체가 깨지지 않게, 값 검사는 NOT VALID 로 넣고 검증은 따로 시도한다
-- (어긴 줄이 있으면 NOTICE 만 남기고 새 줄부터 막는다. 정리 뒤 VALIDATE CONSTRAINT 를 다시 돌린다)

-- 1. 상태 값 검사. 목록은 packages/contracts/src/migration.ts MIGRATION_STATUSES 와 같아야 한다 (tools/db-lint.sh 가 비교)
ALTER TABLE migrations
  ADD CONSTRAINT migrations_status_check CHECK (status IN (
    'draft','importing','spec_review','prechecking','planning','awaiting_approval','approved',
    'provisioning','deploying','syncing','shifting','cutover','rollback_window','cleanup','completed',
    'paused','rolling_back','rolled_back','failed','cancelled','rejected','stale')) NOT VALID,
  ADD CONSTRAINT migrations_paused_from_check CHECK (paused_from IS NULL OR paused_from IN (
    'draft','importing','spec_review','prechecking','planning','awaiting_approval','approved',
    'provisioning','deploying','syncing','shifting','cutover','rollback_window','cleanup','completed',
    'paused','rolling_back','rolled_back','failed','cancelled','rejected','stale')) NOT VALID,
  ADD CONSTRAINT migrations_failed_at_status_check CHECK (failed_at_status IS NULL OR failed_at_status IN (
    'draft','importing','spec_review','prechecking','planning','awaiting_approval','approved',
    'provisioning','deploying','syncing','shifting','cutover','rollback_window','cleanup','completed',
    'paused','rolling_back','rolled_back','failed','cancelled','rejected','stale')) NOT VALID,
  -- 출발 = 도착 이전은 DB도 거부한다 (API 검사가 빠져도 막히게)
  ADD CONSTRAINT migrations_source_ne_target CHECK (source_env_id <> target_env_id) NOT VALID;

-- 목록은 packages/contracts/src/environment.ts ConnectionStatus 와 같아야 한다
ALTER TABLE environments
  ADD CONSTRAINT environments_connection_status_check CHECK (connection_status IN (
    'draft','awaiting_customer','verifying','connected','unstable','failed','expired','disconnected')) NOT VALID;

-- 2. temp_credentials(0009) 는 migration_id 만 묶고 env_id 는 묶지 않았다.
--    0005 에서 고친 것과 같은 구멍(외래 키는 회사 벽을 거치지 않음)이라 회사 번호까지 같이 묶는다
ALTER TABLE temp_credentials
  ADD CONSTRAINT temp_credentials_mig_same_tenant
    FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id) NOT VALID,
  ADD CONSTRAINT temp_credentials_env_same_tenant
    FOREIGN KEY (env_id, tenant_id) REFERENCES environments (id, tenant_id) NOT VALID,
  ADD CONSTRAINT temp_credentials_provider_check
    CHECK (provider IN ('aws','gcp','onprem','azure_mock')) NOT VALID;

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conrelid::regclass AS t, conname FROM pg_constraint
            WHERE NOT convalidated AND connamespace = 'public'::regnamespace
              AND conname IN ('migrations_status_check','migrations_paused_from_check',
                              'migrations_failed_at_status_check','migrations_source_ne_target',
                              'environments_connection_status_check','temp_credentials_mig_same_tenant',
                              'temp_credentials_env_same_tenant','temp_credentials_provider_check') LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.t, c.conname);
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE NOTICE 'Z9: % 의 기존 줄이 % 를 어김. 새 줄만 막는다. 정리 뒤 VALIDATE 다시', c.t, c.conname;
    END;
  END LOOP;
END $$;

-- 3. 자주 쓰는 조회 인덱스 (측정: notes/skeleton/parallel/Z9/CHANGES.md "EXPLAIN")
-- 감사 체인 머리 찾기: audit.ts "ORDER BY seq DESC LIMIT 1" 이 회사 벽 조건(tenant_id=…)과 함께 돈다.
-- PK 만 있으면 다른 회사 줄을 뒤에서부터 훑는다 (조용한 회사일수록 느림, 회사별 advisory lock 안이라 줄이 선다)
CREATE INDEX audit_events_tenant_seq ON audit_events (tenant_id, seq);
-- GET /migrations 목록: 회사 벽 + ORDER BY updated_at DESC LIMIT 50
CREATE INDEX migrations_tenant_updated ON migrations (tenant_id, updated_at DESC);
-- loadLatestApproval: WHERE migration_id = … ORDER BY created_at DESC LIMIT 1
CREATE INDEX plan_approvals_migration ON plan_approvals (migration_id, created_at DESC);
-- 환경 목록: 회사 벽 + ORDER BY name
CREATE INDEX environments_tenant_name ON environments (tenant_id, name);

-- 4. tenants 회사 벽 (U 의 "알려진 한계 T-DB-4": 다른 회사 이름이 보임)
--    앱 코드는 tenants 를 읽지 않는다. 주인(시험의 회사 만들기)은 막지 않게 FORCE 는 켜지 않는다
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Down Migration
-- DROP POLICY tenant_self ON tenants; ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
-- DROP INDEX environments_tenant_name, plan_approvals_migration, migrations_tenant_updated, audit_events_tenant_seq;
-- ALTER TABLE temp_credentials DROP CONSTRAINT temp_credentials_provider_check,
--   DROP CONSTRAINT temp_credentials_env_same_tenant, DROP CONSTRAINT temp_credentials_mig_same_tenant;
-- ALTER TABLE environments DROP CONSTRAINT environments_connection_status_check;
-- ALTER TABLE migrations DROP CONSTRAINT migrations_source_ne_target, DROP CONSTRAINT migrations_failed_at_status_check,
--   DROP CONSTRAINT migrations_paused_from_check, DROP CONSTRAINT migrations_status_check;
