-- 클라우드 RDS 자리 (도착). RDS 마스터 계정 흉내: superuser 아님, CREATEROLE·CREATEDB, 구독 만들기 가능
-- 실제 RDS 와 다른 점 (README "실제와 다른 점"):
--   RDS 는 마스터에 REPLICATION 속성을 못 주고 rds_replication 역할 멤버십으로 준다. 일반 Postgres 에서는 그 역할을 흉내 낼 수 없어
--   여기서는 속성을 직접 준다. 그래서 이 실험장의 클라우드 끝점 provider 는 "rds" 가 아니라 "postgres" 다
CREATE ROLE app LOGIN PASSWORD 'lab-cloud-admin' CREATEROLE CREATEDB REPLICATION;
GRANT pg_create_subscription TO app;
CREATE DATABASE shop OWNER app;
