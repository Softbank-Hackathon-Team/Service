-- 0046: vCluster 리허설 기록 (contracts sandbox.ts). deploying 에 들어올 때마다 리허설 줄은 정확히 하나 (돌리지 않은 경우도 skipped 줄)
--   워커(deploy)가 줄을 만들고, agent-worker 가 sandbox-rehearsal 큐로 받아 결과를 쓰고, 상태는 워커가 advance() 로만 옮긴다
--   agent_runs 에 kind 를 더하지 않은 이유: agent-worker 라우터가 모르는 종류를 수정 고리로 보내고, LLM 키·지출 문이 결정 코드를 막는다
-- DRAFT(ai): 번호 0046. 0045 는 열린 관측 PR(0045_metric_tokens)이 쓰고 있어 건너뛴다. 머지 순서가 바뀌면 다시 매긴다
-- 상태는 앞으로만: queued → running → passed | failed | error (agent-worker), queued | running → error(REHEARSAL_TIMEOUT) (워커). 둘 다 조건부 UPDATE
CREATE TABLE sandbox_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  migration_id uuid NOT NULL,
  epoch int NOT NULL,                 -- deploying 에 들어올 때의 migrations.version. 재개하면 새 차례
  purpose text NOT NULL DEFAULT 'rehearsal' CHECK (purpose IN ('rehearsal')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error', 'skipped')),
  phase text CHECK (phase IN ('mirroring', 'creating', 'applying', 'checking', 'deleting', 'done')),
  skip_reason text CHECK (skip_reason IN ('non_k8s', 'no_cluster', 'unsupported_target', 'disabled', 'mock')),
  plan_id uuid,
  bundle_sha256 text,
  reused_from uuid,                   -- 같은 계획·같은 지문의 앞 통과 줄 (재사용한 경우)
  sandbox_name text,
  host_namespace text,
  input jsonb,                        -- RehearsalInput (큐 내용은 줄 번호 하나뿐)
  result jsonb,                       -- RehearsalResult
  failure_code text,                  -- RehearsalFailureCode
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  deleted_at timestamptz,             -- vCluster 를 지운 때. 비어 있으면 만료 청소가 마무리한다
  UNIQUE (migration_id, epoch, purpose),
  FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id),
  -- DRAFT(ai): RehearsalResult 의 "통과면 코드 없음, 아니면 코드 있음"과 skipped 의 이유를 표에서도 지킨다
  CONSTRAINT sandbox_runs_skip_reason CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CONSTRAINT sandbox_runs_failure_code CHECK ((status IN ('failed', 'error')) = (failure_code IS NOT NULL)
                                              AND (failure_code IS NULL OR failure_code ~ '^REHEARSAL_[A-Z_]+$'))
);
-- 재사용 찾기: 같은 이전·같은 지문의 통과 줄
CREATE INDEX sandbox_runs_reuse ON sandbox_runs (migration_id, bundle_sha256) WHERE status = 'passed';

ALTER TABLE sandbox_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON sandbox_runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 지우지 않는다 (감사·화면이 읽는 기록). 줄 삭제 권한 없음
GRANT SELECT, INSERT, UPDATE ON sandbox_runs TO app_user;

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TABLE sandbox_runs;
