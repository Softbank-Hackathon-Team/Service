#!/usr/bin/env bash
# DRAFT(ai) 시작 전 점검: 도구, Docker 메모리, CPU 종류, 포트
source "$(dirname "$0")/lib.sh"
fail=0
for t in docker k3d kubectl helm node npx openssl perl curl; do
  if command -v "$t" >/dev/null; then echo "ok   $t"; else echo "MISS $t"; fail=1; fi
done
docker info >/dev/null 2>&1 || { echo "MISS docker 데몬 (Docker Desktop 켜기)"; exit 1; }
mem_gb=$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 / 1024 ))
echo "docker 메모리 ${mem_gb}GB (권장 6GB 이상)"
[ "$mem_gb" -ge 6 ] || { echo "WARN Docker Desktop > Settings > Resources 에서 메모리 올리기"; }
echo "CPU $(uname -m) (어댑터 capabilities 는 arch.amd64 고정. Intel 맥 = x86_64 이면 그대로 맞음)"
for p in "$REGISTRY_PORT" "$API_PORT" "$DB_HOST_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "BUSY 포트 $p"; fail=1; else echo "ok   포트 $p"; fi
done
[ -d "$SERVICE_DIR/packages/adapters" ] && echo "ok   SERVICE_DIR=$SERVICE_DIR" || { echo "MISS SERVICE_DIR ($SERVICE_DIR) — export SERVICE_DIR=..."; fail=1; }
exit $fail
