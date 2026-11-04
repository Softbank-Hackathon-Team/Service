#!/usr/bin/env bash
# 샌드박스 호스트 가드(플랫폼 차트 sandbox.*) 끝-끝 검사. 로컬 kind 전용이다. CI 에서 돌리지 않고 실제 클러스터에 쓰지 않는다.
#
# 준비: control-plane 하나 + worker 하나 (worker 에 라벨 pool=sandbox, taint dedicated=sandbox:NoSchedule) 인 kind 클러스터
#   kind create cluster --name iron-pol --image kindest/node:v1.35.8 --config <위 모양 kind 설정>
# 사용 (레포 루트에서):
#   WORK=<빈 폴더> CLUSTER=iron-pol bash deploy/ci/sandbox-kind-e2e.sh <vcluster-0.37.6.tgz> <값 파일...>
#   값 파일 = agent-worker vclusterValues(<스펙>, "$NS") 를 JSON 으로 쓴 것. 릴리스 이름 = 네임스페이스 이름 = $NS
# agent-worker 로 하는 요청은 --as=system:serviceaccount:platform:agent-worker 로 흉내 낸다. 끝에 남는 것은 클러스터째 지운다.
set -u
WORK=${WORK:?WORK 폴더}
CLUSTER=${CLUSTER:-iron-pol}
CTX=kind-$CLUSTER
case $CTX in kind-*) ;; *) echo "kind 컨텍스트만"; exit 2 ;; esac
CP_NODE=$CLUSTER-control-plane
SBX_NODE=$CLUSTER-worker
NS=${NS:-sbx-rehearsal-e2e}
HELM=${HELM:-helm}
VC_CHART=$1; shift
VF=(); for f in "$@"; do VF+=(-f "$f"); done
K="kubectl --context $CTX"
AWU=system:serviceaccount:platform:agent-worker
AW="--as=$AWU --as-group=system:serviceaccounts --as-group=system:serviceaccounts:platform"
HELM_AW="$HELM --kube-context $CTX --kube-as-user $AWU --kube-as-group system:serviceaccounts --kube-as-group system:serviceaccounts:platform"
EXP=$(( $(date +%s) + 1800 ))
PASS=0; FAIL=0
POD_IMG=registry.k8s.io/pause:3.10
SBX='{"nodeSelector":{"pool":"sandbox"},"tolerations":[{"key":"dedicated","operator":"Equal","value":"sandbox","effect":"NoSchedule"}]'
SMALL='"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"memory":"32Mi"}}'
# 가짜 계정의 플랫폼 ECR 샌드박스 자리 (렌더 값과 같아야 한다)
REG=000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox
TA=11111111-1111-4111-8111-111111111111
TB=66666666-6666-4666-8666-666666666666
DIG=@sha256:0000000000000000000000000000000000000000000000000000000000000000
IMG_NS=$NS-img

