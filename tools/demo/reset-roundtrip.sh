#!/usr/bin/env bash
# 왕복 측정(AWS → 온프레 → AWS) 한 회차가 끝난 뒤, 다음 회차를 처음 상태로 되돌린다. DRAFT(ai) 2026-11-08
#
#   bash tools/demo/reset-roundtrip.sh check      7가지를 점검만 한다 (출발 DB 점검에만 real-app 에 임시 파드를 1개 띄웠다 지운다)
#   bash tools/demo/reset-roundtrip.sh run src    출발 RDS sample-shop-db 울타리 해제 (앱 계정 쓰기 복구, read_only 해제)
#   bash tools/demo/reset-roundtrip.sh run vm     VM CNPG shop DB 비우기 (구독·슬롯·임시 계정 삭제 후 DB 다시 만들기)
#   bash tools/demo/reset-roundtrip.sh run cf     Cloudflare: shop 호스트를 잡고 있는 이전 LB·풀·모니터 삭제 → DNS(출발 터널)로 돌아감
#   bash tools/demo/reset-roundtrip.sh run aws    도착 EKS Pod Identity 연결 삭제 + 고정 이름 비밀 그릇 즉시 삭제 (되돌릴 수 없음)
#   bash tools/demo/reset-roundtrip.sh run ns     도착 EKS 네임스페이스 삭제. 내 계정에 클러스터 관리자 권한을 잠깐 붙이고, 끝나면 반드시 뗀다
#   bash tools/demo/reset-roundtrip.sh run all    src → vm → cf → aws (ns 는 권한 변경이라 따로 실행한다)
#
# 남겨 두는 것 (비용만 들고 다음 회차를 막지 않는다): 이전마다 새 이름으로 생기는 RDS shopapi-pg-*, IAM 역할 app-shop*,
#   <RDS>-db-password 비밀, Cloudflare 터널 svc-*-tgt. check 가 목록만 찍는다.
# 비밀값은 화면·인자·셸 기록에 나오지 않는다 (임시 0600 파일 → k8s Secret, 또는 플랫폼 파드 안에서만 쓴다).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SVC="$HERE/../Service"
export AWS_PROFILE=${AWS_PROFILE:-softbank} AWS_REGION=${AWS_REGION:-ap-northeast-2}
APP=shop-api; NS=app-shop-api; SRC_NS=real-app; SRC_DB=sample-shop-db; SRC_DBNAME=shop
CLUSTER=platform-target; TCTX=eks-platform-target; PCTX=softbank-platform; VM=onprem-vm
HOST=shop.softbank-team-iron.com; SRC_TUNNEL=9c151818
PREFIX=platform/t-11111111/shop-api; FIXED_SECRETS="api-secrets shop-api-sample-shop-db-app"; HUB_APP=t-11111111-shop-api-aws-eks
ADMIN_POLICY=arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy

NEED=0
ok()   { printf '정상    %s\n' "$1"; }
todo() { printf '되돌릴 것 %s  →  run %s\n' "$1" "$2"; NEED=1; }

