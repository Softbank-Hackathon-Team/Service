#!/usr/bin/env bash
# 앱 Helm 차트(gitops/charts/app)를 값 5벌로 렌더해서 쿠버네티스 스키마 검사.
#   값: 차트 기본값 + 어댑터 4개(aws·gcp·onprem·azure_mock)가 만든 값(deploy/ci/values/*.json)
#   CRD(ExternalSecret, CNPG Cluster)는 datreeio CRDs-catalog 스키마로 검사
# 필요: helm, kubeconform. 사용: bash deploy/ci/check-gitops.sh
# DRAFT(ai): 쿠버네티스 1.33 스키마 기준(EKS·GKE 기본 버전에 맞춰 바꾼다)
# 값 파일 다시 만들기: 어댑터 toHelmValues() 가 바뀌면 deploy/ci/README 의 명령으로 갱신
set -euo pipefail

CHART=gitops/charts/app
K8S_VERSION="${K8S_VERSION:-1.33.0}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# Z66: 차트 원본은 gitops 레포 하나. 이 사본은 CI 검사용이라 gitops 레포와 한 글자도 다르면 실패시킨다
#   GITOPS_REPO_DIR(워커가 쓰는 작업 복사본)이 있을 때만 비교. 없으면 건너뜀을 출력
if [ -n "${GITOPS_REPO_DIR:-}" ] && [ -d "$GITOPS_REPO_DIR/charts/app" ]; then
  if ! diff -r "$CHART" "$GITOPS_REPO_DIR/charts/app" > "$OUT/drift.diff"; then
    echo "FAIL 차트 사본이 gitops 레포와 다르다 ($GITOPS_REPO_DIR/charts/app):"; cat "$OUT/drift.diff"; exit 1
  fi
  echo "ok   차트 사본 = gitops 레포 차트"
else
  echo "skip 차트 사본 비교 (GITOPS_REPO_DIR 없음)"
fi

helm lint "$CHART"

helm template x "$CHART" > "$OUT/default.yaml"
for f in deploy/ci/values/*.json; do
  n="$(basename "$f" .json)"
  helm template x "$CHART" -f "$f" > "$OUT/$n.yaml"
done

kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT"/*.yaml
