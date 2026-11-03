-- 0030 (L6fix): 같은 환경에 새 등록 토큰을 발급하면 쓰지 않은 옛 토큰을 같은 트랜잭션에서 끝낸다 (expires_at = now())
--   발급 경로가 그 회사의 withTenant 안에서 UPDATE 하므로 app_user 에게 expires_at 열 UPDATE 만 더 연다 (RLS tenant_wall 이 그대로 막음)
-- DRAFT(ai): 번호 0030 은 로컬 통합용 고정. PR 때 머지 순서대로 다시 매긴다
GRANT UPDATE (expires_at) ON agent_enroll_tokens TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- REVOKE UPDATE (expires_at) ON agent_enroll_tokens FROM app_user;
