#!/bin/sh
# Оболочка запуска enotdesk в Docker: выводит производные env из переменных compose,
# чтобы TURN и публичный адрес работали из коробки (spec, история 1-4).
# Сервер при этом не меняется: читает те же ENOT_* (server/main.mjs).
set -eu

# Хостнейм-валидация DOMAIN (P2-15) перед интерполяцией в env сервера:
# ^[A-Za-z0-9.-]+(:[0-9]+)?$ — только буквы/цифры/точки/дефисы, порт опционален.
valid_hostport() {
  case "$1" in
    *:*)
      h="${1%:*}"; p="${1##*:}"
      case "$p" in ''|*[!0-9]*) return 1 ;; esac
      case "$h" in ''|*[!A-Za-z0-9.-]*) return 1 ;; esac
      ;;
    *)
      case "$1" in ''|*[!A-Za-z0-9.-]*) return 1 ;; esac
      ;;
  esac
  return 0
}

if [ -n "${DOMAIN:-}" ] && ! valid_hostport "$DOMAIN"; then
  echo "ENOTDESK: DOMAIN не похож на имя хоста (допустимы буквы, цифры, точка, дефис; опционально :порт) — отказ." >&2
  exit 1
fi

# Публичный адрес: по умолчанию https://$DOMAIN
if [ -z "${ENOT_PUBLIC_URL:-}" ] && [ -n "${DOMAIN:-}" ]; then
  ENOT_PUBLIC_URL="https://$DOMAIN"
fi

if [ -n "${DOMAIN:-}" ]; then
  # TURN-URL из коробки: coturn слушает 3478 (tcp+udp) на хосте.
  if [ -z "${ENOT_TURN_URLS:-}" ]; then
    ENOT_TURN_URLS="stun:$DOMAIN:3478,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp"
  fi
  # coturn в режиме REST-аутентификации ждёт в username метку времени истечения;
  # 2000000000 = 2033-05-18 UTC (coturn парсит метку как 32-битное число —
  # после 2038-01-19 не влезает). Обнови через TURN_USERNAME до истечения.
  if [ -z "${ENOT_TURN_USERNAME:-}" ]; then
    ENOT_TURN_USERNAME="2000000000"
  fi
  # use-auth-secret: пароль клиента = base64(HMAC-SHA1(TURN_SECRET, username))
  if [ -n "${ENOT_TURN_SECRET:-}" ] && [ -z "${ENOT_TURN_PASSWORD:-}" ]; then
    ENOT_TURN_PASSWORD="$(
      ENOT_TURN_USERNAME="$ENOT_TURN_USERNAME" node -e '
        const c = require("node:crypto");
        process.stdout.write(
          c.createHmac("sha1", process.env.ENOT_TURN_SECRET)
            .update(process.env.ENOT_TURN_USERNAME)
            .digest("base64"));
      '
    )"
  fi
elif [ -n "${ENOT_TURN_SECRET:-}" ]; then
  echo "ENOTDESK: DOMAIN не задан — TURN клиенту не отдан (нужен публичный адрес); coturn запущен, но простаивает." >&2
fi

# ENOT_TURN_SECRET пробрасывается серверу как есть (эфемерные TURN-креды):
# compose кладёт его в окружение контейнера, здесь — только явный export.
export ENOT_PUBLIC_URL ENOT_TURN_URLS ENOT_TURN_USERNAME ENOT_TURN_PASSWORD ENOT_TURN_SECRET
exec "$@"
