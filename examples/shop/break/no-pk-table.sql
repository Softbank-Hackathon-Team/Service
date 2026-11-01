-- 셀프 연습용: 기본키 없는 표를 하나 만든다 → 복제 사전 점검 DB-T2 가 실패해야 한다.
-- 되돌리기: break/fix-no-pk-table.sql
SET ROLE shop_owner;
CREATE TABLE shop.audit_log (at timestamptz NOT NULL DEFAULT now(), message text NOT NULL);
RESET ROLE;
GRANT SELECT, INSERT ON shop.audit_log TO app;
