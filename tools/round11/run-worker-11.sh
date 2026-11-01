#!/bin/sh
# Z102 round 11: (re)start the one worker with the replication settings of one direction. The Mac RC runs this between migrations.
#   sh tools/round11/run-worker-11.sh m1   on-prem -> aws RDS, real terraform (MOCK_IAC empty), traffic mock
#   sh tools/round11/run-worker-11.sh m5   aws RDS (M1's) -> on-prem DB shop_rev_aws          (target via imported.json)
#   sh tools/round11/run-worker-11.sh m2   on-prem -> Cloud SQL
#   sh tools/round11/run-worker-11.sh m4   Cloud SQL -> on-prem DB shop_rev_gcp              (target via imported.json)
#   sh tools/round11/run-worker-11.sh m3a  on-prem -> aws RDS DB shop_m3a (imported), real Cloudflare, TRAFFIC_OBSERVE_SEC=20
#   sh tools/round11/run-worker-11.sh m3b  on-prem -> aws RDS DB shop_m3b (imported), real Cloudflare, ROLLBACK_WINDOW_SEC=3
#   sh tools/round11/run-worker-11.sh stop
# Reads no .env itself (the Mac RC may not): npm run dev:worker loads .env on its own, and the values set here win over it
#   (node --env-file never overrides a variable that is already set). Secrets reach the worker only as {tf:key} references,
#   filled at run time by the worker from 0600 files: the migration's own folder (outputs.json, db-secret.json) and
#   REPL_FACTS_FILES = ~/.svc-tf/r11/onprem.json + csql.json, which jeong-up-11.sh (Jeong) writes. Needs patch z102-01-facts-files.
# Non-secret inputs: $Q/m1.id, relay IPs and AWS network ids (terraform output), $Q/cf.ids (LB and pool ids, M3a/M3b only).
# Writes: $Q/worker.pid, $Q/worker-<mode>.log. Never writes a value to a file or the screen.
set -u
SVC="${SVC:-$HOME/Softbank_final/Service}"
Q="${Q:-$HOME/Softbank_final/sql-prep}"
SQL_DIR="${SQL_DIR:-$HOME/.svc-tf/bprime-sql}"
MODE="${1:?m1|m5|m2|m4|m3a|m3b|stop}"
TSLUG="t-66666666"
RDS_CA="$HOME/.svc-tf/rds-ap-northeast-2-bundle.pem"
CSQL_CA="$HOME/.svc-tf/csql-ca.pem"
TFR="$Q/infra/modules/aws/demo-relay"
TFA="$SVC/infra/modules/aws/env"

if [ -f "$Q/worker.pid" ]; then
  kill "$(cat "$Q/worker.pid")" 2>/dev/null
  n=0; while kill -0 "$(cat "$Q/worker.pid")" 2>/dev/null && [ $n -lt 20 ]; do sleep 1; n=$((n+1)); done
  rm -f "$Q/worker.pid"; echo "worker stopped"
fi
[ "$MODE" = stop ] && exit 0

cd "$SVC" || exit 1
export AWS_PROFILE="${AWS_PROFILE:-finals}"
F="$HOME/.svc-tf/r11"
[ -s "$F/onprem.json" ] || { echo "no $F/onprem.json (jeong-up-11.sh writes it)"; exit 1; }
MAC_IP="$(curl -s ifconfig.me)"
RELAY_PRIV="$(terraform -chdir="$TFR" output -raw private_ip)"
RELAY_PUB="$(terraform -chdir="$TFR" output -raw public_ip)"
[ -s "$RDS_CA" ] || curl -sS -o "$RDS_CA" --create-dirs https://truststore.pki.rds.amazonaws.com/ap-northeast-2/ap-northeast-2-bundle.pem

ONPREM_LOCAL='{tf:onprem_user}:{tf:onprem_password}@{tf:onprem_host}:{tf:onprem_port}'
ONPREM_VIA() { printf '{tf:onprem_user}:{tf:onprem_password}@%s:5432' "$1"; }
RDS='{tf:db_username}:{tf:db_password}@{tf:db_address}:5432'
CSQL='{tf:csql_user}:{tf:csql_password}@{tf:csql_address}:5432'

