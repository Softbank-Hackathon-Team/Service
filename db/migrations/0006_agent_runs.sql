-- 0006: AI 에이전트 실행 기록 (agent-run 큐 한 건 = 한 줄)
-- DRAFT(ai): 표 모양은 작업 K 제안. 번호(0006)는 통합 때 다른 마이그레이션과 겹치면 바꾼다
-- kind: remediate = 샌드박스 점검·수정 제안(설계 v1), spec_draft = 가져오기 결과로 명세 초안·위험·계획 설명 만들기

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  migration_id uuid REFERENCES migrations(id),
  kind text NOT NULL CHECK (kind IN ('remediate', 'spec_draft')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'finished', 'failed')),
  task text NOT NULL DEFAULT '',
  model text,                                   -- 실제로 답한 모델 (거부 대체가 돌았으면 대체 모델)
  result jsonb,                                 -- spec_draft: {version, risks, planExplanation, rejectedChanges}
  reason text,                                  -- 실패 이유 (예산 초과, 모델 거부, LLM_AUTH …)
  usage jsonb NOT NULL DEFAULT '{"input":0,"output":0}',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX agent_runs_id_tenant ON agent_runs (id, tenant_id);
CREATE INDEX agent_runs_migration ON agent_runs (migration_id, created_at DESC);
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_mig_same_tenant FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id);

-- 단계 기록은 넣기·읽기만 (감사 기록처럼 고치거나 지우지 않는다)
CREATE TABLE agent_steps (
  run_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  seq int NOT NULL,
  tool text NOT NULL,
  ok boolean NOT NULL,
  note text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id, tenant_id) REFERENCES agent_runs (id, tenant_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs', 'agent_steps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_wall ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- TODO(human): 설계 v1은 agent-worker 전용 DB 역할(app_agent)을 둔다. 지금은 app_user 로 붙는다.
-- app_agent 를 만들면 agent_runs·agent_steps 읽기/쓰기 + spec_versions INSERT + 나머지 표 SELECT 만 준다
GRANT SELECT, INSERT, UPDATE ON agent_runs TO app_user;
GRANT SELECT, INSERT ON agent_steps TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DROP TABLE agent_steps, agent_runs;
