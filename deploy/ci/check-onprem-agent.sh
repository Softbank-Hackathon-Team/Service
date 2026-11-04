#!/usr/bin/env bash
# 온프레 설치 묶음(deploy/helm/onprem-agent, W2)을 렌더해서 스키마 검사 + 권한 단언.
#   - L0 만 / L1 켬 두 벌 렌더, kubeconform (Argo CRD 는 datreeio CRDs-catalog 스키마)
#   - 필수 값이 없거나 모양이 틀리면 렌더가 실패하는지 (태그 이미지, http 보고 주소, 회사 이름)
#   - Agent 권한에 쓰기 동사·Secret·ConfigMap 이 없는지 (ADR-005 D3)
#   - AppProject 가 클러스터 범위 자원과 RBAC 를 git 에서 못 만들게 막는지
# 필요: helm, kubeconform(없으면 스키마 검사만 건너뜀). 사용: bash deploy/ci/check-onprem-agent.sh
set -euo pipefail

CHART=deploy/helm/onprem-agent
K8S_VERSION="${K8S_VERSION:-1.35.0}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail=0

# 가짜 값 (렌더·검사 전용)
DIGEST=$(printf 'a%.0s' $(seq 64))
OK=(--set tenant=t-0a1b2c3d --set gitops.repoURL=https://github.com/example/gitops.git
    --set agent.reportURL=https://api.example.test --set "agent.image=ghcr.io/example/svc-onprem-agent@sha256:$DIGEST")

helm lint "$CHART" "${OK[@]}"
helm template oa "$CHART" -n svc-agent "${OK[@]}" > "$OUT/l0.yaml"
helm template oa "$CHART" -n svc-agent "${OK[@]}" --set grants.cluster=true > "$OUT/l1.yaml"

# 틀린 값은 렌더 실패여야 한다
bad() { if helm template oa "$CHART" "${OK[@]}" "$@" >/dev/null 2>&1; then echo "FAIL 렌더가 됐다: $*"; fail=1; fi; }
bad --set agent.image=ghcr.io/example/svc-onprem-agent:latest
bad --set agent.reportURL=http://api.example.test
bad --set tenant=acme
bad --set gitops.repoURL=
[ $fail -eq 0 ] && echo "ok   필수 값 없음·틀린 모양은 렌더 실패"

if command -v kubeconform >/dev/null; then
  kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    "$OUT"/*.yaml
else
  echo "skip kubeconform 없음 (스키마 검사 건너뜀)"
fi

# 권한·울타리 단언은 렌더 결과를 직접 읽는다 (python3 + PyYAML 없이: 렌더 모양이 고정이라 줄 단위로 충분)
python3 - "$OUT/l0.yaml" "$OUT/l1.yaml" <<'PY' || fail=1
import re, sys
bad = 0
for path, want_roles in ((sys.argv[1], 1), (sys.argv[2], 2)):
    docs = open(path, encoding="utf-8").read().split("\n---")
    roles = [d for d in docs if re.search(r"^kind: ClusterRole$", d, re.M)]
    if len(roles) != want_roles:
        print(f"FAIL {path}: ClusterRole {len(roles)}개, 기대 {want_roles}"); bad = 1
    for d in roles:
        for verbs in re.findall(r"verbs: \[([^\]]*)\]", d):
            for v in re.findall(r'"([a-z]+)"', verbs):
                if v not in ("get", "list", "watch"):
                    print(f"FAIL {path}: 쓰기 동사 {v}"); bad = 1
        for res in re.findall(r"resources: \[([^\]]*)\]", d):
            if re.search(r'"(secrets|configmaps|\*)"', res):
                print(f"FAIL {path}: 읽으면 안 되는 자원 {res}"); bad = 1
    proj = [d for d in docs if re.search(r"^kind: AppProject$", d, re.M)][0]
    if "clusterResourceWhitelist: []" not in proj:
        print(f"FAIL {path}: AppProject 가 클러스터 범위 자원을 연다"); bad = 1
    for k in ("Role", "RoleBinding"):
        if f'kind: "{k}"' not in proj:
            print(f"FAIL {path}: AppProject 가 {k} 를 막지 않는다"); bad = 1
    dep = [d for d in docs if re.search(r"^kind: Deployment$", d, re.M)][0]
    for must in ("readOnlyRootFilesystem: true", "runAsNonRoot: true", "allowPrivilegeEscalation: false"):
        if must not in dep:
            print(f"FAIL {path}: Agent 에 {must} 없음"); bad = 1
if not bad:
    print("ok   Agent 권한은 읽기만(Secret·ConfigMap 없음), AppProject 는 클러스터 자원·RBAC 막음, Agent 는 비루트·읽기 전용")
sys.exit(bad)
PY
exit $fail
