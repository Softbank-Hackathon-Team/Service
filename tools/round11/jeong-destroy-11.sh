#!/bin/sh
# Z102 round 11 (full): remove everything jeong-up-11.sh and the round created. Jeong runs this one line when the Mac RC asks (≈t0+27).
#   GCP side starts at once: served-by off GKE -> Cloud SQL -> GCP network + GKE (PSA retry, then direct peering delete).
#   AWS side waits for $Q/aws.free (the Mac RC touches it after M3; at most 30 min, then goes anyway):
#     tunnel off -> served-by off EKS -> load balancers 0 -> M1 terraform (tf:real destroy) -> relay -> AWS network + EKS.
# Keeps going past a failure; prints FAIL lines and the leftover counts. Progress: $Q/jeong-destroy.progress
# Based on parallel/Z77/tools/mac/jeong-destroy.sh. Account id read at run time, never written.
# Files the Mac RC leaves in $Q: m1.id (M1 migration id), ctx.eks, ctx.gke (kube context names), aws.free (marker).
set -u
SVC="${SVC:-$HOME/Softbank_final/Service}"
Q="${Q:-$HOME/Softbank_final/sql-prep}"
SQL_DIR="${SQL_DIR:-$HOME/.svc-tf/bprime-sql}"
PROJECT="${PROJECT:-finals-demo}"
P="$Q/jeong-destroy.progress"; cd "$Q" || exit 1
log() { echo "$(date -u +%H:%M:%SZ) $*" | tee -a "$P"; }
export AWS_PROFILE="${AWS_PROFILE:-finals}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TFA="$SVC/infra/modules/aws/env"; TFG="infra/modules/gcp/env"; TFR="infra/modules/aws/demo-relay"
log "start (round 11 full)"

gcp_side() {
  rc=0; t=$(date +%s)
  [ -s "$Q/ctx.gke" ] && kubectl --context "$(cat "$Q/ctx.gke")" delete namespace app-demo app-demo2 --wait=true --ignore-not-found > "$Q/gke-ns.destroy.txt" 2>&1 && log "G served-by off GKE"
  for r in $(terraform -chdir="$SQL_DIR" state list 2>/dev/null | grep -E '^google_sql_(database|user)\.'); do
    terraform -chdir="$SQL_DIR" state rm "$r" >/dev/null 2>&1 && log "G state rm $r"
  done
  terraform -chdir="$SQL_DIR" destroy -auto-approve -input=false -no-color > "$Q/cloudsql.destroy.txt" 2>&1 \
    && log "G Cloud SQL $(grep -E 'Destroy complete' "$Q/cloudsql.destroy.txt") $(( $(date +%s) - t ))s" || { log "G FAIL Cloud SQL destroy"; rc=1; }
  gok=0
  for n in 1 2 3 4; do
    if terraform -chdir="$TFG" destroy -auto-approve -input=false -no-color -var "project_id=$PROJECT" -var create_gke=true > "$Q/gcpenv.destroy.txt" 2>&1; then gok=1; break; fi
    grep -q "still using this connection" "$Q/gcpenv.destroy.txt" || break
    [ $n -lt 4 ] && { log "G GCP network: connection still in use, retry $((n+1))/4 in 240s"; sleep 240; }
  done
  if [ $gok = 0 ] && grep -q "still using this connection" "$Q/gcpenv.destroy.txt"; then
    log "G GCP network: deleting the servicenetworking peering directly"
    gcloud compute networks peerings delete servicenetworking-googleapis-com --network=platform-target --project="$PROJECT" --quiet >> "$Q/gcpenv.destroy.txt" 2>&1
    terraform -chdir="$TFG" state rm google_service_networking_connection.psa >> "$Q/gcpenv.destroy.txt" 2>&1
    terraform -chdir="$TFG" destroy -auto-approve -input=false -no-color -var "project_id=$PROJECT" -var create_gke=true >> "$Q/gcpenv.destroy.txt" 2>&1 && gok=1
  fi
  [ $gok = 1 ] && log "G GCP network + GKE $(grep -E 'Destroy complete' "$Q/gcpenv.destroy.txt" | tail -1) $(( $(date +%s) - t ))s from G start" || { log "G FAIL GCP network destroy"; rc=1; }
  [ $rc = 0 ] && touch "$Q/down.gcp.done" || touch "$Q/down.gcp.fail"
}

