#!/bin/sh
# Точка входа coturn для EnotDesk: static-auth-secret уходит в конфиг-файл
# /run/turnserver.conf (tmpfs, 0600), а не в argv процесса — секрет не виден
# в docker inspect / docker ps (P2-13). turnserver читает конфиг флагом -c.
set -eu

[ -n "${TURN_SECRET:-}" ] || {
  echo "ENOTDESK coturn: TURN_SECRET не задан — задай его в .env (см. .env.example)" >&2
  exit 1
}

REALM="localhost"
if [ -n "${DOMAIN:-}" ]; then
  # Хостнейм-валидация перед интерполяцией в конфиг (P2-15): только
  # буквы/цифры/точки/дефисы; всё остальное — честный отказ, а не подстановка.
  case "$DOMAIN" in
    *[!A-Za-z0-9.-]*)
      echo "ENOTDESK coturn: DOMAIN содержит недопустимые символы (ожидались буквы, цифры, точка, дефис) — конфиг не записан, отказ." >&2
      exit 1
      ;;
  esac
  REALM="$DOMAIN"
fi

TLS_PORT="${TURN_TLS_PORT:-}"
TLS_CERT="${TURN_TLS_CERT:-}"
TLS_KEY="${TURN_TLS_KEY:-}"
LISTEN_IP="${TURN_TLS_LISTEN_IP:-}"
if [ -n "$TLS_PORT" ]; then
  case "$TLS_PORT" in *[!0-9]*) echo "ENOTDESK coturn: TURN_TLS_PORT должен быть числом" >&2; exit 1 ;; esac
  [ "$TLS_PORT" -ge 1 ] && [ "$TLS_PORT" -le 65535 ] || {
    echo "ENOTDESK coturn: TURN_TLS_PORT вне диапазона 1..65535" >&2
    exit 1
  }
  [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ] && [ -r "$TLS_CERT" ] && [ -r "$TLS_KEY" ] || {
    echo "ENOTDESK coturn: для TURN_TLS_PORT нужны читаемые TURN_TLS_CERT и TURN_TLS_KEY" >&2
    exit 1
  }
fi

umask 077
cat > /run/turnserver.conf <<EOF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$REALM
min-port=49160
max-port=49999
no-tls
no-dtls
no-multicast-peers
no-cli
EOF
if [ -n "$TLS_PORT" ]; then
  printf 'tls-listening-port=%s\ncert=%s\npkey=%s\n' "$TLS_PORT" "$TLS_CERT" "$TLS_KEY" >> /run/turnserver.conf
fi
if [ -n "$LISTEN_IP" ]; then
  printf 'listening-ip=%s\n' "$LISTEN_IP" >> /run/turnserver.conf
fi
chmod 0600 /run/turnserver.conf

# -c: только этот конфиг (как раньше -c /dev/null + флаги argv).
exec turnserver -c /run/turnserver.conf
