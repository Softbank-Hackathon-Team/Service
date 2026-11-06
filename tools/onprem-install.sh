#!/usr/bin/env bash
# 고객 온프레 k3s 에 설치 묶음(W2)을 까는 스크립트. 고객 서버에서 사람이 돌린다 (플랫폼이 원격으로 돌리지 않는다)
#   1) Argo CD core v2.13.3 (레포에 고정한 파일, sha256 확인 뒤 server-side apply. 인터넷에서 직접 apply 하지 않는다)
#   1c) CNPG 운영자 1.30.1 (레포에 고정한 파일, sha256 확인). 이미 있으면(CRD clusters.postgresql.cnpg.io) 건너뛴다. INSTALL_CNPG=0 이면 안 깐다
#   1d) External Secrets 운영자 2.14.0 (레포에 고정한 helm 차트 tgz, sha256 확인). 이미 있으면(CRD externalsecrets.external-secrets.io) 건너뛴다.
#       INSTALL_ESO=0 이면 안 깐다. 앱 비밀(ExternalSecret)이 이 운영자를 쓴다. 없으면 Argo 동기화가 "synchronization tasks are not valid" 로 멈춘다 (2026-11-07 실측)
#       비밀 저장소(ClusterSecretStore, 이름은 플랫폼 기본 vault 또는 env 출력 secret_store_name)는 고객이 고른다 (TODO(human): 온프레 기본 저장소)
#   1b) 봉인 컨트롤러 sealed-secrets v0.40.0 (레포에 고정한 파일, sha256 확인). DB 이전 비밀(전용 계정·터널 키·인증서)을
#       플랫폼이 이 컨트롤러의 공개 인증서로 봉인해 git 으로 보낸다 (ADR-019). 없으면 배포가 SEALING_CERT_MISSING 으로 멈춘다
#   2) Agent 키 Secret (onprem-agent --enroll 이 만든 키 파일에서. 값을 화면·helm 기록에 남기지 않는다)
#   3) gitops 저장소 Secret (읽기 전용 자격: deploy key 또는 HTTPS 읽기 토큰. 둘 다 없으면 공개 저장소로 본다)
#   4) helm 차트 deploy/helm/onprem-agent (Agent + 권한 + 이 회사만 당기는 Argo 설정)
#   5) 확인: Agent 가 읽기는 되고 쓰기·Secret 읽기는 안 되는지 (kubectl auth can-i)
# 사용 (값은 환경변수로):
#   TENANT=t-0a1b2c3d GITOPS_REPO_URL=git@github.com:org/gitops.git AGENT_REPORT_URL=https://api.example \
#   AGENT_IMAGE=ghcr.io/org/svc-onprem-agent@sha256:... AGENT_KEY_FILE=.agent-key.env \
#   [GITOPS_SSH_KEY_FILE=~/.ssh/gitops_ro | GITOPS_TOKEN_FILE=~/gitops-read-token] [GRANTS_CLUSTER=1] [KUBE_CONTEXT=...] bash tools/onprem-install.sh
#   [INVENTORY=0]  온프레 출발 가져오기 권한·스냅숏 끄기 (기본 켬: Agent 가 ConfigMap·노드 등 읽기 전용 목록을 보낸다. Secret 은 안 읽음)
#   [METRICS_URL=https://metrics.<도메인>/v1/metrics METRIC_TOKEN_FILE=~/svc-metric-token]  트래픽 판정 지표 수집기 (#245, 둘 다 주거나 둘 다 빼기)
#   METRIC_TOKEN_FILE: 이 환경의 지표 토큰 (콘솔·API POST /api/v1/environments/:id/metric-token 응답의 token, 한 번만 보인다).
#     다시 발급하면 이전 토큰이 끊기므로 새 토큰으로 이 스크립트를 다시 돌린다. 토큰은 파일로만 받는다 (명령줄·helm 기록에 안 남게)
#   GITOPS_TOKEN_FILE: https 주소 + 읽기 전용 토큰 (플랫폼 Argo CD 의 gitops-repo Secret 과 같은 방식, 사용자 x-access-token).
#     조직 정책으로 deploy key 를 못 쓰는 레포용 (2026-11-05 Softbank-Hackathon-Team 실측). 토큰은 명령줄·화면에 안 남게 파일로만 받는다
# AGENT_IMAGE 를 레지스트리에서 못 받는 서버(이미지 파일을 옮겨 k3s ctr images import 로 넣는 경우)는 digest 이름표가 따로 있어야 한다.
#   import 는 태그 이름만 남기고, 차트는 AGENT_IMAGE(@sha256:...)로 찾는다 → 이름표가 없으면 ErrImagePull (2026-11-05 VM 실측, 두 번 겪음)
#   sudo k3s ctr -n k8s.io images import svc-onprem-agent.tar
#   sudo k3s ctr -n k8s.io images tag <import 가 찍은 태그 이름> "$AGENT_IMAGE"
#   확인: sudo k3s ctr -n k8s.io images ls -q | grep -F "$AGENT_IMAGE"
# 되돌리기: helm uninstall onprem-agent -n svc-agent; kubectl delete ns svc-agent; Argo·봉인 컨트롤러를 지우려면 같은 yaml 로 kubectl delete
#   (봉인 키 Secret(kube-system 의 sealed-secrets-key…)은 컨트롤러가 만든 것이라 yaml 로 지워지지 않고 남는다. 그 Secret 을 지우면 이미 봉인된 값은 다시 못 푼다)
set -euo pipefail
cd "$(dirname "$0")/.."

