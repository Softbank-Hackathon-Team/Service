#!/usr/bin/env bash
# 온프레 도착 환경 부트스트랩 (노트북/서버 1대, 한 번만). 리눅스 또는 multipass VM에서 실행.
# 하는 일: k3s 설치 → CloudNativePG 오퍼레이터 → External Secrets Operator → 플랫폼 RBAC.
# 앱별 바닥(네임스페이스·할당량)은 infra/modules/onprem/app (Terraform), 앱·DB는 gitops/charts/app (Argo CD).
# TODO(human): 아래 helm 차트 버전 고정 (이 세션에선 차트 저장소가 막혀 최신 버전을 확인하지 못함)
set -euo pipefail

# 1) k3s: 기본 Ingress(traefik)는 끈다. 들어오는 길은 cloudflared 터널
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik --write-kubeconfig-mode 644" sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl wait --for=condition=Ready node --all --timeout=120s

# 2) CloudNativePG 오퍼레이터 (Postgres를 k8s 안에서 운영)
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait

# 3) External Secrets Operator (시크릿 값은 저장소에서 당겨 옴, 차트·Git엔 이름만)
helm upgrade --install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace --wait

# 4) 플랫폼 최소 권한: 클러스터 전체엔 네임스페이스만, 앱 자원은 Kyverno가 만드는 RoleBinding으로 앱 네임스페이스에만
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update
helm upgrade --install kyverno kyverno/kyverno -n kyverno --create-namespace --wait
kubectl apply -f "$(dirname "$0")/../permissions/onprem-operate-clusterrole.yaml"
kubectl apply -f "$(dirname "$0")/../permissions/onprem-kyverno-platform.yaml"

# 5) kubeconfig 컨텍스트 이름을 어댑터 기본값(k3s-onprem)에 맞춘다
kubectl config rename-context default k3s-onprem || true
kubectl get nodes -o wide
