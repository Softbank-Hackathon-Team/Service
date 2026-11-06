-- 0058: 온프레 Agent 인벤토리 스냅숏 보고 (kind 'inventory'). pull 모드 온프레 출발 가져오기가 고객 클러스터에 들어가지 않고 이 보고로 discover 를 다시 돌린다
--   contracts AgentReportKinds 와 같은 값. 보고 본문 모양은 contracts AgentInventorySnapshot 이 정한다
--   환경별 최신 1개 찾기는 0018 의 agent_reports_env_kind (tenant_id, env_id, kind, received_at DESC) 색인을 그대로 쓴다 → 새 색인 없음
-- DRAFT(ai): 번호 0058 (0056 = 연결 역할 꼬리, 0057 = 온프레 출발 끝점 줄)
-- TODO(human): 보관 기간. agent_reports 는 넣기 전용이라 몇 분마다 오는 스냅숏(수십 KB~수 MB)이 계속 쌓인다. 지우는 주기·주체를 정해야 한다
ALTER TABLE agent_reports DROP CONSTRAINT agent_reports_kind_check;
ALTER TABLE agent_reports ADD CONSTRAINT agent_reports_kind_check
  CHECK (kind IN ('security', 'deploy', 'heartbeat', 'facts', 'inventory'));

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DELETE FROM agent_reports WHERE kind = 'inventory';  (넣기 전용 표라 먼저 사람이 확인하고 지운다)
-- ALTER TABLE agent_reports DROP CONSTRAINT agent_reports_kind_check;
-- ALTER TABLE agent_reports ADD CONSTRAINT agent_reports_kind_check CHECK (kind IN ('security', 'deploy', 'heartbeat', 'facts'));
