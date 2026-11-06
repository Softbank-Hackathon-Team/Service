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
  -- 중계기(infra/modules/aws/demo-relay) 사실. 도착(target) 줄에만. 워커가 온프레 터널 값(dbTunnel.relay)으로 그린다
  --   relay_host = 중계 공개 주소, relay_known_hosts = 중계 호스트 키 줄(ssh-keyscan, 공개 값), relay_port = sshd 포트
  -- 개인 키는 받지 않는다 (ca_pem 과 같은 규칙)
  relay_host        text CHECK (length(relay_host) BETWEEN 1 AND 253 AND relay_host ~ '^[A-Za-z0-9.-]+$'),
  relay_known_hosts text CHECK (length(relay_known_hosts) BETWEEN 1 AND 8192 AND relay_known_hosts NOT LIKE '%PRIVATE KEY%'),
  relay_port        int  NOT NULL DEFAULT 22 CHECK (relay_port BETWEEN 1 AND 65535),
  -- DRAFT(ai): 워커가 봉인한 SealedSecret 값(암호문만) + 입력 지문. 다시 렌더할 때 지문이 같으면 이 값을 그대로 다시 써서
  --   커밋 묶음이 매번 바뀌지 않게 한다 (봉인은 무작위 세션 키라 매번 다른 글자가 된다 → 리허설 지문·재개가 어긋난다).
  --   암호문은 어차피 gitops 레포에 커밋되는 값이다 (풀 수 있는 쪽은 클러스터 sealed-secrets 컨트롤러뿐). 평문은 없다
  sealed_material   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- peer_port 만 있고 peer_host 가 없으면 뜻이 없다 (peer_host 만 있으면 port 를 쓴다)
  CONSTRAINT replication_endpoints_peer_pair CHECK (peer_port IS NULL OR peer_host IS NOT NULL),
  -- 중계기 칸·봉인 값은 도착 줄에만, 주소와 호스트 키는 같이 (호스트 키 없이 붙으면 처음 보는 키를 믿게 된다)
  CONSTRAINT replication_endpoints_relay_side CHECK (side = 'target' OR (relay_host IS NULL AND relay_known_hosts IS NULL AND sealed_material IS NULL)),
  CONSTRAINT replication_endpoints_relay_pair CHECK ((relay_host IS NULL) = (relay_known_hosts IS NULL)),
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

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다 (표째 지우므로 relay_*·sealed_material 칸도 같이 사라진다)
-- Down Migration
-- DROP TABLE replication_endpoints;
