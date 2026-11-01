-- 0004: 계획서와 승인 기록
-- 승인(awaiting_approval → approved)의 조건 "계획 지문 일치 + 만료 전"을 DB에서 다시 확인하려고 둔다

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),       -- PlanDoc.planId
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  migration_id uuid NOT NULL REFERENCES migrations(id),
  plan_doc jsonb NOT NULL,                             -- PlanDoc 전체
  plan_hash text NOT NULL,                             -- PlanDoc.planHash
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'rejected', 'stale', 'superseded')),
  expires_at timestamptz NOT NULL,                     -- PlanDoc.expiresAt (승인 유효 기한)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_migration ON plans (migration_id, created_at DESC);

-- 승인 기록은 한 계획에 한 번. 넣기·읽기만 (감사 기록처럼 고치거나 지우지 않는다)
CREATE TABLE plan_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  migration_id uuid NOT NULL REFERENCES migrations(id),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  approved_by text NOT NULL,                           -- actor 값 (user:<id>)
  plan_hash text NOT NULL,                             -- 사람이 본 계획 지문
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'plan_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_wall ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON plans TO app_user;
GRANT SELECT, INSERT ON plan_approvals TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DROP TABLE plan_approvals, plans;
