#!/usr/bin/env bash
# 노트북(맥) Docker 위 k3d 에 온프레 도착 환경 하나를 명령 한 번으로 만든다 (클라우드 → 온프레 데모·시험용)
#   1) k3d 클러스터 <이름> (서버 1대, traefik 끔: 입구는 앱 차트 cloudflared 라 필요 없다). 이미 있으면 그대로 쓴다
#   2) 콘솔 설치 한 줄(<플랫폼>/api/v1/install/onprem.sh = tools/onprem-bootstrap.sh)을 이 클러스터에 돌린다
#      → 등록 + Argo CD core·봉인 컨트롤러·CNPG·External Secrets·Agent. 상태 폴더는 클러스터마다 따로(~/.svc-onprem-<이름>)
#   3) 데모용 비밀 저장소: ClusterSecretStore(기본 이름 vault) = ESO kubernetes 공급자. 같은 클러스터 svc-demo-secrets
#      네임스페이스의 Secret 을 읽는다. DEMO_SECRETS 의 비밀마다 임의 값 Secret <앱이름>-<비밀이름> 을 만든다 (이미 있으면 그대로 둔다)
#      이름 규칙은 온프레 어댑터 remoteKey 와 같다: <app.name>-<비밀이름(소문자, _ → -)>
#      DRAFT(ai): 앱 ExternalSecret 이 기본 저장소 vault 를 가리키는데 온프레에 이를 만드는 곳이 없어 데모용으로만 채운다.
#        TODO(human): 온프레 기본 비밀 저장소(OpenBao 등)를 정하면 3) 을 그것으로 바꾼다
# 사용 (Service 폴더에서, 토큰은 콘솔 환경 연결 화면의 명령에 든 et_... 값. 10분, 한 번만):
#   SVC_ENROLL_TOKEN=et_... bash tools/onprem-k3d.sh up [이름]     이름 기본 svc-onprem
#   bash tools/onprem-k3d.sh down [이름]                          클러스터만 지운다 (상태 폴더·콘솔 환경은 남는다)
# 환경 변수 (선택)
#   SVC_API            플랫폼 주소 (기본 https://console.softbank-team-iron.com)
#   SVC_STATE_DIR      상태 폴더 (기본 ~/.svc-onprem-<이름>). 이미 등록된 상태 폴더면 토큰 없이 설치만 다시 맞춘다
#   APP_NAME           이전할 앱의 명세 이름 app.name (기본 shop-api = 샘플을 가져올 때 이름순 첫 서비스)
#   DEMO_SECRETS       "비밀이름:키1,키2 비밀이름2:키" (기본 api-secrets:API_TOKEN = GCP·AWS 샘플 앱 비밀)
#   SECRET_STORE_NAME  ClusterSecretStore 이름 (기본 vault, 플랫폼 온프레 어댑터 기본값)
# 현재 kubectl 컨텍스트는 바꾸지 않는다 (임시 kubeconfig). 나중에 kubectl 로 보려면: k3d kubeconfig merge <이름> --kubeconfig-switch-context=false
# 필요한 명령: docker k3d kubectl curl ssh-keygen sha256sum(맥: brew install coreutils) tar openssl
# 하지 않는 것: 클라우드 자원·포트 열기·.env 읽기. 토큰·비밀 값을 화면·명령줄에 남기지 않는다
set -euo pipefail
cd "$(dirname "$0")/.."

CMD=${1:-}
NAME=${2:-${ONPREM_NAME:-svc-onprem}}
API=${SVC_API:-https://console.softbank-team-iron.com}
STORE=${SECRET_STORE_NAME:-vault}
STORE_NS=svc-demo-secrets
DEMO_SECRETS=${DEMO_SECRETS:-api-secrets:API_TOKEN}
APP_NAME=${APP_NAME:-shop-api}
say() { echo "onprem-k3d: $*"; }
die() { say "$*" >&2; exit 1; }

case "$CMD" in up|down) ;; *) sed -n '2,22p' "$0"; [ -z "$CMD" ] || exit 2; exit 0 ;; esac
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || die "이름은 소문자·숫자·- 32자 이내: $NAME"
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "APP_NAME 은 소문자·숫자·-: $APP_NAME"
STATE=${SVC_STATE_DIR:-$HOME/.svc-onprem-$NAME}

need=(docker k3d kubectl curl)
[ "$CMD" = up ] && need+=(ssh-keygen sha256sum tar openssl)
for c in "${need[@]}"; do
  command -v "$c" >/dev/null || die "$c 이 필요하다$([ "$c" = sha256sum ] && echo ' (맥: brew install coreutils)')"
done

if [ "$CMD" = down ]; then
  k3d cluster delete "$NAME"
  say "클러스터 $NAME 지움. 상태 폴더 $STATE 와 콘솔 환경은 남아 있다 (같은 이름으로 다시 up 하면 토큰 없이 다시 설치한다)"
  exit 0
