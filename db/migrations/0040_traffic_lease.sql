-- 0040 (PF FM-ORC-10): 트래픽 LB 주인 표. LB 는 워커 전역 TRAFFIC_LB_ID 하나인데 환경 잠금은 환경만 막아서,
--   환경이 안 겹치는 다른 이전(다른 회사 포함)의 롤백·shift 가 지금 이전의 가중치를 덮어썼다 (A shifting 50% 중 B 롤백 → 출발 100%).
-- 표는 회사 벽(RLS) 밖이라 app_user 는 직접 못 읽고, svc_maintenance 가 주인인 함수 셋만 연다 (0003·0026 과 같은 방식).
--   함수는 남의 이전 번호를 돌려주지 않는다 ('mine' | 'other' | 'none' 만).
-- 주인이 끝 상태(completed·rolled_back·cancelled)이거나 없어진 이전이면 다음 사람이 가져간다. 끝 상태가 되면 advance() 가 놓는다.
-- svc_maintenance 는 0003 에서 만들어짐 (migrations SELECT 정책 있음)

CREATE TABLE traffic_leases (
  lb_id        text PRIMARY KEY,
  migration_id uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON traffic_leases FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON traffic_leases TO svc_maintenance;

-- 부르는 회사(app.tenant_id)의 이전일 때만. 아니면 'denied'
CREATE FUNCTION traffic_lease_take(p_lb text, p_mig uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid; holder uuid;
BEGIN
  IF t IS NULL OR NOT EXISTS (SELECT 1 FROM migrations WHERE id = p_mig AND tenant_id = t) THEN RETURN 'denied'; END IF;
  DELETE FROM traffic_leases l WHERE l.lb_id = p_lb AND NOT EXISTS (
    SELECT 1 FROM migrations m WHERE m.id = l.migration_id AND m.status NOT IN ('completed', 'rolled_back', 'cancelled'));
  INSERT INTO traffic_leases (lb_id, migration_id, tenant_id) VALUES (p_lb, p_mig, t) ON CONFLICT (lb_id) DO NOTHING;
  SELECT migration_id INTO holder FROM traffic_leases WHERE lb_id = p_lb;
  RETURN CASE WHEN holder = p_mig THEN 'mine' ELSE 'other' END;
END $$;

-- 가져가지 않고 보기만
CREATE FUNCTION traffic_lease_state(p_lb text, p_mig uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE holder uuid; live boolean;
BEGIN
  SELECT l.migration_id, EXISTS (SELECT 1 FROM migrations m WHERE m.id = l.migration_id AND m.status NOT IN ('completed', 'rolled_back', 'cancelled'))
    INTO holder, live FROM traffic_leases l WHERE l.lb_id = p_lb;
  IF holder IS NULL OR NOT live THEN RETURN 'none'; END IF;
  RETURN CASE WHEN holder = p_mig THEN 'mine' ELSE 'other' END;
END $$;

CREATE FUNCTION traffic_lease_release(p_mig uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid; n integer;
BEGIN
  DELETE FROM traffic_leases WHERE migration_id = p_mig AND tenant_id = t;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT CREATE ON SCHEMA public TO svc_maintenance;
ALTER TABLE traffic_leases OWNER TO svc_maintenance;
ALTER FUNCTION traffic_lease_take(text, uuid) OWNER TO svc_maintenance;
ALTER FUNCTION traffic_lease_state(text, uuid) OWNER TO svc_maintenance;
ALTER FUNCTION traffic_lease_release(uuid) OWNER TO svc_maintenance;
REVOKE CREATE ON SCHEMA public FROM svc_maintenance;
REVOKE ALL ON FUNCTION traffic_lease_take(text, uuid), traffic_lease_state(text, uuid), traffic_lease_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION traffic_lease_take(text, uuid), traffic_lease_state(text, uuid), traffic_lease_release(uuid) TO app_user;

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP FUNCTION traffic_lease_release(uuid); DROP FUNCTION traffic_lease_state(text, uuid); DROP FUNCTION traffic_lease_take(text, uuid);
-- DROP TABLE traffic_leases;
