#!/bin/sh
# 온프레 터널 파드 흉내. ssh 명령은 deploy/helm/onprem-db-tunnel/templates/tunnel.yaml 과 같은 플래그다
#   REVERSE_TARGET: -R 0.0.0.0:5432:<온프레 DB> (클라우드 → 온프레, 역방향 이전의 주 복제 길 + 워커 관리 접속)
#   FORWARD_TARGET: -L 0.0.0.0:5432:<클라우드 DB> (온프레 → 클라우드, 컷오버 뒤 롤백 창 역복제)
set -u
install -m 600 /lab/tunnel_ed25519 /tmp/id
FWD=""; REV=""
[ -n "${FORWARD_TARGET:-}" ] && FWD="-L 0.0.0.0:5432:${FORWARD_TARGET}"
[ -n "${REVERSE_TARGET:-}" ] && REV="-R 0.0.0.0:5432:${REVERSE_TARGET}"
n=0
while :; do
  n=$((n + 1))
  echo "$(date -u +%H:%M:%SZ) 터널 연결 ${n}번째"
  # shellcheck disable=SC2086
  ssh -N -i /tmp/id -p 22 \
    -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/lab/known_hosts \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    $FWD $REV tunnel@relay
  echo "$(date -u +%H:%M:%SZ) 끊김 (끝 코드 $?), 2초 뒤 다시"
  sleep 2
done
