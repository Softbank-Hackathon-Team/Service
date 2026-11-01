-- 임시 자격 증명 장부 (보안 영역, 위협 모델 T-ROLE-8)
-- 값(키·토큰)은 절대 여기 안 들어간다. 참조 이름·만료·상태만 적는다. 값은 발급한 워커의 메모리에만 있다
-- 워커가 여러 대여도 "이 이전의 실행 역할이 전부 회수됐나"(T27)를 이 표로 센다
-- 0009 (통합 번호 확정, DRAFT(ai))
CREATE TABLE temp_credentials (
  credential_ref text PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  migration_id   uuid REFERENCES migrations(id),
  env_id         uuid NOT NULL,
  provider       text NOT NULL,
  purpose        text NOT NULL CHECK (purpose IN ('observe', 'operate')),
  stage          text CHECK (stage IN ('plan', 'apply', 'destroy')),
  role_ref       text NOT NULL,
  owner          text NOT NULL,          -- 값을 쥔 워커 (호스트:pid:무작위). 그 워커만 실제로 지울 수 있다
  issued_at      timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoke_requested', 'revoked')),
  revoke_reason  text,
  revoked_at     timestamptz
);
CREATE INDEX temp_credentials_migration ON temp_credentials (tenant_id, migration_id) WHERE status <> 'revoked';

ALTER TABLE temp_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE temp_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON temp_credentials
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 지우기 권한은 안 준다. 기록은 남기고 상태만 바꾼다 (감사 추적)
GRANT SELECT, INSERT, UPDATE ON temp_credentials TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DROP TABLE temp_credentials;  (지우기 전에 status <> 'revoked' 줄이 0인지 확인: 회수 증거가 사라진다)
