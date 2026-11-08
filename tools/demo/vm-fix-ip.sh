#!/usr/bin/env bash
# Run on the on-prem VM with sudo. Pins the k3s node address 172.27.67.51 on eth0 next to the DHCP address.
# 2026-11-08: netplan apply renewed DHCP and Hyper-V Default Switch handed out a new IP, while k3s still
# advertises 172.27.67.51 (kubernetes Service endpoint), so pods lost the API ("no route to host").
# Does NOT run netplan apply again (that could renew DHCP once more); the address is added live and
# written to netplan + k3s config for the next boot.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
PIN=172.27.67.51/20
ip -4 addr show dev eth0 | grep -q "inet ${PIN%/*}/" || ip addr add "$PIN" dev eth0
cat > /etc/netplan/60-public-dns.yaml <<YAML
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: true
      dhcp4-overrides:
        use-dns: false
      addresses: [$PIN]
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
YAML
chmod 600 /etc/netplan/60-public-dns.yaml
netplan generate
grep -q '^node-ip:' /etc/rancher/k3s/config.yaml || printf 'node-ip: %s\n' "${PIN%/*}" >> /etc/rancher/k3s/config.yaml
ip -br -4 addr show eth0
curl -sk -m5 -o /dev/null -w "apiserver via ${PIN%/*}: %{http_code}\n" "https://${PIN%/*}:6443/readyz" || true
