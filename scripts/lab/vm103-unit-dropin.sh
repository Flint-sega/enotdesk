#!/bin/bash
# LAB VM103 (L2): безопасный hardening-drop-in для enotdesk-agent поверх выпущенного юнита.
# НЕ применяется то, что ломает Chromium/V8: MemoryDenyWriteExecute (JIT), SystemCallFilter
# (широкий набор сисколлов), PrivateUsers/UserNS (песочница Chromium), RestrictAddressFamilies
# (netlink у Chromium). Цель — замер до/после и проверка живучести (L2 MANUAL-QA).
# Запуск на VM 103: bash /home/enotadmin/vm103-unit-dropin.sh
set -euo pipefail
D=/etc/systemd/system/enotdesk-agent.service.d
sudo mkdir -p "$D"
sudo tee "$D/hardening.conf" >/dev/null <<'EOF'
# LAB L2: безопасный hardening поверх выпущенного юнита (не меняет ExecStart/env)
[Service]
UMask=0077
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
CapabilityBoundingSet=
AmbientCapabilities=
EOF
sudo systemctl daemon-reload
sudo systemctl restart enotdesk-agent
sleep 6
echo "unit: $(systemctl is-active enotdesk-agent)"
echo "=== analyze after ==="
sudo systemd-analyze security enotdesk-agent 2>/dev/null | tail -1
sudo systemd-analyze security enotdesk-agent 2>/dev/null | grep -c "✗" || true
