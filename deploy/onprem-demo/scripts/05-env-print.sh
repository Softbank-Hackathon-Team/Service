#!/usr/bin/env bash
# DRAFT(ai) 제어판(.env)에 넣을 온프레 환경 접속 정보.
# 기본: 변수 이름과 비밀 아닌 값만 화면에 찍는다.
# --write: 비밀번호까지 채워 $SERVICE_DIR/.env.onprem 에 쓴다 (권한 600, .gitignore 의 .env.* 에 걸림). 채팅에 붙이지 말 것
source "$(dirname "$0")/lib.sh"
cat <<VARS
# 온프레 환경 등록 (environments.provider = onprem)
ONPREM_ENV_NAME=onprem-k3s-local
ONPREM_KUBE_CONTEXT=${CONTEXT}
ONPREM_KUBECONFIG=\$HOME/.kube/config
ONPREM_REGISTRY_HOST=${REGISTRY_IN_CLUSTER}
ONPREM_REGISTRY_PUSH_HOST=${REGISTRY_PUSH}
ONPREM_ARCH=$( [ "$(uname -m)" = "x86_64" ] && echo amd64 || echo arm64 )
ONPREM_AGENT_KEY_ID=
ONPREM_AGENT_HMAC_SECRET=
# 이 k3d 데모에는 고객 Argo CD 와 Agent 가 없다: 바닥은 워커 Terraform 으로, 배포 확인은 예전처럼 커밋만 (W3·W4 기본 켬을 끈다)
ONPREM_FLOOR_VIA_GIT=0
AGENT_DEPLOY_CONFIRM=0
# DB 이전 도착 = CNPG (packages/replication endpointFromEnv("REPL_TARGET"))
REPL_TARGET_URL=postgres://postgres:<superuser-pw>@localhost:${DB_HOST_PORT}/${APP}?sslmode=require
REPL_TARGET_PEER_URL=postgres://postgres:<superuser-pw>@host.docker.internal:${DB_HOST_PORT}/${APP}?sslmode=require
REPL_TARGET_PROVIDER=cnpg
REPL_TARGET_APP_ROLE=app
VARS
if [ "${1:-}" = "--write" ]; then
  PW=$(kc -n "$NS" get secret "${APP}-db-superuser" -o jsonpath='{.data.password}' | base64 -d)
  out="$SERVICE_DIR/.env.onprem"
  umask 077
  "$0" | sed "s|<superuser-pw>|${PW}|g" > "$out"
  echo "wrote $out (값은 화면에 안 찍음)"
fi
