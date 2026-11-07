#!/usr/bin/env bash
# 온프레 설치 묶음(deploy/helm/onprem-agent, W2)을 렌더해서 스키마 검사 + 권한 단언.
#   - L0 만 / L1 켬 두 벌 렌더(인벤토리 역할 끔 = ADR-005 D3 최소 권한 그대로), kubeconform (Argo CRD 는 datreeio CRDs-catalog 스키마)
#   - 필수 값이 없거나 모양이 틀리면 렌더가 실패하는지 (태그 이미지, http 보고 주소, 회사 이름)
#   - Agent 권한에 쓰기 동사·Secret·ConfigMap 이 없는지 (ADR-005 D3)
#   - AppProject 가 클러스터 범위 자원과 RBAC 를 git 에서 못 만들게 막는지
#   - 인벤토리 역할(grants.inventory, 기본 켬): 온프레 출발 가져오기용 읽기 역할 하나만 더하고, Secret·쓰기 동사는 없는지
#   - 지표 수집기(metrics, #245): 끄면 없음, 켜면 파드 읽기만·들어오는 포트 없음·2000 은 cloudflared 표시 파드로만·토큰은 파일로만
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
helm template oa "$CHART" -n svc-agent "${OK[@]}" --set grants.inventory=false > "$OUT/l0.yaml"
helm template oa "$CHART" -n svc-agent "${OK[@]}" --set grants.inventory=false --set grants.cluster=true > "$OUT/l1.yaml"
helm template oa "$CHART" -n svc-agent "${OK[@]}" > "$OUT/i0.yaml"   # 기본값 = 인벤토리 켬
helm template oa "$CHART" -n svc-agent "${OK[@]}" --set metrics.endpoint=https://metrics.example.test/v1/metrics > "$OUT/m1.yaml"

# 틀린 값은 렌더 실패여야 한다
bad() { if helm template oa "$CHART" "${OK[@]}" "$@" >/dev/null 2>&1; then echo "FAIL 렌더가 됐다: $*"; fail=1; fi; }
bad --set agent.image=ghcr.io/example/svc-onprem-agent:latest
bad --set agent.reportURL=http://api.example.test
bad --set tenant=acme
bad --set gitops.repoURL=
bad --set metrics.endpoint=http://metrics.example.test/v1/metrics
bad --set metrics.endpoint=https://metrics.example.test --set metrics.image=otel/opentelemetry-collector-contrib:0.164.0
bad --set-string site=1A2B3C4D
bad --set-string site=1a2b3c
[ $fail -eq 0 ] && echo "ok   필수 값 없음·틀린 모양은 렌더 실패"

# 환경별 gitops 폴더: site 가 있으면 onprem-k3s-<site> 만, legacyPath 면 예전 공용 폴더도, site 가 없으면 예전 폴더만 (워커 bundleRefFor·argoAppName 과 같은 이름)
paths() { helm template oa "$CHART" -n svc-agent "${OK[@]}" "$@" | grep -o 'path: "tenants/[^"]*"' | sort | tr '\n' ' '; }
want() { local got; got=$(paths "${@:2}"); [ "$got" = "$1" ] || { echo "FAIL gitops 폴더 $* → $got"; fail=1; }; }
want 'path: "tenants/t-0a1b2c3d/apps/*/onprem-k3s-1a2b3c4d" ' --set-string site=1a2b3c4d
want 'path: "tenants/t-0a1b2c3d/apps/*/onprem-k3s" path: "tenants/t-0a1b2c3d/apps/*/onprem-k3s-1a2b3c4d" ' --set-string site=1a2b3c4d --set gitops.legacyPath=true
want 'path: "tenants/t-0a1b2c3d/apps/*/onprem-k3s" '
helm template oa "$CHART" -n svc-agent "${OK[@]}" --set-string site=1a2b3c4d | grep -qF "name: 't-0a1b2c3d-{{ index .path.segments 3 }}-{{ index .path.segments 4 }}'" \
  || { echo "FAIL Application 이름이 <회사>-<앱>-<폴더 이름> 이 아니다 (워커 argoAppName)"; fail=1; }
