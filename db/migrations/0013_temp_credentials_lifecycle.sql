-- 0013 (작업 Z39, 번호 확정): 임시 역할 장부에 "어느 단계가 빌렸나"와 "만료 처리"를 남긴다
-- 0009 장부는 발급·회수만 적었다. 만료는 감사(temp_role.expired)에만 남고, 워커가 죽으면 그마저 없었다.
-- 이제: 작업 단계(precheck·plan·apply·cleanup·rollback)가 빌릴 때 step·동작 수·요청 수명·Mock 여부를 적고,
--       만료 시각이 지난 줄은 청소(sweep)·정리 때 status='expired' + expired_at 으로 바꾼다 (값은 여전히 없다)
-- 기존 줄은 그대로 둔다 (새 칸은 비어도 된다)

ALTER TABLE temp_credentials ADD COLUMN step text;
ALTER TABLE temp_credentials ADD COLUMN actions_count int;
ALTER TABLE temp_credentials ADD COLUMN requested_ttl_sec int;
ALTER TABLE temp_credentials ADD COLUMN stub boolean;
ALTER TABLE temp_credentials ADD COLUMN expired_at timestamptz;

ALTER TABLE temp_credentials DROP CONSTRAINT temp_credentials_status_check;
ALTER TABLE temp_credentials ADD CONSTRAINT temp_credentials_status_check
  CHECK (status IN ('active', 'revoke_requested', 'revoked', 'expired'));
-- 만료 처리된 줄은 만료 시각이 있어야 하고, 회수 시각과 같이 있을 수 없다
ALTER TABLE temp_credentials ADD CONSTRAINT temp_credentials_expired_at_check
  CHECK ((status = 'expired') = (expired_at IS NOT NULL));

-- 청소가 "만료 시각이 지났는데 아직 살아 있다고 적힌 줄"을 빨리 찾게
CREATE INDEX temp_credentials_due ON temp_credentials (tenant_id, expires_at) WHERE status IN ('active', 'revoke_requested');

-- 권한은 0009 그대로 (SELECT, INSERT, UPDATE). 지우기는 여전히 없다

-- Down Migration
-- UPDATE temp_credentials SET status='revoked', revoke_reason=COALESCE(revoke_reason,'expired'), revoked_at=expired_at WHERE status='expired';
-- ALTER TABLE temp_credentials DROP CONSTRAINT temp_credentials_expired_at_check;
-- ALTER TABLE temp_credentials DROP CONSTRAINT temp_credentials_status_check;
-- ALTER TABLE temp_credentials ADD CONSTRAINT temp_credentials_status_check CHECK (status IN ('active', 'revoke_requested', 'revoked'));
-- DROP INDEX temp_credentials_due;
-- ALTER TABLE temp_credentials DROP COLUMN step, DROP COLUMN actions_count, DROP COLUMN requested_ttl_sec, DROP COLUMN stub, DROP COLUMN expired_at;