# common: real paths, no test switches; GitOps off (Argo is checked in A1); fake metrics shortened.
# Every REPL_* the round uses is set here (empty = off) so that older REPL_* lines in .env cannot leak in.
export MOCK_IAC= MOCK_ARGO= MOCK_SEED= MOCK_PRECHECK= FAKE_LLM= DEV_AUTH=
export ONPREM_KUBE_CONTEXT="${ONPREM_KUBE_CONTEXT_R11:-k3s-onprem}"
export GITOPS_DISABLE=1 PROM_URL= TRAFFIC_OBSERVE_SEC=1 ROLLBACK_WINDOW_SEC=3 REPL_COPY_SCHEMA=1 TF_FACT_CLUSTER_NAME=
export TRAFFIC_PROVIDER= TRAFFIC_LB_ID= CF_SOURCE_POOL_ID= CF_TARGET_POOL_ID= CLOUDFLARE_SOURCE_POOL_ID= CLOUDFLARE_TARGET_POOL_ID=
export REPL_FACTS_FILES="$F/onprem.json,$F/csql.json" REPL_EPHEMERAL_USER=
export REPL_SOURCE_CA_FILE= REPL_TARGET_CA_FILE= REPL_TARGET_APP_ROLE= REPL_SOURCE_APP_ROLE=
export REPL_SOURCE_PROVIDER=cnpg REPL_SOURCE_SSLMODE=disable REPL_SOURCE_URL="postgres://$ONPREM_LOCAL/{tf:onprem_db}"
export TF_FACT_VPC_ID="$(terraform -chdir="$TFA" output -raw vpc_id)"
export TF_FACT_DB_SUBNET_IDS_JSON="$(terraform -chdir="$TFA" output -json db_subnet_ids)"
export TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON="$(terraform -chdir="$TFA" output -json public_subnet_ids)"
export DB_PUBLIC=1 DB_DISPOSABLE=1 DB_PEER_CIDRS="$MAC_IP/32,$RELAY_PRIV/32"

to_rds() {
  export REPL_SOURCE_PEER_URL="postgres://$(ONPREM_VIA "$RELAY_PRIV")/{tf:onprem_db}?sslmode=require"
  export REPL_TARGET_PROVIDER=rds REPL_TARGET_SSLMODE=verify-full REPL_TARGET_CA_FILE="$RDS_CA"
  export REPL_TARGET_URL="postgres://$RDS/$1"
  export REPL_TARGET_PEER_URL="postgres://$RDS/$1?sslmode=require"
}
cf_on() {
  [ -s "$Q/cf.ids" ] || { echo "no $Q/cf.ids (TRAFFIC_PROVIDER, TRAFFIC_LB_ID, CF_SOURCE_POOL_ID, CF_TARGET_POOL_ID lines from cf:check --keep)"; exit 1; }
  set -a; . "$Q/cf.ids"; set +a
  export TRAFFIC_PROVIDER=cloudflare
}

case "$MODE" in
  m1)  to_rds shop_api ;;
  m3a) to_rds shop_m3a; cf_on; export TRAFFIC_OBSERVE_SEC=20 ;;
  m3b) to_rds shop_m3b; cf_on ;;
  m5)
    export REPL_SOURCE_PROVIDER=rds REPL_SOURCE_SSLMODE=verify-full REPL_SOURCE_CA_FILE="$RDS_CA"
    export REPL_SOURCE_URL="postgres://$RDS/shop_api"
    export REPL_SOURCE_PEER_URL="postgres://$RDS/shop_api?sslmode=require"
    export REPL_TARGET_PROVIDER=cnpg REPL_TARGET_SSLMODE=disable
    export REPL_TARGET_URL="postgres://$ONPREM_LOCAL/shop_rev_aws"
    export REPL_TARGET_PEER_URL="postgres://$(ONPREM_VIA "$RELAY_PRIV")/shop_rev_aws?sslmode=require" ;;
  m2)
    [ -s "$F/csql.json" ] || { echo "no $F/csql.json"; exit 1; }
    export REPL_SOURCE_PEER_URL="postgres://$(ONPREM_VIA "$RELAY_PUB")/{tf:onprem_db}?sslmode=require"
    export REPL_TARGET_PROVIDER=cloudsql REPL_TARGET_SSLMODE=verify-ca REPL_TARGET_CA_FILE="$CSQL_CA" REPL_TARGET_APP_ROLE=shop_app
    export REPL_TARGET_URL="postgres://$CSQL/shop_api"
    export REPL_TARGET_PEER_URL="postgres://$CSQL/shop_api?sslmode=require" ;;
  m4)
    [ -s "$F/csql.json" ] || { echo "no $F/csql.json"; exit 1; }
    export REPL_SOURCE_PROVIDER=cloudsql REPL_SOURCE_SSLMODE=verify-ca REPL_SOURCE_CA_FILE="$CSQL_CA"
    export REPL_SOURCE_URL="postgres://$CSQL/shop_api"
    export REPL_SOURCE_PEER_URL="postgres://$CSQL/shop_api?sslmode=require"
    export REPL_TARGET_PROVIDER=cnpg REPL_TARGET_SSLMODE=disable
    export REPL_TARGET_URL="postgres://$ONPREM_LOCAL/shop_rev_gcp"
    export REPL_TARGET_PEER_URL="postgres://$(ONPREM_VIA "$RELAY_PUB")/shop_rev_gcp?sslmode=require" ;;
  *) echo "unknown mode $MODE"; exit 2 ;;
esac

nohup npm run dev:worker > "$Q/worker-$MODE.log" 2>&1 &
echo $! > "$Q/worker.pid"
sleep 8
if kill -0 "$(cat "$Q/worker.pid")" 2>/dev/null; then echo "worker $MODE up (log $Q/worker-$MODE.log)"; else echo "worker $MODE died (log $Q/worker-$MODE.log)"; exit 1; fi