fi

# 등록 전이면 토큰이 있어야 한다. 클러스터를 만들기 전에 막는다
if [ ! -f "$STATE/agent-key.env" ] && [ -z "${SVC_ENROLL_TOKEN:-}" ]; then
  die "SVC_ENROLL_TOKEN 이 없다. 콘솔 → 환경 → 온프레 연결 화면의 명령에서 et_... 값을 SVC_ENROLL_TOKEN=et_... 로 앞에 붙인다 (또는 이미 등록한 SVC_STATE_DIR)"
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
KCFG="$TMP/kubeconfig"
K() { kubectl --kubeconfig "$KCFG" "$@"; }

say "1/3 k3d 클러스터 $NAME"
if k3d cluster get "$NAME" >/dev/null 2>&1; then
  say "  이미 있음 (그대로 씀)"
else
  k3d cluster create "$NAME" --servers 1 --agents 0 --k3s-arg "--disable=traefik@server:0" --wait
fi
k3d kubeconfig get "$NAME" > "$KCFG"
K get namespace kube-system >/dev/null || die "클러스터 $NAME 에 붙지 못한다 (Docker Desktop 이 켜져 있는지)"

say "2/3 콘솔 설치 한 줄 ($API, 상태 폴더 $STATE)"
curl -fsSL "$API/api/v1/install/onprem.sh" -o "$TMP/onprem.sh" || die "설치 스크립트를 못 받았다: $API"
# 토큰은 환경으로만 넘긴다 (명령줄에 안 남음). 설치 스크립트가 쓰고 지운다
KUBECONFIG="$KCFG" SVC_STATE_DIR="$STATE" bash "$TMP/onprem.sh"
unset SVC_ENROLL_TOKEN

say "3/3 데모 비밀 저장소 $STORE (kubernetes 공급자 → $STORE_NS)"
K wait --for=condition=established crd/clustersecretstores.external-secrets.io --timeout=180s >/dev/null
K apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Namespace
metadata: { name: ${STORE_NS}, labels: { svc.platform/purpose: demo-secret-store } }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: eso-demo-reader, namespace: ${STORE_NS} }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: eso-demo-reader, namespace: ${STORE_NS} }
rules:
  - { apiGroups: [""], resources: ["secrets"], verbs: ["get", "list", "watch"] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: eso-demo-reader, namespace: ${STORE_NS} }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: eso-demo-reader }
subjects: [{ kind: ServiceAccount, name: eso-demo-reader, namespace: ${STORE_NS} }]
---
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata: { name: ${STORE} }
spec:
  provider:
    kubernetes:
      remoteNamespace: ${STORE_NS}
      server:
        url: https://kubernetes.default.svc
        caProvider: { type: ConfigMap, name: kube-root-ca.crt, key: ca.crt, namespace: ${STORE_NS} }
      auth:
        serviceAccount: { name: eso-demo-reader, namespace: ${STORE_NS} }
EOF
for spec in $DEMO_SECRETS; do
  sname=${spec%%:*}; keys=${spec#*:}
  [[ "$sname" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$ ]] && [ "$keys" != "$spec" ] || die "DEMO_SECRETS 모양: 비밀이름:키1,키2 ($spec)"
  # 온프레 어댑터 remoteKey 와 같은 규칙: <앱>-<비밀이름 소문자, _ → ->
  sname="$APP_NAME-$(echo "$sname" | tr 'A-Z_' 'a-z-')"
  if K -n "$STORE_NS" get secret "$sname" >/dev/null 2>&1; then say "  $sname 이미 있음 (그대로 둠)"; continue; fi
  args=()
  for k in ${keys//,/ }; do
    [[ "$k" =~ ^[A-Za-z0-9._-]+$ ]] || die "비밀 키 이름이 이상하다: $k"
    ( umask 077; openssl rand -hex 16 | tr -d '\n' > "$TMP/v-$k" )
    args+=(--from-file="$k=$TMP/v-$k")
  done
  K -n "$STORE_NS" create secret generic "$sname" "${args[@]}" --dry-run=client -o yaml | K apply -f - >/dev/null
  say "  $sname ($keys) 임의 값으로 만듦"
done
K wait --for=condition=Ready "clustersecretstore/$STORE" --timeout=120s >/dev/null || say "  주의: $STORE 가 아직 Ready 가 아니다 (kubectl describe clustersecretstore $STORE)"

say "끝. 콘솔 환경 화면에 '마지막 신호 N초 전' 이 뜨면 연결된 것이다"
say "kubectl 로 보려면: k3d kubeconfig merge $NAME --kubeconfig-switch-context=false  (컨텍스트 k3d-$NAME)"
