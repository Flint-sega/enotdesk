#!/bin/bash
# LAB VM103 (L5): drop-in ozone для enotdesk-agent — Electron 44 игнорирует
# ELECTRON_OZONE_PLATFORM_HINT, а на Wayland-сессии auto-ozone уводит UI агента
# в wayland (падает без XDG_RUNTIME_DIR). Флаг --ozone-platform=x11 гонит UI
# через Xwayland в обоих режимах (X11 и Wayland); маркер XDG_SESSION_TYPE=wayland
# в agent.env остаётся сигналом адаптеру ввода (честный wayland-unsupported-control).
# Запуск на VM 103: bash /home/enotadmin/vm103-ozone-dropin.sh
set -euo pipefail
D=/etc/systemd/system/enotdesk-agent.service.d
sudo mkdir -p "$D"
sudo tee "$D/ozone.conf" >/dev/null <<'EOF'
# LAB L5: UI агента всегда через X11/Xwayland (Electron 44 игнорирует
# ELECTRON_OZONE_PLATFORM_HINT). Ввод на Wayland всё равно честно отказывает.
[Service]
ExecStart=
ExecStart=/opt/enotdesk-agent/EnotDesk/enotdesk --ozone-platform=x11
EOF
sudo systemctl daemon-reload
sudo systemctl restart enotdesk-agent
sleep 6
echo "unit: $(systemctl is-active enotdesk-agent)"
sudo journalctl -u enotdesk-agent --since "15 seconds ago" --no-pager | grep -E "запущен|Токен" | tail -2
