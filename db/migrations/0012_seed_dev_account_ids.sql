-- 0012 (작업 Z9, DRAFT(ai) 결정 "시드 환경에 가짜 account_id"): 개발용 환경 셋에 가짜 계정 번호를 채운다
-- 진짜 계정이 아니다. 111122223333 은 AWS 문서 예시 번호, stub-project / stub-subscription 은 만든 이름
-- 이미 값이 있으면 건드리지 않는다 (맥에서 손으로 넣은 값 보존)
-- forward-only: 되돌리기 = 아래 Down Migration
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', false);
UPDATE environments SET account_id = '111122223333'
 WHERE id = '22222222-2222-4222-8222-222222222222' AND account_id IS NULL;
UPDATE environments SET account_id = 'stub-project'
 WHERE id = '33333333-3333-4333-8333-333333333333' AND account_id IS NULL;
UPDATE environments SET account_id = 'stub-subscription'
 WHERE id = '44444444-4444-4444-8444-444444444444' AND account_id IS NULL;
SELECT set_config('app.tenant_id', '', false);

-- Down Migration
-- UPDATE environments SET account_id = NULL WHERE id IN ('22222222-2222-4222-8222-222222222222',
--   '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444');
