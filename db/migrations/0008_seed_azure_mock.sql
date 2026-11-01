-- 개발용 Azure Mock 도착 환경 하나 (고정 번호). 실제 Azure 계정 없음: 워커가 AZURE_MOCK=1 이면 Mock 실행기로 apply 한다
-- 0008 (원래 작업 X의 0007, 통합 번호)
-- Z9: 주인이 슈퍼유저가 아니어도 FORCE RLS를 통과하게 이 파일 안에서만 회사 표시
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', false);
INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
 ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 'azure_mock', 'dev-azure-mock', 'connected');
SELECT set_config('app.tenant_id', '', false);

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DELETE FROM environments WHERE id = '44444444-4444-4444-8444-444444444444';  (회사 표시 필요)
