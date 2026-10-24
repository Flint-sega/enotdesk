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
# Файл с одноразовым кодом машины (первая строка) - нужен только при первой
# установке. Код не попадает в argv; после регистрации файл удаляется.
AGENT_CODE_FILE="${AGENT_CODE_FILE:-}"
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
# http:// без allowInsecureHttp агент отбрасывает (как галочка в настройках
# клиента) и молча уходит на 127.0.0.1 - явный http-адрес = согласие на http.
INSECURE=false
case "$SERVER_URL" in http://*) INSECURE=true; echo "внимание: $SERVER_URL без HTTPS - трафик не шифруется (только для тестового сервера)" >&2 ;; esac
printf '{"serverUrl": "%s", "allowInsecureHttp": %s}\n' "$SERVER_URL" "$INSECURE" > "$PROFILE/settings.json"
chown "$AGENT_USER:$AGENT_USER" "$PROFILE/settings.json"
chmod 0600 "$PROFILE/settings.json"

echo "==> env-файл $ENV_FILE"
install -d -m 0750 /etc/enotdesk-agent
if [ -f "$ENV_FILE" ]; then
  # Повторная установка: строки админа (DISPLAY, XAUTHORITY и др.) сохраняются,
  # меняется только имя машины. Раньше файл перезаписывался, и агент молча терял
  # экран и управление (W-9 на стенде 24.10).
  { echo "EDESK_AGENT_NAME=$AGENT_NAME"; grep -v '^EDESK_AGENT_NAME=' "$ENV_FILE" || true; } > "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
else
  {
    echo "EDESK_AGENT_NAME=$AGENT_NAME"
    # Для управления консольной X11-сессией раскомментируйте и поправьте:
    # DISPLAY=:0
    # XAUTHORITY=/etc/enotdesk-agent/xauth
  } > "$ENV_FILE"
fi
chmod 0600 "$ENV_FILE"

TOKEN="$PROFILE/agent-token.json"
if [ ! -f "$TOKEN" ]; then
  if [ -z "$AGENT_CODE_FILE" ] || [ ! -s "$AGENT_CODE_FILE" ]; then
    echo "ошибка: машина ещё не зарегистрирована - укажите AGENT_CODE_FILE с одноразовым кодом" >&2
    echo "        (код выдаёт администратор: программа оператора -> «Машины» -> «Добавить машину»)" >&2
    exit 1
  fi
  REG_LOG="$AGENT_HOME/register.log"
  echo "==> регистрация машины «$AGENT_NAME» на $SERVER_URL"
  # Код - только в окружении процесса (не в argv). runuser без -l оставляет
  # окружение, HOME берёт из passwd служебного пользователя.
  # Экран регистрации не нужен: headless явно в командной строке (Electron 44 выбирает
  # платформу до кода программы; без DISPLAY с x11 процесс падал сразу, W-9 24.10).
  EDESK_AGENT_CODE="$(head -n1 "$AGENT_CODE_FILE")" EDESK_AGENT=1 EDESK_AGENT_NAME="$AGENT_NAME" \
    runuser -u "$AGENT_USER" -- "$APP_DIR/enotdesk" --ozone-platform=headless >"$REG_LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 90); do
    [ -f "$TOKEN" ] && break
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  if [ ! -f "$TOKEN" ]; then
    echo "ошибка: регистрация не прошла, журнал: $REG_LOG" >&2
    tail -n 20 "$REG_LOG" >&2 || true
    exit 1
  fi
  rm -f "$AGENT_CODE_FILE"
  echo "==> зарегистрирована, одноразовый код удалён"
fi

echo "==> unit $UNIT_FILE"
# в ExecStart подставляется только путь к программе: обёртка выбора ozone остаётся
sed "s|/opt/enotdesk-agent/EnotDesk/enotdesk|$APP_DIR/enotdesk|" "$(dirname "$0")/enotdesk-agent.service" > "$UNIT_FILE"
chmod 0644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable enotdesk-agent
# restart, а не enable --now: при повторной установке служба уже работает, и старый
# процесс без нового токена оставлял машину офлайн до ручного перезапуска (W-9, 24.10)
systemctl restart enotdesk-agent
sleep 2
systemctl --no-pager --lines=20 status enotdesk-agent || true
echo
echo "Готово. Логи: journalctl -u enotdesk-agent -f"
echo "Регистрация машины проверьте на сервере (список машин): статус должен стать online."
