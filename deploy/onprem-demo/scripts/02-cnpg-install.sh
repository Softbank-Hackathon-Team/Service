#!/usr/bin/env bash
# DRAFT(ai) CloudNativePG 오퍼레이터 설치 (릴리스 매니페스트 한 장, 버전 고정)
# helm 차트 대신 매니페스트를 쓰는 이유: 저장소 추가·갱신이 없어 한 줄로 끝나고, 버전이 URL 에 박힌다
source "$(dirname "$0")/lib.sh"
t0=$(now_ms)
kc apply --server-side -f "$CNPG_MANIFEST"
kc -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=180s
echo "cnpg_install_ms=$(( $(now_ms) - t0 ))"
kc get crd | grep postgresql.cnpg.io
