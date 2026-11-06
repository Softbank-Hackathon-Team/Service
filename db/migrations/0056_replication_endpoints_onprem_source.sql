-- 0056: 온프레 → 클라우드 (ADR-031 R4). 중계기 칸(relay_host·relay_known_hosts)과 봉인 값(sealed_material)은
--   "온프레 CNPG 줄"에 붙는다. 예전엔 온프레가 늘 도착이라 side = 'target' 으로 묶었는데, 온프레가 출발이면 그 줄이 source 다.
--   그래서 규칙을 "도착 줄 또는 CNPG 줄" 로 넓힌다 (contracts replication-endpoint.ts 의 refine 과 같아야 한다).
--   예전 규칙의 상위 집합이라 이미 있는 줄은 그대로 통과한다
-- DRAFT(ai): 클라우드 출발 줄(rds·cloudsql 등)에는 여전히 못 넣는다 (그쪽은 터널을 받는 쪽이 아니다)
ALTER TABLE replication_endpoints DROP CONSTRAINT IF EXISTS replication_endpoints_relay_side;
ALTER TABLE replication_endpoints ADD CONSTRAINT replication_endpoints_relay_side CHECK (
  side = 'target' OR provider = 'cnpg' OR (relay_host IS NULL AND relay_known_hosts IS NULL AND sealed_material IS NULL)
);

-- forward-only: 되돌리기는 사람이 (온프레 출발 줄이 없을 때만)
--   ALTER TABLE replication_endpoints DROP CONSTRAINT replication_endpoints_relay_side;
--   ALTER TABLE replication_endpoints ADD CONSTRAINT replication_endpoints_relay_side CHECK (side = 'target' OR (relay_host IS NULL AND relay_known_hosts IS NULL AND sealed_material IS NULL));
