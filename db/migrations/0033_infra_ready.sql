-- 0031 (SECAUDIT): "도착 자원 준비됨"(InfraReady) 을 감사 표에서 따로 뺀다.
-- 예전엔 감사 detail.infraReady 에 terraform 출력 전체(DB 주소·ARN 안 계정 번호·역할 ARN)를 넣고 배포·보안 점검이 그걸 다시 읽었다.
-- 감사는 지울 수 없고(해시 체인) 화면·보고서·실패 분석(LLM 입력)으로 퍼지므로 주소·ARN 을 남기면 안 된다.
-- 이제 출력 값은 이 표에만, 감사에는 출력 이름 목록만 남긴다. 옛 감사 줄은 그대로 두고 읽는 쪽이 이 표 → 옛 감사 순으로 본다
CREATE TABLE infra_ready (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  migration_id uuid NOT NULL REFERENCES migrations(id),
  plan_id uuid NOT NULL,
  tf_outputs jsonb NOT NULL CHECK (jsonb_typeof(tf_outputs) = 'object'),
  helm_values_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX infra_ready_migration ON infra_ready (tenant_id, migration_id, id DESC);

ALTER TABLE infra_ready ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra_ready FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON infra_ready
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 쓰기는 apply 작업(withTenant)만, 지우지 않음
GRANT SELECT, INSERT ON infra_ready TO app_user;
GRANT USAGE ON SEQUENCE infra_ready_id_seq TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TABLE infra_ready;   (옛 감사 detail.infraReady 읽기로 돌아가려면 SECAUDIT 코드도 되돌린다)