[ $fail -eq 0 ] && echo "ok   환경별 gitops 폴더·Application 이름"

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
    # 클러스터 범위는 Namespace 하나만 (CreateNamespace 용). 그 밖의 종류가 하나라도 있으면 실패
    wl = re.search(r"clusterResourceWhitelist:\n((?:\s+- .*\n)*)", proj)
    kinds = re.findall(r'kind: "([^"]+)"', wl.group(1)) if wl else []
    if kinds != ["Namespace"] or re.search(r'group: "[^"]+"', wl.group(1) if wl else ""):
        print(f"FAIL {path}: AppProject 클러스터 범위 허용은 Namespace(core) 하나뿐이어야 한다: {kinds}"); bad = 1
    for k in ("Role", "RoleBinding"):
        if f'kind: "{k}"' not in proj:
            print(f"FAIL {path}: AppProject 가 {k} 를 막지 않는다"); bad = 1
    dep = [d for d in docs if re.search(r"^kind: Deployment$", d, re.M) and re.search(r"^  name: onprem-agent$", d, re.M)][0]
    for must in ("readOnlyRootFilesystem: true", "runAsNonRoot: true", "allowPrivilegeEscalation: false"):
        if must not in dep:
            print(f"FAIL {path}: Agent 에 {must} 없음"); bad = 1
    # ADR-019: 봉인 컨트롤러 공개 인증서(8080)로만 더 나간다. 8080 이 아무 곳으로나 열리면 안 된다
    np = [d for d in docs if re.search(r"^kind: NetworkPolicy$", d, re.M) and re.search(r"^  name: onprem-agent$", d, re.M)][0]
    if "port: 8080" not in np or "name: sealed-secrets-controller" not in np or "kubernetes.io/metadata.name: kube-system" not in np:
        print(f"FAIL {path}: Agent 네트워크 정책에 봉인 컨트롤러(kube-system/sealed-secrets-controller:8080) 길이 없다"); bad = 1
    if re.search(r"- ports:\n\s+- \{ protocol: TCP, port: 8080 \}", np):
        print(f"FAIL {path}: 8080 이 목적지 없이 열렸다"); bad = 1
    if "svc-metrics" in open(path, encoding="utf-8").read():
        print(f"FAIL {path}: metrics.endpoint 를 안 줬는데 지표 수집기가 그려졌다"); bad = 1
if not bad:
    print("ok   Agent 권한은 읽기만(Secret·ConfigMap 없음), AppProject 는 클러스터 자원·RBAC 막음, Agent 는 비루트·읽기 전용")
sys.exit(bad)
PY

# 인벤토리 역할 (기본값 렌더). L0 역할 + 이 역할 하나만 더해지고, 정해진 읽기 자원 밖은 없어야 한다
python3 - "$OUT/i0.yaml" <<'PY' || fail=1
import re, sys
bad = 0
docs = open(sys.argv[1], encoding="utf-8").read().split("\n---")
roles = [d for d in docs if re.search(r"^kind: ClusterRole$", d, re.M)]
names = sorted(re.search(r"^  name: (\S+)$", d, re.M).group(1) for d in roles)
inv = [d for d in roles if re.search(r"^  name: svc-onprem-agent-inventory$", d, re.M)]
if len(roles) != 2 or len(inv) != 1:
    print(f"FAIL 기본값 ClusterRole 은 L0 + 인벤토리 2개여야 한다: {names}"); bad = 1
