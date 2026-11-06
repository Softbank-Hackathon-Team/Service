#!/usr/bin/env bash
# 온프레 설치 한 줄 (고객 서버에서 사람이 돌린다. 플랫폼은 고객 서버에 들어가지 않는다)
#   콘솔 연결 화면이 이 명령을 준다:  curl -fsSL <플랫폼>/api/v1/install/onprem.sh | SVC_ENROLL_TOKEN=et_... bash
# 플랫폼 API 가 이 파일의 __SVC_*__ 자리를 채워서 내려준다 (apps/api/src/routes/onprem-install.ts). 레포 체크아웃이 필요 없다.
# 하는 일:
#   1) 설치 파일(차트·고정 yaml·설치 스크립트)을 플랫폼에서 받아 sha256 대조
#   2) gitops 읽기 전용 배포 키를 이 서버에서 만든다 (비밀 반쪽은 이 서버·클러스터 밖으로 안 나간다)
#   3) 일회용 등록 토큰으로 등록: Agent 키 + 회사 전용 gitops 레포 주소 + 지표 주소·토큰을 받는다 (공개 키만 보낸다)
#   4) tools/onprem-install.sh 로 Argo CD core·봉인 컨트롤러·CNPG·External Secrets(없을 때만)·Agent 를 깐다
# 다시 돌려도 된다: 이미 등록된 서버(상태 폴더에 키가 있음)면 등록을 건너뛰고 설치만 다시 맞춘다.
#   다른 환경으로 다시 등록하려면 SVC_REENROLL=1 + 새 토큰
# 전제: 이 서버에서 kubectl 이 클러스터 관리자로 붙는다 (k3s 면 sudo 또는 KUBECONFIG=/etc/rancher/k3s/k3s.yaml).
#   필요한 명령: kubectl curl ssh-keygen sha256sum tar. helm 이 없으면 판 고정 + sha256 확인해서 상태 폴더에 받는다
# 나가는 연결만 쓴다: 플랫폼(443), GitHub ssh.github.com:443(Argo CD 가 gitops 읽기), ghcr.io·quay.io·docker.io(이미지)
set -euo pipefail

API="__SVC_API__"
AGENT_IMAGE="__SVC_AGENT_IMAGE__"
# "sha256  경로" 줄 목록. 경로는 설치 묶음 안의 상대 경로
MANIFEST='__SVC_MANIFEST__'
HELM_VERSION=v4.3.1
# 아래 두 값은 ${!sha_var} 로 간접 참조한다
# shellcheck disable=SC2034
HELM_SHA_amd64=0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b
# shellcheck disable=SC2034
HELM_SHA_arm64=8cf8f66ecbc252ac8f7f06cca68aba88508ddfde3a6a34feb1678ad1694b4f88

die() { echo "svc-onprem: $*" >&2; exit 1; }
STATE=${SVC_STATE_DIR:-$HOME/.svc-onprem}
umask 077
mkdir -p "$STATE"; chmod 700 "$STATE"

for c in kubectl curl ssh-keygen sha256sum tar; do command -v "$c" >/dev/null || die "$c 이 필요하다"; done
kubectl get namespace kube-system >/dev/null 2>&1 || die "kubectl 로 클러스터에 붙지 못한다 (k3s 면 sudo 로 실행하거나 KUBECONFIG=/etc/rancher/k3s/k3s.yaml)"

# helm: 있으면 그것, 없으면 판 고정해서 받는다
if ! command -v helm >/dev/null; then
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "helm 을 받을 수 없는 CPU: $(uname -m)" ;; esac
  sha_var="HELM_SHA_$arch"
  echo "helm 이 없어 $HELM_VERSION ($arch) 을 받는다"
  curl -fsSL "https://get.helm.sh/helm-$HELM_VERSION-linux-$arch.tar.gz" -o "$STATE/helm.tgz"
  echo "${!sha_var}  $STATE/helm.tgz" | sha256sum -c --quiet - || die "helm 내려받기 sha256 불일치"
  tar -xzf "$STATE/helm.tgz" -C "$STATE" "linux-$arch/helm" && mv "$STATE/linux-$arch/helm" "$STATE/helm" && rm -rf "$STATE/linux-$arch" "$STATE/helm.tgz"
  export PATH="$STATE:$PATH"
fi

