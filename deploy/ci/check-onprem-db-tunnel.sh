#!/usr/bin/env bash
# 온프레 DB 터널 차트(deploy/helm/onprem-db-tunnel)를 정방향만 / 양방향 / 역방향만 세 벌로 렌더해서 쿠버네티스 스키마 검사 + 보안 모양 확인.
#   잘못된 값(중계 주소 없음·호스트 키 없음·태그만 이미지·5432 아닌 목적지·너무 넓은 대역·둘 다 끔)은 렌더가 실패해야 한다
#   모양: 루트 아님·읽기 전용·권한 0, Service 는 ClusterIP, NetworkPolicy 가 들어오는 것을 CNPG 로만, 호스트 키 고정(StrictHostKeyChecking=yes)
# 필요: helm, python3, (있으면) kubeconform. 사용: bash deploy/ci/check-onprem-db-tunnel.sh
set -euo pipefail

CHART=deploy/helm/onprem-db-tunnel
K8S_VERSION="${K8S_VERSION:-1.35.0}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# 가짜 값 (렌더·검사 전용)
BASE=(--set relay.host=203.0.113.7 --set-string "relay.knownHosts=203.0.113.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForRenderOnly" --set relay.cidr=203.0.113.7/32)
FWD=(--set forward.target=shop.abc123.ap-northeast-2.rds.amazonaws.com:5432)
REV=(--set reverse.enabled=true --set reverse.target=shop-db-rw:5432)

helm lint "$CHART" "${BASE[@]}" "${FWD[@]}"
helm template t "$CHART" -n app-shop "${BASE[@]}" "${FWD[@]}" > "$OUT/forward.yaml"
helm template t "$CHART" -n app-shop "${BASE[@]}" "${FWD[@]}" "${REV[@]}" > "$OUT/both.yaml"
helm template t "$CHART" -n app-shop "${BASE[@]}" --set forward.enabled=false "${REV[@]}" > "$OUT/reverse.yaml"

fail=0
bad() {  # 설명, 추가 값... → 렌더가 실패해야 한다
  local why="$1"; shift
  if helm template t "$CHART" "$@" >/dev/null 2>&1; then echo "FAIL $why 인데 렌더가 됐다"; fail=1; else echo "ok   거부: $why"; fi
}
bad "relay.host 없음"       --set-string relay.knownHosts=k "${FWD[@]}"
bad "relay.knownHosts 없음" --set relay.host=203.0.113.7 "${FWD[@]}"
bad "태그만 이미지"          "${BASE[@]}" "${FWD[@]}" --set image=alpine/git:v2.54.0
bad "5432 아닌 정방향 목적지" "${BASE[@]}" --set forward.target=10.0.0.10:22
bad "5432 아닌 역방향 목적지" "${BASE[@]}" "${FWD[@]}" --set reverse.enabled=true --set reverse.target=kubernetes.default:443
bad "넓은 relay.cidr"       "${BASE[@]}" "${FWD[@]}" --set relay.cidr=0.0.0.0/0
bad "정방향·역방향 둘 다 끔"  "${BASE[@]}" --set forward.enabled=false

python3 - "$OUT" <<'PY'
import sys, pathlib, re
out = pathlib.Path(sys.argv[1]); bad = []
def docs(name):
    import json, subprocess
    text = (out / name).read_text()
    return [d for d in text.split("\n---") if d.strip()]
def kind(d): m = re.search(r"^kind: (\S+)", d, re.M); return m.group(1) if m else None
for name, fwd, rev in [("forward.yaml", True, False), ("both.yaml", True, True), ("reverse.yaml", False, True)]:
    ds = docs(name); kinds = [kind(d) for d in ds]
    dep = next(d for d in ds if kind(d) == "Deployment"); np_ = next(d for d in ds if kind(d) == "NetworkPolicy")
    need = ["runAsNonRoot: true", "readOnlyRootFilesystem: true", "allowPrivilegeEscalation: false", "drop: [ALL]",
            "automountServiceAccountToken: false", "StrictHostKeyChecking=yes", "ExitOnForwardFailure=yes", "RuntimeDefault"]
    for n in need:
        if n not in dep: bad.append(f"{name}: Deployment 에 '{n}' 없음")
    if "accept-new" in dep or "StrictHostKeyChecking=no" in dep: bad.append(f"{name}: 처음 보는 호스트 키를 받는다")
    if ("-L 0.0.0.0:5432:" in dep) != fwd: bad.append(f"{name}: 정방향 -L 이 기대와 다름")
    if ("-R 0.0.0.0:5432:" in dep) != rev: bad.append(f"{name}: 역방향 -R 이 기대와 다름")
    if ("Service" in kinds) != fwd: bad.append(f"{name}: Service 는 정방향일 때만")
    for d in ds:
        if kind(d) == "Service" and "type: ClusterIP" not in d: bad.append(f"{name}: Service 가 ClusterIP 가 아님")
    if "policyTypes: [Ingress, Egress]" not in np_: bad.append(f"{name}: NetworkPolicy 가 들어오고 나가는 것을 둘 다 막지 않음")
    if fwd and "cnpg.io/podRole: instance" not in np_.split("egress:")[0]: bad.append(f"{name}: 들어오는 것이 CNPG 로 제한되지 않음")
    if not fwd and "ingress: []" not in np_: bad.append(f"{name}: 역방향만인데 들어오는 규칙이 있음")
    if "cidr: 203.0.113.7/32" not in np_: bad.append(f"{name}: 나가는 22 가 중계 대역으로 제한되지 않음")
    if "kind: Secret" in "\n".join(ds): bad.append(f"{name}: 차트가 Secret 을 만든다 (키는 설치 전에 따로)")
for b in bad: print("FAIL", b)
print("ok   보안 모양 (3벌)" if not bad else ""); sys.exit(1 if bad else 0)
PY

if command -v kubeconform >/dev/null; then
  kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" "$OUT"/*.yaml
else
  echo "skip kubeconform (없음)"
fi
exit $fail