report() { # want rc out what [pattern]
  local want=$1 rc=$2 out=$3 what=$4 pat=${5:-}
  echo "$out" | cut -c1-400 | sed 's/^/  /'
  local ok=0
  if [ "$want" = ok ] && [ "$rc" -eq 0 ]; then ok=1; fi
  if [ "$want" = deny ] && [ "$rc" -ne 0 ] && { [ -z "$pat" ] || echo "$out" | grep -q -- "$pat"; }; then ok=1; fi
  if [ $ok -eq 1 ]; then echo "PASS [$want] $what"; PASS=$((PASS+1)); else echo "FAIL [$want] $what (rc=$rc${pat:+, 기대 문구 '$pat'})"; FAIL=$((FAIL+1)); fi
  echo
}
check() { # check ok|deny "<설명>" <명령...>
  local want=$1 what=$2; shift 2
  echo "\$ ${*}"
  local out; out=$("$@" 2>&1); local rc=$?
  report "$want" "$rc" "$out" "$what"
}
deny_by() { # deny_by "<거부 문구>" "<설명>" <명령...>: 실패하고 출력에 그 문구가 있어야 통과
  local pat=$1 what=$2; shift 2
  echo "\$ ${*}"
  local out; out=$("$@" 2>&1); local rc=$?
  report deny "$rc" "$out" "$what" "$pat"
}
ns_json() { # 이름 purpose enforce [테넌트, - 면 라벨 없음]
  local tenant=${4:-$TA} extra=""
  [ "$tenant" != - ] && extra=",\"platform.svc/tenant\":\"$tenant\""
  printf '{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"%s","labels":{"platform.svc/sandbox":"true","platform.svc/sandbox-purpose":"%s","platform.svc/expires-at":"%s","pod-security.kubernetes.io/enforce":"%s"%s}}}' "$1" "$2" "$EXP" "$3" "$extra"
}
pod() { # 누구(aw|admin) ns 이름 spec-추가-json(앞에 , 포함 또는 빈) [nodeSelector 덮기]
  local who=$1 ns=$2 name=$3 extra=$4 base=${5:-$SBX}
  local as=""; [ "$who" = aw ] && as=$AW
  $K $as -n "$ns" run "$name" --image=$POD_IMG --restart=Never --overrides="{\"apiVersion\":\"v1\",\"spec\":$base$extra}}"
}
img_pod() { # ns 이미지 [spec-추가-json] [--labels=..]: agent-worker, server dry-run
  local ns=$1 img=$2 extra=${3:-} labels=${4:-}
  $K $AW -n "$ns" run p --image="$img" --restart=Never --dry-run=server $labels --overrides="{\"apiVersion\":\"v1\",\"spec\":$SBX$extra}}"
}
pf_try() { # ns 대상 포트: agent-worker 로 port-forward 를 열어 본다. 열리면 0, 거부되면 1
  local log=$WORK/pf-try.log
  $K $AW -n "$1" port-forward "$2" 0:"$3" >"$log" 2>&1 &
  local pid=$! i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if grep -q "Forwarding from" "$log"; then kill $pid 2>/dev/null; wait $pid 2>/dev/null; cat "$log"; return 0; fi
    kill -0 $pid 2>/dev/null || break
    sleep 1
  done
  kill $pid 2>/dev/null; wait $pid 2>/dev/null; cat "$log"; return 1
}

echo "## 0. 호스트 가드 올리기 (kind 덮어쓰기: StorageClass provisioner=rancher.io/local-path)"
for n in platform plat sbx-test; do $K get namespace $n >/dev/null 2>&1 || $K create namespace $n >/dev/null; done
check ok "플랫폼 차트 샌드박스 부분 렌더·적용" sh -c "helm template platform deploy/helm/platform -n platform -s templates/serviceaccounts.yaml -s templates/agent-worker-rbac.yaml -s templates/sandbox-vap.yaml -s templates/sandbox-storageclass.yaml --set sandbox.imageRegistry=$REG --set sandbox.storageClass.provisioner=rancher.io/local-path --set sandbox.storageClass.parameters=null | $K apply -f -"
for i in $(seq 1 30); do
  echo "$(ns_json e2e-ready rehearsal baseline)" | $K $AW create --dry-run=server -f - 2>&1 | grep -q sbx-namespace-guard && break
  sleep 1
done
check ok "VAP 타입 검사 끝, 경고 없음" sh -c "$K get validatingadmissionpolicies -o jsonpath='{range .items[*]}{.metadata.name} gen={.metadata.generation} seen={.status.observedGeneration} {.status.typeChecking.expressionWarnings}{\"\\n\"}{end}' | tee /dev/stderr | awk '{split(\$2,a,\"=\"); split(\$3,b,\"=\"); if (a[2]!=b[2] || NF>3) bad=1} END{exit bad}'"

echo "## 1. agent-worker 가 샌드박스를 만든다"
check ok "sbx- 네임스페이스 + 필수 라벨 다섯 (테넌트 포함)" sh -c "echo '$(ns_json $NS rehearsal baseline)' | $K $AW create -f -"
check ok "sbx-operator RoleBinding (자기 자신)" $K $AW -n $NS create rolebinding sbx-operator --clusterrole=sbx-operator --serviceaccount=platform:agent-worker
T0=$(date +%s)
check ok "helm upgrade --install vCluster 0.37.6 (agent-worker 로, 제어판 저장 끔 = Deployment)" $HELM_AW upgrade --install $NS "$VC_CHART" -n $NS --timeout 120s "${VF[@]}"
check ok "제어판 Deployment 준비" $K $AW -n $NS rollout status deploy/$NS --timeout=300s
echo "ready in $(( $(date +%s) - T0 ))s"
for i in $(seq 1 30); do $K $AW -n $NS get secret vc-$NS >/dev/null 2>&1 && break; sleep 2; done
check ok "관리자 kubeconfig Secret 읽기 (sbx 안)" $K $AW -n $NS get secret vc-$NS -o custom-columns=NAME:.metadata.name
check ok "호스트 파드와 노드" $K $AW -n $NS get pods -o wide
check ok "Deployment 만들기 (agent-worker, sbx 안)" $K $AW -n $NS create deployment e2e-dep --image=$POD_IMG --replicas=0
check ok "Deployment 지우기 (agent-worker, sbx 안)" $K $AW -n $NS delete deployment e2e-dep
deny_by "cannot create resource" "Deployment 만들기 (sbx 밖 plat)" $K $AW -n plat create deployment e2e-dep --image=$POD_IMG --replicas=0

