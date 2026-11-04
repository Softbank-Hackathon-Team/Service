#!/usr/bin/env bash
# 고객 온프레 k3s 에 설치 묶음(W2)을 까는 스크립트. 고객 서버에서 사람이 돌린다 (플랫폼이 원격으로 돌리지 않는다)
#   1) Argo CD core v2.13.3 (레포에 고정한 파일, sha256 확인 뒤 server-side apply. 인터넷에서 직접 apply 하지 않는다)
#   2) Agent 키 Secret (onprem-agent --enroll 이 만든 키 파일에서. 값을 화면·helm 기록에 남기지 않는다)
#   3) gitops 저장소 Secret (읽기 전용 자격: deploy key 또는 HTTPS 읽기 토큰. 둘 다 없으면 공개 저장소로 본다)
#   4) helm 차트 deploy/helm/onprem-agent (Agent + 권한 + 이 회사만 당기는 Argo 설정)
#   5) 확인: Agent 가 읽기는 되고 쓰기·Secret 읽기는 안 되는지 (kubectl auth can-i)
# 사용 (값은 환경변수로):
#   TENANT=t-0a1b2c3d GITOPS_REPO_URL=git@github.com:org/gitops.git AGENT_REPORT_URL=https://api.example \
#   AGENT_IMAGE=ghcr.io/org/svc-onprem-agent@sha256:... AGENT_KEY_FILE=.agent-key.env \
#   [GITOPS_SSH_KEY_FILE=~/.ssh/gitops_ro | GITOPS_TOKEN_FILE=~/gitops-read-token] [GRANTS_CLUSTER=1] [KUBE_CONTEXT=...] bash tools/onprem-install.sh
#   GITOPS_TOKEN_FILE: https 주소 + 읽기 전용 토큰 (플랫폼 Argo CD 의 gitops-repo Secret 과 같은 방식, 사용자 x-access-token).
#     조직 정책으로 deploy key 를 못 쓰는 레포용 (2026-11-05 Softbank-Hackathon-Team 실측). 토큰은 명령줄·화면에 안 남게 파일로만 받는다
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
[ -z "${GITOPS_TOKEN_FILE:-}" ] || [ -f "$GITOPS_TOKEN_FILE" ] || die "GITOPS_TOKEN_FILE 없음"
[ -z "${GITOPS_SSH_KEY_FILE:-}" ] || [ -z "${GITOPS_TOKEN_FILE:-}" ] || die "GITOPS_SSH_KEY_FILE 과 GITOPS_TOKEN_FILE 은 하나만"
[ -z "${GITOPS_TOKEN_FILE:-}" ] || case "$GITOPS_REPO_URL" in https://*) ;; *) die "GITOPS_TOKEN_FILE 은 https 주소와 같이 쓴다";; esac
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
# git 확인 주기. 기본(180s + 흔들림)이면 커밋 뒤 적용까지 대부분이 이 대기다 (실제 동기화는 2초, 2026-11-04 VM 실측)
#   확인 한 번 = 저장소 ref 조회 1회. 커밋이 그대로면 렌더 결과를 캐시에서 쓴다. 비용은 앱 수 × (1/주기)
# DRAFT(ai): 30s / 흔들림 5s. 앱 몇 개짜리 온프레에서 GitHub 조회가 시간당 앱당 120회. 팀이 정할 값
ARGO_POLL=${ARGO_POLL:-30s}
ARGO_POLL_JITTER=${ARGO_POLL_JITTER:-5s}
cur=$(K -n "$ARGO_NS" get cm argocd-cm -o jsonpath='{.data.timeout\.reconciliation}/{.data.timeout\.reconciliation\.jitter}')
if [ "$cur" != "$ARGO_POLL/$ARGO_POLL_JITTER" ]; then
  K -n "$ARGO_NS" patch cm argocd-cm --type merge \
    -p "{\"data\":{\"timeout.reconciliation\":\"$ARGO_POLL\",\"timeout.reconciliation.jitter\":\"$ARGO_POLL_JITTER\"}}" >/dev/null
  # 이 값은 시작할 때 환경변수로 읽는다 (설치 yaml 의 configMapKeyRef) → 다시 띄워야 먹는다
  K -n "$ARGO_NS" rollout restart statefulset/argocd-application-controller deploy/argocd-repo-server >/dev/null
  K -n "$ARGO_NS" rollout status statefulset/argocd-application-controller --timeout=300s >/dev/null
  K -n "$ARGO_NS" rollout status deploy/argocd-repo-server --timeout=300s >/dev/null
