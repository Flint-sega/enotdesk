#!/usr/bin/env bash
# ============================================================
# EnotDesk agent - service install (Linux, systemd)
# Запускать от root. Перед запуском скорректируйте переменные ниже.
# ============================================================
set -euo pipefail

# Путь к распакованной сборке клиента (бинарник Electron).
APP_DIR="${APP_DIR:-/opt/enotdesk-agent/EnotDesk}"
# Адрес сервера EnotDesk (обязателен).
SERVER_URL="${SERVER_URL:-}"
# Имя машины в списке (по умолчанию - hostname).
AGENT_NAME="${AGENT_NAME:-$(hostname)}"
# Служебный пользователь и его домашний каталог (профиль агента).
AGENT_USER="${AGENT_USER:-enotdesk-agent}"
AGENT_HOME="${AGENT_HOME:-/var/lib/enotdesk-agent}"
ENV_FILE="/etc/enotdesk-agent/agent.env"
UNIT_FILE="/etc/systemd/system/enotdesk-agent.service"

if [ -z "$SERVER_URL" ]; then
  echo "ошибка: задайте SERVER_URL (адрес сервера EnotDesk), например: SERVER_URL=https://... $0" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "ошибка: запускайте от root" >&2
  exit 1
fi
if [ ! -x "$APP_DIR/enotdesk" ]; then
  echo "ошибка: не найден $APP_DIR/enotdesk - распакуйте сборку и/или поправьте APP_DIR" >&2
  exit 1
fi

echo "==> пользователь $AGENT_USER (system, без логина)"
id "$AGENT_USER" >/dev/null 2>&1 || useradd --system --home-dir "$AGENT_HOME" --create-home --shell /usr/sbin/nologin "$AGENT_USER"

echo "==> профиль агента: $AGENT_HOME/.config/enotdesk/agent (settings.json)"
# Electron именует userData по имени пакета (package.json name = enotdesk,
# строчные) — путь обязан совпадать байт в байт; «EnotDesk» настройку службы
# не подхватывал (приёмка 05.10, L1-б). Родителей создаём и целиком отдаём
# агенту: install -d оставлял промежуточный .config в root-владении, и агент
# не мог дописать в собственный профиль.
PROFILE="$AGENT_HOME/.config/enotdesk/agent"
mkdir -p "$PROFILE"
chown -R "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/.config"
chmod 0700 "$PROFILE"
printf '{"serverUrl": "%s"}\n' "$SERVER_URL" > "$PROFILE/settings.json"
chown "$AGENT_USER:$AGENT_USER" "$PROFILE/settings.json"
chmod 0600 "$PROFILE/settings.json"

echo "==> env-файл $ENV_FILE"
install -d -m 0750 /etc/enotdesk-agent
{
  echo "EDESK_AGENT_NAME=$AGENT_NAME"
  # Для управления консольной X11-сессией раскомментируйте и поправьте:
  # DISPLAY=:0
  # XAUTHORITY=/etc/enotdesk-agent/xauth
} > "$ENV_FILE"
chmod 0600 "$ENV_FILE"

echo "==> unit $UNIT_FILE"
sed "s|ExecStart=.*|ExecStart=$APP_DIR/enotdesk|" "$(dirname "$0")/enotdesk-agent.service" > "$UNIT_FILE"
chmod 0644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable --now enotdesk-agent
sleep 2
systemctl --no-pager --lines=20 status enotdesk-agent || true
echo
echo "Готово. Логи: journalctl -u enotdesk-agent -f"
echo "Регистрация машины проверьте на сервере (список машин): статус должен стать online."