aws_side() {
  rc=0; n=0
  while [ ! -f "$Q/aws.free" ] && [ $n -lt 180 ]; do sleep 10; n=$((n+1)); done
  [ -f "$Q/aws.free" ] && log "W aws.free seen" || log "W aws.free not seen in 30 min, going anyway"
  t=$(date +%s)
  # demo-tunnel.sh reconnects every 2s, so stop its loop first (pid file it writes), then the ssh itself
  TP="$HOME/.svc-tf/demo-day/tunnel.pid"
  if [ -f "$TP" ]; then kill "$(cat "$TP")" 2>/dev/null; rm -f "$TP"; fi
  if [ -f "$Q/tunnel.pid" ]; then kill "$(cat "$Q/tunnel.pid")" 2>/dev/null; rm -f "$Q/tunnel.pid"; fi
  pkill -f "ssh -N .*-R 0.0.0.0:5432:localhost:55434" 2>/dev/null && log "W tunnel stopped"
  [ -s "$Q/ctx.eks" ] && kubectl --context "$(cat "$Q/ctx.eks")" delete namespace app-demo app-demo2 --wait=true --ignore-not-found > "$Q/eks-ns.destroy.txt" 2>&1 && log "W served-by off EKS"
  VPC="$(terraform -chdir="$TFA" output -raw vpc_id 2>/dev/null)"
  if [ -n "$VPC" ]; then
    k=0
    while [ $k -lt 18 ]; do
      lb="$(aws elbv2 describe-load-balancers --query "length(LoadBalancers[?VpcId=='$VPC'])" --output text 2>/dev/null || echo 0)"
      clb="$(aws elb describe-load-balancers --query "length(LoadBalancerDescriptions[?VPCId=='$VPC'])" --output text 2>/dev/null || echo 0)"
      [ "$lb" = 0 ] && [ "$clb" = 0 ] && break
      sleep 10; k=$((k+1))
    done
    log "W load balancers in VPC: ${lb:-?}/${clb:-?} after $((k*10))s"
  fi
  if [ -s "$Q/m1.id" ]; then
    ( cd "$SVC" && npm run -s tf:real -- destroy "$(cat "$Q/m1.id")" ) > "$Q/m1.destroy.txt" 2>&1 \
      && log "W M1 RDS $(grep -E 'OK destroy|Destroy complete' "$Q/m1.destroy.txt" | tail -1)" || { log "W FAIL M1 destroy (m1.destroy.txt)"; rc=1; }
  else log "W no m1.id -> M1 destroy skipped (check: npm run tf:real -- list)"; fi
  RELAY_VPC="$(jq -r '[.resources[] | select(.type == "aws_security_group") | .instances[0].attributes.vpc_id][0] // "x"' "$TFR/terraform.tfstate" 2>/dev/null || echo x)"
  terraform -chdir="$TFR" destroy -auto-approve -input=false -no-color \
    -var "vpc_id=$RELAY_VPC" -var "public_subnet_id=x" -var "ssh_public_key=x" -var 'ssh_cidrs_json=["127.0.0.1/32"]' > "$Q/relay.destroy.txt" 2>&1 \
    && log "W relay $(grep -E 'Destroy complete' "$Q/relay.destroy.txt")" || { log "W FAIL relay destroy"; rc=1; }
  terraform -chdir="$TFA" destroy -auto-approve -input=false -no-color -var "expected_account_id=$ACCOUNT_ID" -var create_eks=true > "$Q/awsenv.destroy.txt" 2>&1 \
    && log "W AWS network + EKS $(grep -E 'Destroy complete' "$Q/awsenv.destroy.txt") $(( $(date +%s) - t ))s" || { log "W FAIL AWS network destroy"; rc=1; }
  [ $rc = 0 ] && touch "$Q/down.aws.done" || touch "$Q/down.aws.fail"
}

rm -f "$Q"/down.*.done "$Q"/down.*.fail
gcp_side & G=$!
aws_side & W=$!
wait $G; wait $W
log "Cloud SQL left: $(gcloud sql instances list --project="$PROJECT" --format='value(name)' 2>/dev/null | wc -l | tr -d ' ')"
log "GKE left: $(gcloud container clusters list --project="$PROJECT" --format='value(name)' 2>/dev/null | wc -l | tr -d ' ')"
log "EKS left: $(aws eks list-clusters --query 'length(clusters)' --output text 2>/dev/null)"
log "RDS left: $(aws rds describe-db-instances --query 'length(DBInstances)' --output text 2>/dev/null)"
log "relay left: $(aws ec2 describe-instances --filters Name=tag:purpose,Values=z77-demo-relay Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations)' --output text 2>/dev/null)"
if [ -f "$Q/down.gcp.done" ] && [ -f "$Q/down.aws.done" ]; then log "완료"; exit 0; else log "일부 실패 (위 FAIL 줄)"; exit 1; fi
