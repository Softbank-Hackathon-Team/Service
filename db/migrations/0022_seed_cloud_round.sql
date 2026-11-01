-- 0021 (Z77, Z62 주제 66): 실클라우드 회차 전용 회사 하나와 환경 셋 (고정 번호). 로컬 smoke·데모(회사 1111…)와 환경 잠금이 안 겹친다
--   회사 66666666…, 출발 onprem 77777777…, 도착 gcp 88888888…, 도착 aws 99999999…
--   smoke 는 SMOKE_TENANT_ID=66666666-6666-4666-8666-666666666666 SMOKE_SOURCE_ENV_ID=77777777-… SMOKE_TARGET_ENV_ID=88888888-… 로 고른다
-- account_id 는 0012 와 같은 가짜 값 (진짜 계정 아님). 이미 있으면 건드리지 않는다 (재실행 안전)
SELECT set_config('app.tenant_id', '66666666-6666-4666-8666-666666666666', false);
INSERT INTO tenants (id, name) VALUES ('66666666-6666-4666-8666-666666666666', 'cloud-round')
ON CONFLICT (id) DO NOTHING;
INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES
 ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666', 'onprem', 'cloud-round-onprem-k3d', 'connected', NULL),
 ('88888888-8888-4888-8888-888888888888', '66666666-6666-4666-8666-666666666666', 'gcp', 'cloud-round-gcp', 'connected', 'stub-project'),
 ('99999999-9999-4999-8999-999999999999', '66666666-6666-4666-8666-666666666666', 'aws', 'cloud-round-aws', 'connected', '111122223333')
ON CONFLICT (id) DO NOTHING;
SELECT set_config('app.tenant_id', '', false);

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DELETE FROM environments WHERE id IN ('77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999999');  (회사 표시 필요)
-- DELETE FROM tenants WHERE id = '66666666-6666-4666-8666-666666666666';