fi
# 상태 판정 더하기: CNPG Cluster (tools/onprem-argocd-health.yaml). 없으면 DB 가 안 떠도 Healthy 로 보여 Agent 가 "적용됨" 을 보낸다
#   controller 가 argocd-cm 을 지켜보므로 다시 띄우지 않아도 먹는다 (VM 실측 약 50초). 같은 값이면 바뀌는 것 없음
K -n "$ARGO_NS" patch cm argocd-cm --type merge --patch-file tools/onprem-argocd-health.yaml >/dev/null

echo "2/5 Agent 키 Secret"
K create ns "$NS" --dry-run=client -o yaml | K apply -f - >/dev/null
K -n "$NS" create secret generic agent-key --from-env-file="$AGENT_KEY_FILE" --dry-run=client -o yaml | K apply -f - >/dev/null

echo "3/5 gitops 저장소 Secret (읽기 전용)"
repo_secret="svc-gitops-$TENANT"
# project 칸을 넣지 않는다 (전역 저장소 자격): ApplicationSet git 생성기는 프로젝트 전용 자격을 안 쓴다 →
#   비공개 저장소에서 "authentication required" 로 앱 폴더를 못 찾는다 (2026-11-05 VM 실측, Argo CD v2.13.3. 공개 저장소에선 안 드러남)
#   어느 저장소를 쓸 수 있는지는 AppProject sourceRepos 가 정한다 (이 클러스터는 한 회사 전용)
args=(--from-literal=type=git --from-literal="url=$GITOPS_REPO_URL")
[ -n "${GITOPS_SSH_KEY_FILE:-}" ] && args+=(--from-file=sshPrivateKey="$GITOPS_SSH_KEY_FILE")
tok=""
if [ -n "${GITOPS_TOKEN_FILE:-}" ]; then
  # 줄바꿈을 뗀 사본을 600 임시 파일로 (끝 줄바꿈이 남으면 인증 실패). --from-literal 은 ps 에 값이 보여 안 쓴다
  tok=$(umask 077; mktemp); trap 'rm -f "$tok"' EXIT
  tr -d '\r\n' < "$GITOPS_TOKEN_FILE" > "$tok"
  [ -s "$tok" ] || die "GITOPS_TOKEN_FILE 이 비어 있다"
  args+=(--from-literal=username=x-access-token --from-file=password="$tok")
fi
K -n "$ARGO_NS" create secret generic "$repo_secret" "${args[@]}" --dry-run=client -o yaml \
  | K label --local -f - argocd.argoproj.io/secret-type=repository -o yaml | K apply -f - >/dev/null

echo "4/5 설치 차트"
# helm 4 는 server-side apply 다. Argo ApplicationSet 컨트롤러가 .spec.generators 를 다시 쓰므로 두 번째 실행부터 충돌로 실패한다
#   (2026-11-05 VM 실측, helm v4.3.1). 이 차트가 그 칸의 주인이라 충돌은 차트 쪽으로 덮는다. helm 3 에는 이 플래그가 없다
ssa=(); helm upgrade --help 2>/dev/null | grep -q -- '--force-conflicts' && ssa=(--force-conflicts)
helm ${KUBE_CONTEXT:+--kube-context "$KUBE_CONTEXT"} upgrade --install onprem-agent deploy/helm/onprem-agent -n "$NS" "${ssa[@]}" \
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
