-- 0052: 환경 층 (도착 GCP 프로젝트의 VPC·GKE·Artifact Registry·ESO, infra/modules/gcp/env). 아키텍처 이전 9단계 "4 기반 생성"
--   worker 가 apply 맨 앞(ensureEnvLayer)에서 도착 GKE 가 없을 때 만들고, 결과(비밀 아닌 사실)를 환경마다 1줄로 둔다.
--   다음 이전부터 같은 환경은 이 줄의 사실을 Terraform 자리표시(<env:clusterName> 등)에 쓴다 (TF_FACT_* 보다 먼저)
--   status: creating(만드는 중, 같은 환경 두 번째 이전은 ENV_LAYER_BUSY) | ready | failed(만들다 만 자원은 지우지 않음, 다시 apply 하면 이어 만든다)
--   facts: cluster_name, cluster_location, network_id, nat_egress_ips, registry_host, secret_store_name. 비밀번호·토큰·키는 넣지 않는다
--   vars_hash: 모듈 입력 지문 (계획서 envLayer.varsHash 와 대조), module_digest: 만들 때의 gcp/env 모듈 지문
--   환경 소유: 이전의 롤백·정리(target-destroy)는 이 줄과 자원을 남긴다. 지우기는 사람이 작업 폴더에서 terraform destroy 뒤 줄을 지운다
-- DRAFT(ai): 번호 0052 (0048·0049 는 다른 작업 예약으로 비워 둔다)
CREATE TABLE environment_layers (
  env_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL CHECK (provider IN ('gcp')),
  status text NOT NULL CHECK (status IN ('creating', 'ready', 'failed')),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  vars_hash text NOT NULL,
  module_digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (env_id, tenant_id) REFERENCES environments (id, tenant_id)
);

ALTER TABLE environment_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE environment_layers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON environment_layers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- DELETE 는 주지 않는다 (worker 가 환경 층 줄을 지우는 길이 없다 = 자동 삭제 없음)
GRANT SELECT, INSERT, UPDATE ON environment_layers TO app_user;

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TABLE environment_layers;