echo "## 2. agent-worker 가 못 하는 것"
check deny "sbx- 접두어 없는 네임스페이스" sh -c "echo '$(ns_json pr5-noprefix rehearsal baseline)' | $K $AW create -f -"
check deny "라벨 없는 sbx 네임스페이스" $K $AW create namespace sbx-pr5-nolabel
check deny "PSA privileged 라벨" sh -c "echo '$(ns_json sbx-pr5-psa rehearsal privileged)' | $K $AW create -f -"
check deny "purpose 가 닫힌 목록 밖" sh -c "echo '$(ns_json sbx-pr5-purpose debug baseline)' | $K $AW create -f -"
deny_by "platform.svc/tenant" "테넌트 라벨 없는 sbx 네임스페이스" sh -c "echo '$(ns_json sbx-e2e-notenant rehearsal baseline -)' | $K $AW create -f -"
deny_by "platform.svc/tenant" "테넌트 라벨 대문자 UUID" sh -c "echo '$(ns_json sbx-e2e-upper rehearsal baseline 11111111-1111-4111-8111-AAAAAAAAAAAA)' | $K $AW create -f -"
deny_by "platform.svc/tenant" "테넌트 라벨 UUID 아님" sh -c "echo '$(ns_json sbx-e2e-acme rehearsal baseline acme)' | $K $AW create -f -"
deny_by "cannot patch" "테넌트 라벨 바꾸기 (agent-worker, 권한 없음)" $K $AW label namespace $NS platform.svc/tenant=$TB --overwrite
deny_by "sbx-namespace-guard" "테넌트 라벨 바꾸기 (관리자도 VAP 에 막힘)" $K label namespace $NS platform.svc/tenant=$TB --overwrite --dry-run=server
deny_by "sbx-namespace-guard" "테넌트 라벨 지우기 (관리자)" $K label namespace $NS platform.svc/tenant- --dry-run=server
check ok "다른 라벨 고치기는 된다 (관리자, expires-at)" $K label namespace $NS platform.svc/expires-at=$(( EXP + 600 )) --overwrite --dry-run=server
check ok "sandbox 아닌 네임스페이스에 같은 라벨은 상관없다 (관리자, plat)" $K label namespace plat platform.svc/tenant=$TB --dry-run=server
check deny "ClusterRole 만들기" $K $AW create clusterrole pr5-x --verb=get --resource=secrets
check deny "ClusterRoleBinding 만들기" $K $AW create clusterrolebinding pr5-x --clusterrole=cluster-admin --serviceaccount=platform:agent-worker
check deny "secrets 읽기 kube-system" $K $AW -n kube-system get secrets
check deny "secrets 읽기 platform" $K $AW -n platform get secrets
check deny "secrets 읽기 plat" $K $AW -n plat get secrets
check deny "secrets 읽기 sbx-test (라벨 없는 sbx)" $K $AW -n sbx-test get secrets
check deny "secrets 전체 목록" $K $AW get secrets -A
check deny "sbx 밖에 sbx-operator 묶기 (plat)" $K $AW -n plat create rolebinding pr5-x --clusterrole=sbx-operator --serviceaccount=platform:agent-worker
check deny "sbx-operator 를 worker SA 에 묶기" $K $AW -n $NS create rolebinding pr5-x --clusterrole=sbx-operator --serviceaccount=platform:worker
check deny "cluster-admin 묶기" $K $AW -n $NS create rolebinding pr5-x --clusterrole=cluster-admin --serviceaccount=platform:agent-worker
check deny "vc Role 을 다른 SA 에 묶기" $K $AW -n $NS create rolebinding pr5-x --role=vc-$NS --serviceaccount=$NS:default
check deny "plat 네임스페이스 지우기 (dry-run)" $K $AW delete namespace plat --dry-run=server
check deny "sbx-test 지우기 (sandbox 라벨 없음, dry-run)" $K $AW delete namespace sbx-test --dry-run=server
check deny "kube-system 에 파드" sh -c "$K $AW -n kube-system run pr5-x --image=$POD_IMG --restart=Never"
deny_by "forbidden" "port-forward svc/kube-dns (kube-system)" pf_try kube-system svc/kube-dns 53
deny_by "forbidden" "port-forward 파드 (kube-system coredns)" pf_try kube-system "pod/$($K -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].metadata.name}')" 53

