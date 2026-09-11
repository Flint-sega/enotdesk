#!/usr/bin/env bash
# EnotDesk — локальный деплой сервера: собирает tarball, доставляет на хост
# через scp/ssh и запускает install-server.sh, затем проверяет health.
#
# Использование:
#   ENOT_DEPLOY_HOST=203.0.113.10 ./scripts/deploy-server.sh
#
# Env: ENOT_DEPLOY_HOST (обязательно), ENOT_DEPLOY_USER (root),
# ENOT_DEPLOY_PASSWORD (опционально, sshpass), ENOT_DEPLOY_PORT (22),
# ENOT_PORT (8080), ENOT_DEPLOY_PROTO (http), ENOT_BIND, ENOT_PUBLIC_URL,
# ENOT_DB, ENOT_TURN_URLS, ENOT_TURN_USERNAME, ENOT_TURN_PASSWORD.
set -euo pipefail

die() { echo "ОШИБКА: $*" >&2; exit 1; }
info() { echo "==> $*"; }

if [ -z "${ENOT_DEPLOY_HOST:-}" ]; then
  die "не задан ENOT_DEPLOY_HOST. Пример: ENOT_DEPLOY_HOST=203.0.113.10 ./scripts/deploy-server.sh (см. .env.example)"
fi

HOST="$ENOT_DEPLOY_HOST"
DEPLOY_USER="${ENOT_DEPLOY_USER:-root}"
DEPLOY_PORT="${ENOT_DEPLOY_PORT:-22}"
PORT="${ENOT_PORT:-8080}"
PROTO="${ENOT_DEPLOY_PROTO:-http}"
REMOTE_DIR="/tmp/enotdesk-install"
REMOTE_TAR="$REMOTE_DIR/app.tar.gz"
REMOTE_INSTALLER="$REMOTE_DIR/install-server.sh"
REMOTE_ENVFILE="$REMOTE_DIR/deploy.env"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for f in server package.json package-lock.json scripts/install-server.sh; do
  [ -e "$ROOT/$f" ] || die "не найден $f — запускайте из корня репозитория EnotDesk"
done
command -v curl >/dev/null 2>&1 || die "не найден curl"
command -v ssh >/dev/null 2>&1 || die "не найден ssh"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -p "$DEPLOY_PORT")
SCP_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -P "$DEPLOY_PORT")
if [ -n "${ENOT_DEPLOY_PASSWORD:-}" ]; then
  command -v sshpass >/dev/null 2>&1 || die "ENOT_DEPLOY_PASSWORD задан, но sshpass не установлен (apt install sshpass / brew install sshpass)"
  export SSHPASS="$ENOT_DEPLOY_PASSWORD"
  SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
  SCP=(sshpass -e scp "${SCP_OPTS[@]}")
else
  SSH=(ssh "${SSH_OPTS[@]}")
  SCP=(scp "${SCP_OPTS[@]}")
fi
DEST="$DEPLOY_USER@$HOST"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "собираю tarball (server/, package.json, package-lock.json, scripts/install-server.sh)"
tar -czf "$TMP/app.tar.gz" -C "$ROOT" server package.json package-lock.json scripts/install-server.sh

# Значения ENOT_* уходят на сервер только файлом 0600: в argv ssh/bash их нет.
ENV_FILE_LOCAL="$TMP/deploy.env"
env_kv() {
  local key="$1" val="$2" esc
  esc="$(printf '%s' "$val" | sed "s/'/'\\\\''/g")"
  printf "%s='%s'\n" "$key" "$esc"
}
: > "$ENV_FILE_LOCAL"
chmod 600 "$ENV_FILE_LOCAL"
{
  env_kv ENOT_PORT "$PORT"
  if [ -n "${ENOT_BIND:-}" ]; then env_kv ENOT_BIND "$ENOT_BIND"; fi
  if [ -n "${ENOT_PUBLIC_URL:-}" ]; then env_kv ENOT_PUBLIC_URL "$ENOT_PUBLIC_URL"; fi
  if [ -n "${ENOT_DB:-}" ]; then env_kv ENOT_DB "$ENOT_DB"; fi
  if [ -n "${ENOT_TURN_URLS:-}" ]; then env_kv ENOT_TURN_URLS "$ENOT_TURN_URLS"; fi
  if [ -n "${ENOT_TURN_USERNAME:-}" ]; then env_kv ENOT_TURN_USERNAME "$ENOT_TURN_USERNAME"; fi
  if [ -n "${ENOT_TURN_PASSWORD:-}" ]; then env_kv ENOT_TURN_PASSWORD "$ENOT_TURN_PASSWORD"; fi
} > "$ENV_FILE_LOCAL"
chmod 600 "$ENV_FILE_LOCAL"

