-- 처음 DB가 만들어질 때 한 번 실행된다 (docker 초기화 폴더)
-- 표 주인 = platform_owner, 앱 = app_user (회사 벽 적용)
-- Z9: 역할은 클러스터 전체에 하나다. 같은 클러스터에 DB가 둘 이상이면(시험 DB, lint) 두 번째에서 깨지지 않게 있으면 건너뛴다
-- 비밀번호 app_pw는 로컬 개발용. 클라우드는 만든 뒤 비밀 저장소 값으로 ALTER ROLE 한다
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pw';
  END IF;
  -- 슈퍼유저가 아닌 주인(RDS·CloudNativePG의 앱 소유자)은 이 역할 멤버여야 소유권 넘기기·AUTHORIZATION이 된다
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT app_user TO %I', current_user);
  END IF;
END $$;
CREATE SCHEMA pgboss AUTHORIZATION app_user;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL CHECK (provider IN ('aws','gcp','onprem','azure_mock')),
  name text NOT NULL,
  connection_status text NOT NULL DEFAULT 'draft',
  external_id text,
  account_id text,
  last_verified_at timestamptz
);

CREATE TABLE migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_env_id uuid NOT NULL REFERENCES environments(id),
  target_env_id uuid NOT NULL REFERENCES environments(id),
  status text NOT NULL DEFAULT 'draft',
  version int NOT NULL DEFAULT 0,
  paused_from text,
  failed_at_status text,
  failure_code text,
  rollback_window_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE spec_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  migration_id uuid NOT NULL REFERENCES migrations(id),
  version int NOT NULL,
  spec jsonb NOT NULL,
  field_meta jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (migration_id, version)
);

CREATE TABLE env_locks (
  env_id uuid PRIMARY KEY REFERENCES environments(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  migration_id uuid NOT NULL REFERENCES migrations(id),
  holder text NOT NULL,            -- 'reserved' | 'worker:<id>'
  job_id uuid,
  lease_expires_at timestamptz NOT NULL
);

CREATE TABLE audit_events (
  seq bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  result text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL
);

-- 회사 벽: 모든 회사 표에 켜고, 표 주인에게도 강제한다
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['environments','migrations','spec_versions','env_locks','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_wall ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT ON tenants TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON environments, migrations, spec_versions, env_locks TO app_user;
-- 감사 기록은 넣기·읽기만 (고치기·지우기 불가)
GRANT SELECT, INSERT ON audit_events TO app_user;
GRANT USAGE ON SEQUENCE audit_events_seq_seq TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DROP TABLE audit_events, env_locks, spec_versions, migrations, environments, tenants;
-- DROP SCHEMA pgboss CASCADE;  (app_user 역할은 클러스터 공용이라 지우지 않는다)
