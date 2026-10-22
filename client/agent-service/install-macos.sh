#!/usr/bin/env bash
# ============================================================
# EnotDesk agent - установка постоянного доступа (macOS, LaunchAgent, ADR 0038)
# Запускать БЕЗ sudo, от имени пользователя Mac, к экрану которого нужен доступ.
#   SERVER_URL=https://... [AGENT_NAME=...] [AGENT_CODE_FILE=файл] ./install-macos.sh
# AGENT_CODE_FILE — файл с одноразовым кодом регистрации машины (первая строка);
# код не попадает в argv, после регистрации файл удаляется.
# ============================================================
set -euo pipefail

APP_PATH="${APP_PATH:-/Applications/EnotDesk.app}"
AGENT_NAME="${AGENT_NAME:-$(scutil --get ComputerName 2>/dev/null || hostname -s)}"
SERVER_URL="${SERVER_URL:-}"
AGENT_CODE_FILE="${AGENT_CODE_FILE:-}"
LABEL="com.enotdesk.agent"
PLIST_SRC="$(dirname "$0")/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROFILE="$HOME/Library/Application Support/EnotDesk/agent"
TOKEN="$PROFILE/agent-token.json"
LOG_FILE="$HOME/Library/Logs/enotdesk-agent.log"
EXE="$APP_PATH/Contents/MacOS/EnotDesk"

if [ "$(id -u)" -eq 0 ]; then
  echo "ошибка: запускайте без sudo — агент работает в сеансе пользователя Mac (видео и управление)" >&2
  exit 1
fi
if [ -z "$SERVER_URL" ]; then
  echo "ошибка: задайте SERVER_URL, например: SERVER_URL=https://... $0" >&2
  exit 1
fi
if [ ! -x "$EXE" ]; then
  echo "ошибка: не найден $EXE — перетащите EnotDesk в «Программы» или поправьте APP_PATH" >&2
  exit 1
fi
case "$AGENT_NAME" in *[\<\>\&\|]*) echo "ошибка: имя машины содержит недопустимые символы" >&2; exit 1 ;; esac

if [ -f /Library/LaunchDaemons/$LABEL.plist ]; then
  echo "внимание: найдена прежняя служба от root (/Library/LaunchDaemons/$LABEL.plist)." >&2
  echo "         Удалите её: sudo launchctl bootout system/$LABEL; sudo rm /Library/LaunchDaemons/$LABEL.plist" >&2
fi

echo "==> профиль агента: $PROFILE"
mkdir -p "$PROFILE" "$(dirname "$PLIST_DST")" "$(dirname "$LOG_FILE")"
chmod 0700 "$PROFILE"
printf '{"serverUrl": "%s"}\n' "$SERVER_URL" > "$PROFILE/settings.json"
chmod 0600 "$PROFILE/settings.json"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

if [ ! -f "$TOKEN" ]; then
  if [ -z "$AGENT_CODE_FILE" ] || [ ! -s "$AGENT_CODE_FILE" ]; then
    echo "ошибка: машина ещё не зарегистрирована — укажите AGENT_CODE_FILE с одноразовым кодом" >&2
    exit 1
  fi
  echo "==> регистрация машины «$AGENT_NAME» на $SERVER_URL"
  EDESK_AGENT_CODE="$(head -n1 "$AGENT_CODE_FILE")" EDESK_AGENT=1 EDESK_AGENT_NAME="$AGENT_NAME" \
    "$EXE" >>"$LOG_FILE" 2>&1 &
  PID=$!
  for _ in $(seq 1 90); do
    [ -f "$TOKEN" ] && break
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  if [ ! -f "$TOKEN" ]; then
    echo "ошибка: регистрация не прошла, журнал: $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    exit 1
  fi
  rm -f "$AGENT_CODE_FILE"
  echo "==> зарегистрирована, одноразовый код удалён"
fi

echo "==> LaunchAgent $PLIST_DST"
sed -e "s|<string>/Applications/EnotDesk.app/Contents/MacOS/EnotDesk</string>|<string>$EXE</string>|" \
    -e "s|<string>mac-mini</string>|<string>$AGENT_NAME</string>|" \
    -e "s|<string>/tmp/enotdesk-agent.log</string>|<string>$LOG_FILE</string>|g" \
    "$PLIST_SRC" > "$PLIST_DST"
chmod 0644 "$PLIST_DST"
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
sleep 2
launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,12p' || true
echo
echo "Готово. Агент работает, пока вы вошли в систему, и стартует сам при входе."
echo "Один раз разрешите EnotDesk: Системные настройки → Конфиденциальность и безопасность →"
echo "«Запись экрана и системного звука» и «Универсальный доступ» — без них видео и управления не будет."
echo "Журнал: $LOG_FILE"
