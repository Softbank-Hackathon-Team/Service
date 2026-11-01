-- 0003: 같은 요청 두 번 막기(멱등 키), 환경 잠금 칸 보완, 청소 전용 함수
-- 규칙: 새 회사 표는 RLS + FORCE + tenant_wall 정책, app_user 권한은 필요한 만큼만

-- 1. 멱등 키: 첫 요청의 응답을 저장해 두고, 같은 키가 다시 오면 그대로 돌려준다.
--    키 줄은 처리와 "같은 트랜잭션의 맨 앞"에서 넣는다 (확정 뒤에 넣으면 그 사이에 죽을 때 키가 사라진다)
CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  req_hash text NOT NULL,            -- 메서드 + 경로 + 본문 지문. 같은 키를 다른 요청에 쓰면 409
  status_code int,                   -- 확정 직전에 채운다
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_keys_created_at ON idempotency_keys (created_at);

-- 2. 환경 잠금 보완: 어떤 큐 작업이 쥐었는지(청소 때 그 작업을 실패 처리), 만든 시각, 주인 모양 검사
ALTER TABLE env_locks
  ADD COLUMN job_queue text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT env_locks_holder_shape CHECK (holder = 'reserved' OR holder LIKE 'worker:%');
CREATE INDEX env_locks_migration ON env_locks (migration_id);
CREATE INDEX env_locks_expires ON env_locks (lease_expires_at);

-- 3. 회사 벽
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- 앱은 넣기·읽기·응답 채우기만. 지우기는 아래 청소 함수만 한다
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO app_user;

-- 4. 청소 전용 역할 (로그인 불가). 청소 작업은 모든 회사의 기한 지난 줄을 봐야 하는데,
--    app_user에 회사 벽 우회 권한을 주지 않으려고 이 역할이 주인인 함수 두 개만 연다.
--    함수는 번호와 상태만 돌려준다. 실제 상태 변경은 워커가 그 회사의 withTenant 안에서 advance()로 한다
-- DRAFT(ai): BYPASSRLS 역할 대신 "역할별 정책 + SECURITY DEFINER 함수"로 했다. RDS에서도 superuser 없이 된다
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_maintenance') THEN
    CREATE ROLE svc_maintenance NOLOGIN;
  END IF;
  -- 슈퍼유저가 아닌 주인(RDS·CloudNativePG의 앱 소유자)은 이 역할 멤버여야 소유권 넘기기·AUTHORIZATION이 된다
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT svc_maintenance TO %I', current_user);
  END IF;
END $$;
GRANT SELECT ON env_locks, migrations TO svc_maintenance;
GRANT SELECT, DELETE ON idempotency_keys TO svc_maintenance;
CREATE POLICY maintenance_read ON env_locks FOR SELECT TO svc_maintenance USING (true);
CREATE POLICY maintenance_read ON migrations FOR SELECT TO svc_maintenance USING (true);
CREATE POLICY maintenance_all ON idempotency_keys FOR ALL TO svc_maintenance USING (true);

-- 기한 지난 환경 잠금 목록. 사람이 볼 상태(일시정지, 실패, 롤백 가능 창)는 빼고 돌려준다
CREATE FUNCTION maint_expired_env_locks(max_rows int DEFAULT 100)
RETURNS TABLE (tenant_id uuid, env_id uuid, migration_id uuid, holder text,
               job_id uuid, job_queue text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.tenant_id, l.env_id, l.migration_id, l.holder, l.job_id, l.job_queue, m.status
    FROM env_locks l JOIN migrations m ON m.id = l.migration_id
   WHERE l.lease_expires_at < now()
     AND m.status NOT IN ('paused', 'failed', 'rollback_window')
   ORDER BY l.lease_expires_at
   LIMIT max_rows
$$;

-- 오래된 멱등 키 지우기. 지운 줄 수를 돌려준다
CREATE FUNCTION maint_cleanup_idempotency(max_age interval DEFAULT interval '24 hours')
RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  DELETE FROM idempotency_keys WHERE created_at < now() - max_age;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Z9: 함수 주인을 바꿀 때 새 주인에게 스키마 CREATE 권한이 있어야 한다(PG15+ public 기본 권한 없음, 슈퍼유저만 검사 면제).
--     바꾸는 순간에만 주고 바로 거둔다
GRANT CREATE ON SCHEMA public TO svc_maintenance;
ALTER FUNCTION maint_expired_env_locks(int) OWNER TO svc_maintenance;
ALTER FUNCTION maint_cleanup_idempotency(interval) OWNER TO svc_maintenance;
REVOKE CREATE ON SCHEMA public FROM svc_maintenance;
REVOKE ALL ON FUNCTION maint_expired_env_locks(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION maint_cleanup_idempotency(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maint_expired_env_locks(int) TO app_user;
GRANT EXECUTE ON FUNCTION maint_cleanup_idempotency(interval) TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DROP FUNCTION maint_cleanup_idempotency(interval), maint_expired_env_locks(int);
-- DROP POLICY maintenance_all ON idempotency_keys; DROP POLICY maintenance_read ON migrations; DROP POLICY maintenance_read ON env_locks;
-- DROP TABLE idempotency_keys;
-- DROP INDEX env_locks_expires, env_locks_migration;
-- ALTER TABLE env_locks DROP CONSTRAINT env_locks_holder_shape, DROP COLUMN created_at, DROP COLUMN job_queue;
