-- 0050: 이전마다 복제 끝점 (출발·도착 DB 주소). 예전엔 워커 전역 .env (REPL_SOURCE_URL·REPL_TARGET_URL …) 하나라
--   워커 하나 = 출발 DB 하나였다 → 회사가 다른 두 이전이 같은 출발 DB 를 원본으로 쓸 수 있었다 (회사 간 데이터 섞임)
-- DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
-- 이 표에 두 줄(source·target)이 다 있으면 워커가 이 값을 쓰고, 둘 다 없으면 예전처럼 .env. 한 줄만 있으면 오류 (섞지 않는다)
-- 줄을 채우는 쪽: 운영자·중계기 스크립트 (tools/repl-endpoint.ts set). 오케는 읽기만
-- 비밀번호 칸은 없다. password_ref 만 (derive:<용도> | env:REPL_SECRET_<이름>) → 워커가 실행할 때만 값으로 바꾼다
-- DRAFT(ai): 번호 0050. 0048·0049 는 다른 영역이 잡아 두었다
CREATE TABLE replication_endpoints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  migration_id   uuid NOT NULL,
  side           text NOT NULL CHECK (side IN ('source', 'target')),
  label          text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  provider       text NOT NULL CHECK (provider IN ('postgres', 'rds', 'cloudsql', 'cnpg', 'azure')),
  host           text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  port           int  NOT NULL CHECK (port BETWEEN 1 AND 65535),
  dbname         text NOT NULL CHECK (length(dbname) BETWEEN 1 AND 63),
  username       text NOT NULL CHECK (length(username) BETWEEN 1 AND 63),
  -- 진짜 비밀번호를 실수로 넣지 못하게 문법을 표에서도 막는다 (contracts PASSWORD_REF_RE 와 같은 규칙)
  password_ref   text NOT NULL CHECK (password_ref ~ '^(derive:[a-z0-9_-]{1,64}|env:REPL_SECRET_[A-Z0-9_]+)$'),
  -- 상대 DB 가 이 DB 에 붙을 때(CREATE SUBSCRIPTION) 쓰는 주소. 없으면 host·port
  peer_host      text CHECK (length(peer_host) BETWEEN 1 AND 253),
  peer_port      int  CHECK (peer_port BETWEEN 1 AND 65535),
  app_role       text NOT NULL DEFAULT 'app_user' CHECK (length(app_role) BETWEEN 1 AND 63),
  fence_roles    text[] NOT NULL DEFAULT '{}',
  schema_name    text CHECK (length(schema_name) BETWEEN 1 AND 63),
  sslmode        text CHECK (sslmode IN ('require', 'verify-ca', 'verify-full')),
  -- host 가 IP 일 때(중계기로 붙음) 서버 인증서에서 확인할 이름
  tls_servername text CHECK (length(tls_servername) BETWEEN 1 AND 253),
  -- 공개 CA 인증서 PEM. 개인 키는 받지 않는다
  ca_pem         text CHECK (ca_pem LIKE '%-----BEGIN CERTIFICATE-----%' AND ca_pem NOT LIKE '%PRIVATE KEY%'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- peer_port 만 있고 peer_host 가 없으면 뜻이 없다 (peer_host 만 있으면 port 를 쓴다)
  CONSTRAINT replication_endpoints_peer_pair CHECK (peer_port IS NULL OR peer_host IS NOT NULL),
  UNIQUE (migration_id, side),
  FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX replication_endpoints_tenant ON replication_endpoints (tenant_id, migration_id);

ALTER TABLE replication_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE replication_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON replication_endpoints
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- DRAFT(ai): 지우기는 이전을 지울 때(CASCADE)만. 운영자는 set 으로 덮어쓴다
GRANT SELECT, INSERT, UPDATE ON replication_endpoints TO app_user;

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TABLE replication_endpoints;
