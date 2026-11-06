-- 0055: 환경 권한 묶음 확인 결과 (PERM-GATE). api 는 클라우드 권한이 없으니 확인은 worker 가 관찰 역할을 빌려 하고 결과를 여기에 둔다
--   api = 줄을 읽고(환경 화면 "권한 갱신 필요"), [다시 확인]이면 requested_at 을 찍고 permission-check 작업을 넣는다 / worker = result·checked_at 을 쓴다
--   환경당 1줄 덮어쓰기 (0051 environment_inventory 와 같은 모양). 이전 사전 점검의 막힘은 이 표가 아니라 그 전이 detail 에 남는다
-- DRAFT(ai): 번호 0055 (main 마지막 0054)
CREATE TABLE environment_permissions (
  environment_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  result jsonb,                       -- contracts StoredPermissionCheck. 첫 확인이 끝나기 전엔 NULL
  requested_at timestamptz,           -- api 가 마지막으로 확인을 요청한 때
  checked_at timestamptz,             -- worker 가 마지막으로 결과를 쓴 때. requested_at 이 더 새것이면 확인 중
  FOREIGN KEY (environment_id, tenant_id) REFERENCES environments (id, tenant_id)
);

ALTER TABLE environment_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE environment_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON environment_permissions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON environment_permissions TO app_user;

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TABLE environment_permissions;