# ── 1. 출발 RDS 울타리 (real-app 에 임시 psql 파드. 관리자 비밀번호는 임시 0600 파일 → Secret → 파드 안에서만) ──
src_pod() {   # $1 = inspect | apply
  local k="kubectl --context $TCTX -n $SRC_NS" d H ARN
  d=$(mktemp -d); chmod 700 "$d"
  trap "$k delete pod rr-psql --ignore-not-found --wait=true >/dev/null 2>&1; $k delete secret rr-psql --ignore-not-found >/dev/null 2>&1; $k delete configmap rr-psql --ignore-not-found >/dev/null 2>&1; rm -rf '$d'" RETURN
  read -r H ARN < <(aws rds describe-db-instances --db-instance-identifier "$SRC_DB" --query 'DBInstances[0].[Endpoint.Address,MasterUserSecret.SecretArn]' --output text)
  ( umask 077; aws secretsmanager get-secret-value --secret-id "$ARN" --query SecretString --output text \
      | python3 -I -c 'import json,sys; j=json.load(sys.stdin); open(sys.argv[1],"w").write(j["username"]); open(sys.argv[2],"w").write(j["password"])' "$d/u" "$d/p" )
  $k delete pod rr-psql --ignore-not-found --wait=true >/dev/null 2>&1 || true
  $k create secret generic rr-psql --from-file=username="$d/u" --from-file=password="$d/p" >/dev/null
  $k create configmap rr-psql --from-file=inspect.sql="$HERE/sql/inspect.sql" --from-file=unfence.sql="$HERE/sql/unfence.sql" >/dev/null
  local cmd='psql -v ON_ERROR_STOP=1 -q -f /sql/inspect.sql'
  [ "$1" = apply ] && cmd='psql -v ON_ERROR_STOP=1 -At -f /sql/unfence.sql >/dev/null && psql -v ON_ERROR_STOP=1 -q -f /sql/inspect.sql'
  $k run rr-psql --restart=Never --image=docker.io/library/postgres:16-alpine --overrides="{\"spec\":{\"restartPolicy\":\"Never\",\"containers\":[{\"name\":\"p\",\"image\":\"docker.io/library/postgres:16-alpine\",
    \"command\":[\"sh\",\"-c\",\"export PGUSER=\$(cat /s/username) PGPASSWORD=\$(cat /s/password) PGHOST=$H PGDATABASE=$SRC_DBNAME PGSSLMODE=require; $cmd\"],
    \"volumeMounts\":[{\"name\":\"s\",\"mountPath\":\"/s\"},{\"name\":\"q\",\"mountPath\":\"/sql\"}]}],
    \"volumes\":[{\"name\":\"s\",\"secret\":{\"secretName\":\"rr-psql\"}},{\"name\":\"q\",\"configMap\":{\"name\":\"rr-psql\"}}]}}" >/dev/null
  local p=""; for _ in $(seq 1 60); do p=$($k get pod rr-psql -o jsonpath='{.status.phase}' 2>/dev/null || true); case "$p" in Succeeded|Failed) break;; esac; sleep 2; done
  $k logs rr-psql 2>/dev/null
  [ "$p" = Succeeded ]
}
src_check() {   # inspect.sql 출력: 이름|값 줄
  local out; out=$(src_pod inspect) || { todo "출발 DB 점검 실패: $out" src; return; }
  local ins rof; ins=$(awk -F'|' '$1=="shop_app_insert"{print $2}' <<<"$out"); rof=$(awk -F'|' '$1=="db_setconfig"{print $2}' <<<"$out")
  if [ "$ins" = t ] && [[ "$rof" != *read_only=on* ]]; then ok "출발 RDS $SRC_DB 쓰기 가능 (orders $(awk -F'|' '$1=="orders_rows"{print $2}' <<<"$out")행)"
  else todo "출발 RDS $SRC_DB 울타리 쳐짐 (앱 INSERT=$ins, 설정=$rof)" src; fi
}

# ── 2. VM CNPG DB ──
vm_counts() {
  ssh -o BatchMode=yes "$VM" "export KUBECONFIG=\$HOME/.kube/config; kubectl -n $NS exec $(printf '%s' "shop-api-sample-shop-db-1") -c postgres -- psql -X -tA -d $SRC_DBNAME -c \"select (select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')) || ' ' || (select count(*) from pg_subscription) || ' ' || (select count(*) from pg_replication_slots where slot_type='logical')\"" 2>/dev/null
}
vm_check() {
  local c; c=$(vm_counts) || { todo "VM DB 를 못 읽음" vm; return; }
  read -r t s l <<<"$c"
  if [ "$t" = 0 ] && [ "$s" = 0 ] && [ "$l" = 0 ]; then ok "VM CNPG $SRC_DBNAME 비어 있음"; else todo "VM CNPG $SRC_DBNAME 표 $t · 구독 $s · 논리 슬롯 $l" vm; fi
}
vm_reset() {
  scp -q "$SVC/tools/onprem-db-reset.sh" "$VM:svc-onprem-db-reset.sh"
  ssh -o BatchMode=yes "$VM" "k=\$(mktemp); cp \$HOME/.kube/config \$k; chmod 600 \$k; KUBECONFIG=\$k kubectl config rename-context default k3s-onprem >/dev/null;
    KUBECONFIG=\$k ONPREM_KUBE_CONTEXT=k3s-onprem bash \$HOME/svc-onprem-db-reset.sh $APP; rc=\$?; rm -f \$k; exit \$rc"
}

