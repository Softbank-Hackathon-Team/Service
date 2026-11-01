-- 0018 (Z92): 온프레 Agent 보고 받기. Agent 키 표 + 받은 보고 표
-- 0017 = z75-38 traffic_progress (8차 묶음). 이 파일은 0017 과 겹치는 표·칸이 없어 순서만 뒤에 둔다
-- 설계: Agent 는 k3s 안에서 밖으로 POST /api/v1/agent/reports 를 보낸다 (온프레는 밖에서 들어갈 길이 없다)
--   서명 = HMAC-SHA256(키 비밀, "<시각>.<본문>"). 키 비밀은 DB 에 두지 않는다:
--   키 비밀 = HMAC-SHA256(AGENT_REPORT_MASTER_KEY, "agent-key:<키 번호>") → 서버는 .env 한 값으로 매번 다시 만든다.
--   DB 가 새어도 키 번호·회사·환경만 보이고 서명은 못 만든다

-- 1. Agent 키 (키 하나 = 회사 하나 + 온프레 환경 하나). 회사·환경은 본문이 아니라 이 줄에서 정한다
CREATE TABLE agent_keys (
  id text PRIMARY KEY CHECK (id ~ '^ak_[A-Za-z0-9]{16,40}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  env_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  -- 0005 와 같은 방식: 환경은 같은 회사 것만 (남의 회사 환경 번호를 키에 묶지 못한다)
  FOREIGN KEY (env_id, tenant_id) REFERENCES environments (id, tenant_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX agent_keys_env ON agent_keys (tenant_id, env_id);

-- 2. 받은 보고. 넣기·읽기만 (감사 기록처럼 고치거나 지우지 않는다)
CREATE TABLE agent_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  env_id uuid NOT NULL,
  key_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('security', 'deploy', 'heartbeat')),
  signature text NOT NULL,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  migration_id uuid,
  body jsonb NOT NULL,
  FOREIGN KEY (key_id, tenant_id) REFERENCES agent_keys (id, tenant_id),
  FOREIGN KEY (env_id, tenant_id) REFERENCES environments (id, tenant_id),
  -- deploy 보고의 이전 번호도 같은 회사 것만. 없는 번호면 23503 → API 404 (errors 플러그인)
  FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id)
);
-- 재전송 막기: 같은 키의 같은 서명(= 같은 시각 + 같은 본문)은 한 번만 들어간다. 5분 시각 창과 합쳐 재전송이 막힌다
CREATE UNIQUE INDEX agent_reports_replay ON agent_reports (key_id, signature);
CREATE INDEX agent_reports_env_kind ON agent_reports (tenant_id, env_id, kind, received_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_keys', 'agent_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_wall ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- 키 발급·폐기는 사람 도구(tools/agent-key.ts)가 그 회사의 withTenant 안에서 한다. 지우지 않고 revoked_at 만 찍는다
GRANT SELECT, INSERT, UPDATE (revoked_at) ON agent_keys TO app_user;
GRANT SELECT, INSERT ON agent_reports TO app_user;

-- 3. 키 찾기. 보고가 올 때는 아직 회사 번호를 모른다 (회사는 키가 정한다).
--    0003 청소 함수와 같은 방식: svc_maintenance 가 주인인 SECURITY DEFINER 함수 하나만 연다.
--    번호 하나를 넣으면 그 키의 회사·환경·폐기 여부만 돌려준다 (목록 보기 없음). 실제 넣기는 그 회사의 withTenant 안에서
GRANT SELECT ON agent_keys TO svc_maintenance;
CREATE POLICY maintenance_read ON agent_keys FOR SELECT TO svc_maintenance USING (true);
CREATE FUNCTION agent_key_lookup(key_id text)
RETURNS TABLE (tenant_id uuid, env_id uuid, revoked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.tenant_id, k.env_id, k.revoked_at IS NOT NULL FROM agent_keys k WHERE k.id = key_id
$$;
GRANT CREATE ON SCHEMA public TO svc_maintenance;
ALTER FUNCTION agent_key_lookup(text) OWNER TO svc_maintenance;
REVOKE CREATE ON SCHEMA public FROM svc_maintenance;
REVOKE ALL ON FUNCTION agent_key_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_key_lookup(text) TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP FUNCTION agent_key_lookup(text); DROP TABLE agent_reports, agent_keys;
