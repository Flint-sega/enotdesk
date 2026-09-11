#!/usr/bin/env bash
# EnotDesk — установщик сервера (Debian/Ubuntu, от root).
# Идемпотентен: повторный запуск с тем же tarball переиспользует релиз.
#
# Использование:
#   bash scripts/install-server.sh <app.tar.gz> [--dry-run] [--open-firewall]
#   bash scripts/install-server.sh --update <app.tar.gz>
#   bash scripts/install-server.sh --uninstall [--purge-data]
#   bash scripts/install-server.sh --help
#
# Env (имена, значения задаются снаружи): ENOT_PORT, ENOT_BIND, ENOT_PUBLIC_URL,
# ENOT_DB, ENOT_TURN_URLS, ENOT_TURN_USERNAME, ENOT_TURN_PASSWORD, NODE_VERSION.
set -euo pipefail

ENOT_USER="enotdesk"
OPT_DIR="/opt/enotdesk"
RELEASES_DIR="$OPT_DIR/releases"
CURRENT_LINK="$OPT_DIR/current"
DATA_DIR="/var/lib/enotdesk"
ENV_DIR="/etc/enotdesk"
ENV_FILE="$ENV_DIR/enotdesk.env"
UNIT_FILE="/etc/systemd/system/enotdesk.service"
SERVICE_NAME="enotdesk"
NODE_PREFIX="/opt/node-24"

NODE_VERSION="${NODE_VERSION:-24.12.0}"
PORT="${ENOT_PORT:-8080}"
BIND="${ENOT_BIND:-0.0.0.0}"
DB_PATH="${ENOT_DB:-$DATA_DIR/enotdesk.db}"
DIST_DIR="${ENOT_DIST_DIR:-}"
PUBLIC_URL=""
TURN_URLS="${ENOT_TURN_URLS:-}"
TURN_USERNAME="${ENOT_TURN_USERNAME:-}"
TURN_PASSWORD="${ENOT_TURN_PASSWORD:-}"

MODE="install"
TARBALL=""
RELEASE=""
DRY_RUN=0
OPEN_FIREWALL=0
PURGE_DATA=0

usage() {
  cat <<'EOF'
EnotDesk — установщик сервера.

Использование:
  install-server.sh <app.tar.gz> [опции]   установить или обновить сервер
  install-server.sh --update <app.tar.gz>  поставить новый релиз и переключить current
  install-server.sh --uninstall [--purge-data]
  install-server.sh --help

Опции:
  <app.tar.gz>       tarball приложения (server/, package.json, package-lock.json)
  --dry-run          показать план и выйти, ничего не меняя
  --update <tar>     то же, что установка с явным tarball (атомарная смена symlink)
  --uninstall        остановить и удалить unit и релизы; БД сохраняется
  --purge-data       вместе с --uninstall удалить и /var/lib/enotdesk
  --open-firewall    открыть порт в ufw, если ufw активен (иначе только сообщить)
  --help             эта справка

Переменные окружения:
  ENOT_PORT          порт сервера (по умолчанию 8080)
  ENOT_BIND          адрес привязки (по умолчанию 0.0.0.0)
  ENOT_PUBLIC_URL    публичный URL (по умолчанию http://<первый IP>:<порт>)
  ENOT_DB            путь к БД (по умолчанию /var/lib/enotdesk/enotdesk.db)
  NODE_VERSION       версия Node.js из tarball nodejs.org (по умолчанию 24.12.0)
  ENOT_TURN_URLS, ENOT_TURN_USERNAME, ENOT_TURN_PASSWORD — TURN для WebRTC
EOF
}

die() { echo "ОШИБКА: $*" >&2; exit 1; }
info() { echo "==> $*"; }
NODE_TMP=""
node_tmp_cleanup() { [ -n "$NODE_TMP" ] && rm -rf "$NODE_TMP"; return 0; }
trap node_tmp_cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --update)
      MODE="update"
      shift
      [ $# -gt 0 ] || die "--update требует путь к tarball"
      TARBALL="$1"
      ;;
    --uninstall) MODE="uninstall" ;;
    --purge-data) PURGE_DATA=1 ;;
    --open-firewall) OPEN_FIREWALL=1 ;;
    -*) die "неизвестный аргумент: $1 (справка: --help)" ;;
    *) TARBALL="$1" ;;
  esac
  shift
