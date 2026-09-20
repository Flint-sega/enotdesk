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

umask 077
cat > /run/turnserver.conf <<EOF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$REALM
min-port=49160
max-port=49200
no-tls
no-dtls
no-multicast-peers
no-cli
EOF
chmod 0600 /run/turnserver.conf

# -c: только этот конфиг (как раньше -c /dev/null + флаги argv).
exec turnserver -c /run/turnserver.conf
