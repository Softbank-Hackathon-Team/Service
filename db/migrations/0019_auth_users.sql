-- 0018 (Z93): 진짜 로그인. 사용자 표 + 로그인 세션(리프레시 토큰) 표 + 로그인 전 조회 함수 2개
-- 0017 은 z75-38(traffic_progress). 이 파일은 0017 이 있든 없든 독립이다 (표·이름 안 겹침)
--
-- 왜 함수가 필요한가
--   로그인할 때는 아직 회사 번호를 모른다. 그런데 users·auth_sessions 는 회사 벽(RLS)이 걸려 있어서
--   app_user 는 회사 표시 없이 한 줄도 못 본다. 그래서 "이메일로 사용자 한 명 찾기"와 "세션 번호로 세션 한 줄 찾기"만
--   SECURITY DEFINER 함수 2개로 연다. 함수 주인은 로그인 못 하는 역할 svc_auth 이고,
--   그 역할에만 "벽 없이 읽기" 정책(auth_lookup)을 준다. app_user 는 svc_auth 가 될 수 없다(멤버 아님).
--   출처: PostgreSQL 16 문서 CREATE POLICY(정책은 TO 역할별), CREATE FUNCTION "Writing SECURITY DEFINER Functions Safely"(search_path 고정)
--
-- 비밀번호 원문·리프레시 토큰 원문은 저장하지 않는다
--   users.password_hash      = scrypt$N$r$p$소금$해시 (앱이 node:crypto scrypt 로 만든다, OWASP Password Storage Cheat Sheet)
--   auth_sessions.refresh_hash = sha256(토큰 비밀 부분) hex. DB 가 새도 토큰을 다시 만들 수 없다
--
-- 시드: 개발 회사(1111…)에 데모 계정 1개. 비밀번호 칸은 비워 둔다(= 로그인 불가).
--   비밀번호는 .env 의 DEMO_USER_PASSWORD 로 `npm run auth:seed` 가 넣는다. 마이그레이션 파일에 비밀번호·해시를 쓰지 않는다

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_auth') THEN
    CREATE ROLE svc_auth NOLOGIN;
  END IF;
  -- 함수 주인을 svc_auth 로 넘기려면 지금 계정이 그 역할로 SET ROLE 할 수 있어야 한다 (0001 의 app_user 와 같은 방식)
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AND NOT pg_has_role(current_user, 'svc_auth', 'MEMBER') THEN
    EXECUTE format('GRANT svc_auth TO %I', current_user);
  END IF;
END $$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  display_name text,
  password_hash text,
  password_changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  -- 이메일은 소문자로만 저장한다 (조회도 소문자). 대소문자만 다른 두 계정이 생기지 않게
  CONSTRAINT users_email_shape CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND length(email) <= 254),
  CONSTRAINT users_hash_shape CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%'),
  -- 세션 표가 (user_id, tenant_id) 를 같이 가리키게 (0005 environments_id_tenant 와 같은 방식: 남의 회사 사용자를 못 가리킨다)
  CONSTRAINT users_id_tenant UNIQUE (id, tenant_id)
);
-- DRAFT(ai) Z93: 이메일은 전체에서 하나 = 사용자 한 명은 회사 하나 (역할 없음 결정과 같은 단순한 모양).
--   대안: memberships(user, tenant) 표로 한 사람이 여러 회사. 로그인 뒤 회사 고르기 화면이 필요해 결선 뒤로
CREATE UNIQUE INDEX users_email_uq ON users (email);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  -- 한 번 로그인에서 리프레시로 이어진 묶음. 이미 바꾼(rotated) 토큰이 다시 오면 묶음 전체를 끊는다 (OWASP: refresh token reuse detection)
  family_id uuid NOT NULL,
  family_started_at timestamptz NOT NULL DEFAULT now(),
  refresh_hash text NOT NULL CHECK (refresh_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('rotated', 'logout', 'reuse', 'disabled')),
  user_agent text,
  CONSTRAINT auth_sessions_user FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT auth_sessions_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX auth_sessions_family ON auth_sessions (family_id);
CREATE INDEX auth_sessions_user_live ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- 회사 벽 (0001 tenant_wall 과 같은 식). 표 주인에게도 강제
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON users
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_wall ON auth_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- 로그인 전 조회 전용: svc_auth 역할만, 읽기만, 벽 없이
CREATE POLICY auth_lookup ON users FOR SELECT TO svc_auth USING (true);
CREATE POLICY auth_lookup ON auth_sessions FOR SELECT TO svc_auth USING (true);

-- 앱 계정: 회사 안에서만. 사용자 만들기·지우기는 앱에 안 준다 (도구 auth:seed 는 주인 계정으로 넣는다)
GRANT SELECT ON users TO app_user;
GRANT UPDATE (password_hash, password_changed_at, display_name, disabled_at) ON users TO app_user;
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO app_user;
GRANT SELECT ON users, auth_sessions TO svc_auth;

-- 이메일 → 사용자 한 명 (회사 번호·해시 포함). 없으면 0줄
CREATE FUNCTION auth_login_lookup(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, email text, display_name text, password_hash text, disabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.email, u.display_name, u.password_hash, u.disabled_at IS NOT NULL
    FROM public.users u
   WHERE u.email = lower(p_email)
$$;

-- 세션 번호 → 세션 한 줄 (리프레시 토큰 확인용). 없으면 0줄
CREATE FUNCTION auth_session_lookup(p_id uuid)
RETURNS TABLE (tenant_id uuid, user_id uuid, family_id uuid, family_started_at timestamptz, refresh_hash text,
               expires_at timestamptz, revoked_at timestamptz, revoked_reason text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.tenant_id, s.user_id, s.family_id, s.family_started_at, s.refresh_hash, s.expires_at, s.revoked_at, s.revoked_reason
    FROM public.auth_sessions s
   WHERE s.id = p_id
$$;

REVOKE ALL ON FUNCTION auth_login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_session_lookup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login_lookup(text) TO app_user;
GRANT EXECUTE ON FUNCTION auth_session_lookup(uuid) TO app_user;
-- 주인 넘기기: 새 주인은 스키마에 CREATE 가 있어야 한다(PG 문서 ALTER FUNCTION). 넘긴 뒤 바로 거둔다
GRANT CREATE ON SCHEMA public TO svc_auth;
ALTER FUNCTION auth_login_lookup(text) OWNER TO svc_auth;
ALTER FUNCTION auth_session_lookup(uuid) OWNER TO svc_auth;
REVOKE CREATE ON SCHEMA public FROM svc_auth;
GRANT USAGE ON SCHEMA public TO svc_auth;

-- 데모 계정 (비밀번호 없음 = 로그인 불가. npm run auth:seed 가 .env 값으로 넣는다)
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', false);
INSERT INTO users (id, tenant_id, email, display_name) VALUES
 ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', 'demo@dev-company.test', '데모 사용자')
ON CONFLICT (id) DO NOTHING;
SELECT set_config('app.tenant_id', '', false);

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP FUNCTION auth_session_lookup(uuid); DROP FUNCTION auth_login_lookup(text);
-- DROP TABLE auth_sessions; DROP TABLE users;
-- (역할 svc_auth 는 클러스터 전체에 하나라 다른 DB 가 쓸 수 있다. 다 지운 뒤에만 DROP ROLE svc_auth)