echo "## 3. 파드·서비스 가드 ($NS: PSA baseline + VAP, agent-worker 로)"
check ok "보통 파드" pod aw $NS pr5-ok ""
check deny "hostPath" pod aw $NS pr5-hostpath ',"volumes":[{"name":"h","hostPath":{"path":"/"}}]'
check deny "hostNetwork" pod aw $NS pr5-hostnet ',"hostNetwork":true'
check deny "privileged" pod aw $NS pr5-priv ',"containers":[{"name":"pr5-priv","image":"'$POD_IMG'","securityContext":{"privileged":true}}]'
check deny "nodeSelector 없음" pod aw $NS pr5-nosel "" '{"tolerations":[]'
check deny "nodeName 으로 제어판 노드" pod aw $NS pr5-nodename ',"nodeName":"'$CP_NODE'"'
check deny "Service LoadBalancer" $K $AW -n $NS create service loadbalancer pr5-lb --tcp=80:80
check deny "Service NodePort" $K $AW -n $NS create service nodeport pr5-np --tcp=80:80
check ok "Service ClusterIP" $K $AW -n $NS create service clusterip pr5-cip --tcp=80:80

echo "## 3b. 이미지 경로 가드 ($IMG_NS: 테넌트 $TA, vCluster 없음, agent-worker, server dry-run)"
check ok "이미지 확인용 네임스페이스" sh -c "echo '$(ns_json $IMG_NS rehearsal baseline)' | $K $AW create -f -"
check ok "sbx-operator RoleBinding" $K $AW -n $IMG_NS create rolebinding sbx-operator --clusterrole=sbx-operator --serviceaccount=platform:agent-worker
check ok "자기 테넌트 ECR 이미지" img_pod $IMG_NS "$REG/$TA/web$DIG"
deny_by "sbx-pod-guard" "다른 테넌트 ECR 이미지" img_pod $IMG_NS "$REG/$TB/web$DIG"
deny_by "sbx-pod-guard" "같은 계정 sandbox 아닌 저장소" img_pod $IMG_NS "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/platform/api$DIG"
deny_by "sbx-pod-guard" "같은 계정 다른 리전" img_pod $IMG_NS "000000000000.dkr.ecr.us-east-1.amazonaws.com/sandbox/$TA/web$DIG"
deny_by "sbx-pod-guard" "호스트 대문자 표기" img_pod $IMG_NS "000000000000.DKR.ECR.AP-NORTHEAST-2.AMAZONAWS.COM/sandbox/$TA/web$DIG"
deny_by "sbx-pod-guard" "호스트 :443 표기" img_pod $IMG_NS "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com:443/sandbox/$TA/web$DIG"
deny_by "sbx-pod-guard" "듀얼스택 호스트 (dkr-ecr ... on.aws)" img_pod $IMG_NS "000000000000.dkr-ecr.ap-northeast-2.on.aws/sandbox/$TA/web$DIG"
deny_by "sbx-pod-guard" "FIPS 호스트 (dkr.ecr-fips)" img_pod $IMG_NS "000000000000.dkr.ecr-fips.us-east-1.amazonaws.com/sandbox/$TA/web$DIG"
check ok "공개 이미지" img_pod $IMG_NS "$POD_IMG"
check ok "다른 계정 ECR (이 계정 노드 역할로는 못 읽는다)" img_pod $IMG_NS "111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox/$TB/web$DIG"
deny_by "sbx-pod-guard" "initContainer 에 다른 테넌트 이미지" img_pod $IMG_NS "$POD_IMG" ',"initContainers":[{"name":"i","image":"'$REG/$TB/init$DIG'"}]'
check ok "ephemeral 확인용 파드" pod aw $IMG_NS base ""
check ok "파드 준비" $K $AW -n $IMG_NS wait --for=condition=Ready pod/base --timeout=120s
deny_by "sbx-pod-guard" "ephemeral 컨테이너에 다른 테넌트 이미지 (pods/ephemeralcontainers)" $K $AW -n $IMG_NS debug base --image="$REG/$TB/dbg$DIG" --profile=baseline --container=dbg1
check ok "ephemeral 컨테이너에 공개 이미지" $K $AW -n $IMG_NS debug base --image=$POD_IMG --profile=baseline --container=dbg2
deny_by "sbx-pod-guard" "파드 UPDATE 로 다른 테넌트 이미지로 바꾸기" $K $AW -n $IMG_NS set image pod/base base="$REG/$TB/web$DIG"
deny_by "sbx-pod-guard" "동기화 라벨 + release=<릴리스>" img_pod $IMG_NS "$POD_IMG" "" "--labels=vcluster.loft.sh/managed-by=$NS,release=$NS"
check ok "동기화 라벨 + release=foo" img_pod $IMG_NS "$POD_IMG" "" "--labels=vcluster.loft.sh/managed-by=$NS,release=foo"
check ok "동기화 라벨 없이 release=<릴리스> (제어판 모양)" img_pod $IMG_NS "$POD_IMG" "" "--labels=app=vcluster,release=$NS"
deny_by "sbx-pod-guard" "동기화 라벨 + app=vcluster-snapshot" img_pod $IMG_NS "$POD_IMG" "" "--labels=vcluster.loft.sh/managed-by=$NS,app=vcluster-snapshot"