ARGO_YAML=tools/argocd-core-install-v2.13.3.yaml
ARGO_SHA=cfe23fcb976c00c96e5add2f8fd9f70db4390b06c66ec4f391634e49e3ef45e3   # tools/argo-k3d.sh 와 같은 값
ARGO_NS=argocd
SEALED_YAML=tools/sealed-secrets-controller-v0.40.0.yaml
SEALED_SHA=ac8aabccdd9110430d117501705818115b2ab0993700a9c118d4d42cf4015a17   # github.com/bitnami-labs/sealed-secrets 릴리스 v0.40.0 controller.yaml
CNPG_YAML=tools/cnpg-1.30.1.yaml
CNPG_SHA=37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb   # github.com/cloudnative-pg/cloudnative-pg 릴리스 v1.30.1 cnpg-1.30.1.yaml (2026-11-06 받음)
ESO_TGZ=tools/external-secrets-2.14.0.tgz
ESO_SHA=0a6d9e91b1ff50adfdbf24b50b582babfa7c5b7df42b21974ca4b3fb88ee5e34   # github.com/external-secrets/external-secrets 릴리스 helm-chart-2.14.0 (2026-11-07 받음, 플랫폼 EKS 와 같은 판)
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
[ -z "${METRICS_URL:-}" ] && [ -z "${METRIC_TOKEN_FILE:-}" ] || { [ -n "${METRICS_URL:-}" ] && [ -n "${METRIC_TOKEN_FILE:-}" ]; } || die "METRICS_URL 과 METRIC_TOKEN_FILE 은 같이 준다"
[ -z "${METRIC_TOKEN_FILE:-}" ] || [ -f "$METRIC_TOKEN_FILE" ] || die "METRIC_TOKEN_FILE 없음"
[ -z "${METRICS_URL:-}" ] || case "$METRICS_URL" in https://*/*) ;; *) die "METRICS_URL 은 https://<호스트>/<경로>";; esac
got=$(sha256sum "$ARGO_YAML" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ARGO_YAML" | cut -d' ' -f1)
[ "$got" = "$ARGO_SHA" ] || die "Argo 설치 파일 sha 불일치: $got"
got=$(sha256sum "$SEALED_YAML" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$SEALED_YAML" | cut -d' ' -f1)
[ "$got" = "$SEALED_SHA" ] || die "봉인 컨트롤러 설치 파일 sha 불일치: $got"
if [ "${INSTALL_CNPG:-1}" != "0" ]; then
  got=$(sha256sum "$CNPG_YAML" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$CNPG_YAML" | cut -d' ' -f1)
  [ "$got" = "$CNPG_SHA" ] || die "CNPG 설치 파일 sha 불일치: $got"
fi

if [ "${INSTALL_ESO:-1}" != "0" ]; then
  got=$(sha256sum "$ESO_TGZ" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ESO_TGZ" | cut -d' ' -f1)
  [ "$got" = "$ESO_SHA" ] || die "External Secrets 차트 sha 불일치: $got"
fi

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

echo "1b/5 봉인 컨트롤러 (sealed-secrets v0.40.0, kube-system)"
# 이미 있으면 같은 파일이라 바뀌는 것 없음. 봉인 키는 컨트롤러가 처음 뜰 때 클러스터 안에서 만든다 (밖으로 안 나간다)
K apply -f "$SEALED_YAML" >/dev/null
K -n kube-system rollout status deploy/sealed-secrets-controller --timeout=300s >/dev/null

echo "1c/5 CNPG 운영자 (온프레 도착 DB)"
# 이미 있으면 그대로 둔다: 고객이 helm 등으로 다른 판을 깔았을 수 있다 (덮어쓰면 그 설치와 싸운다). 다시 실행해도 결과가 같다
if K get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
  echo "  이미 있음 (건너뜀)"
elif [ "${INSTALL_CNPG:-1}" = "0" ]; then
  echo "  INSTALL_CNPG=0: 깔지 않음. 도착 DB(CNPG Cluster)는 CNPG 운영자가 있어야 뜬다" >&2
else
  # CRD 가 커서 client-side apply 의 annotation 한도를 넘는다 → server-side (Argo 와 같은 이유)
  K apply --server-side --force-conflicts -f "$CNPG_YAML" >/dev/null
  K -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=300s >/dev/null
fi

echo "1d/5 External Secrets 운영자 (앱 비밀)"
# CNPG 와 같은 규칙: 이미 있으면(고객이 다른 판을 깔았을 수 있다) 그대로 둔다. 다시 실행해도 결과가 같다
if K get crd externalsecrets.external-secrets.io >/dev/null 2>&1; then
  echo "  이미 있음 (건너뜀)"
elif [ "${INSTALL_ESO:-1}" = "0" ]; then
  echo "  INSTALL_ESO=0: 깔지 않음. 앱 비밀(ExternalSecret)이 있는 이전은 Argo 동기화에서 멈춘다" >&2
else
  helm ${KUBE_CONTEXT:+--kube-context "$KUBE_CONTEXT"} upgrade --install external-secrets "$ESO_TGZ" -n external-secrets --create-namespace \
    --set installCRDs=true --wait --timeout 300s >/dev/null
fi
K get clustersecretstore >/dev/null 2>&1 && [ -n "$(K get clustersecretstore -o name 2>/dev/null)" ] \
  || echo "  주의: 비밀 저장소(ClusterSecretStore)가 없다. 앱 비밀이 있는 이전은 배포 때 비밀 값을 못 가져온다 (저장소를 하나 만든다)" >&2

echo "2/5 Agent 키 Secret"
K create ns "$NS" --dry-run=client -o yaml | K apply -f - >/dev/null
K -n "$NS" create secret generic agent-key --from-env-file="$AGENT_KEY_FILE" --dry-run=client -o yaml | K apply -f - >/dev/null

if [ -n "${METRIC_TOKEN_FILE:-}" ]; then
  # 지표 토큰 (#245). 줄바꿈을 뗀 사본을 600 임시 파일로. 모양(svc_mt_ + 43자)이 아니면 게이트웨이가 401 이라 여기서 멈춘다
  mtok=$(umask 077; mktemp); trap 'rm -f "${mtok:-}"' EXIT
  tr -d '\r\n' < "$METRIC_TOKEN_FILE" > "$mtok"
  grep -Eq '^svc_mt_[A-Za-z0-9_-]{43}$' "$mtok" || { rm -f "$mtok"; die "METRIC_TOKEN_FILE 이 지표 토큰 모양(svc_mt_...)이 아니다"; }
  K -n "$NS" create secret generic svc-metric-token --from-file=token="$mtok" --dry-run=client -o yaml | K apply -f - >/dev/null
  rm -f "$mtok"
fi

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
  tok=$(umask 077; mktemp); trap 'rm -f "$tok" "${mtok:-}"' EXIT
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
  --set grants.cluster="$([ "${GRANTS_CLUSTER:-0}" = 1 ] && echo true || echo false)" \
  --set grants.inventory="$([ "${INVENTORY:-1}" = 0 ] && echo false || echo true)" \
  --set metrics.endpoint="${METRICS_URL:-}" >/dev/null
K -n "$NS" rollout status deploy/onprem-agent --timeout=180s >/dev/null
[ -z "${METRICS_URL:-}" ] || K -n "$NS" rollout status deploy/svc-metrics --timeout=180s >/dev/null

echo "5/5 Agent 권한 확인"
SA="system:serviceaccount:$NS:onprem-agent"
check() { local want=$1; shift; local got; got=$(K auth can-i --as="$SA" "$@" 2>/dev/null || true); [ "$got" = "$want" ] || die "권한이 기대와 다름: can-i $* = $got (기대 $want)"; }
check yes list pods -A
check yes list clusters.postgresql.cnpg.io -A
check yes list applications.argoproj.io -n "$ARGO_NS"
check no create deployments -A
check no delete pods -A
check no get secrets -A
# 온프레 출발 가져오기 역할(grants.inventory, 기본 켬)은 ConfigMap·노드를 읽는다. 끄면(INVENTORY=0) 읽지 못해야 한다
if [ "${INVENTORY:-1}" = 0 ]; then check no get configmaps -A; else check yes list configmaps -A; check yes list nodes; fi
if [ -n "${METRICS_URL:-}" ]; then
  SA="system:serviceaccount:$NS:svc-metrics"   # 지표 수집기: 파드 읽기만
  check yes list pods -A
  check no get secrets -A
  check no create pods -A
  check no list deployments.apps -A
fi
echo "onprem-install: 완료 (Agent 는 읽기만, 들어오는 포트 없음)"
