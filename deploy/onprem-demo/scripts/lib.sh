#!/usr/bin/env bash
# DRAFT(ai) 온프레 데모 공통 값. 다른 스크립트가 source 한다.
# 버전은 2026-10-31 컨테이너에서 내려받기·기동을 확인한 값 (README 실측 표)
set -euo pipefail

CLUSTER="${CLUSTER:-onprem}"
CONTEXT="k3s-onprem"
K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.31.5-k3s1}"
CNPG_VERSION="${CNPG_VERSION:-1.30.1}"
CNPG_MANIFEST="https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${CNPG_VERSION}/cnpg-${CNPG_VERSION}.yaml"
PODINFO_IMAGE="${PODINFO_IMAGE:-docker.io/stefanprodan/podinfo:6.9.2}"

REGISTRY_NAME="onprem-registry.localhost"
REGISTRY_PORT="${REGISTRY_PORT:-5111}"
REGISTRY_PUSH="localhost:${REGISTRY_PORT}"
REGISTRY_IN_CLUSTER="${REGISTRY_IN_CLUSTER:-k3d-${REGISTRY_NAME}:${REGISTRY_PORT}}"

API_PORT="${API_PORT:-6550}"
DB_HOST_PORT="${DB_HOST_PORT:-55434}"
TENANT="${DEMO_TENANT:-dev}"
APP="shop"
NS="app-${APP}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$HERE/.." && pwd)"
SERVICE_DIR="${SERVICE_DIR:-$HOME/Softbank_final/Service}"
WORK="${WORK:-$DEMO_DIR/.work}"
mkdir -p "$WORK"

kc() { kubectl --context "$CONTEXT" "$@"; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
step() { printf '\n== %s\n' "$*"; }