# ── 3. Cloudflare (토큰은 플랫폼 워커 파드 밖으로 안 나간다) ──
cf() {   # $1 = check | delete
  kubectl --context "$PCTX" -n platform exec deploy/worker -- env MODE="$1" HOST="$HOST" SRC="$SRC_TUNNEL" node -e '
const t=process.env.CLOUDFLARE_PROVISION_API_TOKEN, z=process.env.CLOUDFLARE_ZONE_ID, a=process.env.CLOUDFLARE_ACCOUNT_ID, {MODE,HOST,SRC}=process.env;
const api=async(m,p)=>{const r=await fetch("https://api.cloudflare.com/client/v4"+p,{method:m,headers:{Authorization:"Bearer "+t}});const j=await r.json();if(!j.success)throw new Error(JSON.stringify(j.errors).slice(0,200));return j.result;};
(async()=>{
 const A="/accounts/"+a, lbs=(await api("GET","/zones/"+z+"/load_balancers")).filter(l=>l.name===HOST);
 const dns=await api("GET","/zones/"+z+"/dns_records?name="+HOST), dnsOk=dns.some(r=>r.type==="CNAME"&&r.content.startsWith(SRC));
 if(MODE==="check"){console.log(JSON.stringify({lbs:lbs.map(l=>l.description||l.name),dnsOk}));return;}
 for(const l of lbs){
   const mid=((l.description||"").match(/svc migration ([0-9a-f-]{36})/)||[])[1]; if(!mid){console.log("건너뜀: 이전이 만든 LB 가 아님",l.name);continue;}
   const P="svc-"+mid.slice(0,8), TAG="svc migration "+mid;
   const [pools,mons]=await Promise.all([api("GET",A+"/load_balancers/pools"),api("GET",A+"/load_balancers/monitors")]);
   await api("DELETE","/zones/"+z+"/load_balancers/"+l.id); console.log("지움 LB",l.name,TAG);
   for(const p of pools.filter(p=>(p.name===P+"-src"||p.name===P+"-tgt")&&(p.description||"").includes(mid))){await api("DELETE",A+"/load_balancers/pools/"+p.id);console.log("지움 풀",p.name);}
   for(const m of mons.filter(m=>(m.description||"")===P+"-mon "+TAG)){await api("DELETE",A+"/load_balancers/monitors/"+m.id);console.log("지움 모니터",P+"-mon");}
 }
 console.log(dnsOk?"DNS 정상: "+HOST+" → 출발 터널 "+SRC:"주의: "+HOST+" DNS 가 출발 터널을 가리키지 않는다 (사람이 확인)");
})().catch(e=>{console.log("FAIL",e.message);process.exit(1)})'
}
cf_check() {
  local j; j=$(cf check) || { todo "Cloudflare 를 못 읽음" cf; return; }
  python3 -I -c 'import json,sys; j=json.loads(sys.argv[1]); sys.exit(0 if not j["lbs"] and j["dnsOk"] else 1)' "$j" \
    && ok "Cloudflare $HOST → 출발 터널 (LB 없음)" || todo "Cloudflare $HOST: $j" cf
}

# ── 4. 도착 AWS: Pod Identity 연결 + 고정 이름 비밀 그릇 ──
pia_ids() { aws eks list-pod-identity-associations --cluster-name "$CLUSTER" --namespace "$NS" --query 'associations[].associationId' --output text; }
secrets_left() { for s in $FIXED_SECRETS; do aws secretsmanager describe-secret --secret-id "$PREFIX/$s" >/dev/null 2>&1 && printf '%s ' "$s"; done; true; }
aws_check() {
  local p s; p=$(pia_ids); s=$(secrets_left)
  if [ -z "$p" ] && [ -z "$s" ]; then ok "도착 Pod Identity 연결 0개 · 고정 이름 비밀 0개"
  else todo "도착 Pod Identity 연결 [$p] · 고정 이름 비밀 [$s]" aws; fi
}
aws_reset() {
  for id in $(pia_ids); do aws eks delete-pod-identity-association --cluster-name "$CLUSTER" --association-id "$id" >/dev/null; echo "지움 Pod Identity $id"; done
  for s in $(secrets_left); do aws secretsmanager delete-secret --secret-id "$PREFIX/$s" --force-delete-without-recovery >/dev/null; echo "지움 비밀 그릇 $PREFIX/$s (복구 불가)"; done
}

