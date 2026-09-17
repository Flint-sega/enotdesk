#!/bin/sh
# Точка входа caddy для EnotDesk: с DOMAIN — авто-HTTPS (Let's Encrypt),
# без DOMAIN — честный HTTP на :80 с предупреждением в логах (spec, история 2).
set -eu

if [ -n "${DOMAIN:-}" ]; then
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
