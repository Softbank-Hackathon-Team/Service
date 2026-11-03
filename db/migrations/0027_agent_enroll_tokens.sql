-- 0027 (입력층 L6): 온프레 일회용 등록 토큰. 사람이 10분짜리 토큰을 받아 고객 k3s 안 Agent 에 넘기면
-- Agent 가 POST /api/v1/agent/register 로 한 번 바꿔 Agent 키(agent_keys, 0018)를 받는다 (설계 IA 3·6.3)
-- 토큰 원문은 응답에 한 번만. DB 에는 sha256(hex) 만 둔다
CREATE TABLE agent_enroll_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  env_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  key_id text,                         -- 등록으로 만든 Agent 키 (추적용)
  FOREIGN KEY (env_id, tenant_id) REFERENCES environments (id, tenant_id),
  FOREIGN KEY (key_id, tenant_id) REFERENCES agent_keys (id, tenant_id)
);
CREATE INDEX agent_enroll_tokens_env ON agent_enroll_tokens (tenant_id, env_id);
CREATE INDEX agent_enroll_tokens_key ON agent_enroll_tokens (key_id, tenant_id) WHERE key_id IS NOT NULL;

ALTER TABLE agent_enroll_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_enroll_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON agent_enroll_tokens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 발급은 사람 경로가 그 회사의 withTenant 안에서. 등록 뒤 key_id 만 적는다 (지우지 않음)
GRANT SELECT, INSERT, UPDATE (key_id) ON agent_enroll_tokens TO app_user;

-- 토큰 쓰기. 등록 요청이 올 때는 아직 회사 번호를 모른다 (회사는 토큰이 정한다).
-- 0018 agent_key_lookup 과 같은 방식: svc_maintenance 가 주인인 SECURITY DEFINER 함수 하나만 연다.
-- 한 문장으로 "안 쓴 것 + 기한 안" 확인과 used_at 찍기를 같이 한다 → 같은 토큰 두 번은 둘째가 0줄
GRANT SELECT, UPDATE (used_at) ON agent_enroll_tokens TO svc_maintenance;
CREATE POLICY maintenance_read ON agent_enroll_tokens FOR SELECT TO svc_maintenance USING (true);
CREATE POLICY maintenance_consume ON agent_enroll_tokens FOR UPDATE TO svc_maintenance USING (true) WITH CHECK (true);
CREATE FUNCTION agent_enroll_consume(p_token_hash text)
RETURNS TABLE (token_id uuid, tenant_id uuid, env_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE agent_enroll_tokens t SET used_at = now()
   WHERE t.token_hash = p_token_hash AND t.used_at IS NULL AND t.expires_at > now()
  RETURNING t.id, t.tenant_id, t.env_id
$$;
GRANT CREATE ON SCHEMA public TO svc_maintenance;
ALTER FUNCTION agent_enroll_consume(text) OWNER TO svc_maintenance;
REVOKE CREATE ON SCHEMA public FROM svc_maintenance;
REVOKE ALL ON FUNCTION agent_enroll_consume(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_enroll_consume(text) TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP FUNCTION agent_enroll_consume(text); DROP TABLE agent_enroll_tokens;
