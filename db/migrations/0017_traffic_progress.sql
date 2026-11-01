-- 트래픽 전환 진행 (z75-38). 이전 하나에 한 줄. 워커 shift 가 판정마다(최대 초당 1번) 덮어쓰고, 화면은 GET /migrations/:id/traffic-shift 로 읽는다
-- 목표 가중치와 실측 도착 몫(지표 창의 도착 요청 수 / 전체, % 정수)을 같이 둔다. 감사 사슬(audit_events)에는 안 넣는다: 판정마다 쓰면 줄이 너무 많고 회사 잠금을 오래 쥔다
-- 상태 판단에는 안 쓴다 (표시용). 판단은 워커 메모리 안의 runShift 가 하고 결과는 shift 감사 detail.stepShares 에 남는다
CREATE TABLE traffic_progress (
  migration_id     uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  target_pct       int  NOT NULL CHECK (target_pct BETWEEN 0 AND 100),
  observed_pct     int  CHECK (observed_pct BETWEEN 0 AND 100),
  reached          boolean,
  tolerance_pct    int  NOT NULL,
  reobserve        int  NOT NULL DEFAULT 0,
  step_started_at  timestamptz NOT NULL,
  observed_at      timestamptz NOT NULL,
  FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id)
);

ALTER TABLE traffic_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE traffic_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON traffic_progress
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON traffic_progress TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TABLE traffic_progress;  (표시용이라 지워도 상태·감사는 그대로)
