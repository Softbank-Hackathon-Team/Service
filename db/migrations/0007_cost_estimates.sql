-- 0007 (원래 작업 V의 0006, 통합 번호): 비용 추정 결과 저장 (DRAFT(ai), 작업 V 제안)
-- 계약: packages/contracts/src/cost.ts StoredCostEstimate
-- 쌓기만 한다(UPDATE 권한 없음). 같은 이전에 추정이 여러 번 생길 수 있다

CREATE TABLE cost_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  migration_id uuid NOT NULL,
  plan_id uuid,                                        -- 승인 화면에서 쓴 추정이면 계획 번호
  request jsonb NOT NULL,                              -- CostEstimateRequest
  estimate jsonb NOT NULL,                             -- CostEstimate
  price_as_of timestamptz NOT NULL,                    -- estimate.priceAsOf (찾기 쉽게 따로)
  price_sources jsonb NOT NULL DEFAULT '[]'::jsonb,    -- PriceSourceSummary[]
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_estimates_mig_same_tenant
    FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id),
  CONSTRAINT cost_estimates_plan_same_tenant
    FOREIGN KEY (plan_id, tenant_id) REFERENCES plans (id, tenant_id)
);
CREATE INDEX cost_estimates_migration ON cost_estimates (migration_id, created_at DESC);

ALTER TABLE cost_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_estimates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON cost_estimates
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON cost_estimates TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DROP TABLE cost_estimates;
