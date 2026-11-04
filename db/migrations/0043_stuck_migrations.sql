-- PF FM-ORC-15: 도착 자원을 만든 뒤 멈춘 이전(paused, 또는 자원을 만든 뒤 실패해 "재시도할까?" 질문 대기인 failed)을
--   회사 경계를 넘어 찾는 함수. 예전엔 3일 멈춰도 기한·알림이 없어 도착 클러스터·DB 과금이 계속됐다.
--   워커 리퍼(1분마다)가 부르고, 알림(감사 migration.stuck_alert + 화면 신호)은 그 회사의 withTenant 안에서 쓴다 (maint_expired_env_locks 와 같은 모양)
-- DRAFT(ai): 실패 지점 목록 = contracts ROLLBACK_ON_REJECT (자원을 만든 뒤)
CREATE FUNCTION maint_stuck_migrations(min_age interval, max_rows int DEFAULT 100)
RETURNS TABLE (tenant_id uuid, migration_id uuid, status text, failed_at_status text, paused_from text,
               failure_code text, stuck_sec int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.tenant_id, m.id, m.status, m.failed_at_status, m.paused_from, m.failure_code,
         extract(epoch FROM now() - m.updated_at)::int
    FROM migrations m
   WHERE m.updated_at < now() - min_age
     AND (m.status = 'paused'
          OR (m.status = 'failed' AND m.failed_at_status IN
              ('provisioning', 'deploying', 'syncing', 'shifting', 'cutover', 'rollback_window', 'rolling_back')))
   ORDER BY m.updated_at
   LIMIT max_rows
$$;

GRANT CREATE ON SCHEMA public TO svc_maintenance;
ALTER FUNCTION maint_stuck_migrations(interval, int) OWNER TO svc_maintenance;
REVOKE CREATE ON SCHEMA public FROM svc_maintenance;
REVOKE ALL ON FUNCTION maint_stuck_migrations(interval, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maint_stuck_migrations(interval, int) TO app_user;

-- Down Migration
-- DROP FUNCTION maint_stuck_migrations(interval, int);
