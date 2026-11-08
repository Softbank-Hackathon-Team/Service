#!/usr/bin/env bash
# Demo helper: plays the "customer tooling" role for GCP targets so a migration does not pause at
# SECRET_VALUES_MISSING. The platform never copies secret values (APP-20); this script does it from
# outside the platform, the way a customer would, while a migration runs.
#
# What it does, every INTERVAL seconds:
#   1. list Secret Manager containers in TARGET_PROJECT labeled managed-by=platform
#   2. for each container with no version whose suffix is in FILL_SUFFIXES
#      (name = app-<labels.app>-<suffix>, suffix = source k8s Secret name)
#   3. read that k8s Secret from the source cluster (SRC_KUBECONFIG, SRC_NS) and add a version
#      holding JSON {"KEY": "value", ...} (the chart ExternalSecret reads remoteRef.property = KEY)
# Values only pass through a 0600 temp file; nothing is printed or passed as an argument.
#
# DRAFT(ai): defaults are the 2026-11-08 demo1 pair (src-shop-jun real-app -> iron-target-gcp).
# DRAFT(ai): only api-secrets by default. DB password containers are filled by the platform itself
#            (Cloud SQL creates them), and copying the source DB password into GCP is not wanted.
# Stop with Ctrl-C.
set -euo pipefail
TARGET_PROJECT=${TARGET_PROJECT:-iron-target-gcp}
SRC_KUBECONFIG=${SRC_KUBECONFIG:?set SRC_KUBECONFIG to a kubeconfig that can read Secrets in the source namespace}
SRC_NS=${SRC_NS:-real-app}
FILL_SUFFIXES=${FILL_SUFFIXES:-api-secrets}
INTERVAL=${INTERVAL:-10}

work=$(mktemp -d); chmod 700 "$work"; trap 'rm -rf "$work"' EXIT
umask 077
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

fill_one() {   # $1 = container name, $2 = source secret name
  KUBECONFIG=$SRC_KUBECONFIG kubectl -n "$SRC_NS" get secret "$2" -o json > "$work/src.json" 2>/dev/null \
    || { log "skip $1: source secret $SRC_NS/$2 not found"; return 0; }
  python3 -I -c 'import base64,json,sys
d=json.load(open(sys.argv[1])).get("data") or {}
out={k: base64.b64decode(v).decode() for k,v in d.items()}
assert out, "empty source secret"
json.dump(out, open(sys.argv[2],"w"))' "$work/src.json" "$work/val.json"
  gcloud secrets versions add "$1" --project "$TARGET_PROJECT" --data-file="$work/val.json" --format='value(name)' >/dev/null
  rm -f "$work/src.json" "$work/val.json"
  log "filled $1 from $SRC_NS/$2"
}

log "watching $TARGET_PROJECT (suffixes: $FILL_SUFFIXES, source ns: $SRC_NS, every ${INTERVAL}s)"
while :; do
  gcloud secrets list --project "$TARGET_PROJECT" --filter='labels.managed-by=platform' \
      --format='value(name,labels.app)' 2>/dev/null > "$work/list" || true
  while IFS=$'\t' read -r name app; do
    [ -n "$name" ] && [ -n "$app" ] || continue
    suffix=${name#app-"$app"-}
    case " $FILL_SUFFIXES " in *" $suffix "*) ;; *) continue ;; esac
    has=$(gcloud secrets versions list "$name" --project "$TARGET_PROJECT" --limit=1 --format='value(name)' 2>/dev/null || true)
    [ -z "$has" ] && fill_one "$name" "$suffix"
  done < "$work/list"
  sleep "$INTERVAL"
done
