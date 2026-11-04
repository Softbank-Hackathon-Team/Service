-- 0045: 환경별 지표 토큰. 고객 수집기가 OTel 게이트웨이에 지표를 밀 때 쓴다 (원문은 발급 응답에 한 번만, DB 에는 sha256 hex 만)
-- 게이트웨이는 회사 번호를 아직 모르므로 해시로 찾는 SECURITY DEFINER 함수 하나만 쓴다 (0028 과 같은 방식)

CREATE TABLE metric_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  env_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (env_id, tenant_id) REFERENCES environments (id, tenant_id)
);
-- 환경마다 살아 있는 토큰은 하나
CREATE UNIQUE INDEX metric_tokens_active ON metric_tokens (env_id) WHERE revoked_at IS NULL;

ALTER TABLE metric_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON metric_tokens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- 앱 계정: 넣기·읽기, 끊기(revoked_at)만 고친다
GRANT SELECT, INSERT ON metric_tokens TO app_user;
GRANT UPDATE (revoked_at) ON metric_tokens TO app_user;
GRANT SELECT ON metric_tokens TO svc_auth;
CREATE POLICY auth_lookup ON metric_tokens FOR SELECT TO svc_auth USING (true);

-- 해시 → 살아 있는 토큰의 회사·환경. 없거나 끊겼으면 0줄
CREATE FUNCTION metric_token_lookup(p_hash text)
RETURNS TABLE (tenant_id uuid, env_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.tenant_id, t.env_id
    FROM public.metric_tokens t
   WHERE t.token_hash = p_hash AND t.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION metric_token_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metric_token_lookup(text) TO app_user;
GRANT CREATE ON SCHEMA public TO svc_auth;
ALTER FUNCTION metric_token_lookup(text) OWNER TO svc_auth;
REVOKE CREATE ON SCHEMA public FROM svc_auth;
GRANT USAGE ON SCHEMA public TO svc_auth;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP FUNCTION metric_token_lookup(text); DROP TABLE metric_tokens;
