-- 0034 (GHLOGIN): GitHub OAuth 로그인. 사용자 ↔ GitHub 계정 연결 칸 + 로그인 전 조회 함수 1개
-- 이메일 로그인(0019)은 그대로다. 같은 users·auth_sessions 표를 쓰고, GitHub 로 들어와도 같은 세션(리프레시 토큰)을 만든다
--
-- github_id = GitHub 숫자 계정 번호(바뀌지 않음). 로그인 이름(login)·이메일은 바뀔 수 있어서 연결 키로 쓰지 않는다
--   처음 연결: 검증된 기본 이메일이 이미 있는 사용자의 이메일과 같을 때만 (앱 코드). 한 GitHub 계정은 사용자 한 명에만 (유일 인덱스)
-- 로그인 전에는 회사 번호를 모르므로 0019 의 auth_login_lookup 과 같은 방식(SECURITY DEFINER, 주인 svc_auth)으로 번호 → 사용자 한 줄만 연다

ALTER TABLE users ADD COLUMN github_id text;
ALTER TABLE users ADD CONSTRAINT users_github_id_shape CHECK (github_id IS NULL OR github_id ~ '^[0-9]{1,20}$');
CREATE UNIQUE INDEX users_github_id_uq ON users (github_id) WHERE github_id IS NOT NULL;

-- 앱 계정: 연결(한 번만: 이미 있으면 못 바꿈은 앱 SQL 의 IS NULL 조건) 과 새 사용자 만들기(GITHUB_SIGNUP_TENANT_ID 가 켜졌을 때만 앱이 부름).
--   만들기는 열 목록을 좁혔고 회사 벽(WITH CHECK)이 다른 회사에는 못 넣게 막는다. 비밀번호 칸은 못 넣는다
GRANT UPDATE (github_id) ON users TO app_user;
GRANT INSERT (id, tenant_id, email, display_name, github_id) ON users TO app_user;

CREATE FUNCTION auth_github_lookup(p_github_id text)
RETURNS TABLE (user_id uuid, tenant_id uuid, email text, display_name text, disabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.email, u.display_name, u.disabled_at IS NOT NULL
    FROM public.users u
   WHERE u.github_id = p_github_id
$$;
REVOKE ALL ON FUNCTION auth_github_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_github_lookup(text) TO app_user;
GRANT CREATE ON SCHEMA public TO svc_auth;
ALTER FUNCTION auth_github_lookup(text) OWNER TO svc_auth;
REVOKE CREATE ON SCHEMA public FROM svc_auth;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP FUNCTION auth_github_lookup(text); DROP INDEX users_github_id_uq; ALTER TABLE users DROP COLUMN github_id;