done

if [ "$PURGE_DATA" = "1" ] && [ "$MODE" != "uninstall" ]; then
  die "--purge-data работает только вместе с --uninstall"
fi

preflight() {
  if [ "$(id -u)" != "0" ]; then
    die "нужны права root — запустите через sudo (например: sudo bash $0 <app.tar.gz>)"
  fi
  if [ ! -r /etc/os-release ]; then
    die "не удалось определить ОС (нет /etc/os-release); поддерживаются Debian и Ubuntu"
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    debian:*|ubuntu:*|*:debian*|*:ubuntu*) ;;
    *) die "поддерживаются только Debian/Ubuntu, обнаружено: ${PRETTY_NAME:-неизвестная ОС}" ;;
  esac
  command -v systemctl >/dev/null 2>&1 || die "systemd не найден — нужна Ubuntu/Debian с systemd"
  command -v curl >/dev/null 2>&1 || die "не найден curl — он нужен для скачивания Node tarball (пакет curl)"
  command -v tar >/dev/null 2>&1 || die "не найден tar — он нужен для распаковки (пакет tar)"
  command -v xz >/dev/null 2>&1 || die "не найден xz — он нужен для распаковки Node .tar.xz (пакет xz-utils)"
}

check_tarball() {
  [ -n "$TARBALL" ] || die "не указан tarball приложения. Пример: sudo bash $0 /tmp/enotdesk-install/app.tar.gz"
  [ -f "$TARBALL" ] || die "tarball не найден: $TARBALL"
  local list
  list="$(tar -tzf "$TARBALL" 2>/dev/null)" || die "tarball повреждён или это не tar.gz: $TARBALL"
  printf '%s\n' "$list" | grep -qE '(^|\./)server/main\.mjs$' || die "в tarball нет server/main.mjs — это не сборка EnotDesk"
}

check_port() {
  command -v ss >/dev/null 2>&1 || return 0
  if ss -ltnH 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"; then
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      info "порт $PORT занят сервисом $SERVICE_NAME — он будет перезапущен"
    else
      die "порт $PORT уже занят другим процессом — освободите порт или задайте ENOT_PORT"
    fi
  fi
}

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -v 2>/dev/null)" = "v$NODE_VERSION" ]
}

