#!/bin/sh
# 비밀번호는 환경 변수(= compose .env, 실환경은 Secret)에서 받아 userlist 를 만든다. 이미지·폴더에 비밀값을 넣지 않는다
set -eu
: "${APP_DB_PASSWORD:?}" "${PGB_ADMIN_PASSWORD:?}"
(umask 077; printf '"app" "%s"\n"pgb_admin" "%s"\n' "$APP_DB_PASSWORD" "$PGB_ADMIN_PASSWORD" > /etc/pgbouncer/userlist.txt)
# 대상 줄 파일이 아직 없으면 GitOps 값(DBPROXY_ACTIVE)에 맞는 첫 줄을 쓴다. 이후엔 제어 옆차가 바꾼다
if [ ! -s /etc/pgbouncer/dyn/databases.ini ]; then
  case "${DBPROXY_ACTIVE:-source}" in target) H=$TARGET_HOST ;; *) H=$SOURCE_HOST ;; esac
  printf '[databases]\nshop = host=%s port=5432 dbname=shop\n' "$H" > /etc/pgbouncer/dyn/databases.ini
fi
exec pgbouncer /etc/pgbouncer/pgbouncer.ini
