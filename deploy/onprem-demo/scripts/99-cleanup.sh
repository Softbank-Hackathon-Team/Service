#!/usr/bin/env bash
# DRAFT(ai) 데모 정리: 클러스터·저장소 삭제, 컨텍스트 삭제, 작업 폴더 삭제
source "$(dirname "$0")/lib.sh"
t0=$(now_ms)
k3d cluster delete "$CLUSTER" || true
k3d registry delete "k3d-${REGISTRY_NAME}" || true
kubectl config delete-context "$CONTEXT" >/dev/null 2>&1 || true
rm -rf "$WORK"
rm -f "$SERVICE_DIR/.env.onprem"
echo "cleanup_ms=$(( $(now_ms) - t0 ))"
k3d cluster list
