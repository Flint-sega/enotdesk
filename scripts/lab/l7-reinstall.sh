#!/bin/bash
# LAB L7-reinstall: переустановка агента из локальной сборки (уже в APP_DIR после L6)
# + код онбординга (кладётся хостом в /tmp/agent-code) + glue + проверка регистрации.
# Запуск на VM 103: bash /home/enotadmin/l7-reinstall.sh
set -euo pipefail
log(){ echo "[L7R] $*"; }
test -s /tmp/agent-code || { echo "[L7R] FAIL: нет /tmp/agent-code"; exit 1; }
test -x /opt/enotdesk-agent/EnotDesk/enotdesk || { echo "[L7R] FAIL: нет APP_DIR (локальная сборка)"; exit 1; }

cd /var/tmp/enotdesk/src/client/agent-service
sudo env APP_DIR=/opt/enotdesk-agent/EnotDesk SERVER_URL=http://198.51.100.10:8080 AGENT_NAME=enotdesk-linux-a1 bash install-linux.sh >/dev/null
CODE=$(sudo cut -d= -f2 /tmp/agent-code)
sudo sed -i "/^EDESK_AGENT_CODE=/d" /etc/enotdesk-agent/agent.env
sudo sed -i "/^EDESK_AGENT_NAME=/a EDESK_AGENT_CODE=$CODE" /etc/enotdesk-agent/agent.env
sudo rm -f /tmp/agent-code
sudo grep -q EDESK_AGENT_CODE /etc/enotdesk-agent/agent.env && log "код в agent.env"
sudo systemctl restart enotdesk-agent
sleep 6
log "unit: $(systemctl is-active enotdesk-agent)"
# glue: DISPLAY/XAUTHORITY + права каталога (после переустановки install-script пересоздал env-файл)
sudo /usr/local/sbin/enot-xauth-sync.sh 15
sleep 6
log "unit2: $(systemctl is-active enotdesk-agent)"
sudo journalctl -u enotdesk-agent --since "40 seconds ago" --no-pager | grep -E "запущен|зарегистр" | tail -3
