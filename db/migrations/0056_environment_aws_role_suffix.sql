-- 0056 (한 AWS 계정에 환경 여럿): 고객 연결 역할 이름 꼬리
--   environments.aws_role_suffix : 연결 템플릿 매개변수 RoleSuffix 로 넘긴 값. 역할·정책 이름 = svc-observe<꼬리>·svc-operate<꼬리>·
--                                  svc-deploy<꼬리>·svc-operate-policy<꼬리>. 모양 = "-" + 환경 번호 앞 8자(16진) (contracts awsRoleSuffixFor)
--   NULL = 옛 환경 (꼬리 없는 고정 이름). 이미 연결된 환경은 NULL 그대로라 고객 스택·플랫폼 동작이 바뀌지 않는다
--   값은 api 연결 링크가 확인 문구(external_id)를 새로 만들 때만 적는다. 같은 문구를 다시 쓰는 링크(고객 대기·실패·만료)는 칸을 그대로 둔다
--   (이미 옛 이름으로 스택을 만들었을 수 있어서)
-- 왜 새 칸인가: 환경 번호에서 바로 계산하면 옛 환경도 꼬리가 붙어 옛 스택 역할을 못 찾는다. 있는 칸(external_id·verify_detail)은 뜻이 달라
--   "이 환경 스택은 어느 이름 규칙으로 만들었나"를 따로 적는다
-- 권한: app_user 는 environments SELECT·UPDATE (0001) 이미 있음 → 추가 GRANT 없음. RLS 는 environments 표의 tenant_wall 그대로 (줄 단위라 칸 추가에 영향 없음)
-- 더하기만 (기본값 없음 → 기존 줄은 NULL, 표 다시 쓰기 없음)
ALTER TABLE environments ADD COLUMN aws_role_suffix text
  CHECK (aws_role_suffix ~ '^-[0-9a-f]{8}$');
ALTER TABLE environments ADD CONSTRAINT environments_aws_role_suffix_aws_only
  CHECK (aws_role_suffix IS NULL OR provider = 'aws');

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- ALTER TABLE environments DROP CONSTRAINT environments_aws_role_suffix_aws_only;
-- ALTER TABLE environments DROP COLUMN aws_role_suffix;
