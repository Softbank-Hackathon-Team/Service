-- 0053: replication_endpoints.password_ref 에 aws-sm:<ARN> 을 더한다 (출발 RDS 관리 마스터 비밀, Secrets Manager rds!db-…).
--   DECISION(team): 출발 DB 관리자 비밀번호는 고객이 넘기지 않고, 워커가 출발 실행 역할을 빌려 RDS 관리 비밀을 읽는다 (2026-11-06, 보안·온프레 영역 제안 + 연결 템플릿 영역 동의)
--   값은 여전히 칸에 없다. 워커가 접속 직전에 읽고 메모리에만 둔다. 규칙은 contracts PASSWORD_REF_RE 와 같아야 한다
-- DRAFT(ai): 0050 의 CHECK 는 이름 없이 만들어져 PostgreSQL 기본 이름(<표>_<칸>_check)을 쓴다
ALTER TABLE replication_endpoints DROP CONSTRAINT IF EXISTS replication_endpoints_password_ref_check;
ALTER TABLE replication_endpoints ADD CONSTRAINT replication_endpoints_password_ref_check CHECK (
  password_ref ~ '^(derive:[a-z0-9_-]{1,64}|env:REPL_SECRET_[A-Z0-9_]+|aws-sm:arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:rds!db-[A-Za-z0-9-]+)$'
);
