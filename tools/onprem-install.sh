#!/usr/bin/env bash
# 고객 온프레 k3s 에 설치 묶음(W2)을 까는 스크립트. 고객 서버에서 사람이 돌린다 (플랫폼이 원격으로 돌리지 않는다)
#   1) Argo CD core v2.13.3 (레포에 고정한 파일, sha256 확인 뒤 server-side apply. 인터넷에서 직접 apply 하지 않는다)
#   2) Agent 키 Secret (onprem-agent --enroll 이 만든 키 파일에서. 값을 화면·helm 기록에 남기지 않는다)
#   3) gitops 저장소 Secret (회사 경로 읽기 전용 deploy key. 없으면 공개 저장소로 본다)
#   4) helm 차트 deploy/helm/onprem-agent (Agent + 권한 + 이 회사만 당기는 Argo 설정)
#   5) 확인: Agent 가 읽기는 되고 쓰기·Secret 읽기는 안 되는지 (kubectl auth can-i)
# 사용 (값은 환경변수로):
#   TENANT=t-0a1b2c3d GITOPS_REPO_URL=git@github.com:org/gitops.git AGENT_REPORT_URL=https://api.example \
#   AGENT_IMAGE=ghcr.io/org/svc-onprem-agent@sha256:... AGENT_KEY_FILE=.agent-key.env \
#   [GITOPS_SSH_KEY_FILE=~/.ssh/gitops_ro] [GRANTS_CLUSTER=1] [KUBE_CONTEXT=...] bash tools/onprem-install.sh
# 되돌리기: helm uninstall onprem-agent -n svc-agent; kubectl delete ns svc-agent; Argo 를 지우려면 같은 yaml 로 kubectl delete
set -euo pipefail
cd "$(dirname "$0")/.."

ARGO_YAML=tools/argocd-core-install-v2.13.3.yaml
ARGO_SHA=cfe23fcb976c00c96e5add2f8fd9f70db4390b06c66ec4f391634e49e3ef45e3   # tools/argo-k3d.sh 와 같은 값
ARGO_NS=argocd
NS=svc-agent
die() { echo "onprem-install: $*" >&2; exit 1; }
need() { [ -n "${!1:-}" ] || die "$1 필요"; }
K() { kubectl ${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"} "$@"; }

for v in TENANT GITOPS_REPO_URL AGENT_REPORT_URL AGENT_IMAGE AGENT_KEY_FILE; do need "$v"; done
command -v kubectl >/dev/null || die "kubectl 없음"
command -v helm >/dev/null || die "helm 없음"
[ -f "$AGENT_KEY_FILE" ] || die "AGENT_KEY_FILE 없음: $AGENT_KEY_FILE"
grep -q '^AGENT_KEY_ID=' "$AGENT_KEY_FILE" && grep -q '^AGENT_KEY_SECRET=' "$AGENT_KEY_FILE" || die "키 파일에 AGENT_KEY_ID·AGENT_KEY_SECRET 이 없다"
[ -z "${GITOPS_SSH_KEY_FILE:-}" ] || [ -f "$GITOPS_SSH_KEY_FILE" ] || die "GITOPS_SSH_KEY_FILE 없음"
got=$(sha256sum "$ARGO_YAML" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ARGO_YAML" | cut -d' ' -f1)
[ "$got" = "$ARGO_SHA" ] || die "Argo 설치 파일 sha 불일치: $got"

echo "1/5 Argo CD core"
K create ns "$ARGO_NS" --dry-run=client -o yaml | K apply -f - >/dev/null
# CRD 가 커서 client-side apply 의 annotation 한도를 넘는다 → server-side (tools/argo-k3d.sh 와 같은 이유)
K apply -n "$ARGO_NS" --server-side --force-conflicts -f "$ARGO_YAML" >/dev/null
for d in argocd-repo-server argocd-redis argocd-applicationset-controller; do
  K -n "$ARGO_NS" rollout status "deploy/$d" --timeout=300s >/dev/null
done
K -n "$ARGO_NS" rollout status statefulset/argocd-application-controller --timeout=300s >/dev/null

echo "2/5 Agent 키 Secret"
K create ns "$NS" --dry-run=client -o yaml | K apply -f - >/dev/null
K -n "$NS" create secret generic agent-key --from-env-file="$AGENT_KEY_FILE" --dry-run=client -o yaml | K apply -f - >/dev/null

echo "3/5 gitops 저장소 Secret (읽기 전용)"
repo_secret="svc-gitops-$TENANT"
args=(--from-literal=type=git --from-literal="url=$GITOPS_REPO_URL" --from-literal="project=$TENANT")
[ -n "${GITOPS_SSH_KEY_FILE:-}" ] && args+=(--from-file=sshPrivateKey="$GITOPS_SSH_KEY_FILE")
K -n "$ARGO_NS" create secret generic "$repo_secret" "${args[@]}" --dry-run=client -o yaml \
  | K label --local -f - argocd.argoproj.io/secret-type=repository -o yaml | K apply -f - >/dev/null

echo "4/5 설치 차트"
helm ${KUBE_CONTEXT:+--kube-context "$KUBE_CONTEXT"} upgrade --install onprem-agent deploy/helm/onprem-agent -n "$NS" \
  --set tenant="$TENANT" --set gitops.repoURL="$GITOPS_REPO_URL" \
  --set agent.reportURL="$AGENT_REPORT_URL" --set agent.image="$AGENT_IMAGE" \
  --set grants.cluster="$([ "${GRANTS_CLUSTER:-0}" = 1 ] && echo true || echo false)" >/dev/null
K -n "$NS" rollout status deploy/onprem-agent --timeout=180s >/dev/null

echo "5/5 Agent 권한 확인"
SA="system:serviceaccount:$NS:onprem-agent"
check() { local want=$1; shift; local got; got=$(K auth can-i --as="$SA" "$@" 2>/dev/null || true); [ "$got" = "$want" ] || die "권한이 기대와 다름: can-i $* = $got (기대 $want)"; }
check yes list pods -A
check yes list clusters.postgresql.cnpg.io -A
check yes list applications.argoproj.io -n "$ARGO_NS"
check no create deployments -A
check no delete pods -A
check no get secrets -A
check no get configmaps -A
echo "onprem-install: 완료 (Agent 는 읽기만, 들어오는 포트 없음)"