# ── 5. 도착 EKS 네임스페이스 (직접 못 본다. 허브 Argo 앱이 그 안 자원을 Synced 로 보면 아직 있다) ──
ns_live() {
  kubectl --context "$PCTX" -n argocd get application "$HUB_APP" -o json 2>/dev/null | python3 -I -c '
import json, sys
try: a = json.load(sys.stdin)
except Exception: print(0); sys.exit()
print(sum(1 for r in a.get("status", {}).get("resources", []) if r.get("namespace") == sys.argv[1] and r.get("status") == "Synced"))' "$NS" || echo 0
}
ns_check() { local n; n=$(ns_live); [ "${n:-0}" = 0 ] && ok "도착 EKS $NS 없음 (허브 앱 기준)" || todo "도착 EKS $NS 있음 (허브 앱 자원 ${n}개)" ns; }
ns_reset() {
  local me; me=$(aws sts get-caller-identity --query Arn --output text)
  echo "권한 붙임: $me 에 $CLUSTER 클러스터 관리자 (끝나면 반드시 뗀다)"
  aws eks associate-access-policy --cluster-name "$CLUSTER" --principal-arn "$me" --policy-arn "$ADMIN_POLICY" --access-scope type=cluster >/dev/null
  trap "aws eks disassociate-access-policy --cluster-name '$CLUSTER' --principal-arn '$me' --policy-arn '$ADMIN_POLICY' >/dev/null && echo '권한 뗌: 클러스터 관리자'" RETURN
  local i; for i in $(seq 1 10); do kubectl --context "$TCTX" delete ns "$NS" --wait=false >/dev/null 2>&1 && break; sleep 3; done
  for i in $(seq 1 40); do kubectl --context "$TCTX" get ns "$NS" >/dev/null 2>&1 || { echo "지움 네임스페이스 $NS"; return 0; }; sleep 3; done
  echo "주의: $NS 가 120초 뒤에도 남아 있다 (Terminating). kubectl --context $TCTX get ns $NS -o yaml 로 finalizer 를 본다"
}

leftovers() {
  echo; echo "참고 (비용만, 다음 회차를 막지 않음):"
  echo "  RDS:      $(aws rds describe-db-instances --query 'DBInstances[?starts_with(DBInstanceIdentifier,`shopapi-pg-`)].DBInstanceIdentifier' --output text)"
  echo "  IAM 역할: $(aws iam list-roles --query 'Roles[?starts_with(RoleName,`app-shop`)].RoleName' --output text)"
}

case "${1:-check}" in
  check)
    NEED=0
    src_check; vm_check; cf_check; aws_check; ns_check
    leftovers
    echo; [ "$NEED" = 0 ] && echo "=> 다음 회차를 시작해도 된다 (시작 직전 tools/demo/migration-timing.sh ready aws-onprem 도 본다)" || echo "=> 위 '되돌릴 것' 을 run 으로 처리한다"
    ;;
  run)
    case "${2:-}" in
      src) src_pod apply | grep -E '^(shop_app_insert|db_setconfig|orders_rows)' ;;
      vm)  vm_reset ;;
      cf)  cf delete ;;
      aws) aws_reset ;;
      ns)  ns_reset ;;
      all) echo "== src"; src_pod apply | grep -E '^(shop_app_insert|db_setconfig|orders_rows)'; echo "== vm"; vm_reset; echo "== cf"; cf delete; echo "== aws"; aws_reset
           echo "== ns 는 따로: bash tools/demo/reset-roundtrip.sh run ns" ;;
      *) sed -n 2,10p "$0"; exit 1 ;;
    esac ;;
  *) sed -n 2,10p "$0"; exit 1 ;;
esac
