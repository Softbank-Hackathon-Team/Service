-- 0026 (L4b): 연결 주기 재확인 훑기. 설계 IA 6.1 5단계 "1시간마다 다시 확인, 3번 연속 실패 = 불안정"
-- DRAFT(ai) L4b: 번호 0026 은 로컬 통합용 고정. PR 때 머지 순서대로 다시 매긴다
-- 훑기는 모든 회사의 연결된 환경을 봐야 해서 회사 벽(RLS)을 넘어야 한다.
--   app_user 에 우회 권한을 주지 않고 0003 처럼 svc_maintenance 가 주인인 함수 하나만 연다 (H-L10 기본값).
--   함수는 (환경 번호, 회사 번호)만 돌려준다. 실제 확인·상태 변경은 워커가 그 회사의 withTenant 안에서 한다
-- 권한: svc_maintenance 는 0003 에서 만들어짐

GRANT SELECT ON environments TO svc_maintenance;
CREATE POLICY maintenance_read ON environments FOR SELECT TO svc_maintenance USING (true);

-- 주기 재확인 대상: 연결됨·불안정 (설계 IA 6.4. 다른 상태는 처리기도 건너뜀)
-- DRAFT(ai): 오래 확인 안 한 것부터 (last_verified_at NULL 먼저), 한 번에 max_rows 개
CREATE FUNCTION maint_verify_due(max_rows int DEFAULT 500)
RETURNS TABLE (env_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.tenant_id
    FROM environments e
   WHERE e.connection_status IN ('connected', 'unstable')
   ORDER BY e.last_verified_at NULLS FIRST, e.id
   LIMIT max_rows
$$;

GRANT CREATE ON SCHEMA public TO svc_maintenance;
ALTER FUNCTION maint_verify_due(int) OWNER TO svc_maintenance;
REVOKE CREATE ON SCHEMA public FROM svc_maintenance;
REVOKE ALL ON FUNCTION maint_verify_due(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maint_verify_due(int) TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP FUNCTION maint_verify_due(int);
-- DROP POLICY maintenance_read ON environments;
-- REVOKE SELECT ON environments FROM svc_maintenance;
