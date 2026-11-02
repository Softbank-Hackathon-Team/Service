-- 0025 실패 원인 분석 실행 종류 (계획 26 · A5a). agent_runs.kind 에 failure_analysis 를 더한다
-- failure_analysis = 이전이 failed·paused 로 갈 때 advance() 가 같은 트랜잭션에 넣는 읽기 전용 분석
--   (감사·실패 코드·작업 오류 요약 → 원인·고칠 것·retryable). 샌드박스 수정안(remediate)과 분리
-- DRAFT(ai): 번호는 로컬 통합용. PR 때 main 마지막 + 1 로 다시 매기고 tools/db-migrate.sh marker_sql 줄도 같이 바꾼다
-- 권한: app_user·app_agent 는 0006 에서 agent_runs 권한을 이미 가짐 → 추가 GRANT 없음
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_kind_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_check
  CHECK (kind IN ('remediate', 'spec_draft', 'failure_analysis'));

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DELETE FROM agent_runs WHERE kind = 'failure_analysis';   (agent_steps 줄이 있으면 먼저 지움)
-- ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_kind_check;
-- ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_check CHECK (kind IN ('remediate', 'spec_draft'));
