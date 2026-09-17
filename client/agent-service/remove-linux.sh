#!/usr/bin/env bash
# ============================================================
# EnotDesk agent - service remove (Linux, systemd)
# Запускать от root. --purge-data удаляет ещё и профиль/пользователя.
# ============================================================
set -euo pipefail

AGENT_USER="${AGENT_USER:-enotdesk-agent}"
AGENT_HOME="${AGENT_HOME:-/var/lib/enotdesk-agent}"
ENV_DIR="/etc/enotdesk-agent"
UNIT_FILE="/etc/systemd/system/enotdesk-agent.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "ошибка: запускайте от root" >&2
  exit 1
fi

systemctl disable --now enotdesk-agent 2>/dev/null || true
rm -f "$UNIT_FILE"
systemctl daemon-reload

if [ "${1:-}" = "--purge-data" ]; then
  rm -rf "$AGENT_HOME" "$ENV_DIR"
  if id "$AGENT_USER" >/dev/null 2>&1; then
    userdel "$AGENT_USER"
  fi
  echo "Служба удалена, профиль и пользователь $AGENT_USER удалены."
  echo "Не забудьте удалить/отозвать машину на сервере (список машин)."
else
  echo "Служба удалена. Токен и настройки остались в $AGENT_HOME/.config/EnotDesk/agent"
  echo "Повторная установка подхватит прежний токен. Полная очистка: $0 --purge-data"
fi