ensure_node() {
  if node_version_ok; then
    info "Node.js $(node -v) уже установлен — шаг пропущен"
    return 0
  fi

  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="linux-x64" ;;
    *) die "tarball ставится только на x86_64 (amd64); обнаружено: $(uname -m). Установите Node $NODE_VERSION вручную и повторите." ;;
  esac

  local base="https://nodejs.org/dist/v$NODE_VERSION"
  local file="node-v$NODE_VERSION-$arch.tar.xz"
  NODE_TMP="$(mktemp -d)"

  info "скачиваю $base/$file"
  curl -fsSL "$base/$file" -o "$NODE_TMP/$file" || die "не удалось скачать $base/$file — проверьте доступ к nodejs.org"
  curl -fsSL "$base/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt" || die "не удалось скачать $base/SHASUMS256.txt"

  local sum
  sum="$(grep " $file\$" "$NODE_TMP/SHASUMS256.txt" || true)"
  [ -n "$sum" ] || die "в SHASUMS256.txt нет строки для $file"
  info "проверяю SHA256"
  ( cd "$NODE_TMP" && printf '%s\n' "$sum" | sha256sum -c - ) || die "SHA256 не совпал — скачанный tarball повреждён"

  info "распаковываю новый Node ($NODE_PREFIX.tmp)"
  if [ ! -e "$NODE_PREFIX" ] && [ -e "$NODE_PREFIX.bak" ]; then
    mv "$NODE_PREFIX.bak" "$NODE_PREFIX" || die "не удалось вернуть прежний $NODE_PREFIX из .bak"
  fi
  rm -rf "$NODE_PREFIX.tmp"
  install -d -m 0755 "$NODE_PREFIX.tmp"
  tar -xJf "$NODE_TMP/$file" -C "$NODE_PREFIX.tmp" --strip-components=1 || die "не удалось распаковать $file — прежний $NODE_PREFIX не тронут"
  rm -rf "$NODE_PREFIX.bak"
  if [ -e "$NODE_PREFIX" ]; then
    mv "$NODE_PREFIX" "$NODE_PREFIX.bak" || die "не удалось отодвинуть прежний $NODE_PREFIX"
  fi
  if ! mv "$NODE_PREFIX.tmp" "$NODE_PREFIX"; then
    if [ -e "$NODE_PREFIX.bak" ]; then mv "$NODE_PREFIX.bak" "$NODE_PREFIX" || true; fi
    die "не удалось установить $NODE_PREFIX — прежний Node возвращён из .bak"
  fi
  rm -rf "$NODE_PREFIX.bak"
  ln -sfn "$NODE_PREFIX/bin/node" /usr/local/bin/node
  ln -sfn "$NODE_PREFIX/bin/npm" /usr/local/bin/npm
  ln -sfn "$NODE_PREFIX/bin/npx" /usr/local/bin/npx
  hash -r 2>/dev/null || true
  node_version_ok || die "Node.js распакован, но node -v не равен v$NODE_VERSION — проверьте /usr/local/bin в PATH"
  info "установлен Node.js $(node -v) в $NODE_PREFIX"
}

resolve_public_url() {
  if [ -n "${ENOT_PUBLIC_URL:-}" ]; then
    PUBLIC_URL="$ENOT_PUBLIC_URL"
    return 0
  fi
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$ip" ]; then
    ip="$(hostname -f 2>/dev/null || echo 127.0.0.1)"
  fi
  PUBLIC_URL="http://${ip}:${PORT}"
}

