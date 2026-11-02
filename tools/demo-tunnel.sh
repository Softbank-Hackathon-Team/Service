#!/usr/bin/env bash
# 데모 B 역방향 터널 (Z78, Z38 R8-39). 사람 터미널 전용: 맥 분류기가 막는 역방향 터널(External Ingress Tunnel)이라
# 맥 RC 나 다른 스크립트가 대신 열면 안 된다. tools/demo-day.sh up 이 중계기를 만든 뒤 "터널 기다림" 에서 멈추면 이 줄을 친다.
#   bash tools/demo-tunnel.sh
# 중계기 공개 IP 는 demo-day 가 ~/.svc-tf/demo-day/relay_ip 에 적어 둔다. 끊기면 2초 뒤 다시 붙는다(9분 넘게 버텨야 해서).
# 끄기: Ctrl-C (또는 jeong-down·demo-day down 이 tunnel.pid 로 끈다)
# 맥 쪽 출발 DB 포트: TUNNEL_LOCAL_PORT(기본 55434 = k3d 가 CNPG NodePort 30432 를 맥에 이어 둔 포트, Z77 CHANGES ②)
set -u
STATE=${DEMO_DAY_STATE:-$HOME/.svc-tf/demo-day}
LPORT=${TUNNEL_LOCAL_PORT:-55434}
# 중계기 IP: RELAY_IP 가 없으면 relay_ip 파일을 읽는다. demo-day up 은 시작할 때 이 파일을 지우고 중계기를 만든 뒤 다시 적으므로,
#   파일이 없으면 끝내지 않고 기다린다(10초마다, 기본 45분). 연결할 때마다 다시 읽어 새 IP 를 따라간다
relay_ip() { echo "${RELAY_IP:-$(cat "$STATE/relay_ip" 2>/dev/null)}"; }
WAIT_MAX=${TUNNEL_WAIT_SEC:-2700}; waited=0
until [ -n "$(relay_ip)" ]; do
  [ $waited -eq 0 ] && echo "$(date -u +%H:%M:%SZ) 중계기 IP 없음 ($STATE/relay_ip) — demo-day up 이 중계기를 만들 때까지 기다림"
  [ $waited -ge "$WAIT_MAX" ] && { echo "중계기 IP 를 ${WAIT_MAX}초 기다렸지만 없음. demo-day up 진행 파일을 확인" >&2; exit 2; }
  sleep 10; waited=$((waited + 10))
done
echo $$ > "$STATE/tunnel.pid"
trap 'rm -f "$STATE/tunnel.pid"; exit 0' INT TERM
n=0
while :; do
  n=$((n + 1))
  IP=$(relay_ip)
  echo "$(date -u +%H:%M:%SZ) 터널 연결 ${n}번째 (중계기 ${IP%.*.*}.x.x)"
  # UPREV-A: 호스트 키는 이 상태 폴더 전용 known_hosts 에만 (회차마다 새 중계기라 맥 known_hosts 의 같은 IP 옛 키와 부딪히지 않게. demo-day up 이 시작 때 지움)
  ssh -N -o BatchMode=yes -o UserKnownHostsFile="$STATE/known_hosts" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    -R "0.0.0.0:5432:localhost:$LPORT" "ec2-user@$IP"
  echo "$(date -u +%H:%M:%SZ) 끊김 (끝 코드 $?), 2초 뒤 다시"
  sleep 2
done
