#!/usr/bin/env bash
# DRAFT(ai) k3d 로 k3s 클러스터 1노드 + 로컬 이미지 저장소를 띄운다.
# - traefik 은 끈다 (들어오는 길은 cloudflared 터널, 데모에선 port-forward)
# - 컨텍스트 이름을 어댑터 기본값 k3s-onprem 으로 바꾼다 (toTerraform 의 kube_context)
# - 맥 localhost:55434 → 노드 30432 (CNPG Postgres 바깥 접속, manifests/db-expose.yaml)
source "$(dirname "$0")/lib.sh"
t0=$(now_ms)
step "이미지 저장소 ${REGISTRY_NAME}:${REGISTRY_PORT}"
k3d registry list 2>/dev/null | grep -q "k3d-${REGISTRY_NAME}" || k3d registry create "$REGISTRY_NAME" --port "$REGISTRY_PORT"
step "클러스터 $CLUSTER ($K3S_IMAGE)"
k3d cluster create "$CLUSTER" \
  --image "$K3S_IMAGE" \
  --servers 1 --agents 0 \
  --api-port "127.0.0.1:${API_PORT}" \
  --port "${DB_HOST_PORT}:30432@server:0" \
  --registry-use "k3d-${REGISTRY_NAME}:${REGISTRY_PORT}" \
  --k3s-arg "--disable=traefik@server:0" \
  --kubeconfig-update-default --kubeconfig-switch-context \
  --wait --timeout 180s
kubectl config delete-context "$CONTEXT" >/dev/null 2>&1 || true
kubectl config rename-context "k3d-${CLUSTER}" "$CONTEXT"
kc wait --for=condition=Ready node --all --timeout=120s
kc -n kube-system rollout status deploy/coredns --timeout=120s
echo "cluster_up_ms=$(( $(now_ms) - t0 ))"
kc get nodes -o wide
