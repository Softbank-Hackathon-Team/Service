-- 0024 환경 연결 칸 (입력층 L1). 연결 상태 전이(advanceConnection)·링크 발급·연결 확인이 쓰는 칸을 더한다
-- 연결 상태 목록·전이 표는 packages/contracts/src/environment.ts (ConnectionStatus, CONNECTION_VALID)
-- (tenant_id, name) 유일 색인은 넣지 않는다: 기존 DB 시험이 같은 회사에 같은 이름 환경을 두 번 넣는다. 이름 중복은 라우트가 409로 막는다
-- 권한: app_user는 0001에서 environments에 SELECT·INSERT·UPDATE·DELETE를 이미 가짐 → 추가 GRANT 없음
ALTER TABLE environments
  ADD COLUMN region text,
  ADD COLUMN cluster_name text,
  ADD COLUMN link_issued_at timestamptz,
  ADD COLUMN failure_reason text,
  ADD COLUMN verify_failures int NOT NULL DEFAULT 0 CHECK (verify_failures >= 0),
  ADD COLUMN verify_detail jsonb;

-- ExternalId 는 전역에서 하나 (다른 회사와 같으면 혼동된 대리인 방어가 약해진다)
CREATE UNIQUE INDEX environments_external_id_uq ON environments (external_id) WHERE external_id IS NOT NULL;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP INDEX environments_external_id_uq;
-- ALTER TABLE environments DROP COLUMN verify_detail, DROP COLUMN verify_failures, DROP COLUMN failure_reason,
--   DROP COLUMN link_issued_at, DROP COLUMN cluster_name, DROP COLUMN region;
