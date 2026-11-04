-- 0047: 온프레 Agent 보안 사실 보고 (kind 'facts', W5). 보안 판정이 온프레 DB 의 TLS 강제·버전·인증 방식·바깥 노출을 측정값으로 쓴다
--   contracts AgentReportKinds 와 같은 값. 보고 본문 모양은 contracts AgentReport(facts) 가 정한다
ALTER TABLE agent_reports DROP CONSTRAINT agent_reports_kind_check;
ALTER TABLE agent_reports ADD CONSTRAINT agent_reports_kind_check
  CHECK (kind IN ('security', 'deploy', 'heartbeat', 'facts'));

-- Down Migration
-- DELETE FROM agent_reports WHERE kind = 'facts';  (넣기 전용 표라 먼저 사람이 확인하고 지운다)
-- ALTER TABLE agent_reports DROP CONSTRAINT agent_reports_kind_check;
-- ALTER TABLE agent_reports ADD CONSTRAINT agent_reports_kind_check CHECK (kind IN ('security', 'deploy', 'heartbeat'));
