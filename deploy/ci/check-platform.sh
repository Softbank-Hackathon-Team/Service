#!/usr/bin/env bash
# 플랫폼 차트(deploy/helm/platform)를 세 벌로 렌더해서 쿠버네티스 스키마 검사 + 샌드박스 자원 개수 확인.
#   기본(sandbox 끔) / sandbox 켬(gVisor 끔) / gVisor 켬
#   CRD(SecretStore, ExternalSecret)는 datreeio CRDs-catalog 스키마로 검사
#   sandbox 켬이면 sandbox.imageRegistry 가 꼭 있어야 한다. 없거나 모양이 틀리면 렌더가 실패하는지도 본다
# 필요: helm, kubeconform. 사용: bash deploy/ci/check-platform.sh
set -euo pipefail

CHART=deploy/helm/platform
K8S_VERSION="${K8S_VERSION:-1.35.0}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# 가짜 계정 (렌더·검사 전용)
ON=(--set sandbox.enabled=true --set sandbox.imageRegistry=000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox)

helm lint "$CHART"
helm lint "$CHART" "${ON[@]}"

helm template platform "$CHART" -n platform > "$OUT/default.yaml"
helm template platform "$CHART" -n platform "${ON[@]}" > "$OUT/sandbox-on.yaml"
helm template platform "$CHART" -n platform "${ON[@]}" --set sandbox.gvisor.enabled=true > "$OUT/gvisor-on.yaml"

fail=0
for bad in "" "https://000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox" "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox/" "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com" "ghcr.io/sandbox"; do
  if helm template platform "$CHART" -n platform --set sandbox.enabled=true --set "sandbox.imageRegistry=$bad" >/dev/null 2>&1; then
    echo "FAIL sandbox.imageRegistry='$bad' 인데 렌더가 됐다"; fail=1
  fi
done
[ $fail -eq 0 ] && echo "ok   sandbox.imageRegistry 없음·틀린 모양은 렌더 실패"

kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT"/*.yaml

# 자원 개수: 렌더 이름 뒤에 KINDS 순서대로
KINDS=(ClusterRole ClusterRoleBinding ValidatingAdmissionPolicy ValidatingAdmissionPolicyBinding StorageClass RuntimeClass ServiceAccount)
expect() {
  local f=$1; shift
  local want=("$@")
  for i in "${!KINDS[@]}"; do
    local got; got=$(grep -c "^kind: ${KINDS[$i]}\$" "$OUT/$f.yaml" || true)
    if [ "$got" != "${want[$i]}" ]; then echo "FAIL $f: ${KINDS[$i]} ${got}개, 기대 ${want[$i]}개"; fail=1; fi
  done
}
expect default     0 0 0 0 0 0 3
expect sandbox-on  2 1 6 6 1 0 3
expect gvisor-on   2 1 6 6 1 1 3
[ $fail -eq 0 ] && echo "ok   샌드박스 자원 개수 (기본 끔·켬·gVisor)"
exit $fail
