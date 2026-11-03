#!/bin/sh
# Z102 round 11 (full): create every cloud piece in one line. Jeong runs this. Based on parallel/Z77/tools/mac/jeong-up.sh.
#   A: AWS network (no EKS) -> relay (no Cloud SQL IP yet) -> add EKS          markers $Q/up.aws.done, up.relay.done, up.eks.done
#   B: GCP network (no GKE) -> [Cloud SQL || add GKE] -> add Cloud SQL IP to relay  markers $Q/up.sql.done, up.gke.done, up.relay2.done
# Why this order: M1 (on-prem -> aws) needs the relay + tunnel for its sync, so the relay comes right after the AWS network (t0+4),
# not after Cloud SQL (t0+17). Clusters are added later so they never hold up M1 or Cloud SQL.
# Values (IPs, passwords) never go to the screen or to files outside ~/.svc-tf and $Q. Progress: $Q/jeong-up.progress. End: $Q/up.done
# Pair: jeong-destroy-11.sh. Needs int5-9 + z77-sql-edition + z77-sql-no-gke + z77-bprime (tf:real export).
set -u
SVC="${SVC:-$HOME/Softbank_final/Service}"
Q="${Q:-$HOME/Softbank_final/sql-prep}"
SQL_DIR="${SQL_DIR:-$HOME/.svc-tf/bprime-sql}"
PROJECT="${PROJECT:-finals-demo}"
P="$Q/jeong-up.progress"
mkdir -p "$Q" && cd "$Q" || exit 1
rm -f "$Q"/up.*.done "$Q/up.done" "$Q"/up.*.fail
log() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a "$P"; }
command -v jq >/dev/null 2>&1 || { log "FAIL: jq 없음 (맥: brew install jq)"; exit 1; }
export AWS_PROFILE="${AWS_PROFILE:-finals}"
MAC_IP="$(curl -s ifconfig.me)"
[ -n "$MAC_IP" ] || { log "FAIL: no public IP"; exit 1; }
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TFA="$SVC/infra/modules/aws/env"
TFG="infra/modules/gcp/env"
TFR="infra/modules/aws/demo-relay"
log "start (round 11 full)"