echo "## 4. VAP 만 (PSA privileged 네임스페이스, 관리자가 만든 sandbox 라벨, 테넌트 라벨 없음). PSA 를 빼도 VAP 가 막는지"
check ok "관리자: VAP 단독 확인용 네임스페이스" sh -c "echo '$(ns_json sbx-pr5-vaponly rehearsal privileged -)' | $K create -f -"
check ok "보통 파드" pod admin sbx-pr5-vaponly v-ok ""
check deny "hostPath" pod admin sbx-pr5-vaponly v-hostpath ',"volumes":[{"name":"h","hostPath":{"path":"/"}}]'
check deny "hostNetwork" pod admin sbx-pr5-vaponly v-hostnet ',"hostNetwork":true'
check deny "hostPID" pod admin sbx-pr5-vaponly v-hostpid ',"hostPID":true'
check deny "privileged" pod admin sbx-pr5-vaponly v-priv ',"containers":[{"name":"v-priv","image":"'$POD_IMG'","securityContext":{"privileged":true}}]'
check deny "privileged initContainer" pod admin sbx-pr5-vaponly v-initpriv ',"initContainers":[{"name":"i","image":"'$POD_IMG'","securityContext":{"privileged":true}}]'
check deny "hostPort" pod admin sbx-pr5-vaponly v-hostport ',"containers":[{"name":"v-hostport","image":"'$POD_IMG'","ports":[{"containerPort":80,"hostPort":8080}]}]'
check deny "nodeSelector 없음" pod admin sbx-pr5-vaponly v-nosel "" '{"tolerations":[]'
check deny "nodeSelector pool=general" pod admin sbx-pr5-vaponly v-general "" '{"nodeSelector":{"pool":"general"}'
check deny "nodeName" pod admin sbx-pr5-vaponly v-nodename ',"nodeName":"'$CP_NODE'"'
deny_by "platform.svc/tenant 가 없어" "테넌트 라벨 없는 sandbox 네임스페이스: 계정 ECR 이미지 전부 거부" $K -n sbx-pr5-vaponly run v-ecr --image="$REG/$TA/web$DIG" --restart=Never --dry-run=server --overrides="{\"apiVersion\":\"v1\",\"spec\":$SBX}}"
check deny "Service LoadBalancer" $K -n sbx-pr5-vaponly create service loadbalancer v-lb --tcp=80:80
check deny "Service NodePort" $K -n sbx-pr5-vaponly create service nodeport v-np --tcp=80:80
check deny "Service externalIPs" sh -c "$K -n sbx-pr5-vaponly create service clusterip v-eip --tcp=80:80 --dry-run=client -o json | sed 's/\"type\": \"ClusterIP\"/\"type\": \"ClusterIP\", \"externalIPs\": [\"1.2.3.4\"]/' | $K create -f -"
check deny "Ingress" $K -n sbx-pr5-vaponly create ingress v-ing --rule="x.example/*=v:80"
check ok "Service ClusterIP" $K -n sbx-pr5-vaponly create service clusterip v-cip --tcp=80:80

