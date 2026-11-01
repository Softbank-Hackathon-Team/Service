-- 실제 LLM 응답 캐시 (z75-59). 같은 회사·같은 모델·같은 요청(sha256 열쇠)이면 저장한 응답을 돌려준다. 가짜 결과가 아니라 실제 API 가 낸 응답만 넣는다
-- 번호 0020 (0018 = Z92 agent_reports, 0019 = Z93 auth_users, Z38b 지정)
-- 응답에 비밀은 없다: agent-worker 는 도구 입력·결과를 이미 가린(redact) 뒤 LLM 에 보낸다. 그래도 회사 벽(RLS) 안에 둔다
-- 데모 초기화(tools/demo-reset.sh)는 이 표를 지우지 않는다 (외래 키도 없음). 기한(기본 24시간) 지난 줄은 넣을 때 지운다
CREATE TABLE agent_llm_cache (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  key          text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  model        text NOT NULL,
  response     jsonb NOT NULL,
  hits         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_hit_at  timestamptz,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX agent_llm_cache_expires ON agent_llm_cache (tenant_id, expires_at);

ALTER TABLE agent_llm_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_llm_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON agent_llm_cache
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 지난 줄 지우기 때문에 DELETE 도 준다 (쌓기 전용 표가 아니다)
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_llm_cache TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TABLE agent_llm_cache;  (캐시라 지워도 다음 호출이 실제 API 로 다시 만든다)
