-- 0005: 회사 번호까지 같이 묶는 외래 키
-- 외래 키 검사는 회사 벽(RLS)을 거치지 않는다. 그래서 id만 묶으면 다른 회사의 환경 번호로도
-- 이전을 만들 수 있었다. (id, tenant_id) 쌍으로 묶어 DB가 직접 막게 한다

ALTER TABLE environments ADD CONSTRAINT environments_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE migrations ADD CONSTRAINT migrations_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE plans ADD CONSTRAINT plans_id_tenant UNIQUE (id, tenant_id);

ALTER TABLE migrations
  ADD CONSTRAINT migrations_source_env_same_tenant
    FOREIGN KEY (source_env_id, tenant_id) REFERENCES environments (id, tenant_id),
  ADD CONSTRAINT migrations_target_env_same_tenant
    FOREIGN KEY (target_env_id, tenant_id) REFERENCES environments (id, tenant_id);
ALTER TABLE env_locks
  ADD CONSTRAINT env_locks_env_same_tenant FOREIGN KEY (env_id, tenant_id) REFERENCES environments (id, tenant_id),
  ADD CONSTRAINT env_locks_mig_same_tenant FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id);
ALTER TABLE spec_versions
  ADD CONSTRAINT spec_versions_mig_same_tenant FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id);
ALTER TABLE plans
  ADD CONSTRAINT plans_mig_same_tenant FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id);
ALTER TABLE plan_approvals
  ADD CONSTRAINT plan_approvals_mig_same_tenant FOREIGN KEY (migration_id, tenant_id) REFERENCES migrations (id, tenant_id),
  ADD CONSTRAINT plan_approvals_plan_same_tenant FOREIGN KEY (plan_id, tenant_id) REFERENCES plans (id, tenant_id);

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- ALTER TABLE plan_approvals DROP CONSTRAINT plan_approvals_plan_same_tenant, DROP CONSTRAINT plan_approvals_mig_same_tenant;
-- ALTER TABLE plans DROP CONSTRAINT plans_mig_same_tenant;
-- ALTER TABLE spec_versions DROP CONSTRAINT spec_versions_mig_same_tenant;
-- ALTER TABLE env_locks DROP CONSTRAINT env_locks_mig_same_tenant, DROP CONSTRAINT env_locks_env_same_tenant;
-- ALTER TABLE migrations DROP CONSTRAINT migrations_target_env_same_tenant, DROP CONSTRAINT migrations_source_env_same_tenant;
-- ALTER TABLE plans DROP CONSTRAINT plans_id_tenant; ALTER TABLE migrations DROP CONSTRAINT migrations_id_tenant;
-- ALTER TABLE environments DROP CONSTRAINT environments_id_tenant;  (0006 이후 표가 이 유일 제약에 기대므로 그 표를 먼저 지운다)