echo "## 5. remediation 네임스페이스만 RuntimeClass 를 요구한다 (gvisor 끔 = 닫힌 쪽)"
check ok "remediation 네임스페이스" sh -c "echo '$(ns_json sbx-pr5-remed remediation baseline)' | $K $AW create -f -"
check ok "sbx-operator RoleBinding" $K $AW -n sbx-pr5-remed create rolebinding sbx-operator --clusterrole=sbx-operator --serviceaccount=platform:agent-worker
check deny "runtimeClassName 없음" pod aw sbx-pr5-remed r-norc ""
check deny "runtimeClassName gvisor (RuntimeClass 없음)" pod aw sbx-pr5-remed r-gvisor ',"runtimeClassName":"gvisor"'
check ok "제어판 모양 (app=vcluster, 동기화 라벨 없음) 은 빠진다" sh -c "$K $AW -n sbx-pr5-remed run r-cp --image=$POD_IMG --restart=Never --labels=app=vcluster --overrides='{\"apiVersion\":\"v1\",\"spec\":$SBX}}'"
check deny "app=vcluster 위장 + 동기화 라벨" sh -c "$K $AW -n sbx-pr5-remed run r-fake --image=$POD_IMG --restart=Never --labels=app=vcluster,vcluster.loft.sh/managed-by=x --overrides='{\"apiVersion\":\"v1\",\"spec\":$SBX}}'"

