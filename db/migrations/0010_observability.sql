-- 0010 (원래 작업 T의 0006, 통합 번호로 바꿈): 관측(메트릭)용 읽기 함수 하나
-- /metrics 는 모든 회사의 숫자를 합쳐서 봐야 한다. 그런데 app_user 는 회사 벽(RLS) 때문에 한 회사만 본다.
-- 0003 청소 함수와 같은 방식: 로그인 못 하는 전용 역할 + 그 역할이 주인인 SECURITY DEFINER 함수.
-- 함수는 "합계 숫자"만 돌려준다. 회사 번호, 이전 번호, 감사 detail 원문은 밖으로 나가지 않는다
-- DRAFT(ai): 매 수집(15초)마다 감사 표 전체를 훑는다. 감사 줄이 10만 줄을 넘으면 기간 제한이나 요약 표로 바꾼다

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_metrics') THEN
    CREATE ROLE svc_metrics NOLOGIN;
  END IF;
  -- 슈퍼유저가 아닌 주인(RDS·CloudNativePG의 앱 소유자)은 이 역할 멤버여야 소유권 넘기기·AUTHORIZATION이 된다
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT svc_metrics TO %I', current_user);
  END IF;
END $$;
GRANT SELECT ON migrations, env_locks, audit_events TO svc_metrics;
CREATE POLICY metrics_read ON migrations FOR SELECT TO svc_metrics USING (true);
CREATE POLICY metrics_read ON env_locks FOR SELECT TO svc_metrics USING (true);
CREATE POLICY metrics_read ON audit_events FOR SELECT TO svc_metrics USING (true);

-- state_buckets_sec: 상태에 머문 시간 히스토그램 경계(초), pause_buckets_ms: 컷오버 멈춤 경계(ms)
-- lease_sec: 환경 잠금 연장 1번이 미는 길이(LEASE.workerSec). 생존 신호 지연 = now() - (기한 - lease_sec)
CREATE FUNCTION metrics_snapshot(state_buckets_sec float8[], pause_buckets_ms float8[], lease_sec int)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH tr AS (
    -- 상태 이동 감사 줄만 (advance() 가 detail 에 from/to 를 남긴다)
    SELECT tenant_id, target, seq, at, detail->>'from' AS frm, detail->>'to' AS dst
      FROM audit_events
     WHERE detail ? 'from' AND detail ? 'to'
  ), dur AS (
    -- 한 상태에 머문 시간 = 이번 이동 시각 - 그 상태로 들어온 이동 시각
    SELECT frm AS state,
           extract(epoch FROM at - lag(at) OVER (PARTITION BY tenant_id, target ORDER BY seq)) AS sec
      FROM tr
  ), pause AS (
    SELECT (m->>'value')::float8 AS ms, a.seq
      FROM audit_events a,
           jsonb_array_elements(COALESCE(a.detail->'measurements', '[]'::jsonb)) m
     WHERE a.action = 'cutover.rollback_window' AND m->>'name' = 'cutover_pause_ms'
  )
  SELECT jsonb_build_object(
    'migrations', COALESCE((SELECT jsonb_object_agg(status, n)
                              FROM (SELECT status, count(*) AS n FROM migrations GROUP BY status) s), '{}'::jsonb),
    'transitions', COALESCE((SELECT jsonb_agg(jsonb_build_object('from', frm, 'to', dst, 'n', n))
                               FROM (SELECT frm, dst, count(*) AS n FROM tr GROUP BY frm, dst) t), '[]'::jsonb),
    'stateDurations', COALESCE((SELECT jsonb_agg(jsonb_build_object('state', state, 'bucket', b, 'n', n, 'sum', s))
                                  FROM (SELECT state, width_bucket(sec, state_buckets_sec) AS b,
                                               count(*) AS n, sum(sec) AS s
                                          FROM dur WHERE sec IS NOT NULL GROUP BY 1, 2) d), '[]'::jsonb),
    'cutoverPause', jsonb_build_object(
      'buckets', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', b, 'n', n))
                             FROM (SELECT width_bucket(ms, pause_buckets_ms) AS b, count(*) AS n
                                     FROM pause GROUP BY 1) p), '[]'::jsonb),
      'count', (SELECT count(*) FROM pause),
      'sum', (SELECT COALESCE(sum(ms), 0) FROM pause),
      'last', (SELECT ms FROM pause ORDER BY seq DESC LIMIT 1)),
    'leases', jsonb_build_object(
      'reserved', (SELECT count(*) FROM env_locks WHERE holder = 'reserved'),
      'held', (SELECT count(*) FROM env_locks WHERE holder LIKE 'worker:%'),
      'expired', (SELECT count(*) FROM env_locks WHERE lease_expires_at < now()),
      'maxHeartbeatLagSec', (SELECT max(extract(epoch FROM now() - (lease_expires_at - make_interval(secs => lease_sec))))
                               FROM env_locks WHERE holder LIKE 'worker:%'))
  )
$$;

-- Z9: 함수 주인을 바꿀 때 새 주인에게 스키마 CREATE 권한이 있어야 한다(PG15+ public 기본 권한 없음, 슈퍼유저만 검사 면제).
--     바꾸는 순간에만 주고 바로 거둔다
GRANT CREATE ON SCHEMA public TO svc_metrics;
ALTER FUNCTION metrics_snapshot(float8[], float8[], int) OWNER TO svc_metrics;
REVOKE CREATE ON SCHEMA public FROM svc_metrics;
REVOKE ALL ON FUNCTION metrics_snapshot(float8[], float8[], int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metrics_snapshot(float8[], float8[], int) TO app_user;

-- 타임라인(GET /api/v1/migrations/:id/timeline)은 이전 하나의 감사 줄을 seq 순으로 읽는다
CREATE INDEX audit_events_target_seq ON audit_events (target, seq);

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다 (Z9 추가)
-- Down Migration
-- DROP INDEX audit_events_target_seq;
-- DROP FUNCTION metrics_snapshot(float8[], float8[], int);
-- DROP POLICY metrics_read ON audit_events; DROP POLICY metrics_read ON env_locks; DROP POLICY metrics_read ON migrations;
