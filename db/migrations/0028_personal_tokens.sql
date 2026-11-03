-- 0028 (L8b): CLI 개인 토큰. 토큰 원문은 만들 때 한 번만 보여 주고 DB 에는 sha256 hex 만 둔다 (DB 가 새도 토큰을 다시 못 만든다)
-- DRAFT(ai) L8b: 번호 0028 은 로컬 통합용 고정. PR 때 머지 순서대로 다시 매긴다
-- 설계: IA 3·7.1 MUST 최소. 범위는 "만든 사용자와 같음" 하나 (범위 지정은 후속)
--   인증 훅은 회사 번호를 아직 모르므로 해시로 찾는 SECURITY DEFINER 함수 하나만 쓴다 (0019 와 같은 방식)

CREATE TABLE personal_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX personal_tokens_user ON personal_tokens (tenant_id, user_id);

ALTER TABLE personal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON personal_tokens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- 앱 계정: 넣기·읽기, 끊기(revoked_at)만 고친다
GRANT SELECT, INSERT ON personal_tokens TO app_user;
GRANT UPDATE (revoked_at) ON personal_tokens TO app_user;
GRANT SELECT ON personal_tokens TO svc_auth;
CREATE POLICY auth_lookup ON personal_tokens FOR SELECT TO svc_auth USING (true);

-- 해시 → 토큰 한 줄. 없으면 0줄
CREATE FUNCTION auth_token_lookup(p_hash text)
RETURNS TABLE (token_id uuid, tenant_id uuid, user_id uuid, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id, t.tenant_id, t.user_id, t.expires_at, t.revoked_at
    FROM public.personal_tokens t
   WHERE t.token_hash = p_hash
$$;
REVOKE ALL ON FUNCTION auth_token_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_token_lookup(text) TO app_user;
GRANT CREATE ON SCHEMA public TO svc_auth;
ALTER FUNCTION auth_token_lookup(text) OWNER TO svc_auth;
REVOKE CREATE ON SCHEMA public FROM svc_auth;
GRANT USAGE ON SCHEMA public TO svc_auth;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP FUNCTION auth_token_lookup(text); DROP TABLE personal_tokens;
