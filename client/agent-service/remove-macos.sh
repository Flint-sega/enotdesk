#!/usr/bin/env bash
# ============================================================
# EnotDesk agent - удаление постоянного доступа (macOS, LaunchAgent, ADR 0038)
# Запускать без sudo, от имени того же пользователя. --purge-data удаляет
# ещё и профиль агента (токен машины) и журнал.
# ============================================================
set -euo pipefail

LABEL="com.enotdesk.agent"
PROFILE="$HOME/Library/Application Support/EnotDesk/agent"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_FILE="$HOME/Library/Logs/enotdesk-agent.log"

if [ "$(id -u)" -eq 0 ]; then
  echo "ошибка: запускайте без sudo, от имени пользователя, у которого стоит агент" >&2
  exit 1
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"

if [ -f /Library/LaunchDaemons/$LABEL.plist ]; then
  echo "внимание: осталась прежняя служба от root — удалите: sudo launchctl bootout system/$LABEL; sudo rm /Library/LaunchDaemons/$LABEL.plist" >&2
fi

if [ "${1:-}" = "--purge-data" ]; then
  rm -rf "$PROFILE" "$LOG_FILE"
  echo "Агент удалён вместе с токеном машины и журналом."
  echo "Отзовите машину на сервере (список машин), чтобы её запись не висела."
else
  echo "Агент удалён. Токен и настройки остались в $PROFILE"
  echo "Повторная установка подхватит прежний токен. Полная очистка: $0 --purge-data"
fi
