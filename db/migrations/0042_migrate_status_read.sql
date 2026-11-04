-- 0042 (PF FM-ORC-26): 워커·API 가 시작할 때 "안 넣은 마이그레이션"이 있는지 본다 (core migrations-check).
--   예전엔 base 를 바꾸고 db:migrate 를 잊어도 readyz ok·워커 정상 → shifting 에서 traffic_lease_take 없음으로 paused.
-- 기록 표 migrate.applied 는 실행기(tools/db-migrate.sh)가 만든다. 앱 계정에 읽기만 연다 (쓰기·지우기 없음).
-- docker 초기화 폴더로 만든 DB 에는 migrate 스키마가 없을 수 있어 있을 때만
DO $$
BEGIN
  IF to_regclass('migrate.applied') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA migrate TO app_user;
    GRANT SELECT ON migrate.applied TO app_user;
  END IF;
END $$;

-- forward-only
-- Down Migration
-- REVOKE SELECT ON migrate.applied FROM app_user; REVOKE USAGE ON SCHEMA migrate FROM app_user;
