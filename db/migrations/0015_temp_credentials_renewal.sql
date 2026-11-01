-- 0015 (작업 Z61): 임시 자격 재발급을 장부에 잇는다
-- 번호: 0014 = Z49(성능 인덱스, 결정 기록). Z61 은 0015. db-lint S1(번호 연속) 때문에 Z49 0014 가 같이 들어가야 한다
-- 15분 상한 실행 역할을 10분마다 다시 받는다(Jeong 17:03Z 승인값). 재발급 하나 = 새 줄 하나(새 credential_ref).
--   renewed_from = 바로 앞 자격 참조, renew_seq = 몇 번째 재발급인가 (첫 발급 0). 옛 줄은 status='revoked', revoke_reason='renewed'
--   → "apply 하나가 자격 몇 개를 거쳤나"를 사슬로 따라갈 수 있다. 값은 여전히 없다
-- 기존 줄은 renew_seq 0, renewed_from NULL 로 남는다

ALTER TABLE temp_credentials ADD COLUMN renewed_from text REFERENCES temp_credentials(credential_ref);
ALTER TABLE temp_credentials ADD COLUMN renew_seq int NOT NULL DEFAULT 0 CHECK (renew_seq >= 0);
-- 첫 발급이면 앞 참조가 없고, 재발급이면 꼭 있다
ALTER TABLE temp_credentials ADD CONSTRAINT temp_credentials_renew_chain_check
  CHECK ((renew_seq = 0) = (renewed_from IS NULL));
-- 한 자격에서 재발급은 한 번만 갈라진다 (같은 자격을 두 워커가 재발급하는 사고 방지)
CREATE UNIQUE INDEX temp_credentials_renewed_from ON temp_credentials (renewed_from) WHERE renewed_from IS NOT NULL;

-- 권한은 0009 그대로 (SELECT, INSERT, UPDATE). 지우기는 여전히 없다

-- Down Migration
-- DROP INDEX temp_credentials_renewed_from;
-- ALTER TABLE temp_credentials DROP CONSTRAINT temp_credentials_renew_chain_check;
-- ALTER TABLE temp_credentials DROP COLUMN renew_seq, DROP COLUMN renewed_from;
