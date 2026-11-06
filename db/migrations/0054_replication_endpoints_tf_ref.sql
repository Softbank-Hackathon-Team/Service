-- 0054: replication_endpoints.password_ref 에 tf:<키> 를 더한다 (도착 클라우드 DB 관리자 비밀번호).
--   값은 칸에 없다. 실행기가 도착 비밀 그릇(GCP Secret Manager)에서 꺼내 이전 작업 폴더 db-secret.json(0600, 워커 디스크)에 둔 것을
--   워커가 접속 직전에 읽는다 (@svc/replication tf-facts.ts 와 같은 폴더 규칙). 규칙은 contracts PASSWORD_REF_RE 와 같아야 한다
-- DRAFT(ai): 키는 _password 로 끝나는 것만 (줄이 주소 같은 비밀 아닌 사실이나 다른 파일 값을 비밀번호로 쓰지 못하게)
ALTER TABLE replication_endpoints DROP CONSTRAINT IF EXISTS replication_endpoints_password_ref_check;
ALTER TABLE replication_endpoints ADD CONSTRAINT replication_endpoints_password_ref_check CHECK (
  password_ref ~ '^(derive:[a-z0-9_-]{1,64}|env:REPL_SECRET_[A-Z0-9_]+|aws-sm:arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:rds!db-[A-Za-z0-9-]+|tf:[a-z0-9_]{1,55}_password)$'
);
