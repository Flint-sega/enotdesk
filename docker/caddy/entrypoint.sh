#!/bin/sh
# Точка входа caddy для EnotDesk: с DOMAIN — авто-HTTPS (Let's Encrypt),
# без DOMAIN — честный HTTP на :80 с предупреждением в логах (spec, история 2).
set -eu

# Хостнейм-валидация DOMAIN (P2-15) перед интерполяцией в Caddyfile:
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

if [ -n "${DOMAIN:-}" ]; then
  if ! valid_hostport "$DOMAIN"; then
    echo "ENOTDESK: DOMAIN не похож на имя хоста (допустимы буквы, цифры, точка, дефис; опционально :порт) — Caddyfile не записан, отказ." >&2
    exit 1
  fi
  addr="$DOMAIN"
else
  addr=":80"
  echo "ENOTDESK: DOMAIN не задан — HTTPS выключен, работает HTTP на :80 (локальный режим)."
  echo "ENOTDESK: для автоматического TLS задай DOMAIN в .env и открой порты 80/443."
fi

mkdir -p /tmp/enotdesk
cat > /tmp/enotdesk/Caddyfile <<EOF
$addr {
	reverse_proxy enotdesk:8080
}
EOF

exec caddy run --config /tmp/enotdesk/Caddyfile --adapter caddyfile
