#!/bin/bash
# Z77 DRAFT(ai): 데모 Postgres 첫 기동 때 한 번 (docker-entrypoint-initdb.d). 운영자·RBAC 없이 TLS + 논리 복제를 켠다
#  - 자체 서명 인증서 (이름 z77-demo-pg). 워커는 이 인증서를 CA 로 써서 verify-ca, DB↔DB 는 sslmode=require
#  - 평문 접속은 pg_hba 에서 거절 (공개 LB 뒤라서)
set -euo pipefail
cd "$PGDATA"
openssl req -new -x509 -days 3 -nodes -subj "/CN=z77-demo-pg" -keyout server.key -out server.crt 2>/dev/null
chmod 600 server.key
cat >> postgresql.conf <<CONF
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
wal_level = logical
max_replication_slots = 10
max_wal_senders = 10
max_slot_wal_keep_size = 2GB
CONF
cat > pg_hba.conf <<HBA
local all all trust
hostnossl all all 0.0.0.0/0 reject
hostssl all all 0.0.0.0/0 scram-sha-256
HBA
