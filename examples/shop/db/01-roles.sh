#!/bin/sh
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD 가 .env 에 없다}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_pw="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE shop_owner NOLOGIN;
CREATE ROLE app LOGIN PASSWORD :'app_pw';
GRANT CONNECT ON DATABASE shop TO app;
CREATE SCHEMA shop AUTHORIZATION shop_owner;
GRANT USAGE ON SCHEMA shop TO app;
ALTER ROLE app SET search_path = shop, public;
SQL
