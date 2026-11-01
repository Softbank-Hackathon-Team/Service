#!/usr/bin/env bash
# DRAFT(ai) 제어판 배포 순서를 손으로 한 번 따라간다.
#  1) 이미지 복사: 원본 → 온프레 저장소 platform/<테넌트>/<저장소>
#  2) 어댑터 실행: toTerraform / toHelmValues (packages/adapters onprem)
#  3) 앱 바닥: 네임스페이스·할당량·네트워크 정책 (기본 kubectl, USE_TERRAFORM=1 이면 infra/modules/onprem/app)
#  4) 복제 계정 Secret (값은 여기서 바로 만들어 클러스터에만 둔다. 파일·화면에 안 남김)
#  5) Helm 설치: gitops/charts/app (+ O 스레드 chart-patch 가 아직 안 합쳐졌으면 덧씌움)
#  6) 대기: CNPG Cluster Ready → 앱 Deployment Ready
source "$(dirname "$0")/lib.sh"
t0=$(now_ms)

step "1) 이미지 복사"
src_repo="$(basename "${PODINFO_IMAGE%%:*}")"
dst="${REGISTRY_PUSH}/platform/${TENANT}/${src_repo}:demo"
# Docker Hub 요청 한도(429)를 피하려고 이미 있으면 다시 받지 않는다
docker image inspect "$PODINFO_IMAGE" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$PODINFO_IMAGE"
docker tag "$PODINFO_IMAGE" "$dst"
docker push "$dst"
# 주의: docker push 는 단일 아키텍처만 올려 digest 가 원본과 달라질 수 있다 → 저장소가 말하는 digest 를 쓴다
ACCEPT="application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json"
DIGEST=$(curl -sI --noproxy '*' -H "Accept: $ACCEPT" "http://${dst%%/*}/v2/platform/${TENANT}/${src_repo}/manifests/demo" | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}' | tr -d '\r')
echo "digest=$DIGEST"
[ -n "$DIGEST" ]

step "2) 어댑터로 값 만들기"
# tsx 는 파일 위치 기준으로 @svc/adapters 를 찾는다 → Service 의 node_modules 아래(추적 안 되는 캐시)로 복사해 실행
gen="$SERVICE_DIR/node_modules/.cache/onprem-demo/gen-values.ts"
mkdir -p "$(dirname "$gen")" && cp "$HERE/gen-values.ts" "$gen"
( cd "$SERVICE_DIR" && IMAGE_DIGEST="$DIGEST" REGISTRY_HOST="$REGISTRY_IN_CLUSTER" DEMO_TENANT="$TENANT" \
    npx tsx "$gen" "$WORK" )

step "3) 앱 바닥"
if [ "${USE_TERRAFORM:-0}" = "1" ]; then
  # 로컬 k3d 에만 쓰는 apply. 클라우드 자원은 만들지 않는다 (kube_context=k3s-onprem)
  terraform -chdir="$SERVICE_DIR/infra/modules/onprem/app" init -input=false
  terraform -chdir="$SERVICE_DIR/infra/modules/onprem/app" apply -input=false -var-file="$WORK/onprem.tfvars.json"
else
  kc apply -f "$DEMO_DIR/manifests/app-floor.yaml"
fi

step "4) 복제 계정 Secret ${APP}-db-repl"
if ! kc -n "$NS" get secret "${APP}-db-repl" >/dev/null 2>&1; then
  kc -n "$NS" create secret generic "${APP}-db-repl" --type=kubernetes.io/basic-auth \
    --from-literal=username=repl --from-literal=password="$(openssl rand -hex 16)"
  kc -n "$NS" label secret "${APP}-db-repl" cnpg.io/reload=true
fi

step "5) Helm 설치"
chart="$SERVICE_DIR/gitops/charts/app"
if ! grep -q "replication" "$chart/templates/cnpg.yaml"; then
  rm -rf "$WORK/chart" && cp -R "$chart" "$WORK/chart" && cp "$DEMO_DIR/chart-patch/cnpg.yaml" "$WORK/chart/templates/cnpg.yaml"
  chart="$WORK/chart"; echo "(chart-patch 덧씌움: $chart)"
fi
helm --kube-context "$CONTEXT" upgrade --install "$APP" "$chart" -n "$NS" \
  -f "$WORK/onprem.values.json" -f "$DEMO_DIR/values/demo-overrides.yaml"
kc apply -f "$DEMO_DIR/manifests/db-expose.yaml"

step "6) 대기"
kc -n "$NS" wait cluster/"${APP}-db" --for=condition=Ready --timeout=300s
echo "db_ready_ms=$(( $(now_ms) - t0 ))"
kc -n "$NS" rollout status deploy/"$APP" --timeout=180s
echo "app_ready_ms=$(( $(now_ms) - t0 ))"
kc -n "$NS" get pods,svc,cluster
