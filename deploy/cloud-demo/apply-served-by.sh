#!/usr/bin/env bash
# Z70 DRAFT(ai): served-by 오리진 올리기 / 지우기 / 공개 주소 보기
#   bash deploy/cloud-demo/apply-served-by.sh up     <kube-context> <served-by 이름> [구역]
#   bash deploy/cloud-demo/apply-served-by.sh addr   <kube-context> [구역]
#   bash deploy/cloud-demo/apply-served-by.sh down   <kube-context> [구역]
# 구역 기본 app-demo. 한 클러스터에 오리진 두 개(출발·도착)를 올릴 때는 구역을 다르게 준다 (예: app-demo, app-demo2) (Z70-2)
set -euo pipefail
cmd="${1:?up|addr|down}"; ctx="${2:?kube context}"
here="$(cd "$(dirname "$0")" && pwd)"
check() { [[ "$1" =~ ^[a-z0-9-]+$ ]] || { echo "이름은 소문자·숫자·- 만: $1" >&2; exit 2; }; }
case "$cmd" in
  up)
    name="${3:?served-by 이름 (예: aws-app-demo)}"; ns="${4:-app-demo}"
    check "$name"; check "$ns"
    kubectl --context "$ctx" create namespace "$ns" --dry-run=client -o yaml | kubectl --context "$ctx" apply -f -
    # Z70-3: 자체 서명 인증서 (7일). 키는 임시 폴더에서 바로 Secret 으로 넣고 지운다 (파일·화면에 안 남김)
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=served-by" -keyout "$tmp/tls.key" -out "$tmp/tls.crt" 2>/dev/null
    kubectl --context "$ctx" -n "$ns" create secret tls served-by-tls --cert="$tmp/tls.crt" --key="$tmp/tls.key" \
      --dry-run=client -o yaml | kubectl --context "$ctx" apply -f -
    sed -e "s/__SERVED_BY__/${name}/" -e "s/namespace: app-demo/namespace: ${ns}/" -e "s/name: app-demo,/name: ${ns},/" \
      "$here/served-by.yaml" | kubectl --context "$ctx" apply -f -
    kubectl --context "$ctx" -n "$ns" rollout status deploy/served-by --timeout=180s ;;
  addr)
    ns="${3:-app-demo}"; check "$ns"
    kubectl --context "$ctx" -n "$ns" get svc served-by \
      -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{.status.loadBalancer.ingress[0].ip}{"\n"}' ;;
  down)
    ns="${3:-app-demo}"; check "$ns"
    # GATE: 끝나기를 끝없이 기다리지 않는다 (Terminating 에 걸린 구역이면 down 전체가 멈춘다). 남은 LB 는 demo-day 가 API 로 지운다
    kubectl --context "$ctx" delete namespace "$ns" --wait=true --ignore-not-found --timeout=300s ;;
  *) echo "up|addr|down" >&2; exit 2 ;;
esac
