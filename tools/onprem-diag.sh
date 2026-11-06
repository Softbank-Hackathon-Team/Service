#!/usr/bin/env bash
# 온프레 VM 읽기 전용 진단. 고객 서버(또는 VM 접근 권한이 있는 운영자)가 돌린다. 아무것도 바꾸지 않는다.
# 이전이 멈췄을 때 "VM 쪽에서 무엇이 안 됐나"를 한 번에 본다: 노드, Agent·지표, Argo, 봉인 컨트롤러, 비밀 그릇(이름만), 앱 파드,
# cloudflared·db-tunnel, CNPG 와 그 안의 복제 객체(구독·슬롯·발행·임시 계정 수).
#
# 쓰는 법 (VM 에서):   bash tools/onprem-diag.sh [앱이름]
#        (맥에서):     ssh onprem-vm 'bash -s -- shop-api' < tools/onprem-diag.sh
# 환경 변수: KUBECONFIG (없으면 ~/.kube/config, 그것도 없으면 /etc/rancher/k3s/k3s.yaml)
# 비밀 값은 찍지 않는다: Secret 은 이름·키 이름만, 토큰은 길이만.
set -u
APP=${1:-}
if [ -z "${KUBECONFIG:-}" ]; then
  if [ -r "$HOME/.kube/config" ]; then export KUBECONFIG="$HOME/.kube/config"; else export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; fi
fi
k() { kubectl --request-timeout=10s "$@" 2>&1; }
h() { printf '\n== %s\n' "$*"; }

h "노드·k3s"
k get nodes -o wide | cut -c1-160
k3s --version 2>/dev/null | head -1

h "Agent·지표 수집기 (svc-agent)"
k -n svc-agent get deploy,pods -o wide | cut -c1-160
echo "-- Agent 최근 200줄: 보고 성공 수 · 마지막 성공 · 실패 줄"
AL=$(k -n svc-agent logs deploy/onprem-agent --tail=200)
printf '%s\n' "$AL" | grep -c '"ok":true' | sed 's/^/ok 보고 수: /'
printf '%s\n' "$AL" | grep '"ok":true' | tail -1 | grep -oE '"kind":"[a-z]+"|"receivedAt":"[^"]+"' | tr '\n' ' '; echo
printf '%s\n' "$AL" | grep -Ei '"ok":false|error|fail|denied|refused' | tail -10

h "Argo CD Application (동기·건강)"
k get applications.argoproj.io -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REV:.status.sync.revision' | cut -c1-160

h "봉인 컨트롤러·비밀 저장소"
k -n kube-system get deploy sealed-secrets-controller
k get clustersecretstore -o custom-columns='NAME:.metadata.name,READY:.status.conditions[0].status,REASON:.status.conditions[0].reason'
echo "-- svc-app-secrets (이름·키 이름·값 길이만)"
k -n svc-app-secrets get secret -o json | python3 -c '
import json,sys,base64
for s in json.load(sys.stdin).get("items",[]):
    d=s.get("data") or {}
    print(s["metadata"]["name"], {k: len(base64.b64decode(v)) for k,v in d.items()})' 2>/dev/null

NS_LIST=$(k get ns -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep -E '^app-' || true)
[ -n "$APP" ] && NS_LIST="app-$APP"
for NS in $NS_LIST; do
  h "앱 네임스페이스 $NS"
  k -n "$NS" get pods -o wide | cut -c1-160
  echo "-- 준비 안 된 파드의 이유"
  k -n "$NS" get pods -o json | python3 -c '
import json,sys
for p in json.load(sys.stdin).get("items",[]):
    for c in (p.get("status",{}).get("containerStatuses") or []):
        w=(c.get("state") or {}).get("waiting")
        if w or not c.get("ready"): print(p["metadata"]["name"], c["name"], (w or {}).get("reason","not-ready"), ((w or {}).get("message") or "")[:120])' 2>/dev/null
  echo "-- ExternalSecret·SealedSecret"
  k -n "$NS" get externalsecrets -o custom-columns='NAME:.metadata.name,READY:.status.conditions[0].status,REASON:.status.conditions[0].reason' 2>/dev/null
  k -n "$NS" get sealedsecrets -o custom-columns='NAME:.metadata.name,SYNCED:.status.conditions[0].status' 2>/dev/null
  echo "-- cloudflared·db-tunnel 최근 로그"
  for d in $(k -n "$NS" get deploy -o name | grep -E 'cloudflared|db-tunnel'); do
    echo "[$d]"; k -n "$NS" logs "$d" --tail=60 | grep -Ei 'error|fail|refused|registered|connected|denied|forward' | tail -5
  done
  echo "-- CNPG"
  k -n "$NS" get clusters.postgresql.cnpg.io -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,READY:.status.readyInstances,OWNER:.spec.bootstrap.initdb.owner,DB:.spec.bootstrap.initdb.database' 2>/dev/null
  for C in $(k -n "$NS" get clusters.postgresql.cnpg.io -o name 2>/dev/null | sed 's#.*/##'); do
    POD=$(k -n "$NS" get pod -l "cnpg.io/cluster=$C,cnpg.io/instanceRole=primary" -o jsonpath='{.items[0].metadata.name}')
    DB=$(k -n "$NS" get clusters.postgresql.cnpg.io "$C" -o jsonpath='{.spec.bootstrap.initdb.database}')
    [ -n "$POD" ] && [ -n "$DB" ] || continue
    echo "[$C primary=$POD db=$DB]"
    k -n "$NS" get clusters.postgresql.cnpg.io "$C" -o jsonpath='{range .status.managedRolesStatus.byStatus}{@}{"\n"}{end}' 2>/dev/null | head -5
    printf '%s\n' "SELECT 'db_owner='||pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database();
SELECT 'subs='||count(*) FROM pg_subscription;
SELECT 'logical_slots='||count(*) FROM pg_replication_slots WHERE slot_type='logical';
SELECT 'pubs='||count(*) FROM pg_publication;
SELECT 'repl_users='||count(*) FROM pg_roles WHERE rolname ~ '^repl_.*_u\$';
SELECT 'user_tables='||count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema','_repl');
SELECT 'objects_owned_by_svc_migrate='||count(*) FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='svc_migrate');
SELECT 'fence_marker='||(to_regclass('_repl.fence_saved') IS NOT NULL);
SELECT 'read_only='||current_setting('default_transaction_read_only');" \
      | k -n "$NS" exec -i "$POD" -c postgres -- psql -X -U postgres -d "$DB" -qtA 2>&1 | sed 's/^/   /'
  done
done
h "끝 (읽기만 했다)"
