#!/bin/sh
# 중계기 흉내. sshd 설정은 apps/worker/src/relay/aws-relay.ts 의 user-data 와 같은 규칙이다:
#   호스트 키 = 미리 만든 ed25519 하나, 비밀번호 로그인 없음, GatewayPorts clientspecified
#   tunnel 계정: 정방향 -L 은 PERMIT_OPEN 하나, 역방향 -R 은 0.0.0.0:5432 하나, 셸·tty·에이전트·X11 없음
# 그리고 플랫폼 입구(:15432 → 클라우드 DB:5432). 실제 중계의 svc-relay-fwd.py 자리를 socat 이 한다
set -eu
: "${PERMIT_OPEN:?PERMIT_OPEN 이 비었다 (예: cloud-pg:5432)}"
install -m 600 /lab/host_ed25519 /etc/ssh/ssh_host_ed25519_key
install -d -m 700 -o tunnel -g tunnel /home/tunnel/.ssh
install -m 600 -o tunnel -g tunnel /lab/tunnel_ed25519.pub /home/tunnel/.ssh/authorized_keys
cat > /etc/ssh/sshd_config <<CONF
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
GatewayPorts clientspecified
ClientAliveInterval 15
Match User tunnel
  AllowTcpForwarding yes
  PermitOpen ${PERMIT_OPEN}
  PermitListen 0.0.0.0:5432
  PermitTTY no
  X11Forwarding no
  AllowAgentForwarding no
  AllowStreamLocalForwarding no
  PermitTunnel no
  ForceCommand /bin/false
Match all
CONF
/usr/sbin/sshd -t
socat TCP-LISTEN:15432,fork,reuseaddr "TCP:${PERMIT_OPEN}" &
exec /usr/sbin/sshd -D -e
