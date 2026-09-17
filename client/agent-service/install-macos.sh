#!/usr/bin/env bash
# ============================================================
# EnotDesk agent - service install (macOS, LaunchDaemon)
# Запускать от sudo. Перед запуском скорректируйте переменные ниже.
# ============================================================
set -euo pipefail

# Установленное приложение агента.
APP_PATH="${APP_PATH:-/Applications/EnotDesk.app}"
AGENT_NAME="${AGENT_NAME:-$(hostname -s)}"
SERVER_URL="${SERVER_URL:-}"
PLIST_SRC="$(dirname "$0")/com.enotdesk.agent.plist"
PLIST_DST="/Library/LaunchDaemons/com.enotdesk.agent.plist"
# LaunchDaemon работает от root: профиль Electron агента лежит у root.
PROFILE="/var/root/Library/Application Support/EnotDesk/agent"
LOG_FILE="/var/log/enotdesk-agent.log"

if [ -z "$SERVER_URL" ]; then
  echo "ошибка: задайте SERVER_URL, например: sudo SERVER_URL=https://... $0" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "ошибка: запускайте через sudo (root)" >&2
  exit 1
fi
if [ ! -x "$APP_PATH/Contents/MacOS/EnotDesk" ]; then
  echo "ошибка: не найден $APP_PATH/Contents/MacOS/EnotDesk - поправьте APP_PATH" >&2
  exit 1
fi

echo "==> профиль агента: $PROFILE (settings.json)"
mkdir -p "$PROFILE"
printf '{"serverUrl": "%s"}\n' "$SERVER_URL" > "$PROFILE/settings.json"
chmod 0700 "$PROFILE"
chmod 0600 "$PROFILE/settings.json"

echo "==> plist $PLIST_DST"
# LaunchDaemon исполняется от root до логина: RunAtLoad + KeepAlive.
launchctl bootout system/com.enotdesk.agent 2>/dev/null || true
sed -e "s|<string>/Applications/EnotDesk.app/Contents/MacOS/EnotDesk</string>|<string>$APP_PATH/Contents/MacOS/EnotDesk</string>|" \
    -e "s|<string>mac-mini</string>|<string>$AGENT_NAME</string>|" \
    "$PLIST_SRC" > "$PLIST_DST"
chown root:wheel "$PLIST_DST"
chmod 0644 "$PLIST_DST"
touch "$LOG_FILE"

launchctl bootstrap system "$PLIST_DST"
sleep 2
launchctl print system/com.enotdesk.agent | sed -n '1,20p' || true
echo
echo "Готово. Логи: tail -f $LOG_FILE (и Console.app)."
echo "Регистрация машины проверьте на сервере (список машин): статус должен стать online."
