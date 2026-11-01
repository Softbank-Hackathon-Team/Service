-- 개발용 온프레(k3d) 도착 환경 하나 (고정 번호). smoke 는 SMOKE_TARGET_ENV_ID=55555555-5555-4555-8555-555555555555 로 고른다
-- 0016 (4차, 맥 발견: onprem 도착 환경 시드가 없었다). 0008 형식. 이미 있으면 건드리지 않는다 (재실행 안전)
-- Z9: 주인이 슈퍼유저가 아니어도 FORCE RLS를 통과하게 이 파일 안에서만 회사 표시
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', false);
INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
 ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', 'onprem', 'dev-onprem-k3d', 'connected')
ON CONFLICT (id) DO NOTHING;
SELECT set_config('app.tenant_id', '', false);

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DELETE FROM environments WHERE id = '55555555-5555-4555-8555-555555555555';  (회사 표시 필요)
