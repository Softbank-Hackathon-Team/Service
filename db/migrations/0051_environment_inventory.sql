-- 0051: 환경 실자원 조회 결과 (이슈 #242). api 는 클라우드 권한이 없으니 조회는 worker 가 관찰 역할을 빌려 하고, 결과를 여기에 둔다
--   api = 줄을 읽고, 없거나 오래됐으면 requested_at 을 찍고 inventory-refresh 작업을 넣는다 / worker = result·checked_at 을 쓴다
--   환경당 1줄 덮어쓰기. 이력은 안 남긴다 (DECISION(team): 2026-11-05 결정, 결과 보존 = 마지막 1개)
-- DRAFT(ai): 번호 0051. 0050 은 열린 온프레 복제 PR(0050_replication_endpoints)이 쓰고, 0048·0049 는 다른 작업이 예약해 건너뛴다. 머지 순서가 바뀌면 다시 매긴다
CREATE TABLE environment_inventory (
  environment_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  result jsonb,                       -- adapters CloudInventory. 첫 조회가 끝나기 전엔 NULL
  requested_at timestamptz,           -- api 가 마지막으로 조회를 요청한 때
  checked_at timestamptz,             -- worker 가 마지막으로 결과를 쓴 때. requested_at 이 더 새것이면 조회 중
  FOREIGN KEY (environment_id, tenant_id) REFERENCES environments (id, tenant_id)
);

ALTER TABLE environment_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE environment_inventory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON environment_inventory
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON environment_inventory TO app_user;

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TABLE environment_inventory;