if [ "$DEPLOY_USER" = "root" ]; then SUDO=""; else SUDO="sudo "; fi
OPEN_FIREWALL_HINT="ssh ${DEPLOY_PORT:+-p $DEPLOY_PORT }$DEST \"${SUDO}ENOT_PORT=$PORT bash $REMOTE_INSTALLER --open-firewall $REMOTE_TAR\""

info "доставляю на $DEST:$REMOTE_DIR"
if ! "${SSH[@]}" "$DEST" "mkdir -p '$REMOTE_DIR'"; then
  die "не удалось подключиться к $DEST — проверьте ENOT_DEPLOY_HOST/USER/PORT и доступ (ключ или ENOT_DEPLOY_PASSWORD)"
fi
"${SCP[@]}" "$TMP/app.tar.gz" "$DEST:$REMOTE_TAR" || die "scp tarball не удался"
"${SCP[@]}" "$ROOT/scripts/install-server.sh" "$DEST:$REMOTE_INSTALLER" || die "scp install-server.sh не удался"
"${SCP[@]}" "$ENV_FILE_LOCAL" "$DEST:$REMOTE_ENVFILE" || die "scp deploy.env не удался"
"${SSH[@]}" "$DEST" "chmod 600 '$REMOTE_ENVFILE'" || die "не удалось выставить 0600 на deploy.env"

info "запускаю установщик на сервере"
REMOTE_SCRIPT="set -a; . '$REMOTE_ENVFILE'; set +a; rc=0; bash '$REMOTE_INSTALLER' '$REMOTE_TAR' || rc=\$?; rm -f '$REMOTE_ENVFILE'; exit \$rc"
if [ -n "$SUDO" ]; then
  RUN_CMD="sudo bash -c $(printf '%q' "$REMOTE_SCRIPT")"
else
  RUN_CMD="$REMOTE_SCRIPT"
fi
if ! "${SSH[@]}" "$DEST" "$RUN_CMD"; then
  die "установщик завершился с ошибкой — смотрите вывод выше"
fi

info "проверяю health на сервере (127.0.0.1)"
if ! REMOTE_HEALTH="$("${SSH[@]}" "$DEST" "curl -fsS --max-time 5 'http://127.0.0.1:$PORT/api/v1/health'")"; then
  die "health на сервере не отвечает"
fi
info "health на сервере: $REMOTE_HEALTH"

HEALTH_URL="$PROTO://$HOST:$PORT/api/v1/health"
info "проверяю health снаружи: $HEALTH_URL"
if ! PUBLIC_HEALTH="$(curl -fsS --max-time 10 "$HEALTH_URL")"; then
  die "health снаружи не отвечает ($HEALTH_URL) — проверьте firewall/порт. Открыть порт: $OPEN_FIREWALL_HINT"
fi
info "health снаружи: $PUBLIC_HEALTH"

cat <<EOF

Готово: сервер EnotDesk развёрнут.
  Health:   $HEALTH_URL
  Страница: $PROTO://$HOST:$PORT/downloads (наполняется сборками из dist/)

Следующий шаг — создать администратора (интерактивно на сервере):
  ssh ${DEPLOY_PORT:+-p $DEPLOY_PORT }$DEST
  sudo -u enotdesk env ENOT_DB=${ENOT_DB:-/var/lib/enotdesk/enotdesk.db} node /opt/enotdesk/current/server/main.mjs bootstrap

После этого можно проверить сервер снаружи:
  ENOT_BASE_URL=$PROTO://$HOST:$PORT ENOT_ADMIN_LOGIN=<логин> ENOT_ADMIN_PASSWORD=<пароль> node scripts/smoke-remote.mjs
EOF
