-- 0032: LLM 지출 합 표·함수의 주인을 슈퍼유저(표 주인 계정)에서 전용 역할로 (db-lint D7)
-- 0021 은 SECURITY DEFINER 함수 2개와 합 표를 마이그레이션 실행 계정이 그대로 주인으로 두었다. 개발 DB 처럼 그 계정이 슈퍼유저면
-- DEFINER 함수가 슈퍼유저 권한으로 돈다(search_path 를 고정했어도 위험한 모양). 다른 DEFINER 함수(0003·0010·0019)처럼
-- 로그인 못 하는 전용 역할 svc_spend 가 주인이 되게 한다. 함수가 하는 일(합 표에 더하기 / 숫자 하나 읽기)은 그대로.
-- 합 표(llm_spend_global)는 회사 번호 칸이 없다: app_user 에게 아무 권한도 주지 않고 DEFINER 함수로만 접근 (db-lint D5 가 이 조건을 본다)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_spend') THEN
    CREATE ROLE svc_spend NOLOGIN;
  END IF;
  -- 슈퍼유저가 아닌 주인(RDS·CloudNativePG의 앱 소유자)은 이 역할 멤버여야 소유권을 넘길 수 있다
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT svc_spend TO %I', current_user);
  END IF;
END $$;

-- 새 주인은 스키마에 CREATE 가 있어야 한다(PG 문서 ALTER TABLE/FUNCTION). 넘긴 뒤 바로 거둔다
GRANT CREATE ON SCHEMA public TO svc_spend;
ALTER TABLE llm_spend_global OWNER TO svc_spend;
ALTER FUNCTION llm_spend_global_add() OWNER TO svc_spend;
ALTER FUNCTION llm_spend_round_total(text) OWNER TO svc_spend;
REVOKE CREATE ON SCHEMA public FROM svc_spend;
GRANT USAGE ON SCHEMA public TO svc_spend;
-- 주인이 바뀌면 PUBLIC 실행 권한 설정은 그대로지만, 명시로 다시 적어 둔다
REVOKE ALL ON llm_spend_global FROM PUBLIC;
REVOKE ALL ON FUNCTION llm_spend_global_add() FROM PUBLIC;
REVOKE ALL ON FUNCTION llm_spend_round_total(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llm_spend_round_total(text) TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- ALTER TABLE llm_spend_global OWNER TO CURRENT_USER; ALTER FUNCTION llm_spend_global_add() OWNER TO CURRENT_USER; ALTER FUNCTION llm_spend_round_total(text) OWNER TO CURRENT_USER;
