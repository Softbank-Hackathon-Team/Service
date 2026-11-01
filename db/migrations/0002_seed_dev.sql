-- 개발용 회사 하나와 환경 둘 (고정 번호라 smoke 시험이 바로 쓴다)
-- Z9: 주인이 슈퍼유저가 아니면 FORCE RLS 때문에 회사 표시 없이는 environments에 못 넣는다. 이 파일 안에서만 표시한다
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', false);
INSERT INTO tenants (id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'dev-company');
INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
 ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'aws', 'dev-aws', 'connected'),
 ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'gcp', 'dev-gcp', 'connected');
SELECT set_config('app.tenant_id', '', false);

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DELETE FROM environments WHERE id IN ('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333');
-- DELETE FROM tenants WHERE id = '11111111-1111-4111-8111-111111111111';  (회사 표시 필요: set_config('app.tenant_id', …))
