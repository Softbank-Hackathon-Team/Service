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

# 런타임 가드 대상: gVisor 끔 = 수정 고리만, 켬 = 리허설도 (ADR-006 Q7)
purpose() { awk '/^kind: ValidatingAdmissionPolicyBinding$/{b=1} b&&/name: sbx-runtimeclass-guard$/{f=1} f&&/values:/{print; exit}' "$OUT/$1.yaml" | tr -d ' '; }
if [ "$(purpose sandbox-on)" != "values:[remediation]" ]; then echo "FAIL sandbox-on: 런타임 가드 대상 $(purpose sandbox-on)"; fail=1; fi
if [ "$(purpose gvisor-on)" != "values:[remediation,rehearsal]" ]; then echo "FAIL gvisor-on: 런타임 가드 대상 $(purpose gvisor-on)"; fail=1; fi
[ $fail -eq 0 ] && echo "ok   런타임 가드 대상 (gVisor 끔 = 수정 고리, 켬 = 리허설도)"

# worker GCP 로그인: 값이 없으면 아무것도 안 그린다, 값이 있으면 worker 만 설정 파일·토큰을 받는다, 틀린 모양은 렌더 실패
AUD=//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/platform-hub/providers/platform-eks
IMG=(--set apps.image.registry=x --set apps.image.tag=y)
if helm template platform "$CHART" -n platform "${IMG[@]}" | grep -qE 'GCP_PLATFORM_PROJECT|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|worker-gcp-cred'; then
  echo "FAIL gcpPlatform 값 없이 GCP 설정이 그려졌다"; fail=1
fi
# --reuse-values: 이 칸이 생기기 전 릴리스 값으로 올려도 렌더가 돈다
if ! helm template platform "$CHART" -n platform "${IMG[@]}" --set gcpPlatform=null >/dev/null 2>&1; then
  echo "FAIL gcpPlatform 칸이 없는 릴리스 값으로 렌더가 안 된다"; fail=1
fi
GCP=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set gcpPlatform.project=platform-proj --set "gcpPlatform.wifAudience=$AUD")
printf '%s\n' "$GCP" > "$OUT/gcp-on.yaml"
kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT/gcp-on.yaml"
# 앱 Deployment 하나만 잘라 낸다
app() { printf '%s\n' "$GCP" | awk -v n="# Source: platform/templates/app.yaml" -v d="$1" 'BEGIN{RS="\n---\n"} index($0,n) && /kind: Deployment/ && index($0,"  name: " d "\n")'; }
want() { if ! app "$1" | grep -qF -- "$2"; then echo "FAIL $1 에 $2 없음"; fail=1; fi; }
deny() { if app "$1" | grep -qF -- "$2"; then echo "FAIL $1 에 $2 있음"; fail=1; fi; }
want api GCP_PLATFORM_PROJECT
want worker GCP_PLATFORM_PROJECT
want worker CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE
want worker "audience: $AUD"
want worker worker-gcp-cred
for a in api agent-worker web; do deny "$a" CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE; deny "$a" gcp-token; done
deny agent-worker GCP_PLATFORM_PROJECT
deny web GCP_PLATFORM_PROJECT
if ! printf '%s\n' "$GCP" | grep -qF 'svc-worker@platform-proj.iam.gserviceaccount.com:generateAccessToken'; then echo "FAIL 설정 파일에 svc-worker 없음"; fail=1; fi
for bad in "--set gcpPlatform.project=platform-proj" "--set gcpPlatform.project=platform-proj --set gcpPlatform.wifAudience=https://example.com/aud" "--set gcpPlatform.project=Bad_Project --set gcpPlatform.wifAudience=$AUD"; do
  # shellcheck disable=SC2086
  if helm template platform "$CHART" -n platform $bad >/dev/null 2>&1; then echo "FAIL '$bad' 인데 렌더가 됐다"; fail=1; fi
done
[ $fail -eq 0 ] && echo "ok   worker GCP 로그인 (값 없음·worker 만·틀린 모양 거부)"

# worker Terraform 디스크: 값이 없으면 아무것도 안 그린다, 켜면 worker 에만 붙는다, worker 가 2개면 렌더 실패
if helm template platform "$CHART" -n platform "${IMG[@]}" | grep -qE 'worker-tf-work|TF_WORK_DIR|type: Recreate'; then
  echo "FAIL tfWorkDir 값 없이 디스크가 그려졌다"; fail=1
fi
TFD=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set apps.worker.replicas=1 --set apps.worker.tfWorkDir.size=20Gi)
[ "$(printf '%s\n' "$TFD" | grep -c 'claimName: worker-tf-work')" = 1 ] || { echo "FAIL 디스크는 worker 하나에만 붙어야 한다"; fail=1; }
printf '%s\n' "$TFD" | grep -q 'name: TF_WORK_DIR, value: /var/lib/svc-tf' || { echo "FAIL TF_WORK_DIR 이 디스크를 가리키지 않는다"; fail=1; }
printf '%s\n' "$TFD" | grep -q 'type: Recreate' || { echo "FAIL 디스크를 켰는데 Recreate 가 아니다"; fail=1; }
if helm template platform "$CHART" -n platform "${IMG[@]}" --set apps.worker.tfWorkDir.size=20Gi >/dev/null 2>&1; then
  echo "FAIL worker 2개에 디스크를 켰는데 렌더가 됐다"; fail=1
fi
[ $fail -eq 0 ] && echo "ok   worker Terraform 디스크 (값 없음·worker 만·2개 거부)"
exit $fail