# Facts for the worker (z102-01): the Mac RC cannot read .env, so this script (Jeong's shell) writes the on-prem DB account
# once into a 0600 file; the worker fills {tf:onprem_*} from it. Values never go to the screen.
F="$HOME/.svc-tf/r11"; mkdir -p "$F" && chmod 700 "$F"
( umask 077; R11_URL="$(grep -E '^REPL_SOURCE_URL=' "$SVC/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')" \
  node -e 'const u=new URL(process.env.R11_URL);process.stdout.write(JSON.stringify({onprem_user:decodeURIComponent(u.username),onprem_password:decodeURIComponent(u.password),onprem_host:u.hostname,onprem_port:u.port||"5432",onprem_db:u.pathname.slice(1)}))' > "$F/onprem.json" ) \
  && log "facts: onprem.json ok" || { log "FAIL facts: REPL_SOURCE_URL in .env not readable as a URL"; exit 1; }

relay_apply() {
  terraform -chdir="$TFR" apply -auto-approve -input=false -no-color -var "vpc_id=$1" -var "public_subnet_id=$2" \
    -var "ssh_public_key=$(cat ~/.ssh/id_ed25519.pub)" -var "ssh_cidrs_json=[\"$MAC_IP/32\"]" -var "extra_pg_cidrs_json=$3"
}

branch_a() {
  t=$(date +%s)
  terraform -chdir="$TFA" init -input=false -no-color > "$Q/awsenv.up.txt" 2>&1
  terraform -chdir="$TFA" apply -auto-approve -input=false -no-color -var "expected_account_id=$ACCOUNT_ID" -var create_eks=false >> "$Q/awsenv.up.txt" 2>&1 \
    || { log "A FAIL AWS network (awsenv.up.txt)"; touch "$Q/up.aws.fail"; return; }
  log "A AWS network ok $(( $(date +%s) - t ))s"; touch "$Q/up.aws.done"
  VPC="$(terraform -chdir="$TFA" output -raw vpc_id)"
  SUBNET="$(terraform -chdir="$TFA" output -json public_subnet_ids | jq -r '.[0]')"
  printf '%s %s\n' "$VPC" "$SUBNET" > "$Q/relay.where"
  t=$(date +%s)
  terraform -chdir="$TFR" init -input=false -no-color > "$Q/relay.up.txt" 2>&1
  if relay_apply "$VPC" "$SUBNET" '[]' >> "$Q/relay.up.txt" 2>&1
  then mkdir -p "$HOME/.svc-tf/demo-day" && terraform -chdir="$TFR" output -raw public_ip > "$HOME/.svc-tf/demo-day/relay_ip"
       log "A relay ok $(( $(date +%s) - t ))s. next: tunnel line (bash tools/demo-tunnel.sh)"; touch "$Q/up.relay.done"; else log "A FAIL relay (relay.up.txt)"; touch "$Q/up.relay.fail"; fi
  t=$(date +%s)
  if terraform -chdir="$TFA" apply -auto-approve -input=false -no-color -var "expected_account_id=$ACCOUNT_ID" -var create_eks=true > "$Q/eks.up.txt" 2>&1
  then log "A EKS ok $(( $(date +%s) - t ))s"; touch "$Q/up.eks.done"; else log "A FAIL EKS (eks.up.txt)"; touch "$Q/up.eks.fail"; fi
}

sql_part() {
  t=$(date +%s)
  ( cd "$SVC" && TF_FACT_PROJECT_ID="$PROJECT" \
      TF_FACT_NETWORK_ID="$NET_ID" \
      TF_FACT_CLUSTER_NAME="" TF_FACT_CLUSTER_LOCATION="$NET_LOC" \
      DB_PUBLIC=1 DB_DISPOSABLE=1 DB_PEER_CIDRS="$MAC_IP/32" npm run -s tf:real -- export gcp "$SQL_DIR" --no-identity ) > "$Q/cloudsql.up.txt" 2>&1 \
    || { log "B FAIL export (cloudsql.up.txt)"; touch "$Q/up.sql.fail"; return; }
  terraform -chdir="$SQL_DIR" init -input=false -no-color >> "$Q/cloudsql.up.txt" 2>&1
  if terraform -chdir="$SQL_DIR" apply -auto-approve -input=false -no-color >> "$Q/cloudsql.up.txt" 2>&1
  then log "B Cloud SQL ok $(( $(date +%s) - t ))s"; touch "$Q/up.sql.done"; else log "B FAIL Cloud SQL (cloudsql.up.txt)"; touch "$Q/up.sql.fail"; fi
}

gke_part() {
  # Z77: start GKE 150s after Cloud SQL so the GKE control-plane peering and the servicenetworking peering do not race
  # ("peering operation in progress"); the apply is idempotent, so one retry covers a race anyway.
  sleep 150
  t=$(date +%s)
  if terraform -chdir="$TFG" apply -auto-approve -input=false -no-color -var "project_id=$PROJECT" -var create_gke=true > "$Q/gke.up.txt" 2>&1 \
     || { log "B GKE retry once"; sleep 30; terraform -chdir="$TFG" apply -auto-approve -input=false -no-color -var "project_id=$PROJECT" -var create_gke=true >> "$Q/gke.up.txt" 2>&1; }
  then log "B GKE ok $(( $(date +%s) - t ))s"; touch "$Q/up.gke.done"; else log "B FAIL GKE (gke.up.txt)"; touch "$Q/up.gke.fail"; fi
}

branch_b() {
  t=$(date +%s)
  terraform -chdir="$TFG" init -input=false -no-color > "$Q/gcpenv.up.txt" 2>&1
  terraform -chdir="$TFG" apply -auto-approve -input=false -no-color -var "project_id=$PROJECT" -var create_gke=false >> "$Q/gcpenv.up.txt" 2>&1 \
    || { log "B FAIL GCP network (gcpenv.up.txt)"; touch "$Q/up.sql.fail" "$Q/up.gke.fail"; return; }
  log "B GCP network ok $(( $(date +%s) - t ))s"
  NET_ID="$(terraform -chdir="$TFG" output -raw network_id)"
  NET_LOC="$(terraform -chdir="$TFG" output -raw cluster_location)"
  sql_part & S=$!
  gke_part & G=$!
  wait $S; wait $G
  [ -f "$Q/up.sql.done" ] || return
  csql_facts
  n=0
  while [ ! -f "$Q/up.relay.done" ] && [ ! -f "$Q/up.relay.fail" ] && [ ! -f "$Q/up.aws.fail" ] && [ $n -lt 60 ]; do sleep 10; n=$((n+1)); done
  [ -f "$Q/up.relay.done" ] || { log "B skip relay update (no relay)"; return; }
  t=$(date +%s)
  OUT_IP="$(terraform -chdir="$SQL_DIR" output -raw db_outgoing_ip)"
  read -r VPC SUBNET < "$Q/relay.where"
  # Z77: the update must only change the security group (tunnel stays up). Check the plan first; anything else -> do not apply.
  terraform -chdir="$TFR" plan -input=false -no-color -var "vpc_id=$VPC" -var "public_subnet_id=$SUBNET" \
    -var "ssh_public_key=$(cat ~/.ssh/id_ed25519.pub)" -var "ssh_cidrs_json=[\"$MAC_IP/32\"]" -var "extra_pg_cidrs_json=[\"$OUT_IP/32\"]" > "$Q/relay2.plan.txt" 2>&1
  grep -q "0 to add, 1 to change, 0 to destroy" "$Q/relay2.plan.txt" \
    || { log "B FAIL relay update plan is not '0 to add, 1 to change, 0 to destroy' (relay2.plan.txt) -> not applied"; touch "$Q/up.relay2.fail"; return; }
  if relay_apply "$VPC" "$SUBNET" "[\"$OUT_IP/32\"]" > "$Q/relay2.up.txt" 2>&1
  then log "B relay + Cloud SQL IP ok $(( $(date +%s) - t ))s"; touch "$Q/up.relay2.done"; else log "B FAIL relay update (relay2.up.txt)"; touch "$Q/up.relay2.fail"; fi
  terraform -chdir="$SQL_DIR" output -raw db_server_ca_cert > "$HOME/.svc-tf/csql-ca.pem"
}

csql_facts() {
  ( umask 077
    R11_PW="$(gcloud secrets versions access latest --project="$PROJECT" --secret="$(terraform -chdir="$SQL_DIR" output -raw db_password_secret_id)")" \
    R11_IP="$(terraform -chdir="$SQL_DIR" output -raw db_public_ip)" \
    node -e 'process.stdout.write(JSON.stringify({csql_user:"app",csql_password:process.env.R11_PW,csql_address:process.env.R11_IP}))' > "$F/csql.json" ) \
    && [ -s "$F/csql.json" ] && log "facts: csql.json ok" || log "FAIL facts: csql.json"
}

branch_a & A=$!
branch_b & B=$!
wait $A; wait $B
ls "$Q"/up.*.done "$Q"/up.*.fail 2>/dev/null | sed "s|$Q/||" | tr '\n' ' ' | sed 's/^/markers: /' | tee -a "$P"; echo >> "$P"
if [ -f "$Q/up.aws.done" ] && [ -f "$Q/up.relay.done" ]; then log "done (see markers; a FAIL branch only skips its steps). Run jeong-destroy-11.sh at the end in any case."; touch "$Q/up.done"
else log "stop: AWS network or relay failed. Run jeong-destroy-11.sh to clean up."; exit 1; fi
