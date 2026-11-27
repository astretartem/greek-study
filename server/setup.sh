#!/usr/bin/env bash
# Installs the signaling server on a clean Ubuntu 22.04/24.04 (Minimal included), e.g. Oracle Cloud Always Free.
# No dependencies: one Go binary with built-in HTTPS (Let's Encrypt).
#
# On the server, from the folder with setup.sh and bin/:
#   sudo bash setup.sh                         # domain is derived as <IP>.sslip.io
#   sudo DOMAIN=sync.example.com bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"

case "$(uname -m)" in
  aarch64|arm64) BIN=bin/greek-signaling-linux-arm64 ;;
  x86_64|amd64)  BIN=bin/greek-signaling-linux-amd64 ;;
  *) echo "Unknown architecture: $(uname -m)"; exit 1 ;;
esac
[ -f "$BIN" ] || { echo "File $BIN not found"; exit 1; }

echo "==> System updates, automatic security updates, firewall rule persistence"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq --no-install-recommends curl ca-certificates unattended-upgrades iptables-persistent
dpkg-reconfigure -f noninteractive unattended-upgrades

IP=$(curl -fsS https://api.ipify.org)
DOMAIN=${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}
echo "==> External IP: $IP, domain: $DOMAIN"

echo "==> Binary -> /usr/local/bin/greek-signaling"
install -m 0755 "$BIN" /usr/local/bin/greek-signaling

echo "==> systemd service"
cat > /etc/systemd/system/greek-signaling.service <<UNIT
[Unit]
Description=Greek study WebRTC signaling server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/greek-signaling -domain $DOMAIN
Restart=always
RestartSec=2
DynamicUser=yes
StateDirectory=greek-signaling
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
MemoryMax=128M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable greek-signaling
systemctl restart greek-signaling

echo "==> Opening ports 80 and 443 in the Ubuntu firewall (closed in Oracle images)"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport $p -j ACCEPT
done
netfilter-persistent save

echo
echo "Done. The certificate is issued on the first request (a few seconds)."
echo "Check:            curl https://$DOMAIN"
echo "Address for site: wss://$DOMAIN"
