#!/usr/bin/env bash
# 데모 B 역방향 터널 (Z78, Z38 R8-39). 사람 터미널 전용: 맥 분류기가 막는 역방향 터널(External Ingress Tunnel)이라
# 맥 RC 나 다른 스크립트가 대신 열면 안 된다. tools/demo-day.sh up 이 중계기를 만든 뒤 "터널 기다림" 에서 멈추면 이 줄을 친다.
#   bash tools/demo-tunnel.sh
# 중계기 공개 IP 는 demo-day 가 ~/.svc-tf/demo-day/relay_ip 에 적어 둔다. 끊기면 2초 뒤 다시 붙는다(9분 넘게 버텨야 해서).
# 끄기: Ctrl-C (또는 jeong-down·demo-day down 이 tunnel.pid 로 끈다)
# 맥 쪽 출발 DB 포트: TUNNEL_LOCAL_PORT(기본 55434 = k3d 가 CNPG NodePort 30432 를 맥에 이어 둔 포트, Z77 CHANGES ②)
set -u
STATE=${DEMO_DAY_STATE:-$HOME/.svc-tf/demo-day}
IP=${RELAY_IP:-$(cat "$STATE/relay_ip" 2>/dev/null)}
LPORT=${TUNNEL_LOCAL_PORT:-55434}
[ -n "$IP" ] || { echo "중계기 IP 가 없다 ($STATE/relay_ip). demo-day up 이 중계기를 만든 뒤 친다" >&2; exit 2; }
echo $$ > "$STATE/tunnel.pid"
trap 'rm -f "$STATE/tunnel.pid"; exit 0' INT TERM
n=0
while :; do
  n=$((n + 1))
  echo "$(date -u +%H:%M:%SZ) 터널 연결 ${n}번째 (중계기 ${IP%.*.*}.x.x)"
  ssh -N -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    -R "0.0.0.0:5432:localhost:$LPORT" "ec2-user@$IP"
  echo "$(date -u +%H:%M:%SZ) 끊김 (끝 코드 $?), 2초 뒤 다시"
  sleep 2
done
