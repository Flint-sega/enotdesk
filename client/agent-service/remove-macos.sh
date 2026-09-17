#!/usr/bin/env bash
# ============================================================
# EnotDesk agent - service remove (macOS, LaunchDaemon)
# Запускать от sudo. --purge-data удаляет ещё и профиль агента.
# ============================================================
set -euo pipefail

PROFILE="/var/root/Library/Application Support/EnotDesk/agent"
PLIST_DST="/Library/LaunchDaemons/com.enotdesk.agent.plist"
LOG_FILE="/var/log/enotdesk-agent.log"

if [ "$(id -u)" -ne 0 ]; then
  echo "ошибка: запускайте через sudo (root)" >&2
  exit 1
fi

launchctl bootout system/com.enotdesk.agent 2>/dev/null || true
rm -f "$PLIST_DST"

if [ "${1:-}" = "--purge-data" ]; then
  rm -rf "$PROFILE" "$LOG_FILE"
  echo "LaunchDaemon удалён, профиль агента и логи удалены."
  echo "Не забудьте удалить/отозвать машину на сервере (список машин)."
else
  echo "LaunchDaemon удалён. Токен и настройки остались в $PROFILE"
  echo "Повторная установка подхватит прежний токен. Полная очистка: sudo $0 --purge-data"
fi