allowed = {"configmaps", "serviceaccounts", "nodes", "ingresses", "cronjobs", "jobs", "horizontalpodautoscalers", "poddisruptionbudgets"}
for d in inv:
    got = set()
    for res in re.findall(r"resources: \[([^\]]*)\]", d):
        got |= set(re.findall(r'"([^"]+)"', res))
    if got - allowed or "secrets" in got or "*" in got:
        print(f"FAIL 인벤토리 역할에 정해진 밖의 자원: {sorted(got - allowed)}"); bad = 1
    for verbs in re.findall(r"verbs: \[([^\]]*)\]", d):
        for v in re.findall(r'"([a-z]+)"', verbs):
            if v not in ("get", "list"):
                print(f"FAIL 인벤토리 역할에 get·list 밖의 동사 {v}"); bad = 1
for d in roles:
    if not inv or d is not inv[0]:
        for res in re.findall(r"resources: \[([^\]]*)\]", d):
            if re.search(r'"(secrets|configmaps|\*)"', res):
                print(f"FAIL 인벤토리 밖 역할이 읽으면 안 되는 자원 {res}"); bad = 1
bind = [d for d in docs if re.search(r"^kind: ClusterRoleBinding$", d, re.M) and re.search(r"^  name: svc-onprem-agent-inventory$", d, re.M)]
if len(bind) != 1 or "name: onprem-agent, namespace: svc-agent" not in bind[0]:
    print("FAIL 인벤토리 역할은 Agent 서비스 계정 하나에만 묶여야 한다"); bad = 1
if not bad:
    print("ok   인벤토리 역할: 정해진 읽기 자원·get/list 만, Secret 없음, Agent 서비스 계정에만 묶임")
sys.exit(bad)
PY

# 지표 수집기 (#245). 렌더 모양이 고정이라 줄 단위로 읽는다
python3 - "$OUT/m1.yaml" <<'PY' || fail=1
import re, sys
bad = 0
docs = open(sys.argv[1], encoding="utf-8").read().split("\n---")
def one(kind, name):
    got = [d for d in docs if re.search(rf"^kind: {kind}$", d, re.M) and re.search(rf"^  name: {name}$", d, re.M)]
    return got[0] if got else ""
role = one("ClusterRole", "svc-onprem-metrics")
rules = re.findall(r"resources: \[([^\]]*)\]\n\s+verbs: \[([^\]]*)\]", role)
if rules != [('"pods"', '"get", "list", "watch"')]:
    print(f"FAIL 수집기 권한은 파드 읽기만이어야 한다: {rules}"); bad = 1
np = one("NetworkPolicy", "svc-metrics")
if "ingress: []" not in np:
    print("FAIL 수집기에 들어오는 길이 열렸다"); bad = 1
if not re.search(r"podSelector: \{ matchLabels: \{ svc.platform/metrics: cloudflared \} \}\n\s+ports:\n\s+- \{ protocol: TCP, port: 2000 \}", np):
    print("FAIL 수집기 2000 이 cloudflared 표시 파드로만 묶이지 않았다"); bad = 1
cm = one("ConfigMap", "svc-metrics")
if "filename: /var/run/svc-metric/token" not in cm or re.search(r"svc_mt_", cm):
    print("FAIL 수집기 토큰은 Secret 파일로만 읽어야 한다 (설정에 값이 없어야 한다)"); bad = 1
if 'set(name, "svc_ingress_requests_total")' not in cm or "target_label: code" not in cm:
    print("FAIL 수집기가 플랫폼 지표 이름·라벨(svc_ingress_requests_total, code)로 바꾸지 않는다"); bad = 1
dep = one("Deployment", "svc-metrics")
for must in ("readOnlyRootFilesystem: true", "runAsNonRoot: true", "allowPrivilegeEscalation: false", "secretName: svc-metric-token"):
    if must not in dep:
        print(f"FAIL 수집기에 {must} 없음"); bad = 1
if not bad:
    print("ok   지표 수집기: 파드 읽기만, 들어오는 길 없음, 2000 은 cloudflared 표시 파드로만, 토큰은 Secret 파일, 플랫폼 지표 이름으로 바꿈")
sys.exit(bad)
PY
exit $fail