find_or_name_release() {
  local hash="$1" d=""
  for d in "$RELEASES_DIR"/*-"$hash"; do
    [ -d "$d" ] && RELEASE="$d"
  done
  if [ -z "$RELEASE" ]; then
    RELEASE="$RELEASES_DIR/$(date -u +%Y%m%d%H%M%S)-$hash"
  fi
}

read_env_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || { echo ""; return 0; }
  sed -n "s/^${key}=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 || true
}

# merge: переменные, не заданные в текущем прогоне, сохраняют прежние значения
# из env-файла (иначе повторный --update без TURN затирал бы настройки).
merge_env_file() {
  local old
  if [ -z "${ENOT_PORT:-}" ]; then
    old="$(read_env_value ENOT_PORT)"; if [ -n "$old" ]; then PORT="$old"; fi
  fi
  if [ -z "${ENOT_BIND:-}" ]; then
    old="$(read_env_value ENOT_HOST)"; if [ -n "$old" ]; then BIND="$old"; fi
  fi
  if [ -z "${ENOT_DB:-}" ]; then
    old="$(read_env_value ENOT_DB)"; if [ -n "$old" ]; then DB_PATH="$old"; fi
  fi
  if [ -z "${ENOT_DIST_DIR:-}" ]; then
    old="$(read_env_value ENOT_DIST_DIR)"; if [ -n "$old" ]; then DIST_DIR="$old"; fi
  fi
  if [ -z "$DIST_DIR" ]; then DIST_DIR="$DATA_DIR/dist"; fi
  if [ -z "${ENOT_PUBLIC_URL:-}" ]; then
    old="$(read_env_value ENOT_PUBLIC_URL)"; if [ -n "$old" ]; then PUBLIC_URL="$old"; fi
  fi
  if [ -z "$TURN_URLS" ]; then TURN_URLS="$(read_env_value ENOT_TURN_URLS)"; fi
  if [ -z "$TURN_USERNAME" ]; then TURN_USERNAME="$(read_env_value ENOT_TURN_USERNAME)"; fi
  if [ -z "$TURN_PASSWORD" ]; then TURN_PASSWORD="$(read_env_value ENOT_TURN_PASSWORD)"; fi
}

print_plan() {
  echo "EnotDesk — план ($MODE, dry-run: изменения не вносятся)"
  if [ "$MODE" = "uninstall" ]; then
    echo "  остановить/disable: $SERVICE_NAME"
    echo "  удалить unit:       $UNIT_FILE"
    echo "  удалить каталоги:   $OPT_DIR, $ENV_DIR"
    if [ "$PURGE_DATA" = "1" ]; then
      echo "  удалить данные:     $DATA_DIR"
    else
      echo "  данные сохранить:   $DB_PATH"
    fi
    return 0
  fi
  local node_state="Node.js не найден — будет установлен $NODE_VERSION из tarball nodejs.org в $NODE_PREFIX"
  if node_version_ok; then
    node_state="$(node -v) — уже подходит (шаг пропускается)"
  elif command -v node >/dev/null 2>&1; then
    node_state="$(node -v) — будет заменён на v$NODE_VERSION (tarball nodejs.org, $NODE_PREFIX)"
  fi
  local release_state="будет создан"
  if [ -f "$RELEASE/server/main.mjs" ]; then
    release_state="будет переиспользован"
  fi
  echo "  tarball:            $TARBALL"
  echo "  релиз:              $RELEASE ($release_state)"
  echo "  current:            $CURRENT_LINK"
  echo "  пользователь:       $ENOT_USER (system, nologin)"
  echo "  БД:                 $DB_PATH"
  echo "  артефакты:          $DIST_DIR"
  echo "  env-файл:           $ENV_FILE (0600)"
  echo "  unit:               $UNIT_FILE (Restart=on-failure, EnvironmentFile)"
  echo "  bind/port:          $BIND:$PORT"
  echo "  публичный URL:      $PUBLIC_URL"
  echo "  Node.js:            $node_state"
  echo "  health-poll:        http://127.0.0.1:$PORT/api/v1/health (до 30 с)"
  if [ "$OPEN_FIREWALL" = "1" ]; then
    echo "  ufw:                открыть $PORT/tcp, если ufw активен"
  else
    echo "  ufw:                не трогать"
  fi
}

preflight

if [ "$MODE" = "uninstall" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    print_plan
    exit 0
  fi
  info "останавливаю и удаляю сервис $SERVICE_NAME"
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  rm -rf "$OPT_DIR" "$ENV_DIR"
  if [ "$PURGE_DATA" = "1" ]; then
    rm -rf "$DATA_DIR"
    info "данные удалены: $DATA_DIR"
  else
    info "unit и релизы удалены; БД сохранена: $DB_PATH"
    info "удалить и данные: sudo bash $0 --uninstall --purge-data"
  fi
  exit 0
fi

merge_env_file

check_tarball
check_port

HASH="$(sha256sum "$TARBALL" | cut -c1-12)"
find_or_name_release "$HASH"

if [ "$DRY_RUN" = "1" ]; then
  [ -n "$PUBLIC_URL" ] || resolve_public_url
  print_plan
  exit 0
fi

info "устанавливаю EnotDesk ($MODE)"
ensure_node
NODE_BIN="$(command -v node)"

if ! id -u "$ENOT_USER" >/dev/null 2>&1; then
  info "создаю системного пользователя $ENOT_USER"
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --shell "$NOLOGIN" --home-dir "$DATA_DIR" --no-create-home "$ENOT_USER"
else
  info "пользователь $ENOT_USER уже существует"
fi

install -d -m 0755 "$OPT_DIR" "$RELEASES_DIR" "$ENV_DIR"
install -d -m 0750 "$DATA_DIR"
mkdir -p "$DIST_DIR"
chown "$ENOT_USER:$ENOT_USER" "$OPT_DIR" "$RELEASES_DIR" "$DATA_DIR"
chown "$ENOT_USER:$ENOT_USER" "$DIST_DIR"

if [ -f "$RELEASE/server/main.mjs" ]; then
  info "релиз уже распакован: $RELEASE"
else
  info "распаковываю релиз: $RELEASE"
  rm -rf "$RELEASE"
  install -d -m 0755 "$RELEASE"
  tar -xzf "$TARBALL" -C "$RELEASE"
fi

if [ ! -d "$RELEASE/node_modules" ]; then
  info "ставлю production-зависимости (npm ci --omit=dev)"
  ( cd "$RELEASE" && npm ci --omit=dev --no-audit --no-fund )
fi
chown -R "$ENOT_USER:$ENOT_USER" "$RELEASE"

rm -f "$CURRENT_LINK.tmp"
ln -s "$RELEASE" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
info "current -> $RELEASE"

[ -n "$PUBLIC_URL" ] || resolve_public_url
info "пишу env-файл $ENV_FILE (0600)"
install -m 0600 /dev/null "$ENV_FILE"
{
  echo "ENOT_HOST=$BIND"
  echo "ENOT_PORT=$PORT"
  echo "ENOT_DB=$DB_PATH"
  echo "ENOT_DIST_DIR=$DIST_DIR"
  echo "ENOT_PUBLIC_URL=$PUBLIC_URL"
  if [ -n "$TURN_URLS" ]; then echo "ENOT_TURN_URLS=$TURN_URLS"; fi
  if [ -n "$TURN_USERNAME" ]; then echo "ENOT_TURN_USERNAME=$TURN_USERNAME"; fi
  if [ -n "$TURN_PASSWORD" ]; then echo "ENOT_TURN_PASSWORD=$TURN_PASSWORD"; fi
} | tee "$ENV_FILE" >/dev/null
chmod 0600 "$ENV_FILE"

info "пишу unit $UNIT_FILE"
install -m 0644 /dev/null "$UNIT_FILE"
tee "$UNIT_FILE" >/dev/null <<EOF
[Unit]
Description=EnotDesk — remote support server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$ENOT_USER
Group=$ENOT_USER
WorkingDirectory=$CURRENT_LINK
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $CURRENT_LINK/server/main.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

info "включаю и запускаю сервис"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

if [ "$OPEN_FIREWALL" = "1" ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$PORT/tcp" >/dev/null
    info "ufw: порт $PORT/tcp открыт"
  else
    info "ufw не установлен или неактивен — правило не добавлено; откройте порт $PORT/tcp вручную"
  fi
fi

HEALTH_URL="http://127.0.0.1:$PORT/api/v1/health"
info "проверяю health: $HEALTH_URL"
healthy=0
deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
  if curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" != "1" ]; then
  echo "--- последние строки журнала $SERVICE_NAME ---" >&2
  journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2 || true
  die "сервис не ответил на health за 30 секунд"
fi
info "health: ok"

cat <<EOF

Установка завершена.
  релиз:     $RELEASE
  current:   $CURRENT_LINK -> $RELEASE
  сервис:    systemctl status $SERVICE_NAME (enabled, Restart=on-failure)
  health:    $PUBLIC_URL/api/v1/health
  БД:        $DB_PATH (вне релизов, переживает обновление и --uninstall)
  env:       $ENV_FILE (0600)

Первый администратор (интерактивно):
  sudo -u $ENOT_USER env ENOT_DB=$DB_PATH $NODE_BIN $CURRENT_LINK/server/main.mjs bootstrap
EOF
