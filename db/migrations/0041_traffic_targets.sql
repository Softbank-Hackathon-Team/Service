-- 0041 (PF TRF-21): 이전마다 트래픽 LB 자리. 예전엔 워커 전역 .env 4줄(TRAFFIC_LB_ID·CLOUDFLARE_SOURCE/TARGET_POOL_ID·ZONE)을
--   이전마다 손으로 바꾸고 워커를 다시 띄웠다. 이 표에 줄이 있으면 워커(shift·rollback)가 이 값을 쓰고, 없으면 예전처럼 .env.
-- 줄을 채우는 쪽: 트래픽 영역의 LB 확인·등록(cf-check) — 오케는 읽기와 자리만 둔다
-- DRAFT(ai): 한 이전 = 한 LB 자리 (출발 풀 1, 도착 풀 1). 환경별 여러 LB 는 아직 없음
CREATE TABLE migration_traffic_targets (
  migration_id   uuid PRIMARY KEY REFERENCES migrations (id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL,
  provider       text NOT NULL CHECK (provider IN ('cloudflare', 'gcp_gclb', 'aws_alb', 'mock')),
  lb_id          text NOT NULL CHECK (length(lb_id) BETWEEN 1 AND 200),
  source_pool_id text CHECK (length(source_pool_id) <= 200),
  target_pool_id text CHECK (length(target_pool_id) <= 200),
  zone_id        text CHECK (length(zone_id) <= 200),
  registered_by  text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX migration_traffic_targets_tenant ON migration_traffic_targets (tenant_id);

ALTER TABLE migration_traffic_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_traffic_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON migration_traffic_targets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON migration_traffic_targets TO app_user;

-- forward-only: 되돌리기는 사람이 직접
-- Down Migration
-- DROP TABLE migration_traffic_targets;