echo "## 6. 테넌트 길: 가상 클러스터 안 매니페스트가 호스트 가드에 걸린다"
$K $AW -n $NS delete pod pr5-ok --wait >/dev/null; $K $AW -n $NS delete svc pr5-cip >/dev/null
VCK=$WORK/vc.kubeconfig
$K $AW -n $NS get secret vc-$NS -o jsonpath='{.data.config}' | base64 -d > "$VCK"; chmod 600 "$VCK"
check ok "port-forward svc/$NS 0:443 (agent-worker, sbx 안: services get + pods list + pods/portforward)" pf_try $NS svc/$NS 443
$K $AW -n $NS port-forward svc/$NS 0:443 >"$WORK/pf.log" 2>&1 &
PF=$!
for i in $(seq 1 10); do grep -q "Forwarding from" "$WORK/pf.log" && break; sleep 1; done
PORT=$(sed -n 's/^Forwarding from 127.0.0.1:\([0-9]*\).*/\1/p' "$WORK/pf.log" | head -1)
V="kubectl --kubeconfig $VCK --server https://localhost:$PORT"
vpod() { # 이름 이미지 [--labels=..]: 작은 자원 (호스트 ResourceQuota 안에 들게)
  $V -n default run "$1" --image="$2" --restart=Never ${3:-} --overrides="{\"apiVersion\":\"v1\",\"spec\":{\"containers\":[{\"name\":\"$1\",\"image\":\"$2\",$SMALL}]}}"
}
check ok "가상 API 닿음" $V get ns
check ok "가상: pool=general 로 고른 파드 (가상 PSA 는 통과)" $V -n default run t-general --image=$POD_IMG --restart=Never --overrides='{"apiVersion":"v1","spec":{"nodeSelector":{"pool":"general"},"containers":[{"name":"t-general","image":"'$POD_IMG'",'"$SMALL"'}]}}'
check deny "가상: LoadBalancer Service 가 호스트 가드에 막혀 가상에서도 실패" $V -n default create service loadbalancer t-lb --tcp=80:80
check deny "가상: privileged 파드 (가상 PSA baseline)" $V -n default run t-priv --image=$POD_IMG --restart=Never --overrides='{"apiVersion":"v1","spec":{"containers":[{"name":"t-priv","image":"'$POD_IMG'","securityContext":{"privileged":true}}]}}'
check ok "가상: nodeName 으로 제어판 노드를 고른 파드" $V -n default run t-nodename --image=$POD_IMG --restart=Never --overrides='{"apiVersion":"v1","spec":{"nodeName":"'$CP_NODE'"}}'
check ok "가상: 다른 테넌트 ECR 이미지 파드" vpod t-other "$REG/$TB/web$DIG"
check ok "가상: 자기 테넌트 ECR 이미지 파드" vpod t-own "$REG/$TA/web$DIG"
check ok "가상: release=foo·app=web 파드" vpod t-relfoo $POD_IMG --labels=release=foo,app=web
check ok "가상: release=<릴리스> 파드" vpod t-relself $POD_IMG --labels=release=$NS
check ok "가상: app=vcluster-snapshot 파드" vpod t-snap $POD_IMG --labels=app=vcluster-snapshot
sleep 20
check ok "호스트 파드 목록" $K $AW -n $NS get pods -o wide
check ok "t-general: 동기화가 nodeSelector 를 pool=sandbox 로 덮어 sandbox 노드에 뜸" sh -c "$K $AW -n $NS get pod t-general-x-default-x-$NS -o jsonpath='{.spec.nodeSelector} {.spec.nodeName}' | tee /dev/stderr | grep -q '\"pool\":\"sandbox\"} $SBX_NODE'"
check deny "호스트에 t-nodename 이 없음" $K $AW -n $NS get pod t-nodename-x-default-x-$NS
check ok "가상 t-nodename 이벤트에 sbx-pod-guard 거부" sh -c "$V -n default get events --field-selector involvedObject.name=t-nodename -o custom-columns=REASON:.reason,MSG:.message | cut -c1-300 | tee /dev/stderr | grep -q sbx-pod-guard"
check deny "호스트에 t-other 가 없음" $K $AW -n $NS get pod t-other-x-default-x-$NS
check ok "가상 t-other 이벤트에 sbx-pod-guard 이미지 거부" sh -c "$V -n default get events --field-selector involvedObject.name=t-other -o custom-columns=REASON:.reason,MSG:.message | cut -c1-300 | tee /dev/stderr | grep -q 'sbx-pod-guard.*ECR'"
check ok "호스트 t-own 이 자기 테넌트 이미지로 동기화됨" sh -c "$K $AW -n $NS get pod t-own-x-default-x-$NS -o jsonpath='{.spec.containers[0].image}' | tee /dev/stderr | grep -q '^$REG/$TA/web@'"
check ok "동기화: app=web 은 그대로, release=foo 는 vcluster.loft.sh/label-* 로 바뀜" sh -c "$K $AW -n $NS get pod t-relfoo-x-default-x-$NS -o json | python3 -I -c 'import json,sys; l=json.load(sys.stdin)[\"metadata\"][\"labels\"]; print({k:v for k,v in l.items() if \"ns-label\" not in k}); sys.exit(0 if l.get(\"app\")==\"web\" and \"release\" not in l and \"foo\" in [v for k,v in l.items() if k.startswith(\"vcluster.loft.sh/label-\")] else 1)'"
check ok "동기화: release=<릴리스> 도 바뀌어 호스트 파드에 release 가 없음" sh -c "$K $AW -n $NS get pod t-relself-x-default-x-$NS -o jsonpath='{.metadata.labels}' | tee /dev/stderr | python3 -I -c 'import json,sys; sys.exit(0 if \"release\" not in json.load(sys.stdin) else 1)'"
check deny "호스트에 t-snap 이 없음 (app 은 그대로 옮겨져 VAP 에 걸림)" $K $AW -n $NS get pod t-snap-x-default-x-$NS
check ok "가상 t-snap 이벤트에 sbx-pod-guard 거부" sh -c "$V -n default get events --field-selector involvedObject.name=t-snap -o custom-columns=REASON:.reason,MSG:.message | cut -c1-300 | tee /dev/stderr | grep -q 'sbx-pod-guard.*vcluster-snapshot'"
kill $PF 2>/dev/null

echo "## 7. agent-worker 가 지운다"
check ok "helm uninstall" $HELM_AW uninstall $NS -n $NS --wait
check ok "네임스페이스 지우기 $NS" $K $AW delete namespace $NS --wait --timeout=180s
check ok "네임스페이스 지우기 $IMG_NS" $K $AW delete namespace $IMG_NS --wait --timeout=180s
check ok "네임스페이스 지우기 sbx-pr5-remed" $K $AW delete namespace sbx-pr5-remed --wait --timeout=180s
$K delete namespace sbx-pr5-vaponly --wait=false >/dev/null 2>&1
rm -f "$VCK"

echo "RESULT pass=$PASS fail=$FAIL"
[ $FAIL -eq 0 ]