echo "1/4 설치 파일 받기 (sha256 확인)"
B="$STATE/bundle"
rm -rf "$B"; mkdir -p "$B"
while read -r sum path; do
  [ -n "$path" ] || continue
  case "$path" in /*|*..*) die "설치 파일 경로가 이상하다: $path" ;; esac
  mkdir -p "$B/$(dirname "$path")"
  curl -fsSL "$API/api/v1/install/onprem/$path" -o "$B/$path"
  echo "$sum  $B/$path" | sha256sum -c --quiet - || die "설치 파일 검증 실패: $path"
done <<<"$MANIFEST"

if [ -f "$STATE/agent-key.env" ] && [ -f "$STATE/install.env" ] && [ "${SVC_REENROLL:-}" != "1" ]; then
  echo "2/4 이미 등록된 서버 (등록 건너뜀. 다른 환경으로 다시 등록하려면 SVC_REENROLL=1 + 새 토큰)"
else
  [ -n "${SVC_ENROLL_TOKEN:-}" ] || die "SVC_ENROLL_TOKEN 이 없다 (콘솔 연결 화면의 명령을 그대로 붙여 넣는다. 토큰은 10분, 한 번만)"
  case "$SVC_ENROLL_TOKEN" in et_*) ;; *) die "SVC_ENROLL_TOKEN 모양이 아니다" ;; esac
  echo "2/4 gitops 읽기 전용 키 만들기 + 등록"
  rm -f "$STATE/gitops_ro" "$STATE/gitops_ro.pub"
  ssh-keygen -q -t ed25519 -N "" -C "svc-onprem-gitops-ro" -f "$STATE/gitops_ro"
  pub=$(cut -d' ' -f1,2 "$STATE/gitops_ro.pub")
  # 토큰은 명령줄(ps)에 안 남게 표준 입력으로 보낸다
  code=$(printf '{"enrollToken":"%s","gitopsPublicKey":"%s"}' "$SVC_ENROLL_TOKEN" "$pub" \
    | curl -sS -o "$STATE/register.json" -w '%{http_code}' -X POST "$API/api/v1/agent/register" \
        -H 'content-type: application/json' --data-binary @-) || die "플랫폼에 닿지 못했다: $API"
  unset SVC_ENROLL_TOKEN
  if [ "$code" != "201" ]; then
    err=$(sed -n 's/.*"code":"\([A-Z_]*\)".*/\1/p' "$STATE/register.json"); rm -f "$STATE/register.json"
    die "등록 실패 (HTTP $code ${err:-}). 토큰은 이미 썼으니 콘솔에서 새 명령을 받아 다시 돌린다"
  fi
  # 응답은 우리 API 가 만든 한 줄 JSON 이고 값 모양이 정해져 있다 → 뽑은 뒤 모양을 다시 검사한다 (jq 없이)
  j() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$STATE/register.json"; }
  key_id=$(j keyId); secret=$(j secret); tenant=$(j tenant); repo=$(j repoURL); murl=$(j url); mtok=$(j token)
  rm -f "$STATE/register.json"
  [[ "$key_id" =~ ^ak_[0-9a-f]{24}$ ]] || die "등록 응답에 Agent 키 번호가 없다"
  [[ "$secret" =~ ^[0-9a-f]{64}$ ]] || die "등록 응답에 Agent 비밀이 없다"
  [[ "$tenant" =~ ^t-[0-9a-f]{8}$ ]] || die "등록 응답에 회사가 없다"
  [[ "$repo" =~ ^ssh://git@ssh\.github\.com:443/[A-Za-z0-9-]+/[A-Za-z0-9._-]+\.git$ ]] || die "등록 응답에 회사 gitops 레포가 없다 (플랫폼에 회사 레포 설정이 없음)"
  printf 'AGENT_KEY_ID=%s\nAGENT_KEY_SECRET=%s\n' "$key_id" "$secret" > "$STATE/agent-key.env"
  { printf 'TENANT=%s\nGITOPS_REPO_URL=%s\n' "$tenant" "$repo"
    if [ -n "$murl" ] && [ -n "$mtok" ]; then
      [[ "$murl" =~ ^https://[^/]+/ ]] && [[ "$mtok" =~ ^svc_mt_[A-Za-z0-9_-]{43}$ ]] || die "등록 응답의 지표 주소·토큰 모양이 이상하다"
      printf '%s' "$mtok" > "$STATE/metric-token"
      printf 'METRICS_URL=%s\n' "$murl"
    fi; } > "$STATE/install.env"
  echo "  등록됨: 회사 $tenant, Agent 키 $key_id"
fi

echo "3/4 설치 (Argo CD core · 봉인 컨트롤러 · CNPG · Agent)"
# shellcheck disable=SC1091
. "$STATE/install.env"
metrics=()
[ -n "${METRICS_URL:-}" ] && [ -f "$STATE/metric-token" ] && metrics=(METRICS_URL="$METRICS_URL" METRIC_TOKEN_FILE="$STATE/metric-token")
(cd "$B" && env TENANT="$TENANT" GITOPS_REPO_URL="$GITOPS_REPO_URL" AGENT_REPORT_URL="$API" AGENT_IMAGE="$AGENT_IMAGE" \
  AGENT_KEY_FILE="$STATE/agent-key.env" GITOPS_SSH_KEY_FILE="$STATE/gitops_ro" ${metrics[@]+"${metrics[@]}"} bash tools/onprem-install.sh)

echo "4/4 확인"
kubectl -n svc-agent rollout status deploy/onprem-agent --timeout=180s
echo "끝. 콘솔 환경 화면에 '마지막 신호 N초 전' 이 뜨면 연결된 것이다. 상태 폴더: $STATE (Agent 키·gitops 키, 권한 700)"
