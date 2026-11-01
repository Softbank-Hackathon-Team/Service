-- 실제 LLM 지출 (z75-64). 회사·회차(LLM_BUDGET_ROUND, 기본 오늘 날짜 UTC)마다 한 줄: 쓴 달러(토큰 × 단가 추정)와 호출 수
-- agent-worker 가 실제 API 를 부르기 전에 읽어 상한(LLM_BUDGET_USD, 기본 $2) 이상이면 부르지 않고, 부른 뒤 더한다. 캐시에서 꺼낸 응답은 안 더한다 (0원)
-- 데모 초기화(tools/demo-reset.sh)는 이 표를 지우지 않는다 (실제 돈이라 초기화로 0 이 되면 안 된다). 새 회차는 LLM_BUDGET_ROUND 이름을 바꿔 연다
CREATE TABLE llm_spend (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  round       text NOT NULL CHECK (round ~ '^[A-Za-z0-9._:-]{1,64}$'),
  usd         numeric(12, 6) NOT NULL DEFAULT 0 CHECK (usd >= 0),
  calls       int NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, round)
);

ALTER TABLE llm_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_spend FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_wall ON llm_spend
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 지우기 권한은 안 준다 (쓴 돈 기록은 남긴다)
GRANT SELECT, INSERT, UPDATE ON llm_spend TO app_user;

-- 모든 회사 합 (Z38 R8-48: API 키가 하나라 회사마다 상한을 두면 회사 N개면 N×상한). 합 표는 회사 벽이 없고 app_user 는 직접 못 본다
-- 트리거(SECURITY DEFINER)가 llm_spend 가 늘 때 차이만큼 더하고, app_user 는 숫자 하나를 돌려주는 함수로만 읽는다 (다른 회사 줄은 안 보임)
CREATE TABLE llm_spend_global (
  round       text PRIMARY KEY CHECK (round ~ '^[A-Za-z0-9._:-]{1,64}$'),
  usd         numeric(14, 6) NOT NULL DEFAULT 0 CHECK (usd >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON llm_spend_global FROM PUBLIC;

CREATE FUNCTION llm_spend_global_add() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d numeric := NEW.usd - CASE WHEN TG_OP = 'UPDATE' THEN OLD.usd ELSE 0 END;
BEGIN
  IF d <> 0 THEN
    INSERT INTO llm_spend_global (round, usd) VALUES (NEW.round, d)
    ON CONFLICT (round) DO UPDATE SET usd = llm_spend_global.usd + EXCLUDED.usd, updated_at = now();
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION llm_spend_global_add() FROM PUBLIC;
CREATE TRIGGER llm_spend_global_add AFTER INSERT OR UPDATE OF usd ON llm_spend
  FOR EACH ROW EXECUTE FUNCTION llm_spend_global_add();

CREATE FUNCTION llm_spend_round_total(p_round text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT usd FROM llm_spend_global WHERE round = p_round), 0)
$$;
REVOKE ALL ON FUNCTION llm_spend_round_total(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llm_spend_round_total(text) TO app_user;

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- DROP TRIGGER llm_spend_global_add ON llm_spend; DROP FUNCTION llm_spend_round_total(text); DROP FUNCTION llm_spend_global_add(); DROP TABLE llm_spend_global; DROP TABLE llm_spend;
