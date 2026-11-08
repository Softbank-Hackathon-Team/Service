#!/usr/bin/env bash
# Run on the on-prem VM with sudo. Makes public DNS permanent so a dead Hyper-V Default Switch DNS proxy
# (172.27.64.1, handed out by DHCP) can no longer break image pulls (containerd) or the agent heartbeat.
# 2026-11-08: that proxy died at 10:24; resolvectl fixed it only until reboot or DHCP renewal.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ts=$(date +%Y%m%d%H%M%S)
cp -a /etc/netplan "/root/netplan-backup-$ts"
install -d /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNS=1.1.1.1 8.8.8.8\nFallbackDNS=1.0.0.1 8.8.4.4\n' > /etc/systemd/resolved.conf.d/10-public-dns.conf
# 60 sorts after 50-cloud-init.yaml, so this merges on top: keep DHCP for the address, ignore its DNS
cat > /etc/netplan/60-public-dns.yaml <<'YAML'
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: true
      dhcp4-overrides:
        use-dns: false
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
YAML
chmod 600 /etc/netplan/60-public-dns.yaml
netplan generate
netplan apply
systemctl restart systemd-resolved
echo "eth0 DNS: $(resolvectl dns eth0)"
getent hosts ghcr.io >/dev/null && echo "ghcr.io resolves: OK" || { echo "ghcr.io does not resolve"; exit 1; }
echo "backup: /root/netplan-backup-$ts"
