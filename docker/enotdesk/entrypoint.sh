#!/bin/sh
# Оболочка запуска enotdesk в Docker: выводит производные env из переменных compose,
# чтобы TURN и публичный адрес работали из коробки (spec, история 1-4).
# Сервер при этом не меняется: читает те же ENOT_* (server/main.mjs).
set -eu

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

export ENOT_PUBLIC_URL ENOT_TURN_URLS ENOT_TURN_USERNAME ENOT_TURN_PASSWORD
exec "$@"
