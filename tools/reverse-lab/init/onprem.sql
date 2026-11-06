-- 온프레 CNPG 자리. gitops/charts/app/templates/cnpg.yaml 이 만드는 모양을 따른다 (superuser 없이 돈다는 것을 같이 확인하려는 것)
--   initdb: database=shop, owner=shop_app (앱도 이 계정으로 붙는다. 온프레 앱 차트의 기본)
--   managed role svc_migrate: LOGIN REPLICATION CREATEROLE INHERIT, inRoles = [pg_create_subscription, shop_app]
-- 비밀번호는 실험장 전용 고정값이다 (이 컨테이너 밖으로 나가지 않는다)
CREATE ROLE shop_app LOGIN PASSWORD 'lab-shop-app';
CREATE DATABASE shop OWNER shop_app;
CREATE ROLE svc_migrate LOGIN REPLICATION CREATEROLE INHERIT PASSWORD 'lab-svc-migrate';
GRANT pg_create_subscription TO svc_migrate;
GRANT shop_app TO svc_migrate;
